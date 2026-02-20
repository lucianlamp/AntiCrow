# AntiCrow 改善計画

**作成日**: 2026-02-20
**ベース**: `docs/code-review-report.md` / `docs/security-audit-report.md`
**全体期間**: 約 3〜4 週間（フェーズ並行実施で短縮可能）

---

## 概要

コードレビューおよびセキュリティ監査の結果を受け、以下の5フェーズで段階的に品質を改善する。各フェーズは優先度順に並べており、フェーズ1・2は並行着手可能。

| フェーズ | 内容 | 優先度 | 想定工数 |
|---|---|---|---|
| 1 | テストカバレッジ拡充 | 🔴 High | 5〜7 日 |
| 2 | 型安全性の強化 | 🟡 Medium | 1 日 |
| 3 | コード構造の改善 | 🟡 Medium | 3〜5 日 |
| 4 | セキュリティ強化 | 🟢 Low | 1 日 |
| 5 | 開発基盤の改善 | 🟢 Low | 2〜3 日 |

---

## フェーズ1: テストカバレッジ拡充 🔴

### 現状
- テストファイル: 12 / ソースファイル: 51（約 24%）
- テストフレームワーク: Vitest
- 既存テスト: `botLock`, `configHelper`, `discordUtils`, `errors`, `fileIpc`, `logger`, `mdToJson`, `memoryStore`, `planParser`, `promptBuilder`, `scheduler`, `templateStore`

### 目標
- テストカバレッジ 50% 以上（重要モジュールは 80% 以上）
- すべてのコアモジュールにテストを配置

### 追加テスト計画

#### 1.1 `executor.test.ts`（優先度: 最高）
対象: `executor.ts`（754行）— コア実行エンジン

| テストケース | 概要 |
|---|---|
| `enqueue` 直列実行 | 複数ジョブのキューイングと直列処理の検証 |
| `enqueueImmediate` | 即時実行ヘルパーの動作確認 |
| `processQueue` 正常系 | ジョブの正常実行フロー |
| `processQueue` エラー系 | ジョブ失敗時のエラーハンドリング |
| リトライ動作 | `maxRetries > 0` 時の再実行 |
| タイムアウト | `timeoutMs` 超過時の振る舞い |
| 重複実行防止 | `recentExecutionIds` による重複チェック |
| `forceReset` | 実行状態のクリア |
| `forceStop` | 実行中ジョブの停止 |
| `cancelJob` | キューからのジョブ削除 |
| `getQueueInfo` | キュー情報の取得 |
| `recordExecution` | 実行履歴の記録 |

**モック**: `CdpBridge`, `FileIpc`, `PlanStore`, `NotifyFunc`, `SendTypingFunc`

#### 1.2 `messageHandler.test.ts`（優先度: 最高）
対象: `messageHandler.ts`（528行）— メッセージルーティング

| テストケース | 概要 |
|---|---|
| メッセージ重複排除 | 同一メッセージ ID の二重処理防止 |
| ワークスペース別キュー | 異なるワークスペースの並列処理 |
| 同一ワークスペース直列化 | 同じワークスペース内の直列処理 |
| `resetProcessingFlag` | キューリセット |
| `getMessageQueueStatus` | ステータス取得 |
| 計画生成フロー | `plan_generation` タスクの処理 |
| 実行フロー | `execution` タスクの処理 |
| ユーザー権限チェック | 未許可ユーザーの拒否 |

**モック**: `BridgeContext`, Discord `Message`

#### 1.3 `cdpPool.test.ts`（優先度: 高）
対象: `cdpPool.ts`（430行）— プール管理

| テストケース | 概要 |
|---|---|
| `acquire` 新規作成 | 未知ワークスペースの新規接続 |
| `acquire` 既存返却 | 既存エントリの再利用 |
| `acquire` 排他制御 | 同時呼び出しの直列化 |
| `get` / `getDefault` | プール検索 |
| `releaseIdle` | アイドル接続の開放 |
| `disconnectAll` | 全接続切断 |
| ポートファイル再読取 | `getFreshPorts` 動作 |
| `learnFolderPath` | ワークスペースパスの自動学習 |

**モック**: `CdpBridge`, `WorkspaceStore`

#### 1.4 `accessControl.test.ts`（優先度: 高）
対象: `accessControl.ts`（27行）— セキュリティ上重要

| テストケース | 概要 |
|---|---|
| 開発者 ID 判定 | 登録済み ID → `true` |
| 非開発者 ID 判定 | 未登録 ID → `false` |
| 空文字列 | エッジケース |

#### 1.5 `discordBot.test.ts`（優先度: 中）
対象: `discordBot.ts`（445行）

| テストケース | 概要 |
|---|---|
| `mapCommandToIntent` | コマンド名 → intent マッピング |
| `sendToTextChannel` | 長文メッセージの分割 |
| `workspaceCategoryName` | カテゴリー名生成 |
| `extractWorkspaceFromCategoryName` | カテゴリー名からの抽出 |

