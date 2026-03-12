# Changelog

## [0.1.1] - 2026-03-12

### ⚠️ 破壊的変更

- `antiCrow.autoAccept` 設定を**廃止**。`antiCrow.autoAcceptEnhanced` に統合
- `autoAcceptEnhanced` のデフォルトを `false` に変更（pesosz/antigravity-auto-accept のみ使用がデフォルト）
- 既存ユーザーが AntiCrow の拡張 Auto Accept 機能を使いたい場合は、手動で `autoAcceptEnhanced: true` に設定する必要がある

### 変更

- Auto Accept 機能の DOM フォールバック（TreeWalker + Shadow DOM 再帰探索）を削除し、pesosz/antigravity-auto-accept に委譲
- `antiCrow.autoAcceptEnhanced` を `true` にすると、pesosz と併用しつつ AntiCrow 独自の追加機能が有効:
  - VSCode コマンド承認（4種）
  - 自動スクロール
  - UI セクション展開
  - 権限ダイアログ処理
- `cdpUI.ts` から約220行の DOM コードを削減
- Pro 機能一覧の表示名を「拡張自動承認（pesosz 併用モード）」に更新
- `licenseGate.ts` の PRO_ONLY_FEATURES を `autoAcceptEnhanced` に変更

### 削除

- **UIWatcher 機能の完全削除**: `src/uiWatcher.ts` を削除し、`executor.ts`, `executorPool.ts`, `bridgeLifecycle.ts` から UIWatcher 関連コードを除去
- **`antiCrow.autoAcceptEnhanced` 設定の完全削除**: `package.json` の設定定義、`extension.ts`/`bridgeContext.ts` の未使用タイマー、ドキュメント9ファイル（README.md, getting-started.md 日英, pricing.md 日英, pro-plan.md 日英, security.md 日英）から全痕跡を撤去
- **`out/` ディレクトリのビルド残留物クリーンアップ**: ソースが削除済みの古いビルド成果物（`uiWatcher`, `autoModeHistory`, `cdpHistory`, `historyButtons`, `slashButtonHistory`, `licenseWebview.test`）を削除

### 変更ファイル

- `package.json` — autoAccept 設定削除、autoAcceptEnhanced 設定定義の完全削除
- `src/extension.ts` — トグルコマンド・リスナーを統合、autoAcceptWatcherTimer 除去
- `src/bridgeLifecycle.ts` — UIWatcher 起動条件を除去
- `src/bridgeContext.ts` — autoAcceptWatcherTimer 除去
- `src/executor.ts` — UIWatcher 管理メソッド削除
- `src/executorPool.ts` — UIWatcher 管理プロパティ・メソッド削除
- `src/cdpUI.ts` — DOM フォールバック削除
- `src/licensing/licenseGate.ts` — フィーチャー名変更
- `src/adminHandler.ts` — Pro 機能一覧を更新
- `src/i18n/en.ts` — 翻訳キー整理
- `src/i18n/ja.ts` — 翻訳キー整理
- `README.md` — autoAcceptEnhanced 記載削除
- `docs/ja/getting-started.md`, `docs/en/getting-started.md` — 設定説明削除
- `docs/ja/pricing.md`, `docs/en/pricing.md` — 料金表から削除
- `docs/ja/pro-plan.md`, `docs/en/pro-plan.md` — 比較表から削除
