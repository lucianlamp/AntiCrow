---
name: learnings
description: 作業中に得た学びや解決策をワークスペースレベルで保持するナレッジベース。新しい知見が得られたら追記していく。
---

# ワークスペース学習ナレッジ

anti-crow 開発で得られた知見・解決策・パターンを蓄積するスキルです。
新しい学びがあれば該当セクションに追記、または新セクションを作成してください。

---

## このスキルの使い方

### 自律的な更新ルール

1. **バグ修正完了時**: 修正した問題の根本原因と対策を該当セクションに追記する
2. **ユーザー指摘を受けた時**: 「ユーザー指摘履歴」セクションに記録する
3. **同じミスを2回以上した時**: 「よくある失敗パターンと対策」セクションに追記する
4. **新しい設計パターンを導入した時**: 「設計原則・ベストプラクティス」に追記する
5. **CDP/DOM 構造の変更を発見した時**: 関連セクションを更新する
6. **デプロイやテストで新しい注意点を発見した時**: 該当セクションに追記する

### 参照タイミング

- **開発開始時**: 関連セクションを読んでから作業に着手する
- **バグ修正時**: 「よくある失敗パターン」を確認して同じミスを避ける
- **リファクタリング時**: 「設計原則」を確認してパターンに従う
- **デプロイ時**: 「デプロイ」セクションの注意点を確認する

---

## よくある失敗パターンと対策

### 🔴 モジュールレベル変数 vs ローカル変数の混同

- **症状**: `/cancel` しても typing indicator が止まらない
- **原因**: `setInterval` のタイマーIDをローカル変数で持っていたため、外部から停止できなかった
- **対策**: 外部からキャンセルが必要なタイマーは**モジュールレベル変数**に昇格する。`AbortController` も併用して `waitForResponse` などの非同期処理も即座にキャンセルできるようにする
- **該当コード**: `messageHandler.ts` の `typingInterval`, `progressInterval`, `currentPlanAbortController`

### 🔴 2つのキューシステムの見落とし

- **症状**: `/queue` が「実行中のタスクなし」と表示するが、実際にはPlan生成中のタスクがある
- **原因**: Anti-Crow には2つの独立したキューシステムがある:
  1. `messageHandler` のメッセージ処理パイプライン（Discord受信 → Plan生成 → 確認 → executor投入）
  2. `executor` の実行パイプライン（Plan → Antigravity実行 → 結果）
  `/queue` は (2) しか見ていなかったため、(1) にいるタスクが見えなかった
- **対策**: ステータス表示コマンドは**全パイプラインステージ**をカバーする。`ProcessingStatus` 型でフェーズを追跡し、`getMessageQueueStatus()` で統合的に返す

### 🔴 CDP パラメータのタイポ

- **症状**: `evaluateInCascade` が空オブジェクト `{}` を返す
- **原因**: `Page.createIsolatedWorld` の `grantUniversalAccess` パラメータのタイポ（`grantUniveralAccess`）。CDP は未知パラメータを**黙って無視**するため、例外が発生せずデバッグが困難
- **対策**: CDP パラメータ名は必ず公式ドキュメントと照合する。`evaluate` メソッドに生レスポンスのデバッグログを追加して異常検出を容易にする

### 🔴 VSIX インストール時の IPC 中断

- **症状**: 実行結果が Discord に届かない
- **原因**: `antigravity --install-extension` は拡張ホストを再起動するため、`waitForResponse` のポーリングが中断 → レスポンスファイルが未回収
- **対策**:
  1. デプロイ時はレスポンス書き込みを先に完了させてから VSIX インストール
  2. `recoverStaleResponses` で起動時に未回収ファイルを検出・クリーンアップ
  3. `cleanupOldFiles` で定期クリーンアップ（`activeRequests` による誤削除防止付き）

### 🔴 cascade context リセット後の DOM 操作失敗

- **症状**: `evaluateInCascade` が selectConversation 後に動作しない
- **原因**: `resetCascadeContext` が呼ばれるとコンテキストIDが無効化される
- **対策**: `conn.evaluate` をフォールバックとして追加。安定的な対話には **Escape キー送信**を最優先戦略とする（cascade context に依存しない）

### 🟡 class ベースの DOM セレクタの脆弱性

