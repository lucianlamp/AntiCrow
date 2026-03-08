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
| License Key | Antigravity SecretStorage | OS-level encryption |
| Execution Plans | Local JSON files | Protected by user permissions |
| Task Execution Counter | Antigravity globalState | Local persistence (daily/weekly reset) |
| Custom AI Instructions | `~/.anticrow/ANTICROW.md` | Fully managed by the user |

### Data Never Sent

- ❌ Telemetry or usage statistics
- ❌ Analytics or tracking information
- ❌ User's file system structure
- ❌ Data to third-party APIs
- ❌ License keys externally (verification via encrypted communication only)
- ❌ Task execution counts or limit information externally

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

## License and Plan Security

AntiCrow offers Free and Pro plans. License-related data is securely managed as follows:

### License Key Storage

- License keys are encrypted and stored in Antigravity's **SecretStorage**
- They are never recorded in plain text in configuration files
- License verification is done solely via HTTPS requests to the Lemonsqueezy API

### Execution Limit Management

- Free plan execution limits (10/day, 50/week) are stored and managed locally
- Execution counts and limit information are never sent externally
- Pro trial information is also stored locally and never sent externally

---

## User-Controllable Settings

AntiCrow is designed to give users full control:

| Setting | Description |
|---|---|
| `allowedUserIds` | Control who can operate the Bot |
| `~/.anticrow/ANTICROW.md` | Edit and review custom instructions sent to AI |
| `autoAccept` | Control auto-approval on/off (Pro only) |
| `workspacePaths` | Control which folders AI can access |
| `responseTimeoutMs` | Control timeout duration |

> 💡 `ANTICROW.md` is a plain text Markdown file. You can review and edit the custom instructions sent to AI at any time.

---

## Reporting Vulnerabilities

If you discover a security issue, please contact us:

- **X (Twitter):** [@lucianlampdefi](https://x.com/lucianlampdefi)

Please report via DM rather than a public Issue.
