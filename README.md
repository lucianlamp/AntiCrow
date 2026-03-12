# 🐦‍⬛ AntiCrow

**Discord → Antigravity Automation Bridge**

Send a natural language message from Discord on your phone → Antigravity executes it automatically → Results are sent back to Discord 🚀

> 📖 [日本語ドキュメント](https://anticrow.gitbook.io/ja)

---

## ✨ Features

- 📱 **Remote Control from Mobile** — Delegate tasks to AI via Discord, anywhere, anytime
- ⏰ **Scheduled Execution** — Register automated tasks using cron expressions (daily, weekly, hourly, etc.)
- 🔄 **Instant Execution** — Quickly request tasks to be done right now
- 📂 **Multi-Workspace Support** — Automatically organizes projects into Discord categories
- 📎 **File Attachments** — Attach images and documents for AI analysis
- 📊 **Progress Notifications** — Real-time progress updates for long-running tasks
- 📝 **Prompt Templates** — Save frequently used instructions as templates for one-tap execution
- 🧠 **Model & Mode Switching** — Switch AI models and execution modes from Discord
- 🤖 **Auto Mode** — AI autonomously executes tasks in sequence with safety guards (Pro only)
- ⚡ **Auto Accept** — Automatically clicks Run / Allow / Continue, etc. (Pro only)
- 🤝 **Agent Team Mode** — Multiple AI agents execute tasks in parallel for faster results (Pro only)
- 💾 **Memory** — Automatically records and utilizes past learnings (global / workspace-specific)
- 🛡️ **Safety Guard** — 21-pattern dangerous operation detection (file deletion, credential leaks, injection attacks)
- 🔐 **Security** — Encrypted token storage, user ID restrictions

---

## 💎 Plan Comparison

| Feature | Free | Pro |
| --- | --- | --- |
| Task execution via Discord | ✅ 10/day, 50/week | ✅ Unlimited |
| Scheduled execution (cron) | ✅ | ✅ |
| Slash commands | ✅ | ✅ |
| File attachments & progress notifications | ✅ | ✅ |
| Model & mode switching | ✅ | ✅ |
| Templates | ✅ | ✅ |
| Auto Mode | ❌ | ✅ |
| Auto Accept | ❌ | ✅ |
| Agent Team Mode | ❌ | ✅ |
| Pro Trial | — | 14 days free |

Run the `/pro` command in Discord to manage, purchase, or enter a license key.

---

## 🔧 How It Works

AntiCrow acts as a bridge between Discord and Antigravity.

```
📱 Discord (Mobile/PC)
    ↕ Message exchange
🐦‍⬛ AntiCrow Extension (Your PC)
    ↕ Task coordination
🤖 Antigravity AI (Your PC)
```

> 🔒 **All processing runs entirely on your PC.** No data is sent to external servers. Only Discord API communication is performed. No telemetry or usage statistics are collected.

---

## Prerequisites

| Item | Requirement |
| --- | --- |
| Antigravity | Installed and launchable |
| Node.js | 16.11 or higher |
| Discord Account | Developer Portal access required for Bot creation |
| Discord Server | A server where you have admin permissions |

---

## Setup Guide

### 1️⃣ Create a Discord Bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **"New Application"** in the top right → Enter a name (e.g., `AntiCrow`)
3. Select **"Bot"** from the left menu
4. Click **"Reset Token"** to obtain a token → **Save it immediately** (it cannot be displayed again)
5. On the same page, configure **Privileged Gateway Intents**:
   - ✅ **MESSAGE CONTENT INTENT** — Required (to read message content)
   - ✅ **SERVER MEMBERS INTENT** — Recommended (for user information retrieval)

### 2️⃣ Invite the Bot to Your Server

1. Select **"OAuth2"** from the left menu
2. In **"URL Generator"**, configure:
   - **SCOPES**: `bot`
   - **BOT PERMISSIONS**: `Send Messages`, `Read Message History`, `Add Reactions`, `Manage Channels`, `Attach Files`, `Embed Links`, `Create Public Threads`, `Send Messages in Threads`, `Manage Threads`
3. Copy the generated URL and open it in your browser → Invite the Bot to your server

### 3️⃣ Install the Extension

1. Obtain the `.vsix` file from the developer
2. In Antigravity, open Command Palette (`Ctrl+Shift+P`) → Select **Extensions: Install from VSIX...**
3. Select the `.vsix` file to install

### 4️⃣ Initial Configuration

1. Command Palette (`Ctrl+Shift+P`) → Run **"AntiCrow: Set Bot Token"** → Enter the Bot Token you saved
2. When **`✓ AntiCrow [Free]`** or **`✓ AntiCrow [Pro]`** appears in the status bar, you're connected 🎉

> `autoStart` is enabled by default, so the bridge will start automatically after setting the token.

> 💡 The status bar shows your current plan. During a Pro trial, it displays `✓ AntiCrow [Trial: X days left]`.

> ⚠️ **Important:** AntiCrow requires Antigravity to be launched from a dedicated desktop shortcut.
> After initial setup, create a shortcut with the `AntiCrow: Create Desktop Shortcut` command and always launch from it.

---

## Basic Usage

### 💬 Send Natural Language Requests (#agent-chat)

Just send a message in the `#agent-chat` channel. AntiCrow analyzes the content and automatically determines whether to execute immediately or register as a scheduled task.

**Instant Execution:**

```
List all TODOs in the current project
```

```
Fix the bug shown in this image
```

**Scheduled Execution:**

```
Summarize GitHub notifications every morning at 9 AM
```

→ Converted to a cron expression and executed automatically at the specified time.

### ✅ Confirmation Reactions

When confirmation is required before execution:

- Press ✅ → **Approve and start execution**
- Press ❌ → **Reject and cancel**

### 📎 File Attachments

Attach files to your message, and AI will analyze the content and use it for the task. Supports various formats including images, text, and documents.

---

## Workspace Integration

AntiCrow automatically detects open Antigravity workspaces and creates categories in the Discord server.

```
📁 🔧 crypto (Category)
  └── #agent-chat
📁 🔧 web-app (Category)
  └── #agent-chat
```

Messages sent from channels within a category are executed in the corresponding workspace. If the workspace's Antigravity is not running, it will automatically attempt to launch.

---

## 🤖 Auto Mode (Pro Only)

AI autonomously decides the next action and executes tasks in sequence. Start with the `/auto` command:

```
/auto Redesign the landing page
/auto --steps 15 --confirm semi Refactor the entire project
```

**Options:** `--steps N` (1-20), `--duration N` (5-120 min), `--confirm auto|semi|manual`, `--select auto-delegate|first|ai-select`

**Safety Guard:** 21-pattern detection protects against file system destruction, Git force operations, database drops, crypto key leaks, and prompt injection attacks.

> 📖 [Full Auto Mode documentation](https://anticrow.gitbook.io/en/auto-mode)

---

## 🤝 Agent Team Mode (Pro Only)

Multiple AI sub-agents execute tasks in parallel. Large-scale changes are automatically split, with multiple AIs working simultaneously.

- 🚀 Automatically splits large tasks for parallel execution
- 💬 Each sub-agent's progress displayed in real-time via Discord threads
- 🔄 Results automatically aggregated and returned to Discord

Toggle on/off with the `/team` command.

> 📖 [Full Team Mode documentation](https://anticrow.gitbook.io/en/team-mode)

---

## Slash Commands

| Command | Description |
| --- | --- |
| `/status` | Display Bot, connection, and queue status |
| `/stop` | Stop the currently running task |
| `/newchat` | Open a new chat in Antigravity |
| `/workspace` | Display detected workspace list |
| `/queue` | Display message processing queue details |
| `/model` | Display and switch AI models |
| `/mode` | Switch AI mode (Planning / Fast) |
| `/template` | Manage prompt templates |
| `/schedules` | Display and manage scheduled executions |
| `/auto` | Start Auto Mode (Pro only) |
| `/auto-config` | View/change Auto Mode settings |
| `/team` | Manage Agent Team Mode (Pro only) |
| `/suggest` | Re-display suggestion buttons |
| `/screenshot` | Capture current screen |
| `/soul` | View/reset customization settings |
| `/pro` | Manage Pro license |
| `/update` | Auto-update to latest version |
| `/help` | Display usage guide |

---

## Settings Reference

| Setting Key | Type | Default | Description |
| --- | --- | --- | --- |
| `antiCrow.botToken` | boolean | `false` | Bot Token configuration status (display only) |
| `antiCrow.responseTimeoutMs` | number | `1800000` | Idle timeout since last progress update (30 min) |
| `antiCrow.autoStart` | boolean | `true` | Automatically start bridge on launch |
| `antiCrow.categoryArchiveDays` | number | `7` | Workspace category auto-archive days (0 = disabled) |
| `antiCrow.allowedUserIds` | string[] | `[]` | Allowed Discord user IDs (**empty = all denied**) |
| `antiCrow.autoAccept` | boolean | `false` | Enable auto accept (Pro only) |
| `antiCrow.maxRetries` | number | `0` | Auto retry count on timeout (0 = disabled) |
| `antiCrow.workspaceParentDirs` | string[] | `[]` | Parent directories for new workspace creation |

---

## Command Palette Commands

| Command | Description |
| --- | --- |
| `AntiCrow: Start` | Start Discord Bridge |
| `AntiCrow: Stop` | Stop Discord Bridge |
| `AntiCrow: Set Bot Token` | Securely store Discord Bot Token |
| `AntiCrow: Show Plans` | Display all registered plans as JSON |
| `AntiCrow: Clear All Plans` | Delete all plans |
| `AntiCrow: Create Desktop Shortcut` | Create an Antigravity desktop shortcut |
| `AntiCrow: Toggle Auto Accept` | Toggle auto accept on/off (Pro only) |
| `AntiCrow: License Info` | Display current license information |
| `AntiCrow: Set License Key` | Enter/update license key |

---

## Customization

### 🎨 AI Personality & Tone

Write instructions in `~/.anticrow/SOUL.md` to customize AI behavior:

```markdown
# Basic Style
- Always respond in English
- Use a friendly and concise tone

# Coding Style
- Use TypeScript
- Follow ESLint rules
```

### 💾 Memory

AntiCrow automatically records lessons learned from past tasks:

| Type | Location | Purpose |
| --- | --- | --- |
| Global Memory | `~/.anticrow/MEMORY.md` | Cross-project learnings |
| Workspace Memory | `{workspace}/.anticrow/MEMORY.md` | Project-specific learnings |

---

## 🔒 Security

- Bot Token is stored encrypted in Antigravity's SecretStorage
- `allowedUserIds` whitelist restricts who can operate the Bot
- All processing runs locally — no data sent to external servers
- No telemetry or usage statistics collected

> 📖 [Full Security Policy](https://anticrow.gitbook.io/en/security) | [Privacy Policy](https://anticrow.gitbook.io/en/privacy)

---

## 📖 Full Documentation

For detailed guides, FAQ, troubleshooting, and more:

- 🇬🇧 [English Documentation](https://anticrow.gitbook.io/en)
- 🇯🇵 [日本語ドキュメント](https://anticrow.gitbook.io/ja)

---

## About the Developer

AntiCrow is developed and maintained by [@lucianlamp](https://x.com/lucianlamp).

- **X (Twitter):** [@lucianlamp](https://x.com/lucianlamp)

---

## ⚠️ Disclaimer

> **🛡️ Safety of AntiCrow**

The AntiCrow extension itself **does not contain any malicious or destructive code**. It is designed to prevent exposure of API keys and secret credentials. AntiCrow serves as a bridge that relays instructions from Discord to Antigravity.

> **⚠️ Risks from Antigravity**

However, **Antigravity (the AI coding editor)** that AntiCrow connects to may, based on AI judgment, autonomously perform actions that carry the following risks. **These risks are not caused by AntiCrow, but are inherent to the Antigravity AI platform.**

> **🔧 Technical Architecture**

AntiCrow does not use Antigravity's OAuth keys or API keys. It operates the Antigravity editor directly via **CDP (Chrome DevTools Protocol)**. This means there is no risk of being banned for OAuth token misuse. However, if Antigravity updates restrict CDP-based operations, some or all AntiCrow features may stop working.

- **Automated Operation Risks** — AI-driven automation may cause unintended file modifications or deletions
- **Code Modification Risks** — Auto-generated/edited code may break your existing codebase
- **API Key Handling** — Designed to prevent API key exposure, but AI judgment may use keys in unintended ways
- **Self-Responsibility** — All use is entirely at **your own risk**
- **Provided "AS IS"** — Without warranty of any kind, express or implied
- **Developer Disclaimer** — The developer assumes no liability for any damages arising from use

> 📖 [Full Disclaimer](https://anticrow.gitbook.io/en/disclaimer)

---

## License

MIT
