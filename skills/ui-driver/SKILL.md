---
name: ui-driver
description: "Drive ServiceNow Employee Center (ESC) Service Portal UI components from the agent. For each task you compose a small, disposable js_eval script that opens, fills, commits, and validates the real on-screen controls (select2, date pickers, list collectors, native inputs) via iframe_tool. Use when there is no Table API / record-producer path and you must operate the rendered form."
---

# ui-driver — driving ESC portal UI components

A field guide for programmatically operating the **Employee Center** portal (`/esc`). Each component type needs its own open/fill/commit/close dance; this skill gives you a verified recipe per component, plus the overall approach.

> **Employee Center** (the `esc` portal) is a *Service-Portal-based* portal (Angular + jQuery **select2**), **not** Next Experience / `sn-record-picker` web components. A catalog item form renders `.select2-container` elements and **zero** `sn-record-picker`, so the select2 recipes here apply across the whole catalog.
>
> **Beyond the catalog:** the same portal also hosts **custom SP widgets** that are *not* catalog items (e.g. a registration/intake form at `/esc?id=<widget_id>`). They render the **same** select2 / native controls and the recipe **mechanics** apply unchanged — but their **anchoring and surrounding assumptions differ**: **no** `#s2id_sp_formfield_*` ids, **modals**, **multi-stage wizards**, and primary buttons that often **are** genuinely validity-gated. See `select2.md` (custom-widget anchoring), `modals.md`, and the Standard loop's re-profile step.

## The approach: write a disposable driver script each time

We do **not** ship a generic "fill any form" function. Instead, for each task you **compose a small `js_eval` script** that calls `iframe_tool` actions to drive the specific controls in front of you, assembling the per-component recipes below. Why:

