# Platform Differences

AntiCrow supports Windows, macOS, and Linux. This page documents the differences in behavior across operating systems.

## Desktop Shortcuts

AntiCrow automatically creates a desktop shortcut on first launch. The shortcut launches Antigravity with the CDP (Chrome DevTools Protocol) port enabled.

| Item | Windows | macOS | Linux |
|------|---------|-------|-------|
| File format | `.lnk` (shortcut) | `.command` (shell script) | `.desktop` (desktop entry) |
| Location | Desktop | `~/Desktop/` | `~/.local/share/applications/` |
| Launch command | `Antigravity.exe --remote-debugging-port=9333` | `open -a Antigravity --args --remote-debugging-port=9333` | `antigravity --remote-debugging-port=9333` |

### Windows Notes

- Shortcuts are created correctly even in OneDrive-synced desktop environments
- The shortcut includes the AntiCrow icon

### macOS Notes

- Double-click the `.command` file to launch
- On first run, you may see a "cannot verify the developer" warning
  - **Fix**: Go to `System Settings` → `Privacy & Security` → click `Allow Anyway`
- A shell script is used instead of a symbolic link because `.app` bundles cannot receive arguments via symlinks

### Linux Notes

- A `.desktop` file is created in `~/.local/share/applications/`
- You can search for "AntiCrow" in your application menu to launch it

## CDP Connection

AntiCrow communicates with the Antigravity editor using CDP (Chrome DevTools Protocol). The shell used differs by OS.

| Item | Windows | macOS | Linux |
|------|---------|-------|-------|
| Shell | PowerShell | zsh | bash |
| Command | `powershell.exe -ExecutionPolicy Bypass -NoProfile` | `/bin/zsh -l` | `/bin/bash -l` |

### Troubleshooting

- If your firewall blocks `localhost:9333`, CDP connection will fail
- On macOS, settings in `.zshrc` / `.zprofile` may affect behavior
- On Linux, settings in `.bashrc` / `.bash_profile` may affect behavior

## Process Detection

AntiCrow uses different commands on each OS to detect whether Antigravity is running.

| Item | Windows | macOS | Linux |
|------|---------|-------|-------|
| Detection command | `tasklist.exe` | `pgrep -x Antigravity` | `pgrep -x Antigravity` |
| Process name | `Antigravity.exe` | `Antigravity` | `antigravity` |

### macOS Note

The Language Server binary differs between Apple Silicon and Intel Macs:

- ARM64 (Apple Silicon): `language_server_darwin_arm64`
- Intel: `language_server_darwin_x64`

## Common Settings

### CDP Port

- **Default**: `9333`
- **How to change**: Modify `antiCrow.cdpPort` in Antigravity settings
- When launching from the shortcut, this setting value is automatically used

### Antigravity Installation Path

| OS | Path |
|----|------|
| Windows | `%LOCALAPPDATA%\Programs\antigravity\` |
| macOS | `/Applications/Antigravity.app` |
| Linux | `antigravity` on system PATH |
