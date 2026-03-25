# Changelog

All notable changes to AntiCrow will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

## [0.2.0] - 2026-03-25

### Changed

- All features are now free — removed Pro tier, licensing system, and all Pro-related UI labels
- Removed Pro badge from Agent Team Mode and Continuous Auto Mode in landing page (EN/JA)
- Removed Pro trial FAQ entry from landing page (EN/JA)
- Removed license system section and `/pro` command from embedded agent skill
- Removed "Pro限定" label from `/help` command output
- Updated getting-started docs to use extension settings UI instead of `Ctrl+,` for `allowedUserIds` configuration
- Moved Bot Permissions list from Bot section to OAuth2 section in getting-started docs (EN/JA)

### Removed

- Removed `.agent/`, `.vscode/`, `docs/superpowers/` from git tracking (auto-generated / local-only files)

## [0.1.9] - 2026-03-24

### Removed

- Removed `/update` slash command (OpenVSX marketplace handles updates)
- Removed R2 distribution system (`upload-r2.ts`, `r2-deploy` skill, `upload:r2` script)
- Removed `--allow-missing-repository` flag from package script (repository field now set)

### Changed

- Added `repository` field and updated `bugs` URL to GitHub Issues in package.json
- Unified install instructions across all docs to Antigravity marketplace search + OpenVSX
- Added OGP banner image to README
- VSIX package size reduced from 2.9MB to 1.6MB by narrowing `.vscodeignore`
- Repository is now public

## [0.1.8] - 2026-03-24

### Fixed

- Removed outdated "built-in auto-approve" claim from README; now correctly references external [pesosz/antigravity-auto-accept](https://github.com/pesosz/antigravity-auto-accept) extension
- Removed orphan `anti-crow.toggleAutoAccept` command definition from package.json (no implementation since v0.1.1)
- Updated auto-mode docs (en/ja) to replace `autoApprove` setting references with external extension guidance

### Changed

- Added missing `language` and `cdpPort` settings to README settings reference table

## [0.1.7] - 2026-03-20

### Fixed

- Fixed continuous auto mode not dispatching tasks to team mode sub-agents (`processSuggestionPrompt` was not passing `isTeamMode`/`autoMode` to `dispatchPlan`)

### Added

- Added sub-agent window reuse during continuous auto mode (windows are kept in idle pool instead of closing between steps)
- Added `enableWindowReuse` setting to `teamConfig.ts` and `.anticrow/team.json`
- Added `setWindowReuse()` method to `SubagentManager` and `TeamOrchestrator` for dynamic toggle
- Added `onCleanup` callback to `AutoModeState` for cleanup on auto mode stop

## [0.1.6] - 2026-03-19

### Fixed

- Fixed plan generation JSON format errors by strengthening retry prompts with schema examples and explicit constraints
- Fixed team mode integrated report not being delivered to Discord after all sub-agents complete
- Extended team report Cascade timeout from 300s to 600s to prevent premature timeouts
- Added try-catch error handling for CDP sendPrompt in team report phase
- Enhanced fallback error details shown in Discord when integrated report generation fails
- Expanded fallback individual report preview from 500 to 1500 characters

### Changed

- Added `pipeline.reportStarted` Discord notification for team report integration phase
- Strengthened i18n prompt rules (ja/en) with explicit output restrictions for plan generation

## [0.1.5] - 2026-03-18

### Added

- Added `docs-sync` skill for automatic GitBook documentation updates on feature changes
- Added GitBook documentation (Japanese and English) under `docs/ja/` and `docs/en/`

### Changed

- Updated skill documentation and metadata
- Documentation updates for social media preview

## [0.1.4] - 2026-03-17

### Added

- Sub-agent thread support for parallel task execution in team mode
- Suggestion buttons in Discord responses for quick follow-up actions
- Helper agent support: completed sub-agents assist remaining tasks
- Progress polling for team mode sub-agents with real-time Discord updates
- Continuous auto mode improvements for sustained autonomous execution

### Changed

- Improved Discord embed formatting for long messages
- Enhanced error handling in executor response pipeline
- Simplified CHANGELOG format

## [0.1.3] - 2026-03-17

### Fixed

- Fixed cross-workspace auto mode leak where one workspace's auto mode could hijack another workspace's execution
- Added orphan dummy folder cleanup at extension startup to prevent `.anticrow/subwindows/` accumulation
- Fixed continuous auto mode terminating prematurely due to false-positive completion phrase detection
- Auto mode now considers active suggestions when determining task completion
- Removed misleading "report completion" instruction from autonomous prompts
- Tightened completion phrase list to reduce false positives

### Changed

- Conducted continuous auto mode reproduction test (package.json description, README.md badges, CHANGELOG.md entry)

## [0.1.1] - 2026-03-12

### Breaking Changes

- The `autoAccept` setting has been removed. Auto-accept functionality is now handled by [pesosz/antigravity-auto-accept](https://github.com/pesosz/antigravity-auto-accept).

### Changed

- Delegated auto-accept operations to the pesosz/antigravity-auto-accept extension for improved reliability
- Streamlined internal UI automation for better performance

### Removed

- Removed the built-in UIWatcher feature (replaced by external extension)
- Removed the `autoAcceptEnhanced` setting (no longer needed)
- Cleaned up unused build artifacts
