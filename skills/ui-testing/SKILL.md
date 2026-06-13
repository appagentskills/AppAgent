---
name: ui-testing
description: "Comprehensive UI testing skill for ServiceNow UI Pages. Covers full UI exploration, form validation, backend validation, edge cases, error display, visual consistency, and bug documentation. Supports three testing levels (smoke, standard, comprehensive) and five user personas."
---

# UI Testing Skill

A structured, thorough approach to testing ServiceNow UI Pages. This skill ensures complete coverage by following a strict testing sequence: explore first, validate everything, and document any bugs found.

## When to Use This Skill

- When asked to "test" a UI page
- When verifying a UI page works correctly after creation or modification
- When doing a full QA pass on a UI page
- When looking for bugs or regressions in a UI page

## Choosing a Testing Level

If the user does not specify a level, default to **Standard**.

| Level | When to Use | Phases |
|-------|-------------|--------|
| **Smoke** | Quick sanity check after a small change, or verifying a page still loads | 0, 2, 3, 9, 10 |
| **Standard** | Default for most testing requests. Full functional coverage | 0, 1, 2, 3, 4, 6, 8, 9, 10 |
| **Comprehensive** | Full QA pass before release, or when specifically asked for thorough/deep testing | All phases (0–10) |

---

## User Personas

Test the page from the perspective of these personas. Not every persona applies to every page — determine which are relevant during Phase 0 (source code review) based on what roles and access levels the page serves.

### 1. Admin
- **Role:** `admin` — full system access
- **Behavior:** Configures the system, manages users and roles, accesses all records, modifies settings
- **Test focus:** Verify all features are accessible. Confirm admin-only actions (delete, configure, override) work correctly. Check that sensitive operations have confirmation dialogs.

### 2. Fulfiller (ITIL User)
- **Role:** `itil` — standard IT service management access
- **Behavior:** Works incidents, changes, problems, and requests. Creates and updates records in their assignment groups. Cannot access admin settings.
- **Test focus:** Verify standard CRUD workflows. Confirm the page filters data correctly to their scope. Check that admin-only UI elements are hidden or disabled.

### 3. End User (Requester)
- **Role:** `snc_internal` or basic access — minimal permissions
- **Behavior:** Submits requests, views their own records, cannot see other users' data. Often the least technical user.
- **Test focus:** Verify the page is usable without technical knowledge. Confirm data is scoped to their own records only. Check that unauthorized actions are blocked both in the UI and the backend. Test with the simplest possible interaction patterns.

### 4. Approver (Manager)
- **Role:** `approver_user` — can approve/reject workflows
- **Behavior:** Reviews requests from their team, approves or rejects items, views team-level dashboards and reports.
- **Test focus:** Verify approval actions work correctly. Confirm they can see their team's data but not other teams'. Check that approved/rejected states update properly in the UI.

### 5. Unauthenticated / No Role
- **Role:** None — a logged-in user with no relevant roles, or in some cases a public-facing page
- **Behavior:** Should be blocked from accessing the page entirely, or see only public content.
- **Test focus:** Verify access control. The page should show an access denied message or redirect — not a broken/empty page. Check that no data leaks through API calls even if the UI blocks access.

### Applying Personas

During testing, for each relevant persona:
1. **Identify which personas apply** based on the page's purpose and the roles it checks (from Phase 0 source review).
2. **Switch personas with impersonation** — use `iframe_tool` with action `impersonate` and `user` set to the persona's username/name/sys_id; pass `user: "stop"` to end impersonation. Always stop impersonation when finished with a persona.
3. **Test the happy path as each persona** — at minimum the Admin and the most restrictive relevant persona.
4. **Verify role-based UI differences** — elements that should be hidden, disabled, or absent for lower-privilege personas.
5. **Verify backend enforcement** — even if the UI hides a button, use `servicenow_api` to call the underlying API directly and confirm the backend also blocks the action for unauthorized roles.

> **Shortcut:** If the page does not have any role-based logic (no ACL checks, no role conditionals in the code), you may skip multi-persona testing and test as the current user only. Note this in your test report.

---

