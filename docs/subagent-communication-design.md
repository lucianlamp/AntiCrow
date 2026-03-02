# サブエージェント通信設計

> **ステータス**: Draft v1.1 (レビュー反映)  
> **作成日**: 2026-03-02  
> **根拠**: マルチウィンドウ PoC テスト結果（同日実施）

---

## 1. アーキテクチャ概要

```
┌─────────────────────────────────────────────────┐
│ メインウィンドウ (anti-crow)                      │
│                                                   │
│  SubagentManager                                  │
│  ├── spawn(taskPrompt) → SubagentHandle           │
│  ├── list() → SubagentHandle[]                    │
│  └── killAll()                                    │
│                                                   │
│  SubagentHandle                                   │
│  ├── worktree + branch 管理                       │
│  ├── CDP 接続 (一時 CdpConnection)                │
│  ├── ファイル IPC (prompt → response)             │
│  └── closeWindow() でシャットダウン               │
└───────────┬───────────────────────────────────────┘
            │ CDP ポート 9333 (共有)
            │ ファイル IPC (globalStorage)
┌───────────┴───────────────────────────────────────┐
│ サブウィンドウ (anti-crow-subagent-1)              │
│  - 独立した worktree + ブランチ                    │
│  - Anti-Crow 拡張が自動ロード                      │
│  - ファイル IPC で prompt を受信                    │
│  - 通常の Antigravity として応答を生成             │
└───────────────────────────────────────────────────┘
```

---

## 2. PoC で確認済みの制約

| 項目 | 結果 | 設計への影響 |
|---|---|---|
| CDP ポート | 全ウィンドウが 9333 を共有 | ポート単位ではなくターゲット単位で管理 |
| `vscode.commands` | ページコンテキストで **不可** | DOM 操作やファイル IPC を代替手段にする |
| `window.close()` | ✅ 動作確認済み | シャットダウンに使用 |
| `Runtime.evaluate()` | ✅ JS 実行可能 | ステータス確認に使用可能 |
| ファイル IPC | 既存インフラ | プロンプト送信・レスポンス受信の主要チャネル |
| `extractWorkspaceName()` | ✅ WS 名抽出可能 | ターゲット特定に使用 |

---

## 3. プロンプト送信方式

### 採用: ファイル IPC（推奨）

**理由**: CDP の `Runtime.evaluate()` ではプロンプトを DOM に注入できるが、Antigravity の Cascade Panel は iframe 内にあり、コンテキスト ID の取得が不安定。ファイル IPC は既に Anti-Crow で実証済みの仕組みでありシンプル。

### フロー

```
1. メインエージェントが JSON ファイルを書き込む:
   {globalStorage}/ipc/subagent_{name}_prompt_{timestamp}.json
   
2. サブウィンドウの Anti-Crow 拡張がファイルを検知:
   - fs.watch() で ipc/ ディレクトリを監視
   - 自分のワークスペース名に一致するファイルのみ処理
   
3. Anti-Crow がプロンプトを Antigravity に送信:
   - 既存の sendPrompt() / executorPool を使用
```

### ファイルフォーマット

```json
{
  "type": "subagent_prompt",
  "from": "anti-crow",
  "to": "anti-crow-subagent-1",
  "timestamp": 1772456365532,
  "prompt": "コードレビューしてください...",
  "timeout_ms": 300000,
  "callback_path": "{globalStorage}/ipc/subagent_1_response_{timestamp}.json"
}
```

---

## 4. レスポンス受信方式

### 採用: ファイル IPC + ポーリング

**理由**: CDP イベント監視は接続を維持する必要があり、リソース消費が大きい。ファイル IPC + ポーリングは `fs.watchFile()` で十分実装可能で、既存のパターンと一致。

### フロー

