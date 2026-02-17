# ワークスペース毎並列処理 — 計画・要件定義

> **状態:** DRAFT  
> **作成日:** 2026-02-16  
> **前提:** Antigravity は単一 CDP ポートでしか起動できない（複数ポート同時起動不可）

---

## 1. 現在のアーキテクチャ

### 1.1 モジュール関係図

```
Discord Message
       │
       ▼
  messageHandler.ts ── isProcessingMessage (グローバル排他)
       │
       ▼
  BridgeContext (シングルトン)
   ├── bot: DiscordBot         ... 1個
   ├── cdp: CdpBridge          ... 1個 ★ボトルネック
   ├── executor: Executor      ... 1個（直列キュー）
   ├── fileIpc: FileIpc        ... 1個
   ├── scheduler: Scheduler    ... 1個
   └── planStore: PlanStore    ... 1個

CdpBridge
   └── CdpConnection (1個)
        ├── ws: WebSocket       ... 1本（1ターゲットのみ）
        ├── activeTargetId      ... 現在接続中のターゲット
        └── activeTargetPort    ... 現在のCDPポート
```

### 1.2 現在のワークスペース切り替えフロー

1. `messageHandler.ts` がワークスペースカテゴリー名を判定
2. `CdpBridge.discoverInstances()` で全ターゲットをスキャン
3. `cdp.switchTarget(targetId)` で WebSocket 接続を張り替え
4. プロンプト送信 → レスポンス待機（直列、排他制御）

**問題点:** `switchTarget` は既存接続を切断してから新接続するため、同時に2つのワークスペースで作業できない。

### 1.3 主要ファイルと責務

| ファイル | 責務 | 並列化への影響 |
| --- | --- | --- |
| `bridgeContext.ts` | 共有状態定義 | cdp を Map 化が必要 |
| `cdpBridge.ts` | CDP ファサード | インスタンス複数化 |
| `cdpConnection.ts` | WebSocket 管理 | コア変更なし |
| `cdpTargets.ts` | ターゲット発見 | 変更不要 |
| `executor.ts` | 直列実行キュー | WS毎キュー化 |
| `messageHandler.ts` | メッセージ処理 | 排他制御の分離 |
| `bridgeLifecycle.ts` | 起動/停止管理 | プール管理追加 |
| `extension.ts` | エントリポイント | Context初期化変更 |

---

## 2. 単一ポート制約の分析

### 2.1 制約の詳細

- Antigravity は `--remote-debugging-port=XXXX` で CDP を公開
- **複数インスタンスを起動しても、すべて同じポート（例: 9222）で動作**
- 同一ポート上に複数の「ページ」（ターゲット）が存在する
- 各ワークスペースは異なるターゲット（WebSocket URL）として見える
- `GET http://127.0.0.1:9222/json` で全ターゲットが一覧取得可能

### 2.2 制約が意味すること

```
Antigravity (ポート 9222)
  ├── ターゲット A: "my-project — Antigravity" (wsUrl: ws://...devtools/page/XXX)
  ├── ターゲット B: "another-app — Antigravity" (wsUrl: ws://...devtools/page/YYY)
  └── ターゲット C: "third-repo — Antigravity" (wsUrl: ws://...devtools/page/ZZZ)
```

- 全ターゲットが同一ポート上に存在 → **ポート管理の複雑さはない**
- 各ターゲットは個別の WebSocket URL を持つ → **同時に複数接続可能**
- つまり: **単一ポート制約は並列化の障壁ではなく、むしろ簡素化要因**

---

## 3. 設計方針: マルチ WebSocket 接続方式

### 3.1 概要

単一ポートの `/json` エンドポイントから全ワークスペースを検出し、  
各ワークスペースに対して独立した WebSocket 接続を維持する。

```
Discord Messages
  ├── WS "my-project" → CdpConnection A → ws://...page/XXX
  ├── WS "another-app" → CdpConnection B → ws://...page/YYY
  └── WS "third-repo" → CdpConnection C → ws://...page/ZZZ
                              │
                              └── すべて同じ 127.0.0.1:9222
```

### 3.2 新アーキテクチャ

```
BridgeContext (変更後)
  ├── bot: DiscordBot             ... 1個（共有）
  ├── cdpPool: CdpPool            ... 1個 ★NEW
  │    └── Map<workspaceName, CdpBridge>
  ├── executorPool: ExecutorPool  ... 1個 ★NEW
  │    └── Map<workspaceName, Executor>
  ├── fileIpc: FileIpc            ... 1個（共有、リクエストIDで衝突回避）
  ├── scheduler: Scheduler        ... 1個（共有）
  └── planStore: PlanStore        ... 1個（共有）
```

### 3.3 新規モジュール

#### `cdpPool.ts` (NEW)

```typescript
export class CdpPool {
    private pool: Map<string, CdpBridge> = new Map();
    private port: number; // 単一ポート

    // ワークスペース名で CdpBridge を取得（なければ作成）
    async acquire(workspaceName: string): Promise<CdpBridge>;
    
    // 未使用の接続を開放
    async releaseIdle(maxIdleMs: number): void;
    
    // 全接続を切断
    async disconnectAll(): void;
}
```