## Testing Levels in Detail

### Smoke Test (Phases: 0, 2, 3, 9, 10)

A fast sanity check. Confirms the page loads, the main workflow works, and there are no backend explosions.

- Read the source code (Phase 0) — quick scan, focus on what the page does and its main workflow
- Explore the full UI (Phase 2) — navigate, screenshot, scroll if needed
- Happy path only (Phase 3) — run the primary workflow as the current user
- Check glide logs (Phase 9) — verify no backend errors
- Document any bugs found (Phase 10)

### Standard Test (Phases: 0, 1, 2, 3, 4, 6, 8, 9, 10)

Full functional testing. Covers forms, empty states, and visual checks. This is the **default level**.

- Everything in Smoke, plus:
- Prepare test data (Phase 1) — ensure records exist for normal and empty scenarios
- Client-side form validation (Phase 4) — test required fields, field types, error display
- Empty states (Phase 6) — verify the page handles no data gracefully
- Theme & visual consistency (Phase 8) — check colors, spacing, alignment
- Test with at least **two personas** if the page has role-based logic (Admin + most restrictive relevant persona)

### Comprehensive Test (Phases: 0–10, all phases)

Full QA pass with deep edge-case coverage. Use before releases or when asked for thorough testing.

- Everything in Standard, plus:
- Backend form validation (Phase 5) — bypass client validation, test server-side enforcement
- Long content & large lists (Phase 7) — overflow, pagination, performance
- Test with **all relevant personas**
- Security-focused inputs (XSS, injection patterns) in Phase 4
- Cross-field validation and duplicate detection in Phase 5

---

## Testing Phases

Follow the phases included in your testing level **in order**. Do not skip phases that are part of your level.

---

### Phase 0: Read the Source Code

Before touching the UI, read the source code of the page under test to understand its structure and identify edge cases.

1. **Read the UI Page record** - Use `servicenow_api` to GET the `sys_ui_page` record. Read both the `html` and `client_script` fields.
2. **Identify all features** - List every form, button, list, modal, tab, and interactive element defined in the code.
3. **Identify data dependencies** - What tables does the page query? What data does it expect? What happens if that data is missing?
4. **Identify validation logic** - What client-side validation exists? What server-side validation exists via API calls?
5. **Identify error handling** - Where are try/catch blocks? Where are error messages displayed vs silently swallowed?
6. **Note edge cases from code** - Look for boundary conditions, optional parameters, empty checks, and conditional rendering.

---

### Phase 1: Prepare Test Data

Before testing, ensure the UI has data to display. Empty pages with no data hide bugs.

1. **Check what data the page needs** - Based on Phase 0, determine what ServiceNow records the page queries.
2. **Verify data exists** - Use `servicenow_api` to query the relevant tables and confirm records exist.
3. **Create test data if needed** - Use `servicenow_api` to INSERT records so the page has content to render. Create enough records to test:
   - **Normal case** - A few typical records
   - **Empty case** - You will test with no records later (delete or filter them out)
   - **Long content** - Records with very long strings in text fields (200+ characters)
   - **Many records** - Enough records to trigger pagination or scrolling (if applicable)
4. **Note the test data created** - Track what you created so you can clean up later if needed.

---

### Phase 2: Full UI Exploration

Get a complete picture of the entire UI before testing anything specific.

1. **Navigate to the page** - Use `iframe_tool` with action `navigate` to open the UI page.
2. **Take a full screenshot** - Use `take_screenshot` to capture the initial state.
3. **Extract visible text** - Use `iframe_tool` with action `get_visible_text` (with `deep: true`) to get a structured view of all visible elements.
4. **Scroll and capture everything** - If the page extends beyond the viewport:
   - Use `iframe_tool` (scroll) with `y: 500` to scroll down (or `position: "bottom"` to jump to end)
   - Take another screenshot after each scroll
   - Repeat until you reach the bottom of the page
   - Use `iframe_tool` (scroll) with `position: "top"` to scroll back to top when done
5. **Document the full UI** - List every visible section, form, button, table, tab, and interactive element you found.
6. **Compare with source code** - Verify that everything defined in the code from Phase 0 is actually rendered.

