# Continuous Auto Mode

> 🤖 AI autonomously executes tasks in sequence

## Overview

Continuous Auto Mode (`/auto`) lets you assign complex tasks to AI for autonomous continuous processing. After each step completes, AI determines the next action and automatically continues execution.

## Usage

### Basic

```
/auto Redesign the landing page
```

### With Options

```
/auto --steps 5 --confirm semi --duration 30 Fix all bugs
```

## Options

| Option | Values | Default | Description |
|--------|--------|---------|-------------|
| `--steps` | 1-20 | 10 | Maximum number of steps |
| `--duration` | 5-120 | 60 | Maximum duration (minutes) |
| `--confirm` | `auto` / `semi` / `manual` | `auto` | Confirmation mode |
| `--select` | `auto-delegate` / `first` / `ai-select` | `auto-delegate` | Selection mode |

## Confirmation Modes

### `auto` (Automatic)

⚡ Executes all steps without confirmation. Most efficient, but risky for unintended operations (Safety Guard protects against this).

### `semi` (Even Steps)

🔄 Pauses at even steps (2, 4, 6...) and asks the user to continue or stop. Balanced between automatic and manual.

### `manual` (Every Step)

✋ Asks for confirmation after every step. Safest, but requires more interaction.

## Selection Modes

### `auto-delegate` (Autonomous)

🤖 Fully delegates task progression to AI. If suggestions are available, AI picks the best one; otherwise, it determines the next action autonomously.

### `first` (First Suggestion)

1️⃣ Automatically selects the first suggestion from the previous step.

### `ai-select` (AI Selection)

🧠 Shows the suggestion list to AI and lets it choose the most appropriate one.

## Safety Guard 🛡️

During Continuous Auto Mode execution, the following dangerous actions trigger an **automatic pause**:

### Blocked (Confirmation Required)

| Category | Example Patterns |
|----------|-----------------|
| Filesystem Destruction | `rm -rf`, `format`, disk operations |
| Git Destructive Ops | `git push --force`, `git reset --hard` |
| Database Destruction | `DROP TABLE`, `TRUNCATE TABLE` |
| Secret Key Access | `private_key`, `secret_key`, `mnemonic` |
| Crypto Operations | `transfer`, `swap`, `withdraw all` |
| External Transmission | `curl + secret`, `post + mnemonic` |
| Env File Leakage | `.env` file output |
| Code Injection | `eval`, `exec()`, `Function()` |

### Safety Trigger Buttons

| Button | Action |
|--------|--------|
| ✅ Approve | Allow this operation and resume the loop |
| ⏭️ Skip | Skip this step and proceed to the next |
| 🛑 Stop | Fully stop Continuous Auto Mode |

## Step Flow

```
🚀 Continuous Auto Mode Start
   ↓
📝 Step 1 Execution
   ↓
✅ Step 1 Complete → Suggestions generated
   ↓
🤖 AI selects next suggestion (based on selection mode)
   ↓
📝 Step 2 Execution
   ↓
   ... (repeats until maxSteps or maxDuration)
   ↓
📊 Continuous Auto Mode Complete
```

## Completion Report

Information displayed when Continuous Auto Mode completes:

- ✅ Completed steps / max steps
- ⏱️ Total time
- 🛡️ Safety trigger count

### Suggestion Buttons

When Continuous Auto Mode completes, if the AI generated suggestions in the last step, **suggestion buttons** are displayed alongside the completion summary. Click a button to immediately execute that action.

| Button | Description |
|--------|-------------|
| 💡🔧🚀 Suggestions | AI-suggested next actions (up to 3) |
| 🤖 Let Agent Decide | AI autonomously picks the best action |
| 🔄 Run in Continuous Auto Mode | Re-run Continuous Auto Mode based on suggestions |

If no suggestions were generated, no buttons are shown.

## How to Stop

To stop Continuous Auto Mode mid-execution:

1. Execute the `/stop` command
2. Click "🛑 Stop" when Safety Guard triggers
3. Click "🛑 Stop" during confirmation prompts

## Settings Persistence

Settings specified with `/auto` are **saved per channel**. Next time you use `/auto` in the same channel, previous settings are applied as defaults.

## Notes

- Continuous Auto Mode is available to all users for free
- During execution, `autoApprove` (auto-approve confirmation dialogs) is temporarily enabled
- After Continuous Auto Mode ends, `autoApprove` reverts to its original setting
- Safety Guard is always active (cannot be disabled)
