# Templates

> 📋 Save frequently used prompts and execute with one click

## Overview

The template feature lets you save commonly used prompts with a name and execute them with a single button click. You can also use variables to dynamically change parameters at execution time.

## Usage

### View Templates

```
/templates
```

Saved templates are displayed as a list with buttons.

### Create New

1. Execute the `/templates` command
2. Click the "➕ New" button
3. Enter a template name and prompt in the modal
4. Save

### Execute a Template

1. Execute the `/templates` command
2. Click the "▶ Run" button for the desired template
3. If there are custom arguments, enter values in the modal
4. After preview, execute

### Delete a Template

1. Execute the `/templates` command
2. Click the "🗑️ Delete" button for the template
3. Confirm deletion

## Variables

You can use the following variables in template prompts:

### Built-in Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `{{date}}` | Today's date | `2026-03-08` |
| `{{time}}` | Current time | `21:00` |
| `{{datetime}}` | Date and time | `2026-03-08 21:00` |
| `{{year}}` | Year | `2026` |
| `{{month}}` | Month | `03` |
| `{{day}}` | Day | `08` |

### Environment Variables

```
{{env:VARIABLE_NAME}}
```

Expands OS environment variables.

### Custom Arguments

```
{{argument_name}}
```

Define custom arguments with any name. Values are entered via modal at execution time (up to 5).

## Template Examples

### Daily Report

**Name:** `daily-report`

**Prompt:**

```
Create a daily report for {{date}}.
Check today's commit log and summarize the changes.
```

### Deploy

**Name:** `deploy`

**Prompt:**

```
Deploy the {{branch}} branch to production.
Make sure tests pass before deploying.
```

→ Enter the `branch` value in the modal at execution time

### Code Review

**Name:** `code-review`

**Prompt:**

```
Review the latest commits.
Check for bugs, security risks, and performance issues, then report improvements.
```