- **症状**: Antigravity UI 更新後にセレクタが機能しなくなる
- **原因**: CSS クラス名は UI フレームワークの更新で変更されやすい
- **対策**: `data-tooltip-id` など安定した属性を最優先セレクタとし、class ベースはフォールバックとして残す。利用可能な tooltip-id: `new-conversation-tooltip`, `history-tooltip`, `cascade-header-menu`, `input-send-button-send-tooltip`, `input-send-button-cancel-tooltip`

### 📋 変更影響チェックリスト（変更前に確認）

変更を始める前に以下を確認する。詳細は `regression-prevention` スキル参照。

- [ ] **Map/Set のクリア漏れ**: 追加した Map は `reset`/`cancel` 関数でもクリアされるか
- [ ] **コールバック伝搬**: パラメータ追加時、Pool・Lifecycle 等の全呼び出し元に反映したか
- [ ] **表示ロジック**: 表示値は逆算ではなく直接的な情報源（配列等）から取得しているか
- [ ] **finally ブロック**: 全エラーパスでクリーンアップが実行されるか
- [ ] **型の変更**: interface/type 変更時、全参照箇所を更新したか

### 📋 回帰テスト必須パターン

| 変更対象 | 必須テスト | 補足 |
|---------|-----------|-----|
| messageHandler | `messageHandler.test.ts` | キュー状態の整合性を確認 |
| templateStore | `templateStore.test.ts` | 変数展開・引数検出 |
| licenseChecker | `licenseChecker.test.ts` | トライアル・Pro判定 |
| fileIpc | `fileIpc.test.ts` | ファイル操作・タイムアウト |
| CDP 関連 | 実機テスト（手動） | DOM セレクタの健全性 |
| executor | `executor.test.ts` | ジョブ実行フロー |

---

## ユーザー指摘履歴

### 2026-02-20

| 指摘内容 | 根本原因 | 修正方法 |
|---|---|---|
| `/queue` が実行中タスクを表示しない | messageHandler パイプラインが executor キューから独立していた | `ProcessingStatus` 追跡を追加し `/queue` で全パイプラインを表示 |
| `/cancel` 後に typing indicator が継続 | `generatePlan()` の typing interval がローカル変数で外部キャンセル不可 | モジュールレベル変数 + `cancelPlanGeneration()` + AbortController |
| `/queue` と `/cancel` のバグを何度も指摘 | 表面的な修正（症状への対処）で根本原因に到達していなかった | 2つのキューシステムの全体像を理解した上で根本的に再設計 |
| Window Reload を Anti-Crow 自身では実行できない | Anti-Crow は拡張機能として動作しており自身を再起動できない | 手動操作または `/deploy` による代替案を案内 |

---

## 設計原則・ベストプラクティス

### アーキテクチャ

- **2段パイプライン構造**: メッセージ処理（messageHandler）→ 実行（executor）の2段構成。ステータス表示や制御は両方をカバーすること
- **スラッシュコマンドのディスパッチマップ**: `COMMAND_HANDLERS: Record<string, CommandHandler>` パターンで各コマンドを独立関数に分離
- **handleDiscordMessage の5関数分割**: 巨大な関数は意味単位で分割する

### コーディング規約

- **any 型の禁止**: `unknown` + `Record<string, unknown>` + 型ガードパターンで置換
- **外部キャンセル必要なタイマー**: モジュールレベル変数 + エクスポートされたキャンセル関数
- **DOM セレクタ戦略**: 安定属性（`data-tooltip-id`）→ class ベース → innerText の優先順

### テスト

- テストランナーは **vitest**（Jest ではない）
- `npx vitest run` で全テスト実行
- `npx tsc --noEmit` で型チェック
- 現在のテストスイート: 12 スイート（増加中）

### セキュリティ

- ソースコードを外部 AI API（Codex CLI 等）に送信しない
- テストにはオープンソースプロジェクトやダミーリポジトリを使用
- API キーはハードコードせず環境変数から取得

---

## CDP (Chrome DevTools Protocol)

### ターゲット選択

- Antigravity は複数の CDP ターゲット（`Launchpad`, メインウィンドウ等）を持つ
- **cascade フレーム**（`antigravity.agentPanel`）を含むのは `workbench.html` ターゲットのみ
- `findAntigravityTarget` は `workbench.html` を含む URL を最優先で選択する
- テスト時は全ターゲットを列挙して正しいものを特定すること

