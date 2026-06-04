---
name: instance-audit
description: "Comprehensive ServiceNow instance audit covering security, health, performance, and best practices. Identifies issues with users, roles, stale records, SLAs, errors, and configuration."
actions:
  - name: Quick Audit
    icon: zap
    show: [home]
  - name: Full Audit
    icon: shield
    show: [home]
  - name: Security Scan
    icon: lock
    show: [home]
---

# Instance Audit Skill

A comprehensive audit tool for ServiceNow instances that checks security, health, performance, and best practices.

## When to Use This Skill

- When asked to "audit" the instance
- When checking instance health or security
- When looking for configuration issues or best practices violations
- During instance reviews or assessments

## Action Lifecycles

When an Action button is clicked, call `update_action_state` frequently to show progress. Use `tasks` for multi-step flows so the PM sees a live checklist on hover.

### Action Lifecycle: Quick Audit

1. `update_action_state({ state: 'running', icon: 'search', label: 'Scanning…', tasks: [{label: 'Run audit', status: 'running'}, {label: 'Render report', status: 'pending'}] })`
2. Call `run_audit({ category: 'all' })`
3. `update_action_state({ state: 'running', icon: 'list', label: 'Building report', tasks: [{label: 'Run audit', status: 'done'}, {label: 'Render report', status: 'running'}] })`
4. Build an `html_widget` summarizing findings (status_summary + table)
5. `update_action_state({ state: 'done', icon: 'check', label: 'N findings', tasks: [{label: 'Run audit', status: 'done'}, {label: 'Render report', status: 'done'}] })`

### Action Lifecycle: Full Audit

Same as Quick Audit but more detailed — include full findings for every category and render a rich dashboard widget. Use tasks for each category: Security, Users, ITSM, System, Config.

### Action Lifecycle: Security Scan

1. `update_action_state({ state: 'running', icon: 'shield', label: 'Checking security…' })`
2. Call `run_audit({ category: 'security' })`
3. For each critical finding, call `update_action_state` with `icon: 'alert'` briefly
4. `update_action_state({ state: 'done', icon: 'check', label: 'Security scan complete' })`

## How to Run Audits

Use `run_audit` to fetch audit data, then display the results in a widget with the data already embedded. Use `js_eval` to chain both steps — call `run_audit`, build the HTML from the findings, then call `html_widget`. Return the `widget_id` to screenshot or edit later.

Do **not** create widgets that call `executeTool()` on load — this triggers permission prompts every time the widget is displayed.

```
run_audit({ "category": "all" })
run_audit({ "category": "security" })
run_audit({ "checks": ["admin_accounts", "breached_slas"] })
```

## Available Audit Checks

| Check ID | Category | Description |
|----------|----------|-------------|
| `admin_accounts` | security | Users with admin role and login status |
| `locked_users` | security | Active users who are locked out |
| `client_callable_scripts` | security | Script includes callable from client |
| `open_acls` | security | ACLs without proper restrictions |
| `security_properties` | security | Critical security property settings |
| `groups_no_manager` | users | Groups without assigned managers |
| `stale_incidents` | itsm | Incidents not updated in 30+ days |
| `breached_slas` | itsm | Active SLAs that are breached |
| `pending_changes` | itsm | Changes past scheduled dates |
| `active_problems` | itsm | Open problems by priority |
| `unassigned_critical` | itsm | Critical tickets without assignee |
| `error_logs` | system | Recent errors in syslog |
| `script_errors` | system | Recurring script/evaluator errors |
| `update_sets` | system | Non-default update sets in progress |
| `non_operational_cis` | config | CIs marked non-operational |

## Example: Display Audit Results in a Widget

```javascript
// In js_eval:
const audit = await executeTool('run_audit', { category: 'all' });
const s = audit.summary;

function severityColor(sev) {
  return { critical: '#ef4444', warning: '#f59e0b', info: '#3b82f6', passed: '#22c55e' }[sev];
}

function renderFindings(items, severity) {
  if (!items.length) return '';
  return items.map(f => `
    <div style="border-left:3px solid ${severityColor(severity)};background:#1e293b;border-radius:6px;padding:12px;margin-bottom:8px;">
      <strong style="color:#f1f5f9;">${f.title}</strong>
      ${f.count ? '<span style="background:' + severityColor(severity) + ';color:#fff;padding:2px 8px;border-radius:10px;margin-left:8px;font-size:12px;">' + f.count + '</span>' : ''}
      <div style="color:#94a3b8;font-size:13px;margin-top:4px;">${f.detail}</div>
      ${f.items ? '<ul style="color:#cbd5e1;font-size:13px;margin:6px 0 0;">' + f.items.map(i => '<li>' + i + '</li>').join('') + '</ul>' : ''}
      ${f.recommendation ? '<div style="background:#0f172a;border-radius:4px;padding:8px;margin-top:6px;color:#38bdf8;font-size:12px;">Recommendation: ' + f.recommendation + '</div>' : ''}
    </div>
  `).join('');
}

const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f172a;color:#f1f5f9;padding:20px;min-height:100%;">
  <h2 style="margin:0 0 16px;">Instance Audit</h2>
  <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px;">
    <div style="background:#1e293b;border-radius:8px;padding:16px;text-align:center;">
      <div style="font-size:28px;font-weight:700;color:#ef4444;">${s.critical_count}</div><div style="color:#94a3b8;">Critical</div>
    </div>
    <div style="background:#1e293b;border-radius:8px;padding:16px;text-align:center;">
      <div style="font-size:28px;font-weight:700;color:#f59e0b;">${s.warning_count}</div><div style="color:#94a3b8;">Warning</div>
    </div>
    <div style="background:#1e293b;border-radius:8px;padding:16px;text-align:center;">
      <div style="font-size:28px;font-weight:700;color:#3b82f6;">${s.info_count}</div><div style="color:#94a3b8;">Info</div>
    </div>
    <div style="background:#1e293b;border-radius:8px;padding:16px;text-align:center;">
      <div style="font-size:28px;font-weight:700;color:#22c55e;">${s.passed_count}</div><div style="color:#94a3b8;">Passed</div>
    </div>
  </div>
  ${renderFindings(audit.critical, 'critical')}
  ${renderFindings(audit.warning, 'warning')}
  ${renderFindings(audit.info, 'info')}
  ${renderFindings(audit.passed, 'passed')}
</div>`;

const widget = await executeTool('html_widget', { html, width: 700, height: 600 });
return widget.widgetId;
```

## Widget Display Guidelines

Display the audit results widget with:
- Dark theme (background: #0f172a, cards: #1e293b)
- Stats grid: Critical (red #ef4444), Warning (yellow #f59e0b), Info (blue #3b82f6), Passed (green #22c55e)
- Sections with colored left border by severity
- Badge with count, bullet list of items, recommendation box
