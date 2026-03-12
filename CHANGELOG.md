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

### 変更ファイル

- `package.json` — autoAccept 設定削除、autoAcceptEnhanced のデフォルト変更
- `src/extension.ts` — トグルコマンド・リスナーを autoAcceptEnhanced に統合
- `src/bridgeLifecycle.ts` — UIWatcher 起動条件を autoAcceptEnhanced に統合
- `src/uiWatcher.ts` — 2段チェック → 1段チェックに統合
- `src/cdpUI.ts` — DOM フォールバック削除
- `src/licensing/licenseGate.ts` — フィーチャー名変更
- `src/adminHandler.ts` — Pro 機能一覧を更新
- `src/i18n/en.ts` — 翻訳キー整理
- `src/i18n/ja.ts` — 翻訳キー整理
