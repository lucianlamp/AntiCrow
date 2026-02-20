# AntiCrow コードレビューレポート

**レビュー日**: 2026-02-20
**対象バージョン**: 0.1.0
**レビュー範囲**: `src/` 配下 51 ファイル + テスト 12 ファイル

---

## エグゼクティブサマリー

AntiCrow は全体的に **高品質なコードベース** を持つ VS Code 拡張機能です。TypeScript の `strict` モードが有効化されており、一貫した設計パターンとモジュール分割が実現されています。エラーハンドリングは充実しており、専用のカスタムエラー階層（`errors.ts`）を持ち、ほぼすべてのモジュールで適切な try-catch が実装されています。ログ出力は専用の `logger.ts` を通じた一元管理がなされ、`console.log` の直接使用はゼロです。

主な改善点はテストカバレッジの拡充（現在約 24%）と、少数の `any` 型使用の解消です。

---

## 詳細評価

### 1. コード品質: 可読性・保守性・命名規則

**評価: Good ✅**

- **ファイルヘッダー**: すべてのファイルに責務を説明するヘッダーコメントが記載されており、保守性が高い
- **命名規則**: camelCase（変数・関数）、PascalCase（型・クラス・インターフェース）が一貫して使用
- **定数管理**: マジックナンバーは名前付き定数として抽出（`UI_WATCHER_INTERVAL_MS`、`RETRY_DELAY_MS` 等）
- **JSDoc**: 公開 API には JSDoc コメントが付与されている

**改善提案**:
- `executor.ts`（754行）と `cdpBridge.ts`（784行）が大きい。機能単位でのさらなる分割を検討
  - `executor.ts`: UI ウォッチャー関連（682-743行）を `uiWatcher.ts` に分離
  - `cdpBridge.ts`: ポート検索・起動ロジック（191-248行）を独立ユーティリティに

---

### 2. アーキテクチャ: モジュール分割・責務の分離

**評価: Good ✅**

- **責務分離が明確**: Discord Bot (`discordBot.ts`) → メッセージハンドラ (`messageHandler.ts`) → エグゼキュータ (`executor.ts`) → ファイル IPC (`fileIpc.ts`) のパイプラインが明瞭
- **CDP 関連の適切な分割**:
  - `cdpConnection.ts`: 低レベル WebSocket 通信
  - `cdpBridge.ts`: 高レベル操作 API
  - `cdpPool.ts`: ワークスペース毎のプール管理
  - `cdpTargets.ts`: ターゲット探索
  - `cdpUI.ts` / `cdpHistory.ts` / `cdpModels.ts` / `cdpModes.ts`: 機能別ヘルパー
- **設定の一元管理**: `configHelper.ts` で全設定値を集約
- **ライセンスモジュール**: `licensing/` ディレクトリで独立管理（5 ファイル構成）
- **BridgeContext パターン**: `bridgeContext.ts` で依存注入的な設計を実現

**改善提案**:
- `messageHandler.ts`（528行）の `handleDiscordMessage` 関数（145-527行、約380行）が長大。計画生成フローと実行フローの分岐を個別関数に抽出すると可読性向上
- `adminHandler.ts`（17,578バイト）も機能ごとの分割を検討

---

### 3. エラーハンドリング

**評価: Good ✅**

- **カスタムエラー階層**: `errors.ts` に `BridgeError` を基底とした6つの専用エラークラスを定義
  - `CdpConnectionError`, `CdpCommandError`, `CdpTargetNotFoundError`, `AntigravityLaunchError`, `CascadePanelError`, `IpcTimeoutError`
- **try-catch の網羅性**: 40以上のファイルで catch 句が使用されており、エラーが適切にハンドリングされている
- **リトライメカニズム**: `executor.ts` で設定可能なリトライ回数（`maxRetries`）とリトライ遅延を実装
- **Discord 通知との連携**: エラー発生時に Discord チャンネルへの通知が `safeNotify` で安全に実行

**改善提案**:
- `catch (e)` のような型付けなし catch が一部存在。`catch (e: unknown)` を明示し、`instanceof` チェックのパターンをより統一的に適用すると良い

---

### 4. TypeScript 型安全性

**評価: Good ✅（軽微な改善点あり）**

- **strict モード有効**: `tsconfig.json` で `"strict": true` が設定済み
- **型定義**: `types.ts` で主要な型（`Plan`, `PlanOutput`, `ExecutionJob`, `ProgressUpdate`, `ClickOptions`, `ClickResult` 等）を一元定義
- **Union 型の活用**: `ChannelIntent`, `ChoiceMode`, `PlanStatus`, `PlanTarget` で厳密な型制約

