# Agent agent team mode

> 👥 Multiple AI sub-agents work on tasks in parallel

## Overview

Agent agent team mode splits large tasks across multiple sub-agents (separate Antigravity windows) for parallel processing. For example, 3 independent file modifications can be handled by 3 sub-agents simultaneously, dramatically reducing processing time.

## Usage

### Enable Agent agent team mode

1. Execute the `/team` command
2. Click the "🟢 Team ON" button

### Disable Agent agent team mode

1. Execute the `/team` command
2. Click the "🔴 Team OFF" button

### Executing Tasks

With Agent agent team mode enabled, when you post a regular message, AI determines:

- If the task is **splittable** → Automatically distributed to sub-agents
- If the task is **not splittable** → Executed by the main agent alone

### Split Criteria

AI splits tasks based on these criteria:

**Split (use Agent agent team mode):**

- Changes spanning 3 or more files
- Work requiring implementation + testing + deployment
- Multiple independent issues to fix simultaneously
- Tasks where research, implementation, and verification can run in parallel

**Don't split (main agent alone):**

- Single file modifications or config changes
- Information queries or question answering
- Simple bug fixes (1-2 files)
- Type checking, testing, or build-only tasks

## Team Management Panel

The `/team` command shows the following:

| Item | Description |
|------|-------------|
| Agent agent team mode | Enabled / Disabled |
| Active Sub-agents | Number of currently active agents |
| Timeout | Maximum execution time for sub-agents |
| Monitor Interval | Progress check interval |
| Auto Spawn | Automatic sub-agent launching |

## Help Mode 🤝

Agent agent team mode includes a built-in **Help Mode**. Sub-agents that finish their tasks early automatically help with other incomplete tasks.

### Help Priority

1. Test creation
2. Documentation updates
3. Code review
4. Unstarted related work

### Constraints

- **Never overwrite** files that other agents are working on
- Each sub-agent works in an independent Git worktree

## Notes

- Agent Team Mode is available to all users for free
- The repository must have at least one commit
- Each sub-agent runs in a separate Antigravity window
- After completion, changes are automatically merged into the main branch
