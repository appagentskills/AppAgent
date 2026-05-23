---
name: instance-quickstart
description: "Common starting-point checks for any ServiceNow instance — log scans, P1 reviews, smoke tests, broken-script hunts, and a global health check. Each one runs as a one-click background action on the home page."
actions:
  - name: Check Logs for Errors
    icon: alert
    show: [home]
  - name: Review Open P1 Incidents
    icon: bug
    show: [home]
  - name: Smoke Test Catalog
    icon: play
    show: [home]
  - name: Find Broken Scripts
    icon: code
    show: [home]
  - name: App Health Check
    icon: stats
    show: [home]
---

# Instance Quickstart

A small bundle of the highest-value diagnostic actions to run on any ServiceNow instance. Each action surfaces on the home page as a one-click button — no typing required.

These are **read-only inspections**. They never modify records.

---

## Action Lifecycle: Check Logs for Errors

Scans `syslog` for recent errors and groups repetitive ones so the PM can spot noisy modules at a glance.

1. `update_action_state({ state: 'running', icon: 'alert', label: 'Scanning system logs…', tasks: [{label: 'Query syslog (last 24h)', status: 'running'}, {label: 'Group repetitive errors', status: 'pending'}, {label: 'Render summary', status: 'pending'}] })`
2. `servicenow_api` GET on `syslog` with `sysparm_query: level=2^sys_created_on>javascript:gs.hoursAgoStart(24)`, fields `level,source,message,sys_created_on`, limit 200
3. Group by `source` and by the first 80 chars of `message` to detect repetition
4. Update tasks as you progress
5. Render via `display` `table` (top sources by count) AND a `status_summary` (Total errors / Unique sources / Top source)
6. `update_action_state({ state: 'done', icon: 'check', label: 'N errors • M unique', output: '**Top sources:** … (markdown summary)' })`

---

## Action Lifecycle: Review Open P1 Incidents

Lists all currently-open P1 incidents and adds context you can act on.

1. `update_action_state({ state: 'running', icon: 'bug', label: 'Loading P1 incidents…' })`
2. `servicenow_api` GET on `incident` with `sysparm_query: priority=1^active=true`, fields `number,short_description,assignment_group,assigned_to,opened_at,sys_updated_on,state`, `url_params: { sysparm_display_value: 'true' }`
3. For each incident, compute "stale hours" = (now - sys_updated_on) / 3600
4. Render via `display` `table` sorted by stale hours desc; flag rows where stale > 4h
5. `update_action_state({ state: 'done', icon: 'check', label: 'N P1s open', output: 'Top stale: …' })`

If there are zero open P1s, finish with an upbeat `output: '✅ No open P1 incidents.'` and `auto_dismiss_ms: 4000`.

---

## Action Lifecycle: Smoke Test Catalog

Quick smoke test of the Service Catalog: counts active items, checks for missing variables, and surfaces orphaned categories.

1. `update_action_state({ state: 'running', icon: 'play', label: 'Smoke-testing catalog…', tasks: [{label: 'Active catalog items', status: 'running'}, {label: 'Variables coverage', status: 'pending'}, {label: 'Orphaned categories', status: 'pending'}] })`
2. `servicenow_api` GET on `sc_cat_item` with `active=true`, fields `name,sys_id,category,sys_class_name`, limit 200
3. For each item, check it has at least one variable: GET `item_option_new` with `cat_item=<sys_id>`, limit 1 (use a single batch query if possible)
4. `servicenow_api` GET on `sc_category` and check that each category has at least one active item
5. Render `card_list` with one card per finding category (Items without variables / Empty categories / Inactive parents)
6. `update_action_state({ state: 'done', icon: 'check', label: 'Catalog: N issues', output: '…' })`

---

## Action Lifecycle: Find Broken Scripts

Hunts for scripts that broke after the last upgrade or deploy.

1. `update_action_state({ state: 'running', icon: 'code', label: 'Scanning scripts…' })`
2. `servicenow_api` GET on `syslog` with `sysparm_query: source=evaluator^sys_created_on>javascript:gs.daysAgoStart(7)`, fields `message,source,sys_created_on`, limit 100 — these are JS evaluator errors, almost always from broken scripts
3. From each message, extract the script name via regex `/in (sys_script[a-z_]*\.[A-Za-z0-9_]+)/`
4. Cross-reference against `sys_script`, `sys_script_include`, `sys_ui_action`, `sys_ui_policy_action` to identify which records are throwing
5. Render `display` `table` with `[Script type, Name, Last error, Count]`; offer a follow-up `show_action_button` to "Open script" if exact match is found
6. `update_action_state({ state: 'done', icon: 'check', label: 'N broken scripts', output: '…' })`

---

## Action Lifecycle: App Health Check

A 60-second high-level snapshot of the instance: open issues, scheduled-job health, and a few signals about the platform itself.

1. `update_action_state({ state: 'running', icon: 'stats', label: 'Running health check…', tasks: [ {label: 'Open incidents', status: 'pending'}, {label: 'Failed scheduled jobs', status: 'pending'}, {label: 'Long-running transactions', status: 'pending'}, {label: 'Storage / queue health', status: 'pending'} ] })`
2. For each task, mark `running`, run the query, then mark `done`/`error`:
   - Open incidents: `incident` count by priority
   - Failed jobs: `sys_trigger` with `state=error`
   - Long-running: `syslog_transaction` with `response_time>5000` in last hour
   - Storage / queue: `sys_email` waiting count, `sys_audit_delete` recent rate
3. Render a `status_summary` with one tile per metric
4. `update_action_state({ state: 'done', icon: 'check', label: 'Health: …', output: '…' })`

---

## Notes

- **Read-only.** Never call `POST/PUT/PATCH/DELETE` from these actions.
- Keep result payloads bounded (`limit: 100–200`) so the home action stays snappy.
- Always finish with a meaningful `output` markdown block — the PM only sees the popover.
- Use `auto_dismiss_ms: 4000` for "all clear" results that don't need PM follow-up.
