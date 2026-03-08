# Scheduled Execution

> ⏰ Automatically execute tasks on a recurring schedule

## Overview

The scheduling feature lets you run tasks on a cron schedule. Automate recurring tasks like daily reports, periodic test runs, backups, and more.

## Creating Schedules

### Method 1: Automatic Detection from Messages

When you send a Discord message, AI automatically determines whether it should be an "immediate execution" or "scheduled execution."

```
Create a daily report every day at 9am
```

→ AI recognizes this as a scheduled execution and proposes a cron schedule.

### Method 2: Create via `/schedules` Command

1. Execute the `/schedules` command
2. Click the "➕ New" button
3. Fill in the modal:
   - **Name**: Schedule name (e.g., `daily-report`)
   - **Schedule**: Specify in natural language (e.g., `every day at 9am`)
   - **Prompt**: What to execute

### Schedule Format

You can specify schedules in natural language:

| Input Example | Cron Expression |
|---------------|----------------|
| `every day at 9am` | `0 9 * * *` |
| `every Monday at 2:30pm` | `30 14 * * 1` |
| `Monday and Wednesday at 2:30pm` | `30 14 * * 1,3` |
| `first day of every month at 10am` | `0 10 1 * *` |
| `every Friday at 6pm` | `0 18 * * 5` |

## Managing Schedules

Use the `/schedules` command to display the management panel.

### Action Buttons

| Button | Action |
|--------|--------|
| ⏸️ / ▶️ | Pause / Resume schedule |
| ✏️ | Edit schedule (name, schedule, prompt) |
| 🗑️ | Delete schedule |
| ▶️ Run Now | Execute schedule immediately (one-time) |
| ➕ New | Add a new schedule |

## Result Notifications

Scheduled execution results are automatically delivered to the target workspace's Discord channel.

## Notes

- Schedules are only active while Antigravity is running
- Registered schedules persist across Antigravity restarts
- Timezone follows your settings (default: JST / `Etc/GMT-9`)