- ESC forms are **dynamic** — catalog variables, UI policies, and reference qualifiers mean the field set is only knowable at runtime.
- Each component needs a **specific** interaction sequence; you pick the matching recipe for each field present.
- A script lets you **reload-fresh → fill → assert validity** (read the primary button's `disabled`) as one holistic check.

**Standard loop:**

1. `iframe_tool navigate` to the page; `wait_for` a known field to confirm render.
2. Identify the controls present (by label/placeholder, or profile the DOM).
3. For each control, run the matching recipe (component files below).
4. Commit via the component's **explicit** mechanic (e.g. select2 = `mouseup` on the result label; prefer it over Enter).
5. **Re-profile after every commit.** A commit can (a) reveal **new fields in place** (conditional rendering — e.g. timezone-dependent date-time fields that render only *after* a Location field is set, since they need its timezone), or (b) close the current overlay and open a **new** one (a multi-stage wizard — e.g. an *Add* dialog that then opens a second details modal). Never assume the first field set is complete.
6. Assert: **no drop left open** + the primary button (Order / Submit / Create) is **enabled** *(only when it's genuinely validity-gated — see Golden rules)*.

## Golden rules (every component)

- **API first.** If the job maps to a UI Action or record producer, prefer the Table API / `servicenow_run_script`. Drive the UI only when there is genuinely no API path, or the task *is* "operate the rendered form".
- **Commit, then wait for the close signal.** Every widget has an explicit commit + close event. `wait_for selector_gone` on the close signal — never sleep-and-hope.
- **Validity — prefer per-field signals; the primary button is often NOT wired to validity.** The standard ESC **SC Catalog Item** widget renders an **"Order Now"** button bound to `ng-disabled="disableControls()"` (a processing flag) that stays **enabled even when required fields are empty** (verified live) — so do **not** gate on `#submit-btn.disabled` there. **Treat this diagnostically, not absolutely:** before trusting *or* distrusting any primary button, **read its `ng-disabled` expression** (`get_dom` the button). If it references only a **processing flag** (`disableControls()`, `isSubmitting`) the disabled state is **not** a validity signal; if it references **real form/field validity** (`!formValid`, `!isValid`, a required-count) the disabled state **IS** trustworthy. Verified live: a custom SP widget gated its primary button on `ng-disabled="!formValid"` (and a Confirm button on a minimum row count), so there the enabled/disabled flip is reliable. Use **per-field** signals instead: a select2 has non-empty `.select2-chosen` (empty carries `.select2-default`); a List Collector's hidden `#sp_formfield_<var>` is a non-empty CSV; a satisfied mandatory field's asterisk `#<var> span.mandatory` gains class `mandatory-filled` (⚠️ detect it via the `aria-label="Required Filled"` flip, **not** a bare `/mandatory-filled/` regex — the asterisk's `ng-class` binding literal always contains that string; see `native-inputs.md`); an invalid field shows `has-error`. *Some* other SC widgets (a "Submit"-button record-producer) **do** flip `#submit-btn.disabled` — use it only after confirming it actually toggles when a required field is cleared.
- **Reading classes — use `classList`.** `get_properties` now ALWAYS returns `className` (string) **and** `classList` (array) alongside `.value`/`.checked`/`.disabled`/`visible`. For class-based assertions (`mandatory-filled`, `has-error`, `select2-highlighted`, …) test `properties.classList` directly (e.g. `classList.includes("select2-highlighted")`) instead of scraping markup. *(Legacy fallback for un-updated builds: `get_dom` the scoped selector and regex the markup.)*
- **Fresh reload per scenario** when testing, so prior state never leaks.
- **Prefer `mouseup` to commit select2.** `dispatch_event mouseup` on the highlighted result label is the reliable, verified commit. `mousedown` and `mouseup` are now **first-class in the `dispatch_event` enum and fire real `MouseEvent`s** (mousedown opens, mouseup commits). `keydown Enter` also commits the highlighted row (handy fallback for async multi lists), but on some single/static fields Enter can submit/reload the form — so default to `mouseup`.

## ESC component inventory

Catalog variable types grouped by how you drive them, with rough prevalence on a typical ESC catalog.

| Component (variable type) | Renders as | Driver file | Status | Prevalence |
|---|---|---|---|---|
| Reference, Select Box, Lookup Select Box, Requested For, Table Name, Yes/No | **select2** | `select2.md` | ✅ | very common |
| Single/Multi-line text, Email, IP, Masked, Wide single | native `<input>`/`<textarea>` | `native-inputs.md` | ✅ | very common |
| CheckBox, Multiple Choice (radio), Numeric Scale | native click | `native-inputs.md` | ✅ | common |
| Date, Date/Time | glide date/time picker | `date-datetime-picker.md` | ✅ | occasional |
| List Collector (glide_list) | **select2 multi** tag input — *not* a slushbucket on SP | `list-collector.md` | ✅ | occasional |
| Custom, Custom w/ Label, UI Page | arbitrary embedded widget | `custom-macro.md` | 🔲 | common |
| Attachment | file upload (UI not drivable → API) | `attachment.md` | ⚠️ | rare |
| Duration | day/hour/min/sec sub-inputs | `duration.md` | ✅ | rare |
| Container / Break / Label / HTML / Rich Text | layout / display only | — ignore — | — | — |

**Status legend:** ✅ verified & documented · ⚠️ documented, partial/hard · 🔲 stub / TODO.

## Component guides

- **`select2.md`** — reference / choice / lookup / multi pickers (the big one).
- **`date-datetime-picker.md`** — glide date & date-time pickers.
- **`list-collector.md`** — List Collector / glide_list, which renders as a **select2-multi** tag input on SP (*not* a slushbucket).
- **`native-inputs.md`** — text, textarea, checkbox, radio, numeric.
- **`duration.md`** — Duration: a fieldset of `#dur-{days,hours,minutes,seconds}-<var>` text sub-inputs (✅ verified).
- **`attachment.md`** — Attachment: the on-form control is a native file picker (not UI-drivable) → attach via the Attachment API (⚠️).
- **`custom-macro.md`** — stub; embedded widgets/UI pages — profile the DOM, then reuse the `select2.md` / `native-inputs.md` recipes.
- **`modals.md`** — custom dialogs/overlays: profile the container (no Bootstrap guarantee), scope fields to the modal, disambiguate the modal's commit button from the page's, close via `selector_gone`, and watch for multi-stage wizards.

Each component file states: what it is, the selectors, the open/commit/close mechanic, the gotchas, and a verified helper snippet.

## Where forms live on ESC

- **Catalog stack** — `sc_cat_item`, order guides, `ticket`, `sc_request` (the bulk of forms).
- **Custom SP widgets** — non-catalog pages (`/esc?id=<widget_id>`): the same controls with different anchoring/flow (see `select2.md` custom-widget note + `modals.md`).

## Post-submit: find the record you just created

After a UI commit, locate the new record for backend verification by either: **(a)** reading a **sys_id the widget drops into the URL** (verified: a widget redirected to `…&<param>=<sys_id>` on submit), or **(b)** querying the target table **`ORDERBYDESCsys_created_on`** with a **distinguishing filter** — a value you just typed (email, description). Verified live: the created record's sys_id appeared in `window.location`, and the row existed in its table the instant the modal was submitted (before enrichment).

## How we keep improving this skill

This is a living skill. When you discover a new component, a better selector, or a new gotcha: add/extend the relevant `*.md`, keep recipes **verified-on-a-real-page** (cite the page you tested), and flip the status in the table above. Prefer surgical edits over rewrites.
