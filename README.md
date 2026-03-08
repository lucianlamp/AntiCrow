[🇯🇵 日本語版はこちら](README.ja.md)

# 🐦‍⬛ AntiCrow

**Discord → Antigravity Automation Bridge**

Send a natural language message from Discord on your phone → Antigravity executes it automatically → Results are sent back to Discord 🚀

## ✨ Features

- 📱 **Remote Control from Mobile** — Delegate tasks to AI via Discord, anywhere, anytime
- ⏰ **Scheduled Execution** — Register automated tasks using cron expressions (daily, weekly, hourly, etc.)
- 🔄 **Instant Execution** — Quickly request tasks to be done right now
- 📂 **Multi-Workspace Support** — Automatically organizes projects into Discord categories
- 📎 **File Attachments** — Attach images and documents for AI analysis
- 📊 **Progress Notifications** — Real-time progress updates for long-running tasks
- 📝 **Prompt Templates** — Save frequently used instructions as templates for one-tap execution
- 🧠 **Model & Mode Switching** — Switch AI models and execution modes from Discord
- ⚡ **Auto Accept** — Automatically clicks Run / Allow / Continue, etc. (Pro only)
- 🤝 **Agent Team Mode** — Multiple AI agents execute tasks in parallel for faster results (Pro only)
- 💾 **Memory** — Automatically records and utilizes past learnings (global / workspace-specific)
- 🛡️ **Security** — Encrypted token storage, user ID restrictions

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
| Auto Accept | ❌ | ✅ |
| Agent Team Mode | ❌ | ✅ |
| Pro Trial | — | 14 days free |

### How to Get a License Key

- Run the `/pro` command in Discord → Manage, purchase, or enter a license key

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

See [Security Policy](docs/ja/security.md) and [Privacy Policy](docs/ja/privacy.md) for details.

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

#### Instant Execution Examples

```
List all TODOs in the current project
```

```
Fix the bug shown in this image
```

```
Update the dependencies in package.json
```

→ Antigravity executes immediately and returns the results to Discord.

#### Scheduled Execution Examples

```
Summarize GitHub notifications every morning at 9 AM
```

```
Organize this week's tasks every Monday
```

→ Converted to a cron expression and executed automatically at the specified time.

### ✅ Confirmation Reactions

When confirmation is required before execution, the Bot posts a confirmation message:

- Press ✅ → **Approve and start execution**
- Press ❌ → **Reject and cancel**

When there are choices:

- 1️⃣ 2️⃣ 3️⃣ ... for **individual selection**
- ☑️ to **confirm selection** (for multi-select)

### 📎 File Attachments

Attach files to your message, and AI will analyze the content and use it for the task. Supports various formats including images, text, and documents.

### 📊 Progress Notifications

For long-running tasks, progress is reported to Discord in real-time (with percentage and status messages).

---

## Workspace Integration

AntiCrow can manage multiple Antigravity workspaces.

AntiCrow automatically detects open Antigravity workspaces and creates categories in the Discord server. No manual path configuration is needed.

### Discord Category Mapping

When a workspace is detected, categories are automatically created in the Discord server:

```
📁 🔧 crypto (Category)
  └── #agent-chat
📁 🔧 web-app (Category)
  └── #agent-chat
```

Messages sent from channels within a category are executed in the corresponding workspace.

### Auto Launch

If a workspace's Antigravity is not running when a message is sent, it will automatically attempt to launch. The task is executed after the workspace opens.

### Category Auto-Archive

Categories unused for the number of days set in `antiCrow.categoryArchiveDays` (default: 7 days) are automatically deleted. No need to manually clean up unused categories.

---

## 🤖 Agent Team Mode (Pro Only)

A feature where multiple AI sub-agents execute tasks in parallel. Large-scale changes are automatically split, with multiple AIs working simultaneously for significant speedup.

### How to Enable

Run the `/team` command in Discord to manage Agent Team Mode (toggle on/off).

### Features

- 🚀 Automatically splits large tasks for parallel execution
- 💬 Each sub-agent's progress is displayed in real-time via Discord threads
- 🔄 Results are automatically aggregated and returned to Discord
- 🔒 **Pro plan only** (Free plan shows an error message)

---

## Slash Commands

Slash commands are automatically registered when the Bot starts. The following commands are available in Discord:

