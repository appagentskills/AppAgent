---
name: flow-designer
description: A recipe for creating flows in ServiceNow Flow Designer via UI automation. Covers approval flows, trigger configuration, and common patterns.
---

# Flow Designer — UI Automation Recipes

Create ServiceNow flows by driving the Flow Designer UI with `iframe_tool`. No usable REST API exists for flow creation.

## URLs

- Home: `/$flow-designer.do`
- New flow: `/$flow-designer.do#/flow-designer/new`
- New subflow: `/$flow-designer.do#/sub-flow-designer/new/subflow`
- New action: `/$flow-designer.do#/action-designer/new`

Use the direct URLs to skip the home page entirely.

## Gotchas

- **`get_dom` is useless here** — returns ~50KB of Angular bootstrap JS, not rendered UI. Use `get_visible_text` instead.
- **Select2 combobox fields** (Table picker): TWO inputs — a readonly focuser (`#s2id_autogenN`) and the actual search input (`#s2id_autogenN_search`). Fill the `_search` one. `N` varies — discover via `get_visible_text`.
- **Trigger category items** — don't click `li.selected` directly, it won't work. Use the search input (`#action-picker-search-input`), then `dispatch_event` click on the result buttons (e.g., `button[aria-label='Category Record: Created']`).
- **Application scope field** is `#scope`, NOT `#application`.
- **Data pills** (record references) can't be dragged. Use the search/text field and select from autocomplete instead.

## Recipe: Record-Triggered Flow

1. Navigate to `/$flow-designer.do#/flow-designer/new` with `wait: true` — the properties dialog opens directly
2. Fill `#name` with flow name, optionally `#description`. Change scope with `select_option` on `#scope`. Click `#flow_properties_submit_btn`.
3. Click `#flow_trigger_text_toggle` → fill `#action-picker-search-input` with trigger type (e.g., "Created") → `dispatch_event` click on `button[aria-label='Category Record: Created']`
4. Configure table: click Select2 focuser → fill `_search` input with table name → click result from `.select2-results` → click "Done"
5. Click "Add an Action, Flow Logic, or Subflow" → search and select action → configure → click "Done"
6. Save → Activate

## Recipe: Approval Flow

Same as above, plus after the trigger:
1. Add "If" condition block for approval criteria
2. Inside "then" branch, add "Ask for Approval" action
3. Add another "If" to check approval state
4. Add "Update Record" actions for approved/rejected outcomes

## Known Selectors

| Element | Selector | Notes |
|---------|----------|-------|
| Flow name | `#name` | input |
| Description | `#description` | textarea |
| Application scope | `#scope` | select — NOT `#application` |
| Submit button | `#flow_properties_submit_btn` | Active after filling name |
| Cancel button | `#flow_properties_cancel_btn` | |
| Add trigger link | `#flow_trigger_text_toggle` | |
| Add trigger button | `#flow_trigger_add_toggle` | Blue "+" icon |
| Trigger search | `#action-picker-search-input` | |
| Created trigger | `button[aria-label='Category Record: Created']` | Use `dispatch_event` click |
| Created or Updated | `button[aria-label='Category Record: Created or Updated']` | Use `dispatch_event` click |
| Table focuser | `#s2id_autogenN` | Readonly — click to open |
| Table search | `#s2id_autogenN_search` | Fill this one. N varies |
| Add action link | text "Add an Action, Flow Logic, or Subflow" | `.textOpener` class |
| Add action button | `#flow_action_btnToggleAction` | Blue "+" icon |
| Done button | text "Done" | Saves trigger/action config |
| Error handler | `#error-handling-switch` | checkbox |
| More actions | `#btn_moreActionsPopoverButton` | |
| Create new button | `#new_btn` | Home page only |
| Flow dropdown item | `a[aria-label='Flow']` | Home page dropdown |