**`any` 型の使用箇所（6件）**:

| ファイル | 行 | 内容 | リスク |
|---|---|---|---|
| `quotaProvider.ts` | 356 | `parseQuotaResponse(response: any)` | Medium |
| `quotaProvider.ts` | 434 | `sortModels(models, modelSorts: any[])` | Low |
| `cdpModes.ts` | 188 | `findDebug?: any` | Low |
| `cdpModes.ts` | 280 | `debug: any` | Low |
| `cdpModels.ts` | 155 | `findDebug?: any` | Low |
| `cdpModels.ts` | 246 | `debug: any` | Low |

**改善提案**:
- `quotaProvider.ts` の `parseQuotaResponse`: 入力型を `unknown` に変更し、型ガードで検証
- `cdpModes.ts` / `cdpModels.ts` の `findDebug` / `debug`: `Record<string, unknown>` に変更

---

### 5. パフォーマンス

**評価: Good ✅**

- **ポーリングの適切な間隔設定**: UIウォッチャー 1秒、進捗監視 3秒、IPC 監視 1秒
- **排他制御**: `cdpPool.ts` で Promise チェーンによる排他制御を実装し、同一ワークスペースへの並行 acquire を防止
- **重複防止**: `messageHandler.ts` でメッセージID重複チェック（5分TTL）を実装
- **esbuild**: `treeShaking: true` でデッドコード除去が有効
- **アイドル接続の開放**: `CdpPool.releaseIdle()` で未使用接続を自動開放

**改善提案**:
- `bridgeLifecycle.ts` の `startBridge` に再入防止フラグ（`bridgeStarting`）があるが、Promise ベースのロックに統一すると堅牢性が向上
- `fileIpc.ts` のポーリング方式（`fs.watch` は Windows で不安定であるため採用）は現時点で妥当な選択

---

### 6. テストカバレッジ

**評価: Needs Improvement ⚠️**

- **テストファイル数**: 12 ファイル / 51 ソースファイル（約 24%）
- **テストフレームワーク**: Vitest を使用

**テストが存在するモジュール**:
| テストファイル | 対象モジュール |
|---|---|
| `botLock.test.ts` | `botLock.ts` |
| `configHelper.test.ts` | `configHelper.ts` |
| `discordUtils.test.ts` | `discordUtils.ts` |
| `errors.test.ts` | `errors.ts` |
| `fileIpc.test.ts` | `fileIpc.ts` |
| `logger.test.ts` | `logger.ts` |
| `mdToJson.test.ts` | `mdToJson.ts` |
| `memoryStore.test.ts` | `memoryStore.ts` |
| `planParser.test.ts` | `planParser.ts` |
| `promptBuilder.test.ts` | `promptBuilder.ts` |
| `scheduler.test.ts` | `scheduler.ts` |
| `templateStore.test.ts` | `templateStore.ts` |

**テストが不足している重要モジュール（優先度順）**:
1. **`executor.ts`** — コア実行エンジン（754行）。キュー処理・リトライ・タイムアウトのテストが必要
2. **`messageHandler.ts`** — メッセージルーティング（528行）。重複防止・ワークスペース分岐のテストが必要
3. **`cdpPool.ts`** — プール管理（430行）。排他制御・アイドル開放のテストが必要
4. **`discordBot.ts`** — Bot ライフサイクル（445行）
5. **`accessControl.ts`** — 権限判定（シンプルだがセキュリティ上重要）
6. **`embedHelper.ts`** — Discord Embed 生成
7. **`discordFormatter.ts`** — メッセージフォーマット

---

## 優先度付きアクションアイテム

| 優先度 | アクション | 対象ファイル |
|---|---|---|
| 🔴 High | テスト追加: `executor.ts` のキュー処理・リトライロジック | `executor.ts` |
| 🔴 High | テスト追加: `messageHandler.ts` の重複防止・ルーティング | `messageHandler.ts` |
| 🟡 Medium | `any` 型を `unknown` + 型ガードに置換 | `quotaProvider.ts` |
| 🟡 Medium | テスト追加: `cdpPool.ts` の排他制御 | `cdpPool.ts` |
| 🟡 Medium | `handleDiscordMessage` の長大関数を分割 | `messageHandler.ts` |
| 🟢 Low | `executor.ts` の UI ウォッチャーを別ファイルに分離 | `executor.ts` |
| 🟢 Low | `cdpModes.ts` / `cdpModels.ts` の `any` 型除去 | `cdpModes.ts`, `cdpModels.ts` |
| 🟢 Low | テスト追加: `accessControl.ts` | `accessControl.ts` |