---

### Phase 3: Happy Path Testing

Start with the expected, normal usage flow.

1. **Identify the primary workflow** - What is the main thing a user does on this page?
2. **Execute the happy path step by step:**
   - Fill forms with valid data using `iframe_tool` action `fill`
   - Click buttons using `iframe_tool` action `click`
   - Take a screenshot after each significant interaction
   - Verify expected outcomes (success messages, data changes, navigation)
3. **Verify backend effects** - After form submissions, use `servicenow_api` to query the target table and confirm the record was created/updated correctly.
4. **Check network requests** - Use `iframe_tool` with action `get_network_requests` to verify API calls succeeded.
5. **Check console logs** - Use `iframe_tool` with action `get_console_logs` to verify no errors occurred.

---

### Phase 4: Form Validation (Client-Side)

Test every form on the page with invalid and edge-case inputs.

For **each form** on the page, test these scenarios:

#### Required Fields
- Submit the form with all fields empty
- Submit with only some required fields filled
- Verify error messages appear **on the page** (not just in console)

#### Field Types
- **Text fields**: Empty string, whitespace only, very long text (500+ chars), special characters (`<script>alert(1)</script>`, `'; DROP TABLE --`, unicode: `日本語`, emojis)
- **Number fields**: Letters, negative numbers, zero, decimals, very large numbers
- **Email fields**: Missing @, missing domain, spaces
- **Date fields**: Past dates, future dates, invalid formats
- **Dropdowns/selects**: First option, last option, verify all options load
- **Checkboxes/toggles**: On/off states, default state

#### Error Display Verification
- Confirm errors are shown as **visible UI elements** (banners, inline messages, highlighted fields)
- Use `take_screenshot` to capture the error state
- Use `get_console_logs` to check if errors are **only** logged to console (this is a bug - errors must be visible to users)

---

### Phase 5: Form Validation (Backend)

Test important input combinations against the backend to verify server-side validation.

1. **Bypass client validation** - Use `servicenow_api` to directly make the same API calls the form would make, but with invalid data, bypassing any client-side checks.
2. **Test important combinations:**
   - Required fields missing in API call
   - Invalid field values that pass client validation
   - Duplicate records (if uniqueness is expected)
   - Cross-field validation (e.g., end date before start date)
3. **Verify backend responses** - Check that the API returns proper error codes and messages.
4. **Verify UI handles backend errors** - If the backend rejects the request, does the UI display the error? Or does it fail silently?

---

### Phase 6: Empty States

Test how the page behaves with no data.

1. **Remove or filter out test data** - Query with filters that return no results, or temporarily remove test records.
2. **Navigate to the page with no data**.
3. **Take a screenshot** and verify:
   - Is there a meaningful empty state message? (e.g., "No records found")
   - Or does the page show a blank area with no explanation? (this is a bug)
   - Are there broken layouts, missing containers, or JavaScript errors?
4. **Check console logs** - Look for null reference errors or failed API calls.

---

### Phase 7: Long Content & Large Lists

Test how the page handles overflow.

1. **Long text content:**
   - Create records with very long text in key fields (500+ chars)
   - Navigate to the page and verify text is truncated or wrapped properly
   - Take a screenshot to check for layout breakage (overflow, overlapping elements)

2. **Large lists:**
   - If the page displays lists or tables, ensure there are many records (50+)
   - Verify pagination works (if implemented)
   - Verify scrolling works within containers
   - Check for performance issues (slow rendering, missing records)

3. **Take screenshots** of any layout issues found.

---

### Phase 8: Theme & Visual Consistency

Check the visual quality of the page.

1. **Color consistency** - Are colors consistent across the page? Do they match the overall theme?
2. **Typography** - Are font sizes, weights, and families consistent?
3. **Spacing** - Are margins and padding consistent between similar elements?
4. **Alignment** - Are elements properly aligned? Are grids and layouts straight?
5. **Interactive states** - Do buttons have hover/active states? Do focused inputs have visible focus rings?
6. **Responsive behavior** - If applicable, test at different viewport sizes using `iframe_tool` (resize) (presets: `mobile`, `tablet`, `desktop`, `fullhd`).
7. **Take screenshots** to document any visual inconsistencies.

