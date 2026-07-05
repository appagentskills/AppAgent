---
name: instance-explorer
description: "Quick access to ServiceNow instance structure — tables, business rules, pages, and roles. Renders inline widgets for fast inspection."
actions:
  - name: Show Roles
    icon: shield
    show: [sidebar]
---

# Instance Explorer

Fast, one-click inspection of an instance's structure. Each action queries ServiceNow and renders a sortable table/card list inline so the PM can browse without leaving the current chat.

## When to Use

- When the PM asks "what tables are in this instance?"
- When inspecting business rules, UI pages, or roles
- As a starting point before deeper analysis

## Action Lifecycle: Show Roles

1. `update_action_state({ state: 'running', icon: 'shield', label: 'Loading roles…' })`
2. Call `servicenow_api` GET on `sys_user_role`, fields `name,description,elevated_privilege,grantable,sys_scope`
3. Render via `display` table
4. `update_action_state({ state: 'done', icon: 'check', label: 'N roles' })`

## Tips

- Keep `limit` reasonable (200–500) to keep responses fast
- Use `url_params: { sysparm_display_value: 'true' }` so reference fields render as labels
- Always use the `display` tool (not `html_widget`) for simple tabular data
