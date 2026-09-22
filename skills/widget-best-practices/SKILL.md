---
name: widget-best-practices
description: Best practices for creating rich widgets inline in chat using html_widget tool. Use when displaying dashboards, data visualizations, tables, forms, or any visual presentations.
---

# Widget Best Practices

## Overview

The `html_widget` tool creates rich visual presentations inline in chat instead of plain text. Widgets appear in the conversation and can be added to the dashboard.

> **Note:** Widgets are different from UI Pages. Widgets run in an isolated chat iframe, while UI Pages run in ServiceNow's `gsft_main` frame. See the `ui-pages-best-practices` skill for UI Page guidance.

## Permanent identity and saved versions

- **Iteration is a new version, not a new widget.** Keep the existing `widget_id` for fixes, redesigns, regeneration, and follow-ups. Never infer identity from title/HTML.
- Read first: `html_widget({action:"read", widget_id:"widget_…"})` returns HTML, `latest_version` and history. Save the SAME `widget_id`, with `expected_version` from that read and a unique `operation_id`. On `VERSION_CONFLICT`, read and reconcile; never blindly overwrite.
- `action:"list"` discovers retained widgets even after unpin/chat deletion. `action:"read", version:N` reads history without restoring it.
- Omitted `widget_id` follows the explicit widget-edit target on the **current user request only**. A later ordinary user request does not inherit that target; pass the permanent `widget_id` explicitly to continue editing. The “Edit with agent” composer target is consumed once when its prefilled request is sent. `create_new:true` deliberately creates a distinct artifact, never an iteration. Return `widget_id` and `version` from js_eval.
- Reuse `operation_id` only for an identical retry; separate edits need new keys. Top-level tool-call IDs are a fallback; sandbox/js_eval retry chains need explicit stable keys.
- All users can choose Latest or history independently per mounted view. Latest follows saves; history selection never modifies saved content. Reopened views default to Latest.
- Manual code saves and `iframe_tool edit_html` append versions too; edit_html requires `expected_version`. `widget_eval` remains runtime-only and never auto-saves.

## When to Use Widgets

Use `html_widget` when showing:
- **Data summaries, statistics, or metrics** - Dashboards with charts/gauges
- **Lists or tables of information** - Styled HTML tables or cards
- **Progress indicators or status displays** - Visual progress bars, status badges
- **Interactive forms for user input** - Collect data from users
- **Infographics or visual explanations** - Diagrams, flowcharts, visual guides

## Technical Constraints

