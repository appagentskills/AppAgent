---
name: quick-actions
description: "Common PM workflows — test the current page, show recent changes, find defects. One-click buttons that run from anywhere."
actions:
  - name: Test This Page
    icon: eye
    show: [home]
  - name: Recent Changes
    icon: clock
    show: [home]
  - name: Find Defects
    icon: bug
    show: [home]
---

# Quick Actions

One-click workflows a PM does daily on ServiceNow.

## Action Lifecycle: Test This Page

Runs a smoke test on the page currently open in the browser panel.

1. `update_action_state({ state: 'running', icon: 'eye', label: 'Capturing page…', tasks: [{label: 'Get page info', status: 'running'}, {label: 'Check for errors', status: 'pending'}, {label: 'Visual snapshot', status: 'pending'}] })`
2. `iframe_tool` action `get_page_info` — verify there IS an active page
3. `iframe_tool` action `get_console_logs` — check for JS errors
4. `update_action_state` with `tasks` progress
5. `take_screenshot` to capture the current view
6. Render findings via `display` (`status_summary`) with counts: errors, warnings, load time
7. `update_action_state({ state: 'done', icon: 'check', label: 'Tested — N issues' })`

## Action Lifecycle: Recent Changes

Shows what's been changed in the instance in the last 24 hours.

1. `update_action_state({ state: 'running', icon: 'clock', label: 'Loading changes…' })`
2. `servicenow_api` GET on `sys_update_xml` with `query: sys_updated_on>javascript:gs.hoursAgoStart(24)` and fields `name,target_name,type,sys_updated_on,sys_updated_by`
3. Render via `display` `table` sorted by `sys_updated_on` desc
4. `update_action_state({ state: 'done', icon: 'check', label: 'N changes in 24h' })`

## Action Lifecycle: Find Defects

Looks for common configuration defects across the instance.

Use `tasks` to show progress:
- Check business rule errors (syslog)
- Check inactive required fields
- Check duplicate ACLs
- Check orphaned catalog items

1. Initial: `update_action_state({ state: 'running', icon: 'bug', label: 'Scanning for defects…', tasks: [...all 4 pending] })`
2. For each check, mark task `running`, run the query, mark `done` (or `error`), then update again
3. Final: render `display` `card_list` with one card per defect category; `update_action_state({ state: 'done', icon: 'check', label: 'N defects found' })`

## Notes

- Never impersonate or modify records — these are inspection-only actions
- Keep queries bounded (`limit: 100`) so results stay quick
- If no active ServiceNow tab, return early with `state: 'error'` and a helpful label
