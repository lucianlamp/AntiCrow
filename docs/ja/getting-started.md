# インストール・初期設定

## 1. AntiCrow をインストールする

AntiCrow は Antigravity の拡張機能（VSIX）として提供されます。

### インストール方法

```bash
antigravity --install-extension anti-crow-0.1.0.vsix --force
```

または、Antigravity のコマンドパレット（`Ctrl+Shift+P`）から「Extensions: Install from VSIX...」を選択してインストールできます。

## 2. Discord Bot を作成する

1. [Discord Developer Portal](https://discord.com/developers/applications) にアクセス
2. 「New Application」をクリック
3. アプリケーション名を入力（例: `AntiCrow`）
4. 「Bot」セクションに移動
5. 「Reset Token」をクリックして **Bot Token** をコピー（この Token は一度しか表示されません！）
6. **Privileged Gateway Intents** で以下を有効化:
   - Message Content Intent
   - Server Members Intent
7. **Bot Permissions** で以下を付与:
   - Send Messages
   - Manage Channels
   - Read Message History
   - Embed Links
   - Attach Files
   - Add Reactions
   - Use Slash Commands
   - Manage Messages

## 3. Bot をサーバーに招待する

1. Developer Portal の「OAuth2」→「URL Generator」に移動
2. Scopes: `bot`, `applications.commands` を選択
3. Bot Permissions: 上記の権限を選択
4. 生成された URL をブラウザで開いてサーバーに招待

## 4. AntiCrow の初期設定

### Bot Token を設定

1. Antigravity のコマンドパレット（`Ctrl+Shift+P`）を開く
2. **「AntiCrow: Set Bot Token」** を選択
3. コピーした Bot Token を貼り付けて Enter

### 許可ユーザーを設定

セキュリティのため、操作を許可するユーザーの Discord ID を設定します。

1. Discord の設定 → 「詳細設定」→ 「開発者モード」を有効化
2. 自分のユーザー名を右クリック →「ユーザーIDをコピー」
3. Antigravity の設定（`Ctrl+,`）で `antiCrow.allowedUserIds` を検索
4. JSON 配列にユーザー ID を追加:

```json
"antiCrow.allowedUserIds": ["123456789012345678"]
```

> ⚠️ **重要**: この設定が空の場合、すべてのユーザーのメッセージが拒否されます。

### 自動起動の設定

デフォルトでは Antigravity の起動と同時に AntiCrow が自動起動します。無効にする場合は:

```json
"antiCrow.autoStart": false
```

## 5. 起動を確認する

設定完了後、ステータスバーに AntiCrow のアイコンが表示されます。

- 🟢 **Active** — Bot がオンラインでメッセージを処理中
- 🟡 **Standby** — 別のワークスペースが Bot を管理中
- 🔴 **Stopped** — Bot が停止中

Discord サーバーに移動し、テキストチャンネルでメッセージを送信して動作を確認してください。

## 設定一覧

| 設定名 | デフォルト | 説明 |
|--------|-----------|------|
| `antiCrow.botToken` | — | Bot Token の設定状態（SecretStorage に暗号化保存） |
| `antiCrow.autoStart` | `true` | Antigravity 起動時に自動で Bot を開始 |
| `antiCrow.allowedUserIds` | `[]` | 操作を許可する Discord ユーザー ID 一覧 |
| `antiCrow.responseTimeoutMs` | `0` | アイドルタイムアウト（ミリ秒）。0 = 無制限 |
| `antiCrow.autoAccept` | `false` | 確認ダイアログの自動承認 |
| `antiCrow.maxRetries` | `0` | タイムアウト時の自動リトライ回数 |
| `antiCrow.cdpPort` | `9333` | CDP 接続に使用するポート番号 |
| `antiCrow.language` | `ja` | UI・プロンプトの表示言語（`ja` / `en`） |
| `antiCrow.categoryArchiveDays` | `7` | 未使用カテゴリーの自動削除日数。0 で無効 |
| `antiCrow.workspaceParentDirs` | `[]` | 新規ワークスペース作成時のフォルダ配置先 |
