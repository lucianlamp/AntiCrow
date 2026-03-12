# 環境別セットアップ

AntiCrow は Windows、macOS、Linux に対応しています。各 OS で動作が異なる部分をまとめました。

## デスクトップショートカット

AntiCrow は初回起動時にデスクトップショートカットを自動作成します。CDP（Chrome DevTools Protocol）ポート付きで Antigravity を起動するためのものです。

| 項目 | Windows | macOS | Linux |
|------|---------|-------|-------|
| ファイル形式 | `.lnk`（ショートカット） | `.command`（シェルスクリプト） | `.desktop`（デスクトップエントリ） |
| 作成場所 | デスクトップ | `~/Desktop/` | `~/.local/share/applications/` |
| 起動コマンド | `Antigravity.exe --remote-debugging-port=9333` | `open -a Antigravity --args --remote-debugging-port=9333` | `antigravity --remote-debugging-port=9333` |

### Windows の注意事項

- OneDrive でデスクトップが同期されている環境でも、正しいパスにショートカットが作成されます
- ショートカットには AntiCrow のアイコンが設定されます

### macOS の注意事項

- `.command` ファイルをダブルクリックで起動できます
- 初回実行時に「開発元を検証できません」という警告が表示される場合があります
  - **対処法**: `システム設定` → `セキュリティとプライバシー` → `このまま許可` をクリック
- `.app` バンドルにはシンボリックリンクで引数を渡せないため、シェルスクリプト方式を採用しています

### Linux の注意事項

- `.desktop` ファイルが `~/.local/share/applications/` に作成されます
- アプリケーションメニューから「AntiCrow」で検索して起動できます

## CDP 接続

AntiCrow は CDP（Chrome DevTools Protocol）を使って Antigravity エディタと通信します。OS ごとに使用するシェルが異なります。

| 項目 | Windows | macOS | Linux |
|------|---------|-------|-------|
| シェル | PowerShell | zsh | bash |
| 起動コマンド | `powershell.exe -ExecutionPolicy Bypass -NoProfile` | `/bin/zsh -l` | `/bin/bash -l` |

### トラブルシューティング

- ファイアウォールが `localhost:9333` をブロックしている場合、CDP 接続が失敗します
- macOS では `.zshrc` / `.zprofile` の設定が影響する場合があります
- Linux では `.bashrc` / `.bash_profile` の設定が影響する場合があります

## プロセス検出

AntiCrow が Antigravity の稼働状況を確認する際、OS ごとに異なるコマンドを使用します。

| 項目 | Windows | macOS | Linux |
|------|---------|-------|-------|
| 検出コマンド | `tasklist.exe` | `pgrep -x Antigravity` | `pgrep -x Antigravity` |
| プロセス名 | `Antigravity.exe` | `Antigravity` | `antigravity` |

### macOS の補足

Apple Silicon（M1/M2/M3/M4）と Intel Mac では Language Server のバイナリが異なります：

- ARM64（Apple Silicon）: `language_server_darwin_arm64`
- Intel: `language_server_darwin_x64`

## 共通設定

### CDP ポート

- **デフォルト**: `9333`
- **変更方法**: Antigravity の設定で `antiCrow.cdpPort` を変更
- ショートカットから起動する場合、自動的にこの設定値が使われます

### Antigravity のインストール先

| OS | パス |
|----|------|
| Windows | `%LOCALAPPDATA%\Programs\antigravity\` |
| macOS | `/Applications/Antigravity.app` |
| Linux | システムの PATH 上の `antigravity` |
