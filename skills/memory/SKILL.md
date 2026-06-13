---
name: memory
description: Self-improving memory for recording mistakes and solutions. Read knowledge-base.md before tasks to learn from past mistakes, and append new learnings when discovering fixes.
---

# Memory

## Overview

This skill is your **self-improving memory**. When you make mistakes and discover solutions, record them in `knowledge-base.md`. This creates a growing knowledge base that prevents repeating errors.

## How to Use

### Before Starting a Task

Read `knowledge-base.md` in this directory to review accumulated learnings from previous sessions. This helps avoid repeating past mistakes.

At runtime, read it with `get_skill({ skill_id: 'memory', action: 'read_file', filename: 'knowledge-base.md' })` and append entries with `manage_skill({ skill_id: 'memory', action: 'update_file', filename: 'knowledge-base.md', file_content: <existing + new entry> })`. **Exception:** if the AppAgent repo is cloned and extension-dev is active, edit `skills/memory/knowledge-base.md` with the `workspace` tool instead — `manage_skill` writes are ephemeral there and get overwritten by the next build.

### When to Add a Learning

Append a new entry when:
- You make a mistake and discover the fix
- The solution is non-obvious or took investigation
- It's something worth remembering for similar future tasks

**Do NOT record a learning until the solution is confirmed working.**

### Entry Format

```markdown
## [YYYY-MM-DD] - [Topic/Category]

**Mistake:** Brief description of what went wrong

**Fix:** Concise solution (1-3 lines)

**Why:** One sentence explaining why this works
```

**Keep entries concise - aim for 3-5 lines per entry.**

## Example Entry

```markdown
## 2026-01-01 - State Field Type

**Mistake:** Counting incidents by state failed because `i.state === 1` never matched.

**Fix:** Use string comparison: `i.state === '1'` instead of `i.state === 1`.

**Why:** ServiceNow REST API returns field values as strings, not numbers.
```