| Command | Description |
| --- | --- |
| `/status` | Display Bot, connection, and queue status overview |
| `/schedules` | Display scheduled execution list and management panel |
| `/stop` | Stop the currently running task |
| `/newchat` | Open a new chat in Antigravity |
| `/workspace` | Display detected Antigravity workspace list |
| `/queue` | Display message processing queue and execution queue details |
| `/template` | Display and manage prompt template list |
| `/model` | Display and switch available AI models |
| `/mode` | Switch AI mode (Planning / Fast) |
| `/history` | Display Antigravity conversation history |
| `/suggest` | Analyze the project and suggest next actions |
| `/help` | Display usage guide and command list |
| `/pro` | Manage, purchase, or enter Pro license |
| `/screenshot` | Capture a screenshot of the current screen |
| `/soul` | Edit SOUL.md (customization settings) |
| `/team` | Manage Agent Team Mode |

### `/schedules` Panel

Running `/schedules` displays a list of registered schedules with buttons:

- ⏸️ **Pause** / ▶️ **Resume** — Toggle schedule on/off
- 🗑️ **Delete** — Permanently delete a schedule (with confirmation)
- Also shows next execution time, run count, and last execution result

### `/template` Usage

Running `/template` displays the template management panel:

- ➕ **Create New** — Register a template with a name and prompt
- ▶️ **Execute** — Immediately execute a template's prompt
- 🗑️ **Delete** — Delete a template

Template prompts support the following variables:

| Variable | Example |
| --- | --- |
| `{{date}}` | `2026-02-18` |
| `{{time}}` | `18:30` |
| `{{datetime}}` | `2026-02-18 18:30` |
| `{{year}}` | `2026` |
| `{{month}}` | `02` |
| `{{day}}` | `18` |

### `/model` Usage

Running `/model` displays a list of available AI models with remaining quota. Press a button to switch models.

### `/mode` Usage

Running `/mode` lets you switch AI modes:

- **Planning** — Normal mode. Plans before executing
- **Fast** — Fast mode. Skips planning and executes immediately

---

## Settings Reference

The following settings can be changed in Antigravity settings (`Ctrl+,`):

| Setting Key | Type | Default | Description |
| --- | --- | --- | --- |
| `antiCrow.botToken` | boolean | `false` | Bot Token configuration status (display only). Set via `Set Bot Token` in Command Palette |
| `antiCrow.responseTimeoutMs` | number | `1800000` | Idle timeout since last progress update (ms). Default 30 minutes |
| `antiCrow.autoStart` | boolean | `true` | Automatically start bridge on Antigravity launch |
| `antiCrow.categoryArchiveDays` | number | `7` | Workspace category auto-archive days. 0 to disable |
| `antiCrow.allowedUserIds` | string[] | `[]` | Discord user IDs allowed to process messages. **Empty = all denied (must configure)** |
| `antiCrow.autoAccept` | boolean | `false` | Enable auto accept (Run / Allow / Continue, etc.) **(Pro only)**. Also toggleable via status bar button |
| `antiCrow.maxRetries` | number | `0` | Auto retry count on timeout. 0 to disable |
| `antiCrow.workspaceParentDirs` | string[] | `[]` | Parent directories for new workspace creation |

> 💡 When `autoAccept` is on, Antigravity's confirmation dialogs (Continue, Allow, Retry, etc.) are automatically clicked and agent proposals are automatically approved — only during AntiCrow-initiated job execution. Auto accept does not activate during manual Antigravity operation.

---

## Command Palette Commands

Commands available from Antigravity's Command Palette (`Ctrl+Shift+P`):

| Command | Description |
| --- | --- |
| `AntiCrow: Start` | Start Discord Bridge. Bot goes online and begins accepting messages |
| `AntiCrow: Stop` | Stop Discord Bridge. Bot goes offline |
| `AntiCrow: Set Bot Token` | Securely store Discord Bot Token (encrypted via SecretStorage) |
| `AntiCrow: Show Plans` | Display all registered plans (including instant executions) as JSON in editor |
| `AntiCrow: Clear All Plans` | Delete all plans (including scheduled execution schedules) |
| `AntiCrow: Create Desktop Shortcut` | Create an Antigravity desktop shortcut |
| `AntiCrow: Toggle Auto Accept` | Toggle auto accept (Run / Allow / Continue, etc.) on/off **(Pro only)** |
| `AntiCrow: License Info` | Display current license information / upgrade |
| `AntiCrow: Set License Key` | Enter / update license key |

---

## Customization

### 🎨 Customize AI Personality & Tone

Write instructions for AI in `~/.anticrow/SOUL.md`, and they will be automatically applied to all prompts.

#### Configuration File Location

```
Windows: C:\Users\<username>\.anticrow\SOUL.md
```

#### Example Configuration

```markdown
# Basic Style
- Always respond in English
- Use a friendly and concise tone
- Use emojis moderately
- Avoid jargon and use simple language

# Coding Style
- Use TypeScript
- Write comments in English
- Follow ESLint rules
```

### 💾 Memory Feature