### Environment
- Widgets run in an **isolated iframe** - no access to parent window or page globals
- **`executeTool()`** is available for calling agent tools (including ServiceNow API)
- CSS is fully isolated - use `<style>` tags freely (the app's design tokens ARE pre-injected, see below)
- **No external dependencies** - no CDN links, external fonts, or libraries
- Use vanilla HTML/CSS/JS only

### Live script execution: `widget_eval`

Use `widget_eval` to inspect or modify **one exact live render**, without replacing its HTML or losing its JS/DOM state. This is not a persistent job/event system. Changes are not saved to the widget artifact.

1. Discover mounted copies with `widget_eval({action: "list"})`. Each record has `instance_id`, saved `widget_id`, `surface` (`chat`, `dashboard`, `fullscreen`), `ready`, and `visible`. Select the user's intended copy; never choose an arbitrary same-widget match.
2. Execute an async function body with `widget_eval({action: "eval", instance_id: "wi_…", code: "await Promise.resolve(); return document.title;", timeout_ms: 10000})`.
3. Success returns `{success: true, instance_id, result}`. Errors return `{success: false, code, error}` (usually also `instance_id`). Return plain JSON data. Top-level `undefined` becomes `null`; circular values, functions, symbols, BigInt, non-finite numbers, nested `undefined`, DOM nodes and non-JSON class objects are rejected. JSON envelopes and input code are limited to **65,536 UTF-16 characters**; error messages to 1,024 characters. JSON `toJSON` conversions (for example Date → ISO string) follow ordinary JSON semantics.

**Identity/lifecycle:** `instance_id` is a random per-render ID, **not** a saved `widget_…` ID. Chat, dashboard and fullscreen copies of the same widget have different IDs. Reopening, rerendering, navigating, or closing invalidates the old ID. Unavailable/not-ready targets return `INSTANCE_UNAVAILABLE`; there is no saved-ID fallback, auto-recreation, offscreen clone or parked replay. The tool probes connected foreground panels and dispatches only to the owning panel. `window._widgetInstanceId` is exposed inside the widget for convenience, but the parent resolves identity from the actual message source, never a widget claim.

**Origin → background agent:** a widget's `executeTool("start_chat", {message: "Update this widget's progress", background: true})` automatically includes its exact live origin in the new agent message, even without `include_widget`. The background chat stays top-level, so it can target that ID while the render remains mounted. Foreground sends/drafts can close or replace the origin; the agent must report that ID unavailable rather than silently use a different copy.

**Security/limits (v1):** execution requires an identified **top-level chat**. Sub-agents, including full-roster subs, may list but cannot execute (`RESTRICTED_CONTEXT`); unknown callers fail closed. A top-level agent may review worker-proposed code and execute it itself. Normal tool approvals still apply (`widget_eval:list` is read-only; execution uses `widget_eval`), and denial is a hard stop. Code runs only in the manifest-sandboxed widget iframe; no privileged-panel eval or private-token injection. The widget's existing `executeTool` bridge and later asynchronous callbacks keep their ordinary widget attribution/permissions — **there is no per-callback evaluating-agent provenance guarantee**. Do not use this tool to transfer a restricted worker's authority into a widget.

`timeout_ms` is an integer from 100–30,000 (default 10,000), bounding the **response wait, not cancellation**. A synchronous infinite loop may freeze its renderer; a timed-out async script can still mutate state or call tools later. One pending evaluation per render returns `INSTANCE_BUSY` for concurrent calls; after timeout this guard no longer implies the older script stopped. Keep scripts short, await intended work, and do not start persistent loops. Transport discovery/approval waits are separately bounded (60s per panel, 90s execution transport).

### Native fullscreen media

Widget iframe mounts delegate native fullscreen. Call `video.requestFullscreen()` (or a local container's method) **directly from a genuine user click**, and catch rejection to show a useful message. Browser activation/policy still applies: an agent script or synthetic click cannot manufacture user activation. Any nested iframe must also delegate fullscreen. Existing AppAgent fullscreen overlays remain distinct renders; do not add floating buttons to unrelated websites.

### Design tokens (auto-injected)

Every widget gets a `<style data-appagent-tokens="1">` block prepended, so `var(--token)` works with no setup. Light/dark switches **live** - an attribute flip on `<html>`, no re-render, widget state survives. Both injected selectors are wrapped in `:where()` (zero specificity), so **any** rule of your own overrides a token - `:root{}`, `body{}`, `.cls{}` or an inline `style=`. The block is added at render time and is **not** part of the stored widget HTML (so don't `edit_html` against it).

`color-scheme` is deliberately NOT set, so set your own: `body { background: var(--bg-main); color: var(--text-primary); }`.

These tokens are **always defined**, so a `var(--x, fallback)` fallback will never be used - pick an explicit value, or a different custom-property name, if you need your own default.

| Token | Light | Dark |
|---|---|---|
| `--primary` `--primary-hover` `--primary-light` | `#293E6B` `#1e2f52` `#e8f0fa` | `#6b8bc4` `#85a1d4` `#1e2a42` |
| `--accent` | `#0891b2` | `#22d3ee` |
| `--success` `--warning` `--danger` `--info` | `#059669` `#d97706` `#dc2626` `#3b82f6` | `#34d399` `#fbbf24` `#f87171` `#60a5fa` |
| `--border` `--border-light` | `#e5e7eb` `#f0f0f0` | `#2e3138` `#252830` |
| `--text-primary` `--text-secondary` `--text-muted` | `#1f2937` `#6b7280` `#9ca3af` | `#e5e7eb` `#9ca3af` `#6b7280` |
| `--text-heading` `--text-link` | `#111827` `#2563eb` | `#f3f4f6` `#60a5fa` |
| `--bg-main` `--bg-light` `--bg-hover` | `#fff` `#f9fafb` `#f3f4f6` | `#111317` `#181a1f` `#1f2228` |
| `--bg-code` `--bg-secondary` | `#f5f5f5` `#f3f4f6` | `#1a1d24` `#1a1d24` |
| `--shadow-sm` `--shadow-md` | `0 1px 3px rgba(0,0,0,0.08)` `0 2px 8px rgba(0,0,0,0.1)` | `0 1px 3px rgba(0,0,0,0.3)` `0 2px 8px rgba(0,0,0,0.4)` |
| `--space-2` `-4` `-6` `-8` `-10` | `4px` `8px` `12px` `16px` `24px` | same |
| `--text-caption` `--text-body-sm` `--text-body` `--text-body-lg` `--text-xl` `--text-2xl` | `11px` `12px` `13px` `14px` `16px` `18px` | same |
| `--radius-sm` `-md` `-lg` `-xl` | `4px` `6px` `8px` `12px` | same |
| `--font-sans` `--font-mono` | system-ui stack / SFMono-Regular stack | same |

### Sizing
- Use **static width and height** that best suits the content
- Set explicit dimensions when calling the tool
- The widget can be responsive internally, but the container size must be specified

## ServiceNow API Access

Use `executeTool()` to call the ServiceNow API. This goes through the permission system:

```javascript
const response = await executeTool('servicenow_api', {
    method: 'GET',
    scope: 'global',
    table: 'incident',
    limit: 10,
    fields: 'sys_id,number,short_description'
});
// response.data.result contains the API response
```

### Common API Parameters

| Parameter | Purpose | Example |
|-----------|---------|---------|
| `scope` | `'global'` or a scoped-app sys_id; required for POST/PUT/PATCH | `scope: 'global'` |
| `limit` | Limit results | `limit: 100` |
| `query` | Filter records | `query: 'active=true'` |
| `fields` | Limit fields returned | `fields: 'sys_id,number'` |
| `sys_id` | Get specific record | `sys_id: 'abc123'` |
| `url_params` | Additional params | `url_params: { sysparm_display_value: 'true' }` |

## Ask-the-agent buttons

A widget button can hand a question off to a NEW chat with the `start_chat` tool:

```html
<button id="ask">Ask the agent</button>
<script>
document.getElementById('ask').onclick = async function () {
    // send = answered immediately; background:true keeps THIS widget on screen
    await executeTool('start_chat', { message: 'Why is this SLA breaching?', mode: 'send', background: true, include_widget: true });
    // draft = prefill + focus the composer, user presses enter:
    // await executeTool('start_chat', { message: 'About this chart: ', mode: 'draft', include_widget: true });
};
</script>
```

`include_widget: true` prepends `Context: widget <id> ("<title>") — read it with iframe_tool get_visible_text or take_screenshot.` using the CALLING widget's id (also readable as `window._widgetId`). In foreground modes (`send` without `background`, and `draft`) the view switches to the new chat and this widget's iframe is destroyed — don't await feedback there; use `background: true` if the button must show a result.

## Common Gotchas

| Issue | Cause | Fix |
|-------|-------|-----|
| Field comparison fails | API returns strings, not numbers | Use `=== '1'` not `=== 1` |
| Reference field shows sys_id | Missing display value param | Add `url_params: { sysparm_display_value: 'true' }` |
| Empty response | ACLs blocking access | Check user permissions |
| Widget debugging tools don't work | Widget iframe is isolated from UI Page iframe | Add console.log and display debug output in the widget itself |

## Best Practices

1. **Prefer `js_eval` to prepare data, then display the widget** - Instead of having the widget fetch data itself via `executeTool()`, use `js_eval` to fetch and process data first, then call `html_widget` from within `js_eval` with the data already embedded in the HTML. This is faster (no extra round-trips from the widget iframe), easier to debug, and avoids permission prompts inside the widget. Return the `widget_id` from `js_eval` so you can later take a screenshot of it or edit it.
2. **Self-contained** - All HTML, CSS, and JS in a single widget
3. **Static sizing** - Set explicit width/height when calling the tool
4. **Error handling** - Always handle executeTool failures gracefully
5. **Loading states** - Show loading indicators while fetching data (only needed when the widget fetches its own data)
6. **Only call `executeTool()` after user interaction** - If a widget must call `executeTool()` itself (instead of receiving pre-fetched data), only do so in response to a user action (button click, form submit, etc.). Never call `executeTool()` on widget load — it triggers a permission prompt every time the widget is displayed or re-rendered.

## Example: Incident Table via js_eval

```javascript
// In js_eval:
const res = await executeTool('servicenow_api', {
  method: 'GET', scope: 'global', table: 'incident',
  query: 'active=true', fields: 'number,short_description', limit: 10
});
const rows = (res.data.result || []).map(r =>
  '<tr><td>' + r.number + '</td><td>' + r.short_description + '</td></tr>'
).join('');
const widget = await executeTool('html_widget', {
  title: 'Active Incidents',  // required
  html: '<table><tr><th>Number</th><th>Description</th></tr>' + rows + '</table>',
  width: '600px', height: '400px'  // strings, not numbers
});
return widget.widgetId; // use this to screenshot or edit later
```