### フレーム操作

- cascade パネルは iframe 内にある → `Page.getFrameTree` でフレームツリーを走査
- `Page.createIsolatedWorld` でフレーム内に JS 実行コンテキストを作成
  - **重要**: パラメータ名は `grantUniversalAccess`（`s` を忘れない）。CDP は未知パラメータを黙って無視するため、タイポすると universal access なしで作成されてしまい、iframe DOM 操作結果が空オブジェクト `{}` になる
- `Runtime.evaluate` で DOM を直接操作・調査
- コンテキスト ID はフレーム遷移でリセットされるため、事前の有効性チェックが必要

### DOM 調査パターン

DOM 構造を調べるには:
1. CDP ポートを `cdp_ports/` フォルダから取得
2. Node.js スクリプトで `http://127.0.0.1:{port}/json` からターゲット一覧取得
3. WebSocket で接続し `Page.getFrameTree` → cascade フレーム特定
4. `Page.createIsolatedWorld` → `Runtime.evaluate` で DOM ダンプ
5. 結果を JSON ファイルに保存して分析

---

## Antigravity UI DOM 構造

### data-tooltip-id マッピング（2026-02-20 調査）

| tooltip-id | 用途 | 備考 |
|---|---|---|
| `new-conversation-tooltip` | 新規チャットボタン | |
| `history-tooltip` | 履歴ボタン | トグル動作 |
| `cascade-header-menu` | ヘッダーメニュー | |
| `input-send-button-send-tooltip` | 送信ボタン | |
| `input-send-button-cancel-tooltip` | キャンセルボタン | 生成中のみ表示 |

> **注意**: モデル切替・モード切替ボタンには `data-tooltip-id` は付与されていない。`data-headlessui-state` で管理されている。

### モデルセレクタ

**モデルボタン**（チャット入力欄の下）:
- textbox (`div[role="textbox"]`) の親を 2-5 レベル上に辿り、nextElementSibling を走査
- セレクタ: `button[class*="relative"][class*="flex"][class*="cursor-pointer"]`
- フォールバック: セレクタが合わない場合、textbox 近傍の `button` で `<p>` タグを持つものを探す
- 現在のモデル名: ボタン内の `<p>` 要素のテキスト

**ドロップダウン**（モデルボタンクリック後）:
- ルート: `div[class*="absolute"][class*="overflow-y-auto"][class*="rounded-lg"][class*="border"]`
- ヘッダー: `div[class*="opacity-80"]` (テキスト "Model")
- モデル名: `p[class*="overflow-hidden"][class*="text-ellipsis"][class*="whitespace-nowrap"]`
- クリック先: `div[class*="cursor-pointer"][class*="px-2"][class*="py-1"]`
- 選択中モデル: grandParent に `bg-gray-500/20` クラスあり

> **注意**: 2026-02-18 時点で、モデルドロップダウンも新 UI 構造に変更されている可能性あり（モードドロップダウンと同様の変更パターン）。動作しない場合は下記モードセレクタと同じ `z-50 rounded-md shadow-md` セレクタを試すこと。

**2026-02 時点の利用可能モデル例** (7件):
- Gemini 3 Pro (High) / Gemini 3 Pro (Low) / Gemini 3 Flash
- Claude Sonnet 4.5 / Claude Sonnet 4.5 (Thinking)
- Claude Opus 4.6 (Thinking)
- GPT-OSS 120B (Medium)

**evaluateInCascade が空オブジェクト `{}` を返す問題の修正**:
- 根本原因: `Page.createIsolatedWorld` の `grantUniversalAccess` パラメータのタイポ（`grantUniveralAccess` → `grantUniversalAccess`）
- CDP は未知パラメータを**黙って無視**するため、IsolatedWorld は作成されるが universal access なし → iframe 内の DOM 操作結果が空になる
- 例外は発生せず `evaluate` は正常に返るが value が `undefined` になるため、デバッグが困難
- 対策: `evaluate` メソッドに生レスポンスのデバッグログ（`type`, `subtype`, `hasValue`）を追加して異常を検出しやすくした

### モードセレクタ

