# Changelog

## [0.1.1] - 2026-03-12

### ⚠️ Breaking Changes

- Deprecated `antiCrow.autoAccept` setting. Merged into `antiCrow.autoAcceptEnhanced`
- Changed `autoAcceptEnhanced` default to `false` (only pesosz/antigravity-auto-accept is used by default)
- Existing users who want to use AntiCrow's extended Auto Accept feature must manually set `autoAcceptEnhanced: true`

### Changes

- Removed Auto Accept DOM fallback (TreeWalker + Shadow DOM recursive traversal) from `cdpUI.ts`, delegating to pesosz/antigravity-auto-accept
- When `antiCrow.autoAcceptEnhanced` is set to `true`, the following AntiCrow-specific features are enabled alongside pesosz:
  - VSCode command approval (4 types)
  - Auto scroll
  - UI section expansion
  - Permission dialog handling
- Reduced ~220 lines of DOM code from `cdpUI.ts`
- Updated Pro feature display name to "Extended Auto Accept (pesosz co-op mode)"
- Changed `licenseGate.ts` PRO_ONLY_FEATURES to `autoAcceptEnhanced`

### Removed

- **Complete removal of UIWatcher**: Deleted `src/uiWatcher.ts` and removed all UIWatcher-related code from `executor.ts`, `executorPool.ts`, and `bridgeLifecycle.ts`
- **Complete removal of `antiCrow.autoAcceptEnhanced` setting**: Removed all traces from `package.json` settings definition, unused timers in `extension.ts`/`bridgeContext.ts`, and 9 documentation files (README.md, getting-started.md EN/JA, pricing.md EN/JA, pro-plan.md EN/JA, security.md EN/JA)
- **Cleanup of stale build artifacts in `out/` directory**: Removed old build outputs for deleted sources (`uiWatcher`, `autoModeHistory`, `cdpHistory`, `historyButtons`, `slashButtonHistory`, `licenseWebview.test`)

### Changed Files

- `package.json` — Removed autoAccept setting, completely removed autoAcceptEnhanced setting definition
- `src/extension.ts` — Consolidated toggle commands and listeners, removed autoAcceptWatcherTimer
- `src/bridgeLifecycle.ts` — Removed UIWatcher startup conditions
- `src/bridgeContext.ts` — Removed autoAcceptWatcherTimer
- `src/executor.ts` — Removed UIWatcher management methods
- `src/executorPool.ts` — Removed UIWatcher management properties and methods
- `src/cdpUI.ts` — Removed DOM fallback
- `src/licensing/licenseGate.ts` — Updated feature name
- `src/adminHandler.ts` — Updated Pro feature list
- `src/i18n/en.ts` — Consolidated translation keys
- `src/i18n/ja.ts` — Consolidated translation keys
- `README.md` — Removed autoAcceptEnhanced references
- `docs/ja/getting-started.md`, `docs/en/getting-started.md` — Removed setting descriptions
- `docs/ja/pricing.md`, `docs/en/pricing.md` — Removed from pricing table
- `docs/ja/pro-plan.md`, `docs/en/pro-plan.md` — Removed from comparison table
