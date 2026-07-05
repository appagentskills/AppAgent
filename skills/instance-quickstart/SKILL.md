---
name: instance-quickstart
description: "Common starting-point checks for any ServiceNow instance — log scans, P1 reviews, smoke tests, broken-script hunts, and a global health check. Each one runs as a one-click background action on the home page."
actions:
  - name: Smoke Test Catalog
    icon: play
    show: [home]
  - name: Find Broken Scripts
    icon: code
    show: [home]
---

# Instance Quickstart

A small bundle of the highest-value diagnostic actions to run on any ServiceNow instance. Each action surfaces on the home page as a one-click button — no typing required.

These are **read-only inspections**. They never modify records.

---

## Action Lifecycle: Smoke Test Catalog

Quick smoke test of the Service Catalog: counts active items, checks for missing variables, and surfaces orphaned categories.

1. `update_action_state({ state: 'running', icon: 'play', label: 'Smoke-testing catalog…', tasks: [{label: 'Active catalog items', status: 'running'}, {label: 'Variables coverage', status: 'pending'}, {label: 'Orphaned categories', status: 'pending'}] })`
2. `servicenow_api` GET on `sc_cat_item` with query `active=true`, fields `name,sys_id,category,sys_class_name`, limit 200
3. For each item, check it has at least one variable: GET `item_option_new` with query `cat_item=<sys_id>`, limit 1 (use a single batch query if possible)
4. `servicenow_api` GET on `sc_category` and check that each category has at least one active item
5. Render `card_list` with one card per finding category (Items without variables / Empty categories / Inactive parents)
6. `update_action_state({ state: 'done', icon: 'check', label: 'Catalog: N issues', output: '…' })`

---

## Action Lifecycle: Find Broken Scripts

Hunts for scripts that broke after the last upgrade or deploy.

1. `update_action_state({ state: 'running', icon: 'code', label: 'Scanning scripts…' })`
2. `servicenow_api` GET on `syslog` with `query: source=evaluator^sys_created_on>javascript:gs.daysAgoStart(7)`, fields `message,source,sys_created_on`, limit 100 — these are JS evaluator errors, almost always from broken scripts
3. From each message, extract the script name via regex `/in (sys_script[a-z_]*\.[A-Za-z0-9_]+)/`
4. Cross-reference against `sys_script`, `sys_script_include`, `sys_ui_action`, `sys_ui_policy_action` to identify which records are throwing
5. Render `display` `table` with `[Script type, Name, Last error, Count]`; offer a follow-up `show_action_button` to "Open script" if exact match is found
6. `update_action_state({ state: 'done', icon: 'check', label: 'N broken scripts', output: '…' })`

---

## Notes

- **Read-only.** Never call `POST/PUT/PATCH/DELETE` from these actions.
- Keep result payloads bounded (`limit: 100–200`) so the home action stays snappy.
- Always finish with a meaningful `output` markdown block — the PM only sees the popover.
- Use `auto_dismiss_ms: 4000` for "all clear" results that don't need PM follow-up.