AntiCrow **automatically records** lessons learned and important discoveries from past tasks, and applies them to future tasks.

#### Memory Types

| Type | Location | Purpose |
| --- | --- | --- |
| Global Memory | `~/.anticrow/MEMORY.md` | Cross-project learnings (user preferences, general patterns, etc.) |
| Workspace Memory | `{workspace}/.anticrow/MEMORY.md` | Project-specific learnings (build procedures, bug workarounds, etc.) |

#### What Gets Recorded?

- Important technical decisions and their rationale
- Recurring problem resolution patterns
- Project-specific build procedures and notes
- Failed approaches and alternatives

#### Difference from SOUL.md

| | SOUL.md | MEMORY.md |
| --- | --- | --- |
| Purpose | Specify AI personality, tone, and coding style | Accumulate lessons learned from past tasks |
| Who writes it? | User writes manually | AI records automatically (user can also edit) |
| Content example | "Respond in English", "Use TypeScript" | "This project bundles with esbuild" |

> 💡 `MEMORY.md` is a plain text Markdown file. You can view, edit, or delete it at any time.

---

### 🎛️ User Controls

AntiCrow is designed to give users full control:

| Setting | What You Control |
| --- | --- |
| `allowedUserIds` | Determine who can operate the Bot (whitelist approach) |
| `~/.anticrow/SOUL.md` | View and edit custom instructions sent to AI |
| `autoAccept` | Toggle auto accept on/off (also toggleable from status bar) |
| `workspaceParentDirs` | Specify parent directories for new workspace creation |
| `responseTimeoutMs` | Configure timeout duration |

> 💡 `SOUL.md` is a plain text Markdown file. You can always view the custom instructions sent to AI, and simply delete it to disable.

---

## Troubleshooting

### 🔴 Bot Stays Offline

- **Check token**: Re-enter the correct token via the `Set Bot Token` command
- **Check intents**: Verify that **MESSAGE CONTENT INTENT** is enabled in the Discord Developer Portal
- **Network**: Check your internet connection

### 🔴 Cannot Connect to Antigravity

- Verify that Antigravity is running
- Check error logs in the Output Channel "AntiCrow" (`Ctrl+Shift+U` → Select "AntiCrow" from the dropdown)

### 🔴 Messages Are Ignored

- Verify the channel name is `agent-chat`
- Messages to `#logs` channels are intentionally ignored
- If `allowedUserIds` is configured, verify your Discord user ID is included

### 🔴 No Response for Extended Period

- Increase the `responseTimeoutMs` setting value (default: 30 minutes)
- Use the `/stop` command to stop currently running tasks
- Check logs in the Output Channel "AntiCrow"

### 🔴 Slash Commands Not Appearing

