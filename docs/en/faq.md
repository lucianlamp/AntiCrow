# FAQ

## Setup

### Q: Where do I get a Bot Token?

Create an Application at [Discord Developer Portal](https://discord.com/developers/applications), then go to the Bot section to reset and copy the Token. See [Getting Started](getting-started.md) for details.

### Q: I see "No allowed user IDs configured"

Set your Discord user ID in `antiCrow.allowedUserIds`. Enable "Developer Mode" in Discord Settings → Advanced, then right-click your username → "Copy User ID."

### Q: The bot won't start

Check the following:

1. Is the Bot Token correctly configured? (Command Palette → "AntiCrow: Set Bot Token")
2. Is Antigravity running?
3. Is `antiCrow.autoStart` set to `true`?

---

## Basic Usage

### Q: The bot doesn't respond to my messages

Check the following:

1. Does the status bar show "Active"?
2. Is your ID included in `antiCrow.allowedUserIds`?
3. Is the bot invited to the correct server?
4. Check Antigravity connection status (`/status` command)

### Q: How do I stop a running task?

Use the `/stop` command. The running job will be cancelled.

### Q: What happens if I send another message while a task is running?

It's automatically added to the queue. Once the current task completes, queued tasks are processed in order. Check queue status with `/queue`.

### Q: How do I change the AI model?

Use the `/model` command to display the model list and click a button to switch.

---

## Auto Mode

### Q: Auto mode stops mid-execution

Possible causes:

- Safety Guard triggered (dangerous command detected) → Choose approve/skip/stop
- `--confirm` is set to `semi` or `manual` → Change to `auto`
- Reached `--steps` limit → Increase the value
- `--duration` timeout → Increase the value

### Q: I can't use auto mode

Auto Mode is a **Pro plan exclusive** feature. Upgrade via the `/pro` command.

---

## Team Mode

### Q: How do I use team mode?

1. Upgrade to Pro plan
2. `/team` → "🟢 Team ON" to enable
3. Send messages as usual (AI automatically splits tasks)

### Q: I see "No commits in repository"

Team mode uses Git worktrees and requires at least one commit:

```bash
git init && git add -A && git commit -m "initial commit"
```

---

## License

### Q: What are the Free plan limits?

There are limits on daily and weekly task execution counts. Auto Mode and Team Mode are not available.

### Q: I forgot my license key

Your license key is in the Lemonsqueezy purchase confirmation email.

### Q: Should I choose Monthly or Lifetime?

- **Monthly ($5/mo)**: Better value if you'll use it for less than 10 months
- **Lifetime ($50)**: Better value if you'll use it for 10+ months

---

## Troubleshooting

### Q: I see "Antigravity connection not initialized"

Make sure Antigravity is running. If it still appears, try restarting AntiCrow (Command Palette → "AntiCrow: Stop" → "AntiCrow: Start").

### Q: Responses are timing out

Check `antiCrow.responseTimeoutMs`. Set it to 0 (unlimited) or increase the value. You can also enable retries with `antiCrow.maxRetries`.

### Q: SOUL.md is too long to edit in the modal

The Discord modal limit is 4000 characters. Edit the SOUL.md file directly in a text editor.