```
1. サブエージェントが応答を生成完了
2. Anti-Crow が response ファイルを書き込む:
   {globalStorage}/ipc/subagent_1_response_{timestamp}.json
3. メインエージェントが検知:
   - 2秒間隔でポーリング（fs.existsSync）
   - または fs.watch() でイベント駆動
4. 応答を読み取り、コールバックを実行
```

### レスポンスフォーマット

```json
{
  "type": "subagent_response",
  "from": "anti-crow-subagent-1",
  "timestamp": 1772456400000,
  "status": "success",
  "result": "レビュー結果...",
  "execution_time_ms": 45000
}
```

---

## 5. ライフサイクル管理

### 状態遷移

```
IDLE → CREATING → LAUNCHING → READY → BUSY → COMPLETED → CLOSING → CLEANED
```

### 各フェーズの処理

| フェーズ | 処理 | 所要時間 |
|---|---|---|
| CREATING | `git worktree add` + ブランチ作成 | ~1秒 |
| LAUNCHING | `antigravity.cmd --new-window` | ~5秒 |
| READY | CDP でターゲット出現を確認 | ~3-5秒 |
| BUSY | プロンプト送信 → 応答待ち | タスク依存 |
| COMPLETED | レスポンスファイル検出 | 即時 |
| CLOSING | `closeWindow()` 実行 | ~3秒 |
| CLEANED | worktree remove + branch delete | ~1秒 |

### READY 検出ロジック

```typescript
async waitForReady(wsName: string, timeoutMs = 30000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const instances = await discoverInstances(this.ports);
        const found = instances.find(i => extractWorkspaceName(i.title) === wsName);
        if (found) return true;
        await sleep(1000);
    }
    return false;
}
```

---

## 6. 並列管理

### SubagentManager クラス

```typescript
class SubagentManager {
    private agents: Map<string, SubagentHandle> = new Map();
    private maxConcurrent = 3;  // メモリ制約から3が上限
    
    async spawn(taskPrompt: string): Promise<SubagentHandle>;
    async getAgent(name: string): Promise<SubagentHandle | undefined>;
    async killAgent(name: string): Promise<void>;
    async killAll(): Promise<void>;
    list(): SubagentHandle[];
}
```

### SubagentHandle

```typescript
interface SubagentHandle {
    name: string;                          // "anti-crow-subagent-1"
    branch: string;                        // "team/subagent/anti-crow-subagent-1"
    worktreePath: string;                  // ".worktrees/anti-crow-subagent-1"
    state: SubagentState;                  // IDLE | CREATING | ... | CLEANED
    createdAt: number;                     // timestamp
    currentTask?: string;                  // 現在のプロンプト
    sendPrompt(prompt: string): Promise<SubagentResponse>;
    close(): Promise<void>;                // closeWindow + cleanup
}
```

### 命名規則

```
ワークスペース名: {ws_name}-subagent-{N}
ブランチ名:       team/subagent/{ws_name}-subagent-{N}
worktree パス:    .worktrees/{ws_name}-subagent-{N}
```

N は 1 から連番。使用済み番号は再利用しない（タイムスタンプでユニーク化も検討）。

---

## 7. エラーハンドリング

### タイムアウト

| シナリオ | タイムアウト | 対処 |
|---|---|---|
| ウィンドウ起動 | 30秒 | CREATING → FAILED、worktree 削除 |
| CDP ターゲット出現 | 15秒 | ウィンドウを taskkill → リトライ |
| プロンプト応答 | 5分（デフォルト） | closeWindow → タスク失敗レポート |
| closeWindow | 5秒 | taskkill フォールバック |

### クラッシュ検出

```typescript
// 定期ヘルスチェック（30秒間隔）
async healthCheck(): Promise<void> {
    for (const [name, agent] of this.agents) {
        if (agent.state !== 'BUSY') continue;
        
        const instances = await discoverInstances(this.ports);
        const found = instances.find(i => extractWorkspaceName(i.title) === name);
        
        if (!found) {
            // ウィンドウがクラッシュ → クリーンアップ
            agent.state = 'FAILED';
            await this.cleanupAgent(name);
            // タスク失敗をレポート
        }
    }
}
```