**モードボタン**（チャット入力欄の下、モデルボタンの左隣）:
- textbox の親を 2-5 レベル上に辿り、兄弟要素から button を探す
- ~~モードボタン/モデルボタンともに `<p>` タグでテキスト表示~~ → **2026-02-18 UI 変更で `<span>` に変更**
- **現行構造**: モードボタンは `<span>` タグ、モデルボタンは `<p>` タグでテキスト表示
- 識別方法: `<p>` を持つボタン（モデル）の手前にある `<span>` を持つボタンがモード
- 現在のモード名: ボタン内の `<span>` 要素のテキスト（フォールバック: `<p>` → `innerText`）

**ドロップダウン**（モードボタンクリック後）:
- ~~旧ルート: `div[class*="absolute"][class*="overflow-y-auto"][class*="rounded-lg"][class*="border"]`~~
- ~~旧ヘッダー: `div[class*="opacity-80"]` (テキスト "Mode")~~
- ~~旧モード名: `p[class*="overflow-hidden"][class*="text-ellipsis"]`~~
- **2026-02-18 新構造**:
  - ルート: `div[class*="z-50"][class*="rounded-md"][class*="border"][class*="shadow-md"]`
  - ヘッダー: なし（ヘッダーレス）
  - モード名: `div[class*="font-medium"]` のテキスト
  - クリック先: `div[class*="cursor-pointer"][class*="px-2"][class*="py-1"]`
  - 選択中モード: 親要素に `bg-gray-500/20` クラスあり
- **コード対応**: `cdpModes.ts` で新セレクタを優先使用し、旧セレクタをフォールバックとして残してある

**2026-02-18 時点の利用可能モード** (2件):
- Planning / Fast

**UI 変更時の調査パターン**:
1. CDP 経由で cascade コンテキストに接続
2. ボタンをクリックしてドロップダウンを開く
3. `font-medium`, `cursor-pointer`, `z-50` 等のクラスで要素を検索
4. innerHTML / className / 親子関係をJSON出力して分析
5. Antigravity UI 更新時はボタンのテキストタグ（`<p>` vs `<span>`）とドロップダウンのコンテナクラスの両方を確認すること

### チャットエリア

- textbox: `div[role="textbox"]`
- 送信ボタン: textbox の兄弟/近傍にある `button` 要素
- 履歴ボタン: 左サイドバー内

### 2026-02-23 以降の DOM 構造の変化（Shadow DOM 対応）

- **背景**: VSCode や Antigravity のアップデートにより、ダイアログなどで `<vscode-button>` などの Web コンポーネント展開や Shadow DOM が多用されるようになった。
- **問題点**: 単純な `document.querySelector` や `document.querySelectorAll` では、Shadow DOM 内部の要素（例: `scrollToBottom` 時の `.overflow-y-auto` コンテナや `<vscode-button>` の内部テキストなど）を発見できない。
- **対策 (findInTree の導入)**:
  - `el.shadowRoot` を再帰的に走査して目的の要素やテキストを抽出する独自の探索関数 (`findInTree` などのロジック) を導入する必要がある。
  - `AutoClick` や DOM 操作機能においては、対象タグの探索に `<vscode-button>` を明示的に含めるか、あるいは `tag: 'button'` のような厳しい制約を外し、柔軟な**テキストベースの抽出に寄せる**ことで構造変化に強くする。

---

## IPC 通信

### ファイルベース IPC の仕組み

- Anti-Crow が `tmp_prompt_*.json` をIPCディレクトリに書き込む
- Antigravity（エージェント）がファイルを読み取り、処理後に `*_response.json` / `*_response.md` を書き込む
- `fileIpc.waitForResponse` がポーリング + `fs.watch` でレスポンスファイルを検出

### レスポンス未達問題と4対策

1. **recoverStaleResponses**: 起動時に未回収レスポンス検出 → ログ → 削除
2. **デプロイスキル注意書き**: VSIX インストール前にレスポンス書き込みを完了させる
3. **cleanupOldFiles**: 5分定期実行、`activeRequests` による誤削除防止、response 閾値10分
4. **waitForResponse タイムアウト時**: `logWarn` でメトリクス出力

### AbortSignal 対応

- `waitForResponse` は `AbortSignal` パラメータを受け付ける
- Plan 生成のキャンセル時に `AbortController.abort()` で即座にポーリングを中断できる

---

## キュー・キャンセル処理

