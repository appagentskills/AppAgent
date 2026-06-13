---
name: ui-driver
description: "Drive ServiceNow UI from the agent — Employee Center (ESC) Service Portal forms via iframe_tool selectors (select2, date pickers, list collectors, native inputs), AND Now Experience / Seismic surfaces (Configurable Workspaces, UI Builder, Agent Workspace) whose OPEN shadow-DOM controls iframe_tool pierces, so they are driven by real selectors too (ARIA role + accessible name + now-* class), NO coordinates — and where UI edits are display-only (persist via the Table API). For each task you compose a small, disposable js_eval script that opens, fills, commits, and validates the real on-screen controls. Use when there is no Table API / record-producer path and you must operate the rendered form."
---

# ui-driver — driving ESC portal UI components

A field guide for programmatically operating the **Employee Center** portal (`/esc`). Each component type needs its own open/fill/commit/close dance; this skill gives you a verified recipe per component, plus the overall approach.

> **⭐ Two surfaces — pick the right file.** **(1) ESC / Service Portal / classic forms = light DOM** (`select2.md`, `native-inputs.md`, …), driven by ordinary `querySelector` selectors; **(2) Now Experience / Seismic = OPEN shadow DOM** (Configurable Workspaces, UI Builder, Agent Workspace) — `iframe_tool` **pierces the shadow roots via `findElement`**, so it is driven by **real selectors too, NO coordinates** — see **`now-experience.md`**.

> **Employee Center** (the `esc` portal) is a *Service-Portal-based* portal (Angular + jQuery **select2**), **not** Next Experience / `sn-record-picker` web components. A catalog item form renders `.select2-container` elements and **zero** `sn-record-picker`, so the select2 recipes here apply across the whole catalog.
>
> **Beyond the catalog:** the same portal also hosts **custom SP widgets** that are *not* catalog items (e.g. a registration/intake form at `/esc?id=<widget_id>`). They render the **same** select2 / native controls and the recipe **mechanics** apply unchanged — but their **anchoring and surrounding assumptions differ**: **no** `#s2id_sp_formfield_*` ids, **modals**, **multi-stage wizards**, and primary buttons that often **are** genuinely validity-gated. See `select2.md` (custom-widget anchoring), `modals.md`, and the Standard loop's re-profile step.

## ⚠️ Two rendering worlds — light DOM (this skill) vs Now Experience / Seismic shadow DOM

Everything below (and in `select2.md` / `native-inputs.md` / …) targets **light DOM** — Service Portal (ESC) and classic platform forms (`gsft_main`). **Now Experience** surfaces are a *different platform*: **Configurable Workspaces** (Service Operations / CSM / HR / ITSM), **UI Builder** pages and **Agent Workspace** render their *entire* UI as **web components inside nested shadow roots** (Seismic: `macroponent-*`, `now-*`, `now-typeahead`, …). **Good news — those shadow roots are OPEN and `iframe_tool` already pierces them:** `click` / `fill` / `type` / `dispatch_event` / `wait_for` and `get_properties` all resolve shadow elements, and plain `get_visible_text` reads shadow text. ⚠️ **`get_dom`'s serialization does not include shadow internals** — its selector *lookup* DOES pierce on the current build, but `outerHTML` stops at the matched host's shadow boundary, and selector-less `get_dom` serializes light DOM only; `get_visible_text` `deep:true` recurses shadow roots on the current build (older builds returned only nav chrome — re-verify on your build before relying on it). **So you drive Seismic the PROPER way — real CSS selectors on the real `now-*` controls — not coordinates** (verified on a live SOW incident form).