#### 1.6 `embedHelper.test.ts`（優先度: 中）
対象: `embedHelper.ts`（2,813バイト）

| テストケース | 概要 |
|---|---|
| `buildEmbed` | Embed 生成 |
| `normalizeHeadings` | ヘディングの正規化（`####` → `###`） |

### 想定工数
- 5〜7 日（テストの複雑さに依存）
- フェーズ2と並行着手可能

### 依存関係
- なし（既存コードへの変更なし）

### リスクと軽減策
- **リスク**: モック対象の内部 API が変更される可能性
- **軽減策**: テスト用ヘルパー/ファクトリをテストユーティリティに集約

### 完了条件
- [ ] 上記テストファイルがすべて作成されている
- [ ] `npm test` がすべてパスする
- [ ] コアモジュール（executor, messageHandler, cdpPool）のカバレッジ 80% 以上

---

## フェーズ2: 型安全性の強化 🟡

### 対象: `any` 型 6 件

#### 2.1 `quotaProvider.ts` — `parseQuotaResponse`（356行目）

**現状**:
```typescript
function parseQuotaResponse(response: any): QuotaData {
```

**修正計画**:
```typescript
function parseQuotaResponse(response: unknown): QuotaData {
    if (!response || typeof response !== 'object') {
        return createDefaultQuotaData();
    }
    const res = response as Record<string, unknown>;
    // ... 既存ロジックに型ガードを追加
}
```

**影響範囲**: `callGetUserStatus` の戻り値型も `Promise<unknown>` に変更

#### 2.2 `quotaProvider.ts` — `sortModels`（434行目）

**現状**:
```typescript
function sortModels(models: ModelQuota[], modelSorts: any[]): void {
```

**修正計画**:
```typescript
interface ModelSortEntry {
    name: string;
    priority: number;
}
function sortModels(models: ModelQuota[], modelSorts: ModelSortEntry[]): void {
```

**影響範囲**: `parseQuotaResponse` 内の呼び出し元のみ

#### 2.3 `cdpModes.ts` — `findDebug` / `debug`（188行目、280行目）

**現状**:
```typescript
type OpenResult = { success: boolean; currentMode?: string; error?: string; findDebug?: any };
const listResult = ... as { items: string[]; debug: any } | string[];
```

**修正計画**:
```typescript
type OpenResult = { success: boolean; currentMode?: string; error?: string; findDebug?: Record<string, unknown> };
const listResult = ... as { items: string[]; debug: Record<string, unknown> } | string[];
```

**影響範囲**: ローカル・デバッグ用途のみ。外部 API なし

#### 2.4 `cdpModels.ts` — `findDebug` / `debug`（155行目、246行目）

`cdpModes.ts` と同一パターン。同様に `Record<string, unknown>` に変更。

### 想定工数
- 1 日

### 依存関係
- なし（フェーズ1と並行可能）

### リスクと軽減策
- **リスク**: `unknown` への変更で既存コードがコンパイルエラーになる可能性
- **軽減策**: 各変更後に `npm run typecheck` を実行して確認

### 完了条件
- [ ] `any` 型の使用が 0 件
- [ ] `npm run typecheck` がエラーなし
- [ ] `npm test` がすべてパス

---

## フェーズ3: コード構造の改善 🟡

### 3.1 `executor.ts` の UI ウォッチャー分離

**現状**: `executor.ts`（754行）内に `startUIWatcher`（682-743行）が含まれている

**修正計画**:
1. `src/uiWatcher.ts` を新規作成
2. `AutoClickRule` インターフェースと `DEFAULT_AUTO_CLICK_RULES` を移動
3. `startUIWatcher` / `stopUIWatcher` メソッドのロジックを `UIWatcher` クラスに抽出
4. `Executor` クラスから `UIWatcher` を利用する形にリファクタリング

**影響ファイル**: `executor.ts`, `bridgeLifecycle.ts`（UIウォッチャー起動部分）

### 3.2 `messageHandler.ts` の `handleDiscordMessage` 分割

**現状**: `handleDiscordMessage`（145-527行、約380行）が1関数に集約

**修正計画**:
1. 計画生成フロー（plan_generation）を `handlePlanGeneration` に抽出
2. 実行フロー（execution）を `handleExecution` に抽出
3. 確認フロー（confirmation）を `handleConfirmation` に抽出
4. ワークスペース解決を `resolveAndAcquire` に集約

**影響ファイル**: `messageHandler.ts` のみ（内部リファクタリング）

### 3.3 `adminHandler.ts` の機能別分割

**現状**: `handleManageSlash`（31-356行、325行）が1関数にすべてのスラッシュコマンドを処理

