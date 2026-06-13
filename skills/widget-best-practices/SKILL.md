---
name: widget-best-practices
description: Best practices for creating rich widgets inline in chat using html_widget tool. Use when displaying dashboards, data visualizations, tables, forms, or any visual presentations.
---

# Widget Best Practices

## Overview

The `html_widget` tool creates rich visual presentations inline in chat instead of plain text. Widgets appear in the conversation and can be added to the dashboard.

> **Note:** Widgets are different from UI Pages. Widgets run in an isolated chat iframe, while UI Pages run in ServiceNow's `gsft_main` frame. See the `ui-pages-best-practices` skill for UI Page guidance.

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
- CSS is fully isolated - use `<style>` tags freely
- **No external dependencies** - no CDN links, external fonts, or libraries
- Use vanilla HTML/CSS/JS only

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