- Restart the Bot (Stop → Start) to re-register guild commands
- Restart the Discord app (if it's a cache issue)

### 🔴 Workspace Won't Auto Launch

- Verify the workspace folder actually exists
- Open the workspace in Antigravity once, then restart AntiCrow

---

## FAQ

### Q: Where is the Bot Token stored?

**A:** It's stored encrypted in Antigravity's SecretStorage. It's never recorded in plain text in configuration files.

### Q: Can I use it with multiple Discord servers?

**A:** Currently, it operates with the first detected guild (server). Using a single server is recommended.

### Q: What's the message processing order?

**A:** Messages for the same workspace are processed sequentially in send order. Messages for different workspaces are processed in parallel.

### Q: When does scheduled execution start?

**A:** It automatically starts at the next execution timing specified by the cron expression. Even if the Bot restarts, registered schedules are persisted and automatically restored.

### Q: Can I use it while away from home?

**A:** Yes! You can send requests from anywhere as long as you can use Discord. Just send a message from the Discord app on your phone. However, the PC running Antigravity must be online.

### Q: Is there a file attachment size limit?

**A:** It follows Discord's upload limit (usually 25MB). Files are temporarily downloaded locally for processing.

### Q: What are the Free plan limitations?

**A:** There's a limit of 10 task executions per day and 50 per week. When the limit is reached, an error message is displayed in Discord. Upgrading to Pro removes all limits.

### Q: What is Agent Team Mode?

**A:** A Pro-only feature where multiple AI sub-agents execute tasks in parallel. It enables fast processing of large-scale changes. Toggle on/off with the `/team` command in Discord.

### Q: Is there a Pro trial?

**A:** Yes. First-time users get 14 days of free Pro features. Remaining days are shown in the status bar.

---

## Security Notes

### 🔐 Bot Token Management

- **Never share** your Bot Token with anyone
- Do not commit it to a Git repository
- If the token is compromised, immediately **Reset Token** in the Developer Portal

### 🛡️ Access Restriction Configuration (Required)

> ⚠️ **Important:** When `allowedUserIds` is empty, **nobody can operate the Bot** for security. You must set your user ID.

#### Step 1: Enable Discord Developer Mode

1. Open Discord (desktop or mobile)
2. Open **User Settings** (⚙️ icon)
3. Select **App Settings** → **Advanced**
4. Turn on **Developer Mode**

#### Step 2: Get Your Discord User ID

1. **Right-click** (or long-press on mobile) your icon or username in Discord
2. Select **"Copy User ID"** from the menu
3. An approximately 18-digit number is copied to your clipboard (e.g., `123456789012345678`)

#### Step 3: Add to Antigravity Settings

1. In Antigravity, Command Palette (`Ctrl+Shift+P`) → Run **Preferences: Open Settings (JSON)**
2. Add the following:

```json
{
  "antiCrow.allowedUserIds": ["paste your copied user ID here"]
}
```

To allow multiple users, add them separated by commas:

```json
{
  "antiCrow.allowedUserIds": ["123456789012345678", "987654321098765432"]
}
```

> 💡 Settings take effect immediately upon saving. No Bot restart required.

---

## About the Developer

AntiCrow is developed and maintained by [@lucianlamp](https://x.com/lucianlamp).

Feel free to reach out with feedback, questions, or bug reports 💬

- **X (Twitter):** [@lucianlamp](https://x.com/lucianlamp)
- **Security reports:** See [Security Policy](docs/ja/security.md)

---

## ⚠️ 免責事項 / Disclaimer

### 日本語

> **🛡️ AntiCrow の安全性**

AntiCrow 拡張機能自体には、**悪意のある操作や破壊的な操作は一切含まれていません**。API キーやシークレット情報を外部に露出させるような仕組みも排除するよう設計しています。AntiCrow は Discord からの指示を Antigravity に中継する役割を担っています。

> **⚠️ Antigravity 由来のリスクについて**

ただし、AntiCrow が連携する **Antigravity（AI コーディングエディタ）** の仕様として、AI の判断により以下のリスクが発生する可能性があります。**これらは AntiCrow 側の問題ではなく、Antigravity 本体の仕様に起因します。**

- **自動操作のリスク** — Antigravity の AI による自動操作は、意図しないファイルの変更・削除を引き起こす可能性があります
- **コード変更リスク** — Antigravity の AI が自動生成・自動編集したコードが、既存のコードベースを破壊する可能性があります
- **API キーの取り扱い** — AntiCrow は API キー露出防止設計ですが、Antigravity の AI の判断により、キーが意図しない形で使用される可能性があります
- **自己責任** — ご利用は全て**自己責任**となります
- **AS IS 提供** — 本拡張機能は「現状のまま（AS IS）」で提供されます。明示的・黙示的を問わず、商品性、特定目的への適合性、権利非侵害の保証を含む一切の保証をいたしません
- **開発者免責** — 開発者は、本拡張機能および連携先の Antigravity の使用により生じたいかなる損害（データの損失、コードの破損、セキュリティ侵害、業務の中断、その他の直接的・間接的損害を含むがこれらに限定されない）についても、一切の責任を負いません。Antigravity の AI による自律的な判断に起因するリスクについても同様です

### English

> **🛡️ Safety of AntiCrow**

The AntiCrow extension itself **does not contain any malicious or destructive code**. It is designed to prevent exposure of API keys and secret credentials. AntiCrow serves as a bridge that relays instructions from Discord to Antigravity.

> **⚠️ Risks from Antigravity**

However, **Antigravity (the AI coding editor)** that AntiCrow connects to may, based on AI judgment, autonomously perform actions that carry the following risks. **These risks are not caused by AntiCrow, but are inherent to the Antigravity AI platform.**

- **Automated Operation Risks** — Antigravity's AI-driven automation may cause unintended file modifications or deletions
- **Code Modification Risks** — Code auto-generated or auto-edited by Antigravity's AI may break your existing codebase
- **API Key Handling** — AntiCrow is designed to prevent API key exposure, but Antigravity's AI judgment may use keys in unintended ways
- **Self-Responsibility** — All use is entirely at **your own risk**
- **Provided "AS IS"** — This extension is provided "AS IS" without warranty of any kind, express or implied, including but not limited to the warranties of merchantability, fitness for a particular purpose, and noninfringement
- **Developer Disclaimer** — The developer assumes no liability for any damages arising from the use of this extension or the connected Antigravity platform, including but not limited to data loss, code corruption, security breaches, business interruption, or any other direct or indirect damages. This includes risks arising from Antigravity's AI-driven autonomous actions

---

## License

MIT