**修正計画**:
1. コマンド種別ごとにハンドラ関数を抽出:
   - `handleStatusCommand` — `/status`
   - `handleLogsCommand` — `/logs`
   - `handleQuotaCommand` — `/quota`
   - `handleQueueCommand` — `/queue`
   - `handleSchedulesCommand` — `/schedules`
   - `handleResetCommand` — `/reset`
   - `handleHelpCommand` — `/help`
   - `handleTemplateCommand` — `/template`
2. `handleManageSlash` を switch/dispatch パターンに簡素化

**影響ファイル**: `adminHandler.ts` のみ

### 想定工数
- 3〜5 日

### 依存関係
- フェーズ1のテストが先に完了していると安全（リファクタリング時の回帰テスト）
- ただし並行着手も可能（テストが不十分な部分は手動確認）

### リスクと軽減策
- **リスク**: リファクタリング中に機能の回帰バグ
- **軽減策**: 各分割後に `npm run typecheck && npm test` を実行。可能であればフェーズ1のテストを先に作成

### 完了条件
- [ ] `executor.ts` が 600 行以下
- [ ] `handleDiscordMessage` が 150 行以下
- [ ] `handleManageSlash` が 50 行以下
- [ ] `npm run typecheck` がエラーなし
- [ ] `npm test` がすべてパス
- [ ] 手動テスト: Discord からの基本フロー（メッセージ送信→計画生成→承認→実行→結果通知）が正常動作

---

## フェーズ4: セキュリティ強化 🟢

### 4.1 `npm audit` の定期実行

**計画**:
- GitHub Actions ワークフロー（`.github/workflows/security.yml`）を作成
- 週次で `npm audit` を実行し、脆弱性があればアラート
- 将来的に `dependabot.yml` も検討

### 4.2 `package.json` の description 見直し

**現状**: `"Discord→Antigravity自動操作ブリッジ。自然文で依頼→定期/即時実行→結果通知。"`

**修正案**: `"Discord連携で自然文からタスクを実行・通知。定期実行・即時実行対応。"`
- 「Antigravity」「自動操作」「ブリッジ」を削除し、より抽象的な表現に

### 4.3 セキュリティポリシーの定期レビュー

**計画**:
- 3ヶ月ごとに `.agent/skills/security-policy/SKILL.md` をレビュー
- 新機能追加時にポリシーとの整合性を確認するチェックリストを PR テンプレートに追加

### 想定工数
- 1 日

### 依存関係
- なし（独立して実施可能）

### リスクと軽減策
- **リスク**: description の変更が Marketplace 表示に影響
- **軽減策**: 変更前後で VSIX パッケージのメタデータを確認

### 完了条件
- [ ] `npm audit` が CI で実行されている
- [ ] `package.json` の description が更新されている
- [ ] セキュリティレビューのプロセスが文書化されている

---

## フェーズ5: 開発基盤の改善 🟢

### 5.1 CI/CD パイプラインの構築

**計画**:
- GitHub Actions ワークフロー（`.github/workflows/ci.yml`）を作成:
  - `npm run typecheck` — 型チェック
  - `npm test` — テスト実行
  - `npm run bundle` — ビルド確認
- PR マージ時に自動実行
- ブランチ保護ルールの設定（CI パス必須）

### 5.2 コードレビューの定期化

**計画**:
- 四半期ごとの全体コードレビューを実施
- レビューレポートを `docs/` に蓄積
- 改善計画の進捗を tracking

### 想定工数
- 2〜3 日

### 依存関係
- GitHub リポジトリの設定が必要
- フェーズ1のテストがあると CI の効果が高い

### リスクと軽減策
- **リスク**: CI の設定ミスで開発フローがブロック
- **軽減策**: 最初は required: false で導入し、安定してから必須化

### 完了条件
- [ ] CI が PR の push で自動実行される
- [ ] typecheck + test + build がすべて CI 上でパスする
- [ ] ブランチ保護ルールが設定されている

---

## 実施スケジュール

```
Week 1: フェーズ1（テスト作成前半）+ フェーズ2（any型除去）
Week 2: フェーズ1（テスト作成後半）+ フェーズ3（リファクタリング開始）
Week 3: フェーズ3（リファクタリング完了）+ フェーズ4（セキュリティ）
Week 4: フェーズ5（CI/CD）+ 全体テスト・検証
```

### 並行実施可能なフェーズ

```
フェーズ1 ─────────────────────────────────> (5-7日)
フェーズ2 ───> (1日)
                    フェーズ3 ──────────────> (3-5日)
                              フェーズ4 ──> (1日)
                                    フェーズ5 ──────> (2-3日)
```

---

## セキュリティポリシー準拠確認

この改善計画の全内容がセキュリティポリシー（`.agent/skills/security-policy/SKILL.md`）に準拠していることを確認済み:
- ✅ 内部実装の詳細（プロトコル名、ポート番号等）を外部ドキュメントに露出していない
- ✅ `package.json` の description 修正案はセキュリティポリシーに準拠
- ✅ リファクタリング計画がセキュリティ設定（minify, sourcemap, .vscodeignore）に影響しない
