# Getting Started

## 1. Install AntiCrow

Search for **"AntiCrow"** in the Antigravity extension marketplace and click **Install**.

You can also install from the [OpenVSX Marketplace](https://open-vsx.org/extension/lucianlamp/anti-crow).

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

## 3. Invite the Bot to Your Server

1. Go to "OAuth2" → "URL Generator" in the Developer Portal
2. Scopes: Select `bot`
3. Bot Permissions: Select the following:
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
3. Open the extension settings from the Antigravity sidebar, and add your user ID via **"Add Item"** under the **Allowed User Ids** field in the **AntiCrow** section

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
