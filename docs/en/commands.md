# Slash Commands

All available slash commands in AntiCrow.

## Basic Commands

### `/status`

Display bot connection and queue status.

Shows:

- Discord Bot online status
- Antigravity connection status
- Active target (workspace)
- Current AI model and mode
- Scheduled task count
- Queue status


### `/stop`

Stop the currently running task.

- Running jobs → Cancelled
- Queued jobs → Preserved (not deleted)

### `/newchat`

Start a new chat session in Antigravity. Clears the previous conversation context.

### `/help`

Display the command list and usage tips.

---

## AI Control

### `/model`

Display available AI models and switch between them. Click a button to select a model.

### `/mode`

Switch AI mode.

- **Planning** — Plan mode (carefully consider before executing)
- **Fast** — Fast mode (execute quickly)

### `/suggest`

Analyze the project and suggest 3 next actions. Suggestions appear as clickable buttons.

Click "🤖 Delegate to Agent" to let AI automatically select and execute the best suggestion.

---

## Continuous Auto Mode

### `/auto <prompt>`

Start Continuous Auto Mode. AI autonomously executes tasks in sequence.

Options:

- `--steps N` — Max steps (1-20, default: 10)
- `--confirm MODE` — Confirm mode (`auto` / `semi` / `manual`)
- `--select MODE` — Selection mode (`auto-delegate` / `first` / `ai-select`)
- `--duration N` — Max duration in minutes (5-120, default: 60)

Example:

```
/auto --steps 5 --confirm semi Redesign the landing page
```

See [Continuous Auto Mode](auto-mode.md) for details.

---

## Workspace Management

### `/workspace`

Display detected Antigravity workspaces.

- Create new workspaces
- Delete categories
- Pagination support
- Auto-delete information for unused categories


---

## Queue Management

### `/queue`

Display message processing and execution queue details.

Shows:

- 📨 Messages being processed / waiting
- 🔄 Currently executing task
- ⏳ Tasks waiting for execution
- Elapsed time for each message

Queue actions: "✏️ Edit", "❌ Delete", "🗑️ Clear All"

---

## Agent Team Mode

### `/team`

Display the Agent Team Mode management panel.

- Toggle Agent Team Mode on/off
- View active sub-agent status
- Display team settings

See [Agent agent team mode](team-mode.md) for details.

---

## Templates

### `/template`

Display and manage saved templates.

- List all templates
- Create new (modal input)
- Execute / Delete

See [Templates](templates.md) for details.

---

## Schedules

### `/schedules`

Display and manage scheduled executions.

- View schedule list
- Create / Edit / Delete
- Toggle enabled/disabled
- Immediate execution

See [Scheduled Execution](schedules.md) for details.

---

## Customization

### `/soul`

Edit SOUL.md (customization settings). Customize the AI's tone and behavior.

Edit directly via Discord modal (up to 4000 characters).

### `/screenshot`

Capture and send a screenshot of the current screen to Discord.

---

## Updates

### `/update`

Update AntiCrow to the latest version. Downloads the latest VSIX from Cloudflare R2 and installs it automatically.
