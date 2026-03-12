# Getting Started

## 1. Install AntiCrow

AntiCrow is distributed as an Antigravity extension (VSIX).

### Installation

```bash
antigravity --install-extension anti-crow-0.1.1.vsix --force
```

> 📝 The version may vary depending on the distributed file.

Or install via the Antigravity Command Palette (`Ctrl+Shift+P`) → "Extensions: Install from VSIX..."

### Recommended Extension

To get the most out of AntiCrow, install the following extension:

| | |
|---|---|
| **Name** | Antigravity Auto Accept |
| **ID** | `pesosz.antigravity-auto-accept` |
| **Publisher** | pesosz |
| **Install** | Search `Antigravity Auto Accept` in Antigravity Extensions, or [view on GitHub](https://github.com/pesosz/antigravity-auto-accept) |

> 💡 This extension automatically clicks Antigravity approval buttons (Run / Allow / Continue). Combined with AntiCrow, you get a fully autonomous development workflow.

## 2. Create a Discord Bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click "New Application"
3. Enter an application name (e.g., `AntiCrow`)
4. Navigate to the "Bot" section
5. Click "Reset Token" and copy the **Bot Token** (this is shown only once!)
6. Enable **Privileged Gateway Intents**:
   - Message Content Intent
   - Server Members Intent
7. Grant **Bot Permissions**:
   - Send Messages
   - Manage Channels
   - Read Message History
   - Embed Links
   - Attach Files
   - Add Reactions
   - Use Slash Commands
   - Manage Messages
   - Create Public Threads
   - Send Messages in Threads
   - Manage Threads

## 3. Invite the Bot to Your Server

1. Go to "OAuth2" → "URL Generator" in the Developer Portal
2. Scopes: Select `bot`
3. Bot Permissions: Select the permissions listed above
4. Open the generated URL in your browser to invite the bot

## 4. Configure AntiCrow

### Set Bot Token

1. Open the Antigravity Command Palette (`Ctrl+Shift+P`)
2. Select **"AntiCrow: Set Bot Token"**
3. Paste the Bot Token and press Enter

### Set Allowed Users

For security, configure which Discord users are allowed to operate the bot.

1. Enable "Developer Mode" in Discord Settings → Advanced
2. Right-click your username → "Copy User ID"
3. In Antigravity Settings (`Ctrl+,`), search for `antiCrow.allowedUserIds`
4. Add your user ID to the JSON array:

```json
"antiCrow.allowedUserIds": ["123456789012345678"]
```

> ⚠️ **Important**: If this setting is empty, all user messages will be rejected.

### Auto-Start Configuration

By default, AntiCrow starts automatically when Antigravity launches. To disable:

```json
"antiCrow.autoStart": false
```

## 5. Verify Setup

After configuration, an AntiCrow icon appears in the status bar.

- 🟢 **Active** — Bot is online and processing messages
- 🟡 **Standby** — Another workspace is managing the bot
- 🔴 **Stopped** — Bot is stopped

Go to your Discord server and send a message in a text channel to verify it's working.

## Configuration Reference

| Setting | Default | Description |
|---------|---------|-------------|
| `antiCrow.botToken` | — | Bot Token status (stored encrypted in SecretStorage) |
| `antiCrow.autoStart` | `true` | Auto-start bot when Antigravity launches |
| `antiCrow.allowedUserIds` | `[]` | Discord user IDs allowed to operate the bot |
| `antiCrow.responseTimeoutMs` | `0` | Idle timeout in ms. 0 = unlimited |
| `antiCrow.maxRetries` | `0` | Auto-retry count on timeout |
| `antiCrow.cdpPort` | `9000` | CDP connection port |
| `antiCrow.language` | `ja` | UI/prompt language (`ja` / `en`) |
| `antiCrow.categoryArchiveDays` | `7` | Auto-delete unused categories after N days. 0 = disabled |
| `antiCrow.workspaceParentDirs` | `[]` | Parent directories for new workspace creation |
