# 🔒 Privacy Policy

Last updated: March 5, 2026

AntiCrow (hereinafter "this extension") is designed to respect user privacy and minimize data collection.

---

## Core Principles

- This extension **does not send data to external servers**
- All processing is **completed entirely on the user's local PC**
- We **do not collect** telemetry, analytics, or usage statistics whatsoever

---

## Data We Collect and Use

### Discord Messages

- **Purpose:** Used solely to convert user instructions into AI tasks
- **Storage:** Saved locally as execution plans (JSON files)
- **Destination:** Only sent to the local Antigravity AI (never to external servers)

### Discord Bot Token

- **Purpose:** Authentication for Discord API connections
- **Storage:** Encrypted and stored in Antigravity's SecretStorage
- **Access:** Only accessible by this extension. Never stored in plain text or sent externally

### Attachments

- **Purpose:** Analysis and processing by AI
- **Storage:** Downloaded to a local temporary directory
- **Deletion:** Automatically deleted after processing is complete
- **Destination:** Only sent to the local Antigravity AI

### Custom AI Instructions (`ANTICROW.md`)

- **Purpose:** Applied as additional instructions to all AI prompts
- **Storage:** User's home directory (`~/.anticrow/ANTICROW.md`)
- **Control:** Fully controlled by the user. Content can be reviewed and edited at any time


---

## Data We Do Not Collect

This extension **does not collect or send** the following data:

- Usage statistics or telemetry
- Crash reports
- User personal information
- File system structure or file listings
- Browser history
- Information about other extensions


---

## Third-Party Service Communication

This extension communicates with only the following external services:

| Service | Purpose | Data |
|---|---|---|
| Discord API | Bot message sending/receiving | Message text, reactions, attachments |

No communication is made with any other third-party services.

---

## Data Deletion

To delete all data related to this extension:

1. **Uninstall the extension:** Remove AntiCrow from the Antigravity extensions panel
2. **Delete local data:** Remove the `~/.anticrow/` directory
3. **Invalidate the Bot Token:** Reset the Token on the [Discord Developer Portal](https://discord.com/developers/applications)

---

## Contact

If you have any questions about privacy, please feel free to contact the developer:

- **X (Twitter):** [@lucianlamp](https://x.com/lucianlamp)