---

### Phase 9: Check Glide Logs

After all testing, check the backend logs for errors that may not surface in the UI.

1. **Query syslog for recent errors:**
   ```
   servicenow_api GET syslog
   query: level=0^sys_created_onONToday@javascript:gs.beginningOfToday()@javascript:gs.endOfToday()
   fields: level,source,message,sys_created_on
   limit: 50
   ```
2. **Query for script errors:**
   ```
   servicenow_api GET syslog
   query: source=Evaluator^level=0^sys_created_onONToday@javascript:gs.beginningOfToday()@javascript:gs.endOfToday()
   fields: level,source,message,sys_created_on
   limit: 50
   ```
3. **Review each error** - Determine if it is related to the page under test.
4. **Report any backend errors** found, even if the UI appeared to work correctly. Silent backend errors are bugs.

---

### Phase 10: Bug Documentation

For every bug found during testing, document it with the following format:

```
## Bug: [Short descriptive title]

**Severity:** Critical / High / Medium / Low
**Phase Found:** [Which testing phase]

**Steps to Reproduce:**
1. [Step 1]
2. [Step 2]
3. [Step 3]

**Expected Result:**
[What should happen]

**Actual Result:**
[What actually happens]

**Evidence:**
- Screenshot: [reference to screenshot taken]
- Console errors: [any console errors captured]
- Network errors: [any failed API calls]
- Glide log errors: [any backend errors]

**Code Reference:**
[Relevant code location from Phase 0 source review]
```

---

## Tool Reference

| Tool | Purpose |
|------|---------|
| `iframe_tool` (navigate) | Open a URL in the browser panel |
| `iframe_tool` (get_visible_text) | Extract all visible text and elements (use `deep: true`) |
| `iframe_tool` (get_dom) | Get the full HTML structure |
| `iframe_tool` (click) | Click an element by CSS selector |
| `iframe_tool` (fill) | Fill an input field by CSS selector |
| `iframe_tool` (get_console_logs) | Get browser console output |
| `iframe_tool` (get_network_requests) | Get network request/response log |
| `iframe_tool` (dispatch_event) | Trigger DOM events (hover, focus, change, keydown, etc.) |
| `iframe_tool` (select_option) | Select option in a dropdown by value or text |
| `iframe_tool` (scroll) | Scroll page to position, coordinates, or element |
| `iframe_tool` (resize) | Resize viewport (presets: mobile, tablet, desktop, fullhd) |
| `iframe_tool` (get_properties) | Read computed styles, dimensions, values, attributes of elements |
| `iframe_tool` (set_style) | Apply CSS styles or toggle classes on elements |
| `iframe_tool` (impersonate) | Impersonate a user for persona testing (`user: "stop"` to end) |
| `take_screenshot` | Capture the browser panel or a specific element as PNG |
| `servicenow_api` | Query, create, update ServiceNow records |

## Key Principles

1. **Explore first, test second** - Never start testing specific features until you have a complete picture of the UI.
2. **Screenshot everything** - Take screenshots before and after every significant action. Visual bugs are easy to miss with text-only inspection.
3. **Errors must be visible** - If an error only appears in `console.log` and not in the UI, that is a bug.
4. **Always check the backend** - A successful-looking UI can mask backend failures. Always verify with API queries and glide logs.
5. **Start happy, then break it** - Confirm the page works correctly before trying to break it.
6. **Read the code** - Source code review reveals edge cases that exploratory testing alone would miss.
7. **Scroll down** - If content might extend beyond the viewport, scroll and capture. Hidden content is untested content.
8. **Document reproducibly** - Every bug must have clear steps to reproduce. A bug without repro steps is just a rumor.
9. **Think in personas** - A page that works for an admin may be broken for an end user. Always test from the perspective of the least-privileged relevant persona.
10. **Match depth to context** - Use Smoke for quick checks, Standard for regular testing, Comprehensive for release-quality QA. Don't over-test trivial changes or under-test critical pages.
