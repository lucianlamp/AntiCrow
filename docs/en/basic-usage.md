# Basic Usage

## Sending Messages

The basic usage of AntiCrow is simply sending a message in a Discord text channel.

### Steps

1. Open the Discord server where the AntiCrow Bot is present
2. Post your task in natural language in a text channel
3. AI generates an execution plan and displays a confirmation message
4. Click ✅ (Approve) or ❌ (Reject) to control execution
5. Results are delivered to Discord upon completion

### Examples

```
Create a README in both Japanese and English
```

```
Fix the bug in src/utils.ts. There's a missing null check
```

```
Run all tests and fix any failures
```

## Confirmation Flow

When you send a message, AntiCrow processes it as follows:

1. **📥 Message Received** — Parse the message
2. **🧠 Plan Generation** — AI generates an execution plan as JSON
3. **📋 Confirmation** — Display the plan in Discord for approval
4. **✅ Approve / ❌ Reject** — User decides
5. **⏳ Execution** — Antigravity executes the task
6. **📊 Progress** — Real-time progress updates
7. **✅ Complete** — Results delivered to Discord

## Approval Buttons

| Button | Action |
|--------|--------|
| ✅ Approve | Execute the task |
| ❌ Reject | Cancel the task |
| 🤖 Delegate to Agent | Let AI decide the execution |

## File Attachments

You can attach images or text files to your Discord message. The AI will read the file contents and incorporate them into the task.

```
Create a landing page based on the attached design image
```

## Queuing

If you send additional messages while a task is processing, they are automatically queued. When the current task completes, the next queued task is processed in order.

Check queue status with the `/queue` command.

## Workspace Management

AntiCrow automatically creates Discord categories for each workspace. Each category contains an `#agent-chat` channel for interaction.

- Use `/workspace` to view the workspace list
- Create new workspaces directly from Discord
- Unused categories are auto-archived (configurable)

## Stopping a Task

To interrupt a running task, use the `/stop` command:

```
/stop
```

- Running jobs → Cancelled
- Queued jobs → Preserved

## Tips

> 💡 **1 message = 1 task** improves accuracy

> 📎 Attach images or text files for context

> ⏱️ Messages sent during processing are auto-queued

> ⏹️ Use `/stop` to cancel a running task
