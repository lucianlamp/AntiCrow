# ⚠️ Disclaimer

## Important Notice

Use of the AntiCrow extension involves significant risks. Please read and understand the following before using this software.

## Safety of AntiCrow

The AntiCrow extension itself **does not contain any malicious or destructive code**. It is designed to prevent exposure of API keys and secret credentials.

However, **Antigravity (the AI coding editor)** that AntiCrow connects to may, based on AI judgment, autonomously perform file operations (creation, modification, deletion), send requests to external services, or execute other potentially destructive actions. **These risks are not caused by AntiCrow, but are inherent to the behavior and specifications of the Antigravity AI platform.**

AntiCrow serves as a bridge that relays instructions from Discord to Antigravity. The actual actions executed by the AI and their outcomes are determined by Antigravity's own specifications and AI decision-making.

## 🔧 Technical Architecture

AntiCrow does not use Antigravity's OAuth keys or API keys. It operates the Antigravity editor directly via CDP (Chrome DevTools Protocol).

- **No OAuth BAN Risk** — AntiCrow does not use OAuth tokens, so there is no risk of being banned for token misuse
- **Update Impact** — If Antigravity updates restrict CDP-based operations, some or all AntiCrow features may stop working
- **Use at Your Own Risk** — Please understand the above before installing and use at your own risk

## Risks

Due to the nature of Antigravity's AI-driven operations, the following risks may occur (including but not limited to):

- **Data Loss** — Automated AI operations may overwrite, delete, or corrupt your files and data
- **Unintended Code Changes** — AI-generated modifications may introduce bugs, break existing functionality, or alter your codebase in unexpected ways
- **API Key Misuse** — Based on prompt content or AI judgment, API keys may be accessed or used in unintended ways during automated execution
- **Impact on External Services** — Automated AI operations may send unexpected requests to connected external services

## Use at Your Own Risk

By using this extension, you acknowledge and accept all risks associated with its use. **You are solely responsible** for any consequences resulting from the use of this software. It is strongly recommended to:

- Back up your data before use
- Review all changes made by the extension
- Avoid storing sensitive credentials in accessible locations
- Test in a sandbox environment before using in production

## No Warranty — Provided "AS IS"

This software is provided **"AS IS"**, without warranty of any kind, express or implied, including but not limited to the warranties of merchantability, fitness for a particular purpose, and noninfringement.

## Limitation of Liability

In no event shall the developers or contributors be held liable for any claim, damages, or other liability, whether in an action of contract, tort, or otherwise, arising from, out of, or in connection with the software or the use or other dealings in the software.

**The developers assume no responsibility for any loss, damage, or consequences arising from the use of this extension.**