- **⭐ Litmus:** `get_properties button.now-tab` (or `now-button`) **> 0** ⇒ live `now-*` controls are present — `get_properties` pierces the shadow, so this is the reliable detector. Confirm with `get_dom body` showing a lone **`macroponent-*`** host with **no** form children ⇒ **Seismic** → use **`now-experience.md`**. ⚠️ Do **not** `get_dom` for `now-button` itself: it returns only the bare host tag (`outerHTML` omits shadow content) — usable as a detector, useless for form structure. (Classic forms instead resolve `gsft_main` + plain `input`/`button`.)
- **🔢 `match_count` is reliable on the current build:** `get_properties` pierces shadow, so `0` means **genuinely absent** (e.g. the editable fields are 0 on the read-only **Overview** tab — click **Details** first) and `N` means present. ⚠️ it **counts hidden matches**, so read the **`visible`** property for visibility. (*Historical:* an older build computed the count from a non-piercing `querySelectorAll` while resolving `properties` via piercing `findElement`, so `0` could be a false negative — that's fixed; this once made an attempt think selectors were dead and detour to coordinates.)
- **🔑 Stable selectors only:** element ids (`now-id`, `form-field-…`, `tab_…`, option ids) are **regenerated every load** — anchor on **`aria-label`** / **`role`** / stable **`now-*` class** (`button.now-tab`, `input.now-input-native`, `button.now-select-trigger`, `input.now-typeahead-native-input`). Read a choice's value from the **trigger's `textContent`**, a text field's from **`.value`**. Full recipes (tabs/views, record picker, now-input/textarea, choice, pills, switch, grid row-open, read-back) live in **`now-experience.md`** — **no coordinates needed**.

## The approach: write a disposable driver script each time

We do **not** ship a generic "fill any form" function. Instead, for each task you **compose a small `js_eval` script** that calls `iframe_tool` actions to drive the specific controls in front of you, assembling the per-component recipes below. Why:

- ESC forms are **dynamic** — catalog variables, UI policies, and reference qualifiers mean the field set is only knowable at runtime.
- Each component needs a **specific** interaction sequence; you pick the matching recipe for each field present.
- A script lets you **reload-fresh → fill → assert validity** (per-field signals; the primary button's `disabled` only when it is genuinely validity-gated — see Golden rules) as one holistic check.

> **⚠️ One script, not many turns.** Run the *entire* loop — fill every field, re-profile if needed, assert — inside a **single `js_eval`** that chains `executeTool("iframe_tool", …)` calls. Don't spread the fill across separate assistant turns / recon round-trips: it is slower and leaks stale intermediate state (a *mid-render* read of the primary button can falsely report `disabled`). The only legitimate in-script branch is conditional rendering (step 5) — itself just another `executeTool` call in the same script. The worked example below fills a 9-variable form, with per-field assertions, in one script.

**Standard loop:**

1. `iframe_tool navigate` to the page; `wait_for` a known field to confirm render.
2. Identify the controls present (by label/placeholder, or profile the DOM).
3. For each control, run the matching recipe (component files below).
4. Commit via the component's **explicit** mechanic (e.g. select2 = `mouseup` on the result label; prefer it over Enter).
5. **Re-profile after every commit.** A commit can (a) reveal **new fields in place** (conditional rendering — e.g. timezone-dependent date-time fields that render only *after* a Location field is set, since they need its timezone; ⚠️ such fields often **already exist in the DOM with `visible:false`** before the trigger commits — test via `get_properties` → `.visible`, not `match_count`), or (b) close the current overlay and open a **new** one (a multi-stage wizard — e.g. an *Add* dialog that then opens a second details modal). Never assume the first field set is complete.
6. Assert: **no drop left open** + the primary button (Order / Submit / Create) is **enabled** *(only when it's genuinely validity-gated — see Golden rules)*.

## Golden rules (every component)

- **API first.** If the job maps to a UI Action or record producer, prefer the Table API / `servicenow_run_script`. Drive the UI only when there is genuinely no API path, or the task *is* "operate the rendered form".
- **Commit, then wait for the close signal.** Every widget has an explicit commit + close event. `wait_for selector_gone` on the close signal — never sleep-and-hope.
- **Validity — prefer per-field signals; the primary button is often NOT wired to validity.** The standard ESC **SC Catalog Item** widget renders an **"Order Now"** button bound to `ng-disabled="disableControls()"` (a processing flag) that stays **enabled even when required fields are empty** (verified live) — so do **not** gate on `#submit-btn.disabled` there. **Treat this diagnostically, not absolutely:** before trusting *or* distrusting any primary button, **read its `ng-disabled` expression** (`get_dom` the button). If it references only a **processing flag** (`disableControls()`, `isSubmitting`) the disabled state is **not** a validity signal; if it references **real form/field validity** (`!formValid`, `!isValid`, a required-count) the disabled state **IS** trustworthy. Verified live: a custom SP widget gated its primary button on `ng-disabled="!formValid"` (and a Confirm button on a minimum row count), so there the enabled/disabled flip is reliable. Use **per-field** signals instead: a select2 has non-empty `.select2-chosen` (empty carries `.select2-default`); a List Collector's hidden `#sp_formfield_<var>` is a non-empty CSV; a satisfied mandatory field's asterisk `#<var> span.mandatory` gains class `mandatory-filled` (⚠️ detect it via the `aria-label="Required Filled"` flip, **not** a bare `/mandatory-filled/` regex — the asterisk's `ng-class` binding literal always contains that string; see `native-inputs.md`); an invalid field shows `has-error`. *Some* other SC widgets (a "Submit"-button record-producer) **do** flip `#submit-btn.disabled` — use it only after confirming it actually toggles when a required field is cleared.
- **Reading classes — use `classList`.** `get_properties` now ALWAYS returns `className` (string) **and** `classList` (array) alongside `.value`/`.checked`/`.disabled`/`visible`. For class-based assertions (`mandatory-filled`, `has-error`, `select2-highlighted`, …) test `properties.classList` directly (e.g. `classList.includes("select2-highlighted")`) instead of scraping markup. *(Legacy fallback for un-updated builds: `get_dom` the scoped selector and regex the markup.)*
- **Fresh reload per scenario** when testing, so prior state never leaks.
- **Prefer `mouseup` to commit select2.** `dispatch_event mouseup` on the highlighted result label is the reliable, verified commit. `mousedown` and `mouseup` are now **first-class in the `dispatch_event` enum and fire real `MouseEvent`s** (mousedown opens, mouseup commits). `keydown Enter` also commits the highlighted row (handy fallback for async multi lists), but on some single/static fields Enter can submit/reload the form — so default to `mouseup`.

## Worked example: a whole catalog form in ONE script (✅ verified)

A single `js_eval` filled a 9-variable catalog item — single-line text, multi-line text, **Select Box**, **Reference**, Multiple-Choice radio, CheckBox, **Date**, **Date/Time**, and **List Collector** — and asserted every field, on the first run. Copy this shape: paste the helpers once (from the component files), then **navigate → fill → assert** in one script. Wrapping each field in `try/catch` means one bad selector reports itself instead of aborting the other eight.

```javascript
// ift/gp/sleep + pickSelectBox/pickReference/addMultiChip come from select2.md; setText/setCheckbox/setRadio
// from native-inputs.md; setDateField from date-datetime-picker.md (list-collector.md reuses addMultiChip) — paste them in.
await ift({action:"navigate", url:"/esc?id=sc_cat_item&sys_id=<item_sys_id>", wait:true});
await ift({action:"wait_for", selector_visible:"#sp_formfield_<first_var>", timeout:20000});

const R = {};
const step   = async (k, fn) => { try { R[k] = await fn(); } catch (e) { R[k] = {error:String(e.message||e)}; } };
const chosen = async C => { const p = (await gp(C+" .select2-chosen")).properties; return p && p.textContent; };

await step("text",      async()=>({set: await setText('#sp_formfield_<text_var>', "Laptop won't boot")}));
await step("textarea",  async()=>({set: await setText('#sp_formfield_<ml_var>', "First line. Second line.")}));   // textarea: embed real line breaks in the JS string if needed
await step("selectbox", async()=>{ await pickSelectBox("#s2id_sp_formfield_<choice_var>","High"); return {chosen: await chosen("#s2id_sp_formfield_<choice_var>")}; });
await step("reference", async()=>{ await pickReference("#s2id_sp_formfield_<ref_var>","Abel");      return {chosen: await chosen("#s2id_sp_formfield_<ref_var>")}; });   // type the LEADING token of the display value
await step("radio",     async()=>({checked: await setRadio('<radio_var>','Phone')}));                   // anchor = fieldset #sp_formfield_<var>
await step("checkbox",  async()=>({checked: await setCheckbox('#sp_formfield_<cb_var>', true)}));
await step("date",      async()=> await setDateField('<date_var>',"2026-06-15"));                       // fill + blur
await step("datetime",  async()=> await setDateField('<dt_var>',"2026-06-15 14:30:00"));                // strict 24-hour
await step("listcoll",  async()=>{ await addMultiChip("#s2id_sp_formfield_<glide_list_var>","Abel");
                                   await addMultiChip("#s2id_sp_formfield_<glide_list_var>","Abraham");
                                   return {chips:(await gp("#s2id_sp_formfield_<glide_list_var> li.select2-search-choice")).match_count}; });
return R;   // {text:{set:true}, selectbox:{chosen:"High"}, reference:{chosen:"Abel Tuter"}, date:{committed:true,…}, listcoll:{chips:2}, …}
```

**What this run verified (standard catalog `sp_form` widget):** every documented anchor held first-try — native & date inputs `#sp_formfield_<var>`, select2 `#s2id_sp_formfield_<var>`, the radio **fieldset** `#sp_formfield_<var>`, the date container `#<var>`. The **per-field reads are the validity signal**: the primary button read back `"Order Now"` / `ng-disabled="disableControls()"` (a processing flag) — enabled regardless of validity — exactly as the Golden rule warns. A flat catalog form needs no re-profile, but the one-script discipline still applies.

## ESC component inventory

Catalog variable types grouped by how you drive them, with rough prevalence on a typical ESC catalog.

| Component (variable type) | Renders as | Driver file | Status | Prevalence |
|---|---|---|---|---|
| Reference, Select Box, Lookup Select Box, Requested For, Table Name, Yes/No | **select2** | `select2.md` | ✅ | very common |
| Single/Multi-line text, Email, IP, Masked, Wide single | native `<input>`/`<textarea>` | `native-inputs.md` | ✅ | very common |
| CheckBox, Multiple Choice (radio), Numeric Scale | native click | `native-inputs.md` | ✅ | common |
| Date, Date/Time | glide date/time picker | `date-datetime-picker.md` | ✅ | occasional |
| List Collector (glide_list) | **select2 multi** tag input — *not* a slushbucket on SP | `list-collector.md` | ✅ | occasional |
| Multi-Row Variable Set (MRVS) | Bootstrap modal (`.modal-content`) that is itself an `sp_form` render — fields get `#sp_formfield_*`, commit `#mrvs_save_button`, row is client-side until page submit | `modals.md` §6 | ✅ | occasional |
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
- **`modals.md`** — custom dialogs/overlays: profile the container (no Bootstrap guarantee), scope fields to the modal, disambiguate the modal's commit button from the page's, close via `selector_gone`, and watch for multi-stage wizards. ⚠️ A bare `button.btn-primary` (or even `:not(.ng-scope)`) can collide with **unrelated toolbar buttons** (e.g. an attachment *Save*) and with the page's own primary — target the modal commit by **scoping to the modal container** or by its **validity-bound `ng-disabled` expression**, and treat a literal **"None"** choice value as *unselected* when deciding whether to pick.
- **`now-experience.md`** — Now Experience / Seismic (Configurable Workspaces, UI Builder, Agent Workspace): open shadow roots that `iframe_tool` pierces — real selectors, no coordinates. Read its three headlines first (Details tab, two-phase hydration, release-dependent classes) and its ⛔ persistence rule (UI edits are display-only — persist via Table API).

Each component file states: what it is, the selectors, the open/commit/close mechanic, the gotchas, and a verified helper snippet.

## Where forms live on ESC

- **Catalog stack** — `sc_cat_item`, order guides, `ticket`, `sc_request` (the bulk of forms).
- **Custom SP widgets** — non-catalog pages (`/esc?id=<widget_id>`): the same controls with different anchoring/flow (see `select2.md` custom-widget note + `modals.md`). ⚠️ Page/widget availability is **build-specific** — the “same” flow on another instance may not exist as a custom page at all and instead be a **record producer with an MRVS modal** (standard catalog world, `modals.md` §6). Probe the page first; don't assume a remembered URL exists.

## Post-submit: find the record you just created

After a UI commit, locate the new record for backend verification by either: **(a)** reading a **sys_id the widget drops into the URL** (verified: a widget redirected to `…&<param>=<sys_id>` on submit), or **(b)** querying the target table **`ORDERBYDESCsys_created_on`** with a **distinguishing filter** — a value you just typed (email, description). Verified live: the created record's sys_id appeared in `window.location`, and the row existed in its table the instant the modal was submitted (before enrichment). ⚠️ **But only when the commit actually hits the backend** — an **MRVS** modal commit is client-side (row in the on-page grid, **no record** until the page-level Submit; verified live) — so confirm via API *which* kind of modal you drove before trusting created-on discovery (`modals.md` §6).

## How we keep improving this skill

This is a living skill. When you discover a new component, a better selector, or a new gotcha: add/extend the relevant `*.md`, keep recipes **verified-on-a-real-page** (cite the page you tested), and flip the status in the table above. Prefer surgical edits over rewrites.