#### `executorPool.ts` (NEW)

```typescript
export class ExecutorPool {
    private pool: Map<string, Executor> = new Map();

    // ワークスペース毎の Executor を取得（なければ作成）
    getOrCreate(workspaceName: string, cdp: CdpBridge, ...): Executor;
    
    // 特定ワークスペースのキューにジョブ追加
    enqueue(workspaceName: string, job: ExecutionJob): void;
}
```

---

## 4. 変更対象モジュールと影響範囲

### 4.1 変更ファイル一覧

| ファイル | 変更内容 | 規模 |
| --- | --- | --- |
| `bridgeContext.ts` | `cdp` → `cdpPool`, `executor` → `executorPool` | 小 |
| `cdpPool.ts` | **新規作成**: プール管理 | 中 |
| `executorPool.ts` | **新規作成**: Executor プール | 中 |
| `messageHandler.ts` | `isProcessingMessage` をWS毎に、cdpPool から取得 | 中 |
| `executor.ts` | 既存 Executor のインターフェース微調整 | 小 |
| `bridgeLifecycle.ts` | プールの起動/停止管理 | 小 |
| `extension.ts` | BridgeContext 初期化変更 | 小 |

### 4.2 変更不要ファイル

- `cdpBridge.ts` — 既にインスタンス化可能な設計
- `cdpConnection.ts` — 接続先が異なるだけで動作は同じ
- `cdpTargets.ts` — ターゲット発見ロジックは共通で利用
- `discordBot.ts` — Discord 側は変更不要
- `fileIpc.ts` — リクエストIDベースで既に衝突しない
- `planStore.ts` — workspace_name フィールドで既に対応済み
- `scheduler.ts` — Plan の workspace_name で振り分け可能

---

## 5. 実装ステップ（フェーズ分け）

### Phase 1: CdpPool 導入（低リスク）

1. `cdpPool.ts` を新規作成
2. `bridgeContext.ts` に `cdpPool: CdpPool` を追加（`cdp` は互換のため残す）
3. 単一ワークスペース時は従来と同じ動作を保証

**検証:** 既存の単一ワークスペース運用で regression がないこと

### Phase 2: messageHandler の並列化対応

1. `isProcessingMessage` をワークスペース毎の `Map<string, boolean>` に変更
2. ワークスペース名で cdpPool から CdpBridge を取得するよう変更
3. 異なるワークスペースのメッセージは並列に処理可能に

**検証:** 2つの異なるワークスペースカテゴリーから同時にメッセージを送信して並列処理されること

### Phase 3: ExecutorPool 導入

1. `executorPool.ts` を新規作成
2. ワークスペース毎に独立した実行キューを持つ
3. UIWatcher もワークスペース毎に独立して動作

**検証:** ワークスペースA の実行中にワークスペースB のジョブが開始できること

### Phase 4: アイドル接続管理とリソース最適化

1. 一定時間未使用の CdpBridge を自動切断
2. 同時接続数の上限設定
3. StatusBar に接続中ワークスペース数を表示

---

## 6. リスクと課題

### 6.1 技術的リスク

| リスク | 影響度 | 対策 |
| --- | --- | --- |
| 同一ポートで複数 WS 接続の安定性 | 中 | CDP 仕様では問題ないが、Antigravity 固有の動作確認が必要 |
| cascade-panel iframe の競合 | 中 | 各ターゲットに独立した iframe があるため問題ない見込み |
| FileIpc のレスポンス取り違え | 低 | リクエストIDがユニークなため衝突しない |
| メモリ使用量の増加 | 低 | WebSocket 接続自体は軽量（数KB/接続）、Antigravity プロセスは共通 |

### 6.2 機能的課題

- **startNewChat (Ctrl+Shift+L)**: キーボードショートカットは全ウインドウに影響する可能性
  - 対策: 各ターゲットごとに `Input.dispatchKeyEvent` で送信すればターゲット限定
- **自動起動**: 新規ワークスペースの Antigravity 起動は `code --folder-uri` 経由
  - 単一ポートなので起動後に `/json` で自動検出される

### 6.3 運用上の注意

- Antigravity の CDPポートが固定のため、ポート管理は不要（シンプル）
- ワークスペースの最大同時接続数はメモリ制約ではなく Antigravity の安定性が制約要因
- 推奨: 同時3-5ワークスペースまで

---

## 7. まとめ

**結論: 単一ポート制約はむしろ設計を簡素化する好材料。**

すべてのワークスペースが同じポートの `/json` に一覧されるため、  
ポート管理の複雑さなく、WebSocket 接続の多重化だけで並列処理が実現できる。

主要な変更は以下の3点:
1. **CdpPool**: ワークスペース毎の CdpBridge インスタンス管理
2. **ExecutorPool**: ワークスペース毎の独立した実行キュー
3. **messageHandler**: ワークスペース毎の排他制御

工数見積もり: **2-3日**（テスト含む、Phase 1-3）