### 2段パイプライン構成

```
Discord メッセージ
    ↓
[messageHandler パイプライン]
    ├── connecting       （CDP接続中）
    ├── plan_generating  （Plan生成中 = Antigravity に IPC 送信して応答待ち）
    ├── confirming       （ユーザー承認待ち）
    └── dispatching      （executor へ投入中）
    ↓
[executor パイプライン]
    ├── currentJob       （実行中ジョブ）
    └── queue            （待機中ジョブ）
    ↓
結果を Discord に送信
```

### `/queue` コマンドの表示

- `getMessageQueueStatus()` → messageHandler パイプラインの状態
  - `processing`: 各フェーズの `ProcessingStatus[]`（phase, startTime, messagePreview）
  - `total`: キュー内の総メッセージ数
  - `perWorkspace`: ワークスペースごとのカウント
- `executor.getQueueInfo()` → executor パイプラインの状態
  - `current`: 現在実行中のジョブ（plan + startTime）
  - `pending`: 待機中のプラン配列

### `/cancel` コマンドの処理

キャンセル時に停止すべきもの:
1. `resetProcessingFlag()` → messageHandler のフラグリセット
2. `cancelPlanGeneration()` → Plan 生成中の typing/progress interval + AbortController
3. `executor.forceStop()` → executor のジョブ停止 + typing interval
4. `executorPool.forceStopAll()` → プール内の全 executor 停止
5. `cdp.clickCancelButton()` → Antigravity UI のキャンセルボタンクリック

---

## デプロイ

### フロー

1. `npm run compile` — TypeScript → JavaScript
2. `npm run bundle` — esbuild バンドル
3. `npx -y @vscode/vsce package ...` — VSIX パッケージ作成
4. `antigravity --install-extension anti-crow-0.1.0.vsix --force` — インストール
5. Antigravity 再起動（Developer: Reload Window）

### 注意点

- **複合コマンド非推奨**: `&&` で全ステップをつなぐと `antigravity --install-extension` が失敗することがある → **分割実行が安全**
- vsce package 前の prepublish スクリプトで typecheck + bundle が再実行される → 事前の compile/bundle は冗長だが安全マージンとして有効
- `--no-dependencies` で npm install スキップ（バンドル済みのため）
- **VSIX インストールは拡張ホストを再起動する** → IPC レスポンスが中断される可能性あり

---

## Discord.js

### ボタン制約

- `customId` は **100文字以内**
- 1つの `ActionRow` に最大 **5 ボタン**
- 1つのメッセージに最大 **5 ActionRow**
- ボタンラベルは **80文字以内**

### Embed 制約

- `description` は **4096文字以内**
- `field.value` は **1024文字以内**
- 合計 **6000文字以内**
- フィールド数 **25個以内**

### パターン

- `deferReply()` → 長時間処理 → `editReply()` で応答
- `deferUpdate()` → ボタン押下応答 → `editReply()` で更新
- `followUp({ ephemeral: true })` でエラーを本人のみに表示

---

## テスト・デバッグ

### ファイル消失問題

- `write_to_file` 後にファイルが消えることがある
- 対策: ファイル作成後に `find_by_name` や `view_file` で存在確認を推奨

### CDP 接続デバッグ

- CDP ポートは再起動のたびに変わる → `cdp_ports/port_{pid}.txt` から取得
- ターゲットの切り替え: PID 変更時に古いポートファイルが残ることがある
- テスト用スクリプトは `scripts/` に作成し、作業完了後に削除

### テスト実行

- `npx vitest run` — vitest で全テスト実行（現在 12 スイート）
- テストは `src/__tests__/` 配下
- 新機能追加時は対応するテストも作成する
- **Jest ではなく vitest を使うこと**（`npm test` / `npx jest` は使わない）

---

## 追記ガイド

新しい学びを追加する際:
1. 該当するセクションがあれば、そのセクション内に追記
2. 新しいカテゴリの場合は `---` 区切りで新セクションを作成
3. 具体的なセレクタやコマンドは**コードブロック**で記載
4. 「なぜそうなるか」の背景や理由も可能な限り記載
5. **失敗パターン**は 🔴（重大）/ 🟡（注意）で分類し、症状・原因・対策を明記
6. **ユーザー指摘履歴**は表形式で記録する