### リソースリーク防止

- `process.on('exit')` で全サブエージェントを `killAll()`
- VS Code の `deactivate()` フックで同様
- Antigravity 終了時に `.worktrees/` 配下を自動スキャン & クリーンアップ

---

## 8. ファイル構成（実装時）

```
src/
├── subagentManager.ts     # SubagentManager クラス
├── subagentHandle.ts      # SubagentHandle クラス  
├── subagentIpc.ts         # ファイル IPC ヘルパー
└── subagentTypes.ts       # 型定義

docs/
└── subagent-communication-design.md  # 本ドキュメント
```

---

## 9. 実装優先度

| 優先度 | 機能 | 見積り |
|---|---|---|
| P0 | 単一サブエージェント spawn + prompt + response | 2-3時間 |
| P0 | closeWindow + クリーンアップ | 実装済み ✅ |
| P1 | SubagentManager（並列管理） | 1-2時間 |
| P1 | ヘルスチェック + タイムアウト | 1時間 |
| P2 | リソースリーク防止（deactivate hook） | 30分 |
| P2 | Discord コマンド統合（`/subagent spawn`） | 1時間 |

---

## 10. セキュリティレビュー

### 10.1 パストラバーサル防止

`to` フィールドと `callback_path` にはバリデーションが必要。悪意ある値を注入されると globalStorage 外にファイルを書き込むリスクがある。

**対策**:

```typescript
// subagentIpc.ts に実装
function validateIpcPath(path: string): boolean {
    const resolved = path.resolve(path);
    const ipcDir = path.resolve(globalStoragePath, 'ipc');
    return resolved.startsWith(ipcDir);
}

function validateAgentName(name: string): boolean {
    // 英数字・ハイフン・アンダースコアのみ許可
    return /^[a-zA-Z0-9_-]+$/.test(name);
}
```

### 10.2 プロンプト injection

サブエージェントに送るプロンプトがそのまま Antigravity に送信される設計のため、injection リスクは**低い**。理由:

- メインエージェントがプロンプトを生成するため、外部入力が混入するパスがない
- Discord ユーザーの入力はメインの Anti-Crow ルールでサニタイズ済み

**結論**: 現時点では追加対策不要。外部 API 連携時に再検討。

### 10.3 ファイル権限

- globalStorage は VS Code が管理するディレクトリ（ユーザー権限）
- 同一ユーザーの全ウィンドウがアクセス可能 → マルチウィンドウ IPC に適切
- **リスク**: 他の拡張機能が globalStorage を読み書きする可能性がある（低確率）

**対策**: IPC ファイルに `type` プレフィックス（`subagent_prompt` / `subagent_response`）を必須にし、不正ファイルを無視する。

---

## 11. パフォーマンスレビュー

### 11.1 ポーリング vs fs.watch()

| 方式 | CPU 負荷 | 応答遅延 | 信頼性 |
|---|---|---|---|
| 2秒ポーリング (`fs.existsSync`) | 低 | 最大2秒 | ✅ 高 |
| `fs.watch()` | 極低 | ~0ms | ⚠️ Windows で重複イベント発生 |
| `fs.watchFile()` | 中（stat 呼び出し） | 設定次第 | ✅ 高 |

**結論**: `fs.watch()` + `debounce(500ms)` を推奨。Windows の重複イベントは debounce で吸収。ポーリングはフォールバック用として残す。

### 11.2 メモリフットプリント

| コンポーネント | 1並列 | 3並列 |
|---|---|---|
| SubagentHandle インスタンス | ~1KB | ~3KB |
| CdpConnection（一時接続、使い捨て） | 0 (都度作成/破棄) | 0 |
| Antigravity ウィンドウ（OS側） | ~500MB | ~1.5GB |

