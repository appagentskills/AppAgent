# Testing UI Pages Guide

## Before Testing

Define the test scenarios for the UI page before starting to test. What should the page do? What user interactions should work?

## Available Tools

### Inspection Tools

| Tool | Action | Description |
|------|--------|-------------|
| `take_screenshot` | - | Capture a real PNG screenshot for visual analysis |
| `iframe_tool` | `get_visible_text` | Extract visible text content. Use `deep: true` for structured output with rect, selector, id |
| `iframe_tool` | `get_dom` | Get the full DOM/HTML structure of the page |
| `iframe_tool` | `get_console_logs` | Get browser console log output |
| `iframe_tool` | `get_network_requests` | Get network request/response log |
| `iframe_tool` | `get_properties` | Get computed styles, dimensions, values, and attributes of elements. Use `include` to select: `rect`, `styles`, `value`, `attributes` |

### Interaction Tools

| Tool | Action | Description |
|------|--------|-------------|
| `iframe_tool` | `navigate` | Open a URL in the browser panel |
| `iframe_tool` | `click` | Click an element by CSS selector |
| `iframe_tool` | `fill` | Fill an input field by CSS selector and value |
| `iframe_tool` | `select_option` | Select a dropdown option by `value` or visible `text` |
| `iframe_tool` | `dispatch_event` | Trigger DOM events: click, change, input, focus, blur, submit, mouseenter, mouseleave, keydown, keyup. Use `key` param for keydown/keyup (e.g. "Enter", "Escape", "Tab") |
| `iframe_tool` | `scroll` | Scroll to `position` (top/bottom), coordinates (`x`/`y`), or a CSS `selector` |
| `iframe_tool` | `resize` | Resize viewport with `preset` (mobile, tablet, desktop, fullhd) or custom `width`/`height` |
| `iframe_tool` | `set_style` | Apply CSS styles (`styles` object) or toggle classes (`className`: "add:cls", "remove:cls", "toggle:cls") |
| `iframe_tool` | `impersonate` | Impersonate a ServiceNow user by username, name, or sys_id. Use `user: "stop"` to end |

### Editing Tools

| Tool | Description |
|------|-------------|
| `servicenow_diff_edit` | Edit UI Page `html` or `client_script` fields using search-and-replace. Use to fix issues found during testing |
| `servicenow_api` | Query, create, update ServiceNow records. Use to verify backend effects of form submissions |

## Testing Steps

### 1. Open the UI Page and Take a Screenshot

Navigate to the UI page and capture it visually:

```
iframe_tool({ action: "navigate", url: "/<page_name>.do" })
take_screenshot()
```

Verify that the page loads correctly and displays the expected content.

### 2. Inspect the Page

Use inspection tools to understand the page state:

- **`get_visible_text`** with `deep: true` - Get a structured view of all visible elements with their selectors
- **`get_dom`** - Examine the HTML structure
- **`get_console_logs`** - Check for JavaScript errors
- **`get_network_requests`** - Verify API calls succeeded

If the page extends beyond the viewport:
- Use `scroll` with `position: "bottom"` or `y: 500` to scroll down
- Take screenshots after each scroll
- Use `scroll` with `position: "top"` to return to the top

### 3. Test Interactions

Run through test scenarios using the interaction tools:

- Fill forms with `fill`
- Click buttons with `click`
- Select dropdowns with `select_option`
- Trigger events with `dispatch_event` (e.g. hover, focus, keydown)
- Take a screenshot after each significant interaction

### 4. Verify Backend Effects

After form submissions, use `servicenow_api` to query the target table and confirm records were created/updated correctly.

### 5. Test Responsive Behavior (if applicable)

Use `resize` with presets to check different viewport sizes:

```
iframe_tool({ action: "resize", preset: "mobile" })
take_screenshot()
iframe_tool({ action: "resize", preset: "tablet" })
take_screenshot()
iframe_tool({ action: "resize", preset: "desktop" })
```

### 6. Fix Issues Found

Use `servicenow_diff_edit` to fix code issues directly:

```
servicenow_diff_edit({
  table: "sys_ui_page",
  sys_id: "<page_sys_id>",
  field: "client_script",
  edits: [{ find: "buggy code with context", replace: "fixed code" }]
})
```

Then re-test to verify the fix.

## Troubleshooting

### Page not loading

1. **Jelly in the HTML field** - Jelly can cause silent failures. Make sure there is no Jelly code in the UI page.

2. **Script tag inside the HTML field** - All JavaScript must go in the client_script field, not in `<script>` tags within the HTML field.

3. **Empty html body after save** - ServiceNow silently rejects invalid HTML (returns HTTP 200 but doesn't save). Use `servicenow_api` to GET the record back and compare the `html` field with what you sent. Common causes: unescaped XML entities (`&times;` instead of `&#215;`), unclosed tags, HTML comments (`<!-- -->`).

4. **Template literals in client_script** - `${...}` is interpreted by Jelly before reaching the browser. Use string concatenation instead.

### Console errors but page looks fine

Check `get_console_logs` for JavaScript errors that don't surface in the UI. These are still bugs - errors should be visible to users, not silently swallowed.

### API calls failing

Use `get_network_requests` to inspect failed requests. Common causes:
- Missing `X-UserToken: window.g_ck` header
- Wrong table name or query syntax
- ACL restrictions for the current user
