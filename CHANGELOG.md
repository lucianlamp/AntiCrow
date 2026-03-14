# Changelog

All notable changes to Anti-Crow will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

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