**ボトルネック**: CdpConnection ではなく **Antigravity ウィンドウ自体のメモリ消費**（~500MB/ウィンドウ）。`maxConcurrent = 3` はメモリ 16GB マシンで安全な上限。8GB マシンでは `maxConcurrent = 1` を推奨。

### 11.3 ディスク消費

worktree は git の仕組み上、`.git` 共有のため追加ディスクは**ワーキングツリーのファイル分のみ**。anti-crow プロジェクトで約 50MB/worktree。3 並列でも 150MB（問題なし）。

---

## 12. 拡張性レビュー

### 12.1 マルチマシン対応への移行パス

現在の設計はシングルマシン前提（ファイル IPC + ローカル CDP）。マルチマシン対応が必要になった場合の移行パス:

```
Phase 1（現在）: ローカルファイル IPC + CDP localhost:9333
     ↓
Phase 2: ファイル IPC → HTTP/WebSocket IPC
     - subagentIpc.ts の書き込み層を抽象化
     - IpcTransport インターフェース: FileTransport | HttpTransport
     ↓
Phase 3: CDP ローカル → SSH トンネル経由 CDP
     - ポート転送: ssh -L 19333:localhost:9333 remote-host
     - discoverInstances() のポート配列にリモートポートを追加するだけ
```

**設計上の注意**: `subagentIpc.ts` でファイル操作を直接行わず、`IpcTransport` インターフェースを介すことで Phase 2 への移行を容易にする。

### 12.2 キューイング拡張

タスクが `maxConcurrent` を超えた場合のキューイング:

```typescript
// 将来の拡張（P3）
interface TaskQueue {
    enqueue(task: SubagentTask): string;  // タスクID
    dequeue(): SubagentTask | undefined;
    peek(): SubagentTask | undefined;
    size: number;
}
```

---

## 13. 見落とし: コード共有・マージ戦略

### 13.1 サブエージェント側の受信ロジック（設計追加）

v1.0 では「Anti-Crow がファイルを検知」とだけ記述していたが、受信側の設計が未記述だった。

**追加設計**:

```typescript
// subagentReceiver.ts（サブウィンドウ側）
class SubagentReceiver {
    private watcher: fs.FSWatcher | null = null;
    private myName: string;  // extractWorkspaceName() で取得

    start(): void {
        // 自分宛てのプロンプトファイルのみ処理
        this.watcher = fs.watch(ipcDir, (event, filename) => {
            if (!filename?.startsWith(`subagent_${this.myName}_prompt_`)) return;
            this.handlePrompt(path.join(ipcDir, filename));
        });
    }

    private async handlePrompt(filePath: string): Promise<void> {
        const prompt = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        // 既存の executorPool / sendPrompt で実行
        const result = await this.executor.execute(prompt.prompt);
        // レスポンスを callback_path に書き込み
        fs.writeFileSync(prompt.callback_path, JSON.stringify({
            type: 'subagent_response',
            from: this.myName,
            timestamp: Date.now(),
            status: 'success',
            result
        }));
        // 処理済みプロンプトファイルを削除
        fs.unlinkSync(filePath);
    }
}
```

### 13.2 コード共有・マージ戦略

サブエージェントがファイルを変更した場合のメインブランチへの反映:

| パターン | ユースケース | 方法 |
|---|---|---|
| **読み取り専用** | コードレビュー・分析 | マージ不要。結果は IPC レスポンスで返す |
| **独立作業** | 別ファイルの修正 | `git merge --no-ff` でマージ |
| **共有ファイル** | 同じファイルの異なる箇所 | `git merge` + コンフリクト解決 |

**推奨**: Phase 1 では**読み取り専用**パターンのみサポート。サブエージェントの出力はテキスト（レビュー結果・分析レポート）として IPC レスポンスに含め、ファイル変更はメインエージェントが実施する。

ファイル変更が必要なユースケース（並列リファクタリング等）は Phase 2 で対応。
