# 🛡️ Security Policy

AntiCrow is designed with user security and privacy as the highest priority.

---

## Architecture Overview

AntiCrow completes all processing within the user's local environment.

```
📱 Discord (Mobile/PC)
    ↓ Send message
🐦‍⬛ AntiCrow Extension (Local PC)
    ↓ Convert to task
🤖 Antigravity AI (Local PC)
    ↓ Return result
🐦‍⬛ AntiCrow Extension (Local PC)
    ↓ Send result
📱 Discord (Mobile/PC)
```

**Communication is limited to the Discord API only.** No data is sent to any other external servers.

---

## Data Handling

### Stored Data

| Data | Storage Location | Protection |
|---|---|---|
| Discord Bot Token | Antigravity SecretStorage | OS-level encryption |
| Execution Plans | Local JSON files | Protected by user permissions |
| Custom AI Instructions | `~/.anticrow/ANTICROW.md` | Fully managed by the user |

### Data Never Sent

- ❌ Telemetry or usage statistics
- ❌ Analytics or tracking information
- ❌ User's file system structure
- ❌ Data to third-party APIs

### Attachments

Files sent via Discord are temporarily downloaded locally and automatically deleted after AI processing. They are never uploaded to external servers.

---

## Access Control

- **`allowedUserIds`** — Only permitted Discord users can operate the Bot. If empty, **all users are denied** (whitelist approach).
- **Bot Token** — Only administrators who know the Token can control the Bot.

### ⚠️ If Your Discord Account Is Compromised

If your Discord account is compromised, you can immediately block unauthorized access to AntiCrow with the following steps:

1. Open `antiCrow.allowedUserIds` in Antigravity's settings
2. **Remove** the compromised account's user ID (or clear all IDs to deny everyone)
3. Save settings → **Takes effect immediately** (no Bot restart required)
4. If necessary, **reset the Bot Token** on the Discord Developer Portal

> 💡 Since `allowedUserIds` uses a whitelist approach, simply removing the ID immediately blocks access.

---

## Open Source

AntiCrow is released under the **MIT License**. The source code is publicly available and all features are free to use.

---

## User-Controllable Settings

AntiCrow is designed to give users full control:

| Setting | Description |
|---|---|
| `allowedUserIds` | Control who can operate the Bot |
| `~/.anticrow/ANTICROW.md` | Edit and review custom instructions sent to AI |
| `workspacePaths` | Control which folders AI can access |
| `responseTimeoutMs` | Control timeout duration |

> 💡 `ANTICROW.md` is a plain text Markdown file. You can review and edit the custom instructions sent to AI at any time.

---

## Reporting Vulnerabilities

If you discover a security issue, please contact us:

- **X (Twitter):** [@lucianlampdefi](https://x.com/lucianlampdefi)

Please report via DM rather than a public Issue.
