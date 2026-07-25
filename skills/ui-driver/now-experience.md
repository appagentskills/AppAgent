# now-experience.md — driving Now Experience / Seismic forms (Workspaces & UI Builder), **selector-based, no coordinates**

**Now Experience** (a.k.a. Next Experience / **Seismic** / the Now Experience Framework) — **Configurable Workspaces** (Service Operations / CSM / HR / ITSM workspaces), **UI Builder** pages, **Agent Workspace** — renders its entire UI as **web components inside nested shadow roots** (`macroponent-*`, `now-*`, `sn-*`). Every other file in this skill assumes light DOM (Service Portal / classic `gsft_main`); this file is the Seismic playbook.

> ## ⭐ HEADLINE — the old "you must use x,y coordinates" advice is **OBSOLETE**
> `iframe_tool`'s selector engine **pierces shadow DOM**. You drive Seismic forms with **plain CSS selectors** anchored on **ARIA roles + accessible names + stable `now-*` classes** — **no screenshots, no coordinates, no `elementFromPoint`.** If a selector won't resolve, the fix is a *better selector* (re-census the live DOM per §2) — not coordinates.
>
> ## ⭐ HEADLINE #2 — the editable form is on the **Details** view, not the landing page
> A Configurable-Workspace record opens on the **Overview** tab, which is **read-only summary cards** with **no editable inputs**. If your field selectors all return `match_count:0`, you are almost certainly on Overview. **Click the `Details` form-tab first** (`button.now-tab[aria-label="Details"]`) — that is where `now-input-native` / `now-select-trigger` / `now-typeahead-native-input` mount. This single fact resolves most "the form isn't there / fill does nothing" confusion. See §0.
>
> ## ⭐ HEADLINE #3 — component **class names are RELEASE-dependent**; CENSUS before you trust any selector
> Verified across two instances/releases that rendered the **same** form with **different** specifics (e.g. left-rail buttons carried a `value` accessible name on one release but not the other; choice-option `id`s use two different schemes — see §6.3). **Anchor on role + accessible name + `now-*` class, and always census the live page** (§2 litmus) rather than assuming an exact class. The recipes below are verified-current but treat them as *patterns*, re-confirm on the instance in front of you.

> **Verified live (non-destructively)** on **(1)** a Service Operations Workspace incident (`/now/sow/record/incident/<sys_id>/...`) — tab/view/list/related-record/row-open navigation, two-phase hydration, every field type, a robust choice recipe, and a **network-level** Save→persistence probe; cross-checked across **change_request** & **problem** in the same workspace; and **(2)** earlier on a second instance/release — confirming the model with release-specific selector differences.

---

## 0. ⭐ Tabs & Views — WHERE the form actually is (read this first)

A Configurable-Workspace **record page** has **form-level tabs** rendered as `button.now-tab[aria-label="…"]` (active = `classList` includes **`is-selected`**). On the SOW incident they are:

| Form tab | `button.now-tab[aria-label=…]` | What it contains | Editable form fields? |
|---|---|---|---|
| **Overview** (landing) | `"Overview"` | **Read-only Summary cards** (Short description, Number, State, Priority, Impact …), the **Compose** panel (Work notes / Comments / Email) + **Stacked view** toggle, and the **Activity** stream | ❌ **none** — `input.now-input-native` here are display-only; `button.now-select-trigger` = **0** |
| **Details** | `"Details"` | The **editable record form** (all the real fields) | ✅ **yes** — `input.now-input-native` / `button.now-select-trigger` counts **jump** (e.g. 4→8 / 0→6 on one build; 0→2 / 0→1 on a build with a **sectioned** form — see note below) |
| **Related records** | `"Related records"` | Related-list **switcher** (a `[role="tree"]`) + the related-list **grid** | n/a (lists) |

- **You MUST `click button.now-tab[aria-label="Details"]` before driving any field.** Verified: on Overview every field anchor (`[aria-label*="Short description"]`, `[aria-label="Impact"]`, …) returns **0**; after clicking Details they all resolve.
- **Deep-link the view via the URL:** `…/params/selected-tab-index/N` where **0=Overview, 1=Details, 2=Related records**. Navigating straight to `selected-tab-index/1` still renders Overview first then needs the Details click in this build, so click the tab to be safe.
- **Compose sub-tabs (Work notes/Comments/Email) and the Stacked-view toggle render ONLY on the Overview tab** (they are `0` on Details/Related records).
- **⚠️ The Details form may be SECTIONED with lower sections COLLAPSED** (verified on a 2026 build): right after the Details click only the top section's fields exist as visible matches (2 inputs / 1 select there), and Impact/Urgency/etc. live in collapsed sections. Click `span.sn-section-header.collapsable` to expand (selects went 1→7). So the “count jump” litmus **undercounts until sections are expanded** — if a field anchor reads 0 *or hidden* on Details, expand sections before concluding it's absent.
- **The tab SET is record-type-specific** — the Overview/Details/Related-records triplet is the common *subset*, and the model generalizes across tables. ✅ Verified on SOW: **incident** = Overview / Details / Related records; **change_request** inserts a **Change tasks** tab; **problem** inserts **Problem Tasks** + **Fix Tasks** — always **between Details and Related records**. Overview-read-only / Details-editable / the `[aria-label="Details"]` readiness anchor hold on all three. **Discover the actual tab names with `get_visible_text`.**

---

## 1. Capability model — which `iframe_tool` actions pierce shadow DOM

| Action | Pierces shadow? | Use it for |
|---|---|---|
| `get_properties` | ✅ **yes** (global selector walks all shadow roots) | finding elements, reading state |
| `wait_for` (`selector_visible`/`selector_gone`) | ✅ yes | waiting on deep elements |
| `click` / `fill` / `type` / `dispatch_event` | ✅ yes | **driving** deep controls |
| `get_visible_text` (plain, no `deep`) | ✅ yes — reads **all rendered text** incl. shadow | labels, values, `Showing N of N`, option text, "Child Incidents (1)" counts |
| `get_visible_text` `deep:true` | ⚠️ **build-dependent** — recurses shadow roots on the current build (older builds returned only nav chrome — re-verify on your build before relying on it) | element census with rects/selectors (after re-verifying) |
| `get_dom` | ⚠️ **lookup pierces, serialization doesn't** — the selector lookup resolves shadow elements (current build), but `outerHTML` omits shadow content (a matched host returns its bare tag); selector-less `get_dom` serializes light DOM only | Seismic detector — NOT for form structure |
| `>>>` deep combinator | ❌ throws `is not a valid selector` | never |

> **The one subtlety — descendant combinators don't cross WEB-COMPONENT shadow boundaries.** A **global** selector (`button.now-select-trigger`, `[role="option"]`) finds elements inside *any* shadow root. A **scoped descendant** (`A B`) only works when **A and B live in the same shadow tree**. Verified: `[role="listbox"] [role="option"]` ✅ and `[role="gridcell"] a` / `td a` ✅ (the grid is an HTML `<table>` living in one tree) but `now-date-time input` ❌ `match_count:0` (the input is in `now-date-time`'s *own* shadow). **Rule: target the deep element with a global selector; use descendant combinators only within one component's tree.**

### `get_properties` return shape & limits (memorize)
Returns **only the FIRST match's** properties plus `match_count`:
`{ tagName, id, className, classList[], textContent, value, checked, disabled, visible, rect }`
- ✅ **`match_count` IS reliable on the current build** — it pierces shadow, so `0` means **genuinely absent** (e.g. field anchors on the Overview tab) and `N` means present; a no-match returns `success:true, match_count:0, properties:null` (not an error). *(Historical note: an older tool build computed `match_count` from a non-piercing `querySelectorAll` while resolving `properties` via a piercing `findElement`, so `0` could be a false negative — that is fixed; trust the count now.)*
- ⚠️ **`match_count` counts HIDDEN matches too.** A collapsed/hidden element still matches — to test visibility read the **`visible`** property, never infer from `match_count` (this trips up section-collapse checks — §5).
- It does **NOT** enumerate every match and does **NOT** return `aria-label`/`role`/`name`/`data-*` **values** (`include:["attributes"]` adds nothing here). **You can only MATCH those attributes inside a selector, never read them back.** Discover accessible names with `get_visible_text`.
- For **buttons/tabs/triggers** the rendered label is in **`textContent`** (e.g. a choice trigger reports `textContent:"3 - Low"`). On *some* releases a button's accessible name also surfaces in `value`; on *other* releases the left-rail buttons had **no** `value` — so prefer `textContent`/`is-selected`.

---

## 2. Anchoring model — ARIA role + accessible name + `now-*` class (+ census first)

**Field element ids are RANDOM per render** (`form-field-ujrihc9wxwar-1694`, `<rand>-toggle`, `tab_28`, `now-dropdown-list-maw9xgm0grdm-3227-option-1`). **Never** anchor on them. Anchor on, in order:
1. **`[aria-label="<Field/Tab label>"]`** (exact). Use `[aria-label*="…"]` when the label carries a suffix (mandatory marker, etc.) — `[aria-label="Short description"]` may be 0 while `[aria-label*="Short description"]` is 1.
2. **stable `now-*`/`sn-*` class** — `button.now-tab`, `input.now-input-native`, `textarea.now-textarea-field`, `button.now-select-trigger.now-form-field`, `input.now-typeahead-native-input`, `li.now-typeahead-pill`, `input.now-toggle[role="switch"]`, `span.sn-section-header.collapsable`, `a.sn-chrome-one-tab` — these are **stable PER RENDER** (unlike #1's random ids) but the class names themselves can vary across releases, so census per instance (headline #3).
3. **ARIA role** — `[role="combobox"|"textbox"|"option"|"treeitem"|"switch"|"grid"|"gridcell"|"tab"]`. ⚠️ a role can collide across the page (`[role="combobox"]` matched the **global header search** boxes, not a form field; `[role="tab"]` matched the **left rail**, not form tabs) — combine role + class + accessible name.
4. **stable semantic ids** — chrome ids `#home-btn`, `#list-btn`, `#teams-btn`, `#chrome-add-new-button`, `#record_info`, `#attachments`, `#agent-assist`.

**Active/selected** = `classList` includes **`is-selected`** (tabs, rail, side panel) or `aria-selected="true"` (treeitems) or the `.checked`/`aria-expanded` you match — **not** an accessible-name read.

### "Which world / which state am I in?" litmus (run after the page renders)
- `get_properties button.now-tab` **> 0** and `get_dom body` shows a lone `macroponent-*` host with no form children (`get_dom`'s lookup pierces, but `outerHTML` omits shadow content — hosts render as bare tags) ⇒ **Seismic** → this file.
- All your **field** anchors read **0** but `button.now-tab[aria-label="Details"]` = 1 ⇒ you are on **Overview / not hydrated** → click **Details** (§0) and/or poll hydration (§3).
- `get_dom` shows real form markup and generic `input`/`select` in the hundreds ⇒ **light DOM** → use `select2.md` / `native-inputs.md`.
- **A record tab that renders ONLY “Component is not configured”** (no fields, no tabs, no error banner) ⇒ the record was **deleted / doesn't exist** — verified live: a chrome tab pointing at a dead sys_id renders a silent blank that is **indistinguishable from a hydration failure**. Before debugging hydration, `GET` the record via the Table API to confirm it exists. (Stale open-record chrome tabs persist across sessions and keep pointing at dead records — don't click them.)
- **A workspace route that renders the UXF "Page not found" 404** (URL persists, **0** `now-*` components, visible text "…could not be found") ⇒ that workspace **isn't installed**. Verified live: only **Service Operations Workspace** was installed (`/now/sow/…`); `/now/cwf/agent` (CSM/Agent) and `/now/wm/home` both 404. **Discover installed workspaces via the Table API**: `GET sys_ux_app_config` (name + landing route) — don't assume CSM/HR/ITSM workspaces are present.

---

## 3. Hydration — it is **TWO-PHASE**; poll a readiness anchor, never a fixed sleep for the initial mount

Workspaces hydrate in **two waves**, and this is the **#1 cause of false "field missing" failures** (and of burning wall-clock time and tokens on retry loops):
1. **Text wave (~20 s):** `get_visible_text` already shows all the labels/values — *tempting but premature*.
2. **Interactive wave (~45–60 s on a COLD load):** the actual web components (`button.now-tab`, `input.now-input-native`, `button.now-select-trigger`) mount. **Until this wave, every form/tab selector returns `match_count:0`** even though the text is on screen.

A recently-visited (warm/cached) record re-hydrates in **~7 s**. So **poll a readiness anchor with a few coarse retries** — do **not** sleep a fixed amount, and do **not** spin a 20–30× tight loop (observed: 200+ pointless calls burning minutes and tokens on a single field). *(This applies to INITIAL hydration; a short fixed settle after an in-page click is fine, but never use one to wait out the cold first mount — poll a field/tab anchor.)*

> ⚠️ **Resize the viewport BEFORE navigating.** Verified live: at the default (small) iframe size a **cold** workspace load served the text wave but **never mounted the interactive wave** (>110s, `button.now-tab` stayed 0, and the List→record round-trip didn't unstick it); after `iframe_tool resize preset:"fullhd"` and a fresh `navigate`, the same record hydrated in **7s**. Make `resize` (desktop/fullhd) the first step of any workspace session.

```javascript
async function ift(a){ return await executeTool("iframe_tool", Object.assign({status_message:"x"}, a)); }
async function gp(sel){ const r = await ift({action:"get_properties", selector:sel}); return { n:r.match_count||0, p:r.properties||null }; }
const sleep = ms => new Promise(r=>setTimeout(r, ms));

// Readiness = a FORM tab exists (interactive wave done). ~9 coarse tries × 7s ≈ 63s — covers the ~60s cold worst case.
async function waitWorkspace(){
  for (let i=0;i<9;i++){ await sleep(7000); if ((await gp('button.now-tab[aria-label="Details"]')).n > 0) return (i+1)*7000; }
  return -1; // never hydrated — try a List→record round-trip to force the mount (see the round-trip note just below — it uses §5's #list-btn + open-record strip)
}
```
- **Call discipline:** there is no tool-call cap, but every round-trip costs wall-clock time and context tokens — and context saturation is what actually ends a sub-agent's run. Batch many `ift()` calls into ONE `js_eval`; poll coarsely; never loop-poll per field.
- If `waitWorkspace()` returns `-1`, click the left-rail **`#list-btn`** then re-open the record (or its open-record tab) — a List→record round-trip usually forces the form to finish mounting (⚠️ except viewport-induced stalls — it did NOT unstick a small-viewport cold load; resize first, see the note above).

---

## 4. ⛔ THE PERSISTENCE RULE — drive the UI to *navigate / read / exercise*, **persist with the Table API**

The single most important finding, **re-verified on two releases including network-level proof**, and it reinforces the skill-wide API-first golden rule.

**Verified many ways** (`fill`; per-char `type`; a *real* choice option-click; with explicit `input`/`change`/`blur`; focus+Enter then Save; clean and dirty states): a selector-driven edit updates the **rendered control's display** but does **NOT** commit to the form's data model. Observed:
- the open-record tab **never gains a dirty class** (`a.sn-chrome-one-tab.is-selected` classList identical before/after an edit);
- the value **reverts to the model value on any re-render**;
- the header **Save** (`[aria-label="Save"]`, a real enabled button) **persists nothing** — and the **network proves it**: clicking Save fires **only** a telemetry POST `/api/now/uxmetrics/interactions` and **no `PUT`/`PATCH`** to the record; a Table-API `GET` shows the field unchanged and **`sys_updated_on` does not move**.

> **Root cause:** the UXF form-model dirty/commit pipeline ignores **untrusted synthetic** DOM events; the components still re-render their *display* from them, so Save has nothing dirty to send. The available `iframe_tool` primitives produce synthetic events and there is no in-page-eval / trusted-event action — so **there is no UI path to persist on Seismic with these tools.** (Platform ATF persists because it uses in-page APIs, not synthetic DOM events.)

**⇒ Do NOT use UI-driving as the data-commit path on Seismic.** Use it for:
- **Navigation** — tabs, views, lists, related records, row-open, panels (§5) — fully reliable.
- **Reading** rendered state (`get_visible_text`, `get_properties`).
- **Exercising client-side logic** — UI policies, client scripts, declarative actions, visual/UX testing.

To **set a field / create / update**, use **`servicenow_api` (Table API)** or **`servicenow_run_script`**. To *verify*, `GET` the record (it only reflects **saved** state; compare `sys_updated_on`).

### ⚠️ The native "Leave site?" beforeunload trap
A genuinely **dirty** page raises Chrome's native **"Leave site? Changes that you made may not be saved"** dialog on `navigate`. The biggest source of dirtiness is a **journal draft** — text typed into the **Work notes / Comments compose** box (drafts are tracked separately and *do* dirty the page, unlike field edits which don't). This dialog is **browser chrome, not page DOM** → `iframe_tool` selector actions **cannot dismiss it and the page FREEZES** (every field reads empty, every action no-ops — masquerades as "Save broke / fields gone").
- `iframe_tool navigate` **auto-accepts** it (= **Leave**/discard) — re-issuing `navigate` to a neutral page (e.g. `/now/sow/list`) clears a stuck dialog, but a navigate can also **hang** on it.
- **Mitigations:** never leave compose drafts (don't type into Work notes/Comments/Email when you only need navigation/fields); after editing, navigate to a neutral page to discard; if things suddenly read empty, suspect this dialog, `take_screenshot` to confirm, then `navigate` to clear.

---

## 5. Navigation recipes — all verified on SOW. **Active = `classList` includes `is-selected`** unless noted.

| Target | Anchor (click it) | Read active / verify |
|---|---|---|
| **Form tabs** Overview / Details / Related records | `button.now-tab[aria-label="Overview"\|"Details"\|"Related records"]` (1 each; `[aria-label=…]` alone also matches) | clicked tab's `classList` gains `is-selected`; **Details reveals the editable form** (count `input.now-input-native` / `button.now-select-trigger` before vs after — they jump). `button.now-tab` totals ~6 **logical** (3 form + 3 Overview-only compose) — but the **raw element count is ~8** because Work notes/Comments each mount **2 mirrored copies** (see the Compose sub-tabs row). |
| **Related-list switcher** (Task SLAs, Affected CIs, Child Incidents, …) | a `[role="tree"]`; item `li[role="treeitem"][aria-label^="Child Incidents"]` — **click its inner `div.now-content-tree-node`** (clicking the bare `<li>` does nothing). ⚠️ `div.now-content-tree-node` ALONE matches ~66 (incl. global nav) — **scope it via the `li[role="treeitem"]`** | active = `[role="treeitem"][aria-selected="true"]`; its `textContent` = list name **with a live count** (`"Child Incidents (1)"`) → anchor the treeitem with **`^=`**, never exact. SOW incident has 7: Task SLAs, Affected CIs, Impacted Services/CIs, Child Incidents, Change Requests, Outages, Affected Locations. |
| **Related-list / list grid rows** | The SOW grid is an **HTML `<table>`**: cells carry **`[role="gridcell"]`** (and are `<td>`), but **rows do NOT carry `[role="row"]`** (so `[role="row"]`=0 even with data — *do not* anchor on it here). **Open a record via its data-cell link `[role="gridcell"] a` (≡ `td a`)** — `textContent` = the record number. **Column-header links are `tr a` / `th a`** (text = column name like "Number") — don't click those. | `wait_for '[role="gridcell"]'`; an **empty** list ⇒ 0 cells/links. Clicking the cell link opens the record (URL gains `/sub/record/<table>/<sys_id>` inside the related view). Verified: opened a child incident by its `[role="gridcell"] a`. |
| **Left nav rail** Home / List / Teams (+ Schedules / dashboards) | inner buttons `#home-btn`, `#list-btn`, `#teams-btn`, `#schedules-btn`, `#it-agent-dashboard-btn` (`role="tab"`). *(The wrapper carries id `home`/`list`/`teams` **without** `-btn`.)* | active = `is-selected`; `#list-btn` → `/now/sow/list/params/list-id/<id>`. ⚠️ no `value` accessible name on this release — verify via `is-selected`, not `value`. |
| **Open-record tab strip** | `a.sn-chrome-one-tab[aria-label*="<record_number>"]` (substring; ≡ `#tab_<n>`, ids random). **Close:** `#li_tab_<n> > button.sn-chrome-one-tab-close`. **New tab:** `#chrome-add-new-button`. | active = `is-selected`; switching **changes the page URL sys_id**. |
| **Compose sub-tabs** Work notes / Comments / Email *(Overview only)* | `button.now-tab[aria-label="Work notes"\|"Comments"\|"Email"]` (Work notes/Comments render **2 mirrored copies**, Email 1) | verify via the **first match's `is-selected`** (synced across copies). ⚠️ **don't type here** unless you intend a draft (Leave-site trap, §4). |
| **Stacked-view toggle** *(Overview only)* | `input.now-toggle[role="switch"][aria-label="Stacked view"]` | read **`.checked`** (the visually-hidden input flips on click); `.value` is always `"on"`. |
| **Right side-panel rail** | `#record_info`, `#attachments`, `#agent-assist` (`button.now-tab-button`) | active = `is-selected`; panel content switches. |
| **New-record menu** ("+") | `#chrome-add-new-button` (`aria-haspopup="menu"`) | opens New Interaction / Incident / Change / Problem. |
| **Form section collapse/expand** | `span.sn-section-header.collapsable` (≈6 on Details; first match = top section) | ⚠️ **verify via a field's `visible` flipping, NOT `match_count`** (collapse hides the fields but they still match). Verified: clicking it flipped Short description `visible` true→false→true. Section names live in `textContent` only (no aria-label) → lower sections are positional. |

---

## 6. Field-component recipes (single `js_eval`, chained) — on the **Details** view. **Run the whole fill/assert loop in ONE `js_eval`.**

> Reuse `ift`, `gp`, `sleep`, `waitWorkspace` from §3. Remember §4: these update **display only** — to persist, use the Table API.

### 6.1 Text / single-line — `input.now-input-native`
> ⚠️ **The field LABEL is record-type-specific — only the selector MODEL `input[aria-label*="<label>"].now-input-native` is portable, NOT the label string.** Verified: incident & change use **"Short description"**, but **problem**'s primary free-text field is **"Problem statement"** (`[aria-label*="Short description"]` = 0 there). Choice sets differ too (change: State/Impact/Risk/Category; problem: Impact/Urgency/Category — problem's state field is *not* labelled the literal "State"). **Census the labels per record type via `get_visible_text`; never hardcode "Short description".**

```javascript
const SD = 'input[aria-label*="Short description"].now-input-native'; // an instance of the portable MODEL above — the aria-required field; LABEL varies by table, so census it per record type (see note)
await ift({action:"click", selector:SD});
await ift({action:"fill",  selector:SD, value:"hello world"});
(await gp(SD)).p.value;                            // "hello world" (DISPLAY only)
```

### 6.2 Multi-line — `textarea.now-textarea-field`
```javascript
const DESC = 'textarea[aria-label*="Description"]'; // disambiguate from "Short description" with the textarea tag
await ift({action:"fill", selector:DESC, value:"line1\nline2"});
```

### 6.3 Choice / Select (Impact, Urgency, State, Category) — `button.now-select-trigger.now-form-field`
Read-back = the **trigger's `textContent`**. Options render as **`div[role="option"]`**, `textContent` = label.
```javascript
async function setChoice(label, value /* the STORED value, e.g. "2" */){
  const T = `button.now-select-trigger[aria-label="${label}"]`;
  await ift({action:"click", selector:T}); await sleep(700);                 // OPEN
  // ⚠️ option id scheme VARIES by release/field — try the generated scheme then the clean one:
  let opt = `div[role="option"][id$="-option-${value}"]`;                    // generated: now-dropdown-list-<inst>-option-<value>
  if ((await gp(opt)).n === 0) { opt = `div[role="option"][id="${value}"]`; if ((await gp(opt)).n !== 1) throw new Error(`ambiguous/stale choice option "${value}" (stale-option collision — see now-experience.md §6.3) — clear stale nodes or use the Table API`); }    // clean value-id
  await ift({action:"click", selector:opt}); await sleep(500);               // COMMIT
  return (await gp(T)).p.textContent;                                        // VERIFY by trigger text, e.g. "2 - Medium"
}
```
- ✅ Verified: State → "In Progress" via `div[role="option"][id$="-option-2"]`; trigger `textContent` flipped to "In Progress". The `-option-<value>` = stored-value mapping is **confirmed on this one field** — for unfamiliar choice sets verify via the trigger's `textContent` (see the stale-option collision bullet below) or prefer the Table API.
- 🔁 ⚠️ **STALE-OPTION COLLISION (important).** On a fresh page `div[role="option"]` is empty until you open a dropdown. But option/listbox nodes **linger after close** (10 stale listboxes observed after several opens), and **`div[role="option"][id="<value>"]` then matches MULTIPLE** (a clean `[id="2"]` matched both State's option **and** a stale Impact "2 - Medium" — and clicking the stale one is a no-op). Escape/commit do **not** clear them; only a fresh `navigate` does. **Mitigations:** (a) **always verify by the trigger's `textContent`, not by assuming the click worked**; (b) prefer the more-specific `id$="-option-<value>"`; (c) if you must set several choices precisely, the robust path is the **Table API** (choices don't persist via UI anyway — §4).
- Distinguish from references: **choices are `div[role="option"]`; reference results are `li[role="option"]`; pills are `li.now-typeahead-pill`.**

### 6.4 Reference / record-picker, single (Caller, …) — `input.now-typeahead-native-input`
Read-back = the input's **`.value`**.
```javascript
async function setReference(label, query /* START of the DISPLAY value */){
  const F = `[aria-label*="${label}"]`;                  // input.now-typeahead-native-input
  await ift({action:"click", selector:F});
  await ift({action:"type",  selector:F, value:query, delay:80, append:false});  // ⚠️ type, NOT fill (see note)
  for (let i=0;i<10;i++){ await sleep(500); if ((await gp('li[role="option"]')).n>0) break; } // server, debounced
  await ift({action:"click", selector:'li[role="option"]:not(.now-typeahead-pill)'}); await sleep(700);  // commit first result
  return (await gp(F)).p.value;                          // e.g. "Abel Tuter"
}
```
- ⚠️ **Use `type` (per-character), NOT `fill`, for typeaheads.** Verified: `fill` set the text but produced **0** results; per-char `type` (delay ~80) returned the result list. Single-ref sets `.value` and drops **no pill**.
- Filter on the **start of the display value** (typeahead). Target a specific result with `li[role="option"][id$="<sys_id>"]`.

### 6.5 Multi-value reference / list (Watch list, …) — pills `li.now-typeahead-pill`
Same `input.now-typeahead-native-input`; each commit drops a **pill** and clears the input.
```javascript
const WL = '[aria-label*="Watch list"]';
await ift({action:"click", selector:WL});
await ift({action:"type",  selector:WL, value:"Abel", delay:80, append:false});
for (let i=0;i<10;i++){ await sleep(500); if ((await gp('li[role="option"]:not(.now-typeahead-pill)')).n>0) break; }
await ift({action:"click", selector:'li[role="option"]:not(.now-typeahead-pill)'}); await sleep(700); // result, NOT an existing pill
(await gp('li.now-typeahead-pill')).n;                   // count pills to verify (0→1)
```
- ⚠️ Scope result clicks to **`li[role="option"]:not(.now-typeahead-pill)`** — a bare first-match can hit an existing pill.
- ⚠️ **Pill removal is not solved selector-free** (the remove control is in its own shadow; `keydown Backspace` didn't remove it) → edit the glide_list via **Table API**.

### 6.6 Toggle / Switch — `input.now-toggle[role="switch"]`
```javascript
const SW = 'input.now-toggle[role="switch"][aria-label="Stacked view"]';   // (this one is Overview-only)
const before = (await gp(SW)).p.checked;     // read .checked — NOT .value (value is always "on")
await ift({action:"click", selector:SW});
const after  = (await gp(SW)).p.checked;
```

### 6.7 Date / Date-time (Opened, …) — host `now-date-time` ⚠️ NOT drivable selector-free → Table API
- The component host matches `now-date-time` (≈1 per form; `[class*="now-date"]` ≈6). A `click` on the host did **not** reliably open the calendar, day cells are not name-addressable, and the editable native input lives in `now-date-time`'s **own shadow** (`now-date-time input` = 0, descendant combinator can't cross — §1). `[aria-label*="Opened"]` = 0 (the host isn't labelled by the field name).
- **⇒ Set date/datetime fields with the Table API.** (Aligns with §4 — a calendar pick wouldn't persist anyway.)

### 6.8 Validity signals
- **Required** fields carry `[aria-required="true"]` (Short description was the lone required input on the SOW incident); **invalid** carry `[aria-invalid="true"]`.
- The header **Save is NOT validity-gated** (enabled on a clean form) and per §4 persists nothing — **never** use Save's `disabled` as a validity oracle here.

---

## 7. Read-back & verification
- **Rendered (unsaved) state:** `get_properties` `.value` / `.textContent` (choice trigger) / `.checked` (switch); or `get_visible_text` for free regions, the `Showing N of N` header, and live counts like `"Child Incidents (1)"`. (Reflects the **display**, which may not match the model — §4.)
- **Persisted state:** **only** a `servicenow_api` Table-API `GET` is authoritative. (Verified: in-form edits + Save left `short_description`/`impact`/`sys_updated_on` unchanged; Save fired no record `PUT`.)
- **Did a real (API) change land?** Compare `sys_updated_on` before/after.

---

## 8. Verified helper block (copy into your `js_eval`)
```javascript
async function ift(a){ return await executeTool("iframe_tool", Object.assign({status_message:"drive"}, a)); }
const sleep = ms => new Promise(r=>setTimeout(r, ms));
async function gp(sel){ const r = await ift({action:"get_properties", selector:sel}); return { n:r.match_count||0, p:r.properties||null }; }
async function txt(){ return (await ift({action:"get_visible_text"})).text || ""; }       // pierces shadow

// hydration — poll a FORM tab (interactive wave), coarse retries (§3)
async function waitWorkspace(){ for(let i=0;i<9;i++){ await sleep(7000); if((await gp('button.now-tab[aria-label="Details"]')).n>0) return (i+1)*7000; } return -1; }

// navigation
async function openFormTab(name){ await ift({action:"click", selector:`button.now-tab[aria-label="${name}"]`}); await sleep(2500); }
async function isActiveTab(name){ return (((await gp(`button.now-tab[aria-label="${name}"]`)).p||{}).classList||[]).includes("is-selected"); }
async function openRelatedList(name){ await ift({action:"click", selector:`li[role="treeitem"][aria-label^="${name}"] div.now-content-tree-node`}); await sleep(2000); }
async function openGridRecord(){ await ift({action:"click", selector:'[role="gridcell"] a'}); await sleep(4000); } // first data row
async function rail(id){ await ift({action:"click", selector:"#"+id}); await sleep(1200); }     // home-btn|list-btn|teams-btn
async function sidePanel(id){ await ift({action:"click", selector:"#"+id}); await sleep(800); }  // record_info|attachments|agent-assist

// fields (DISPLAY only — persist via Table API). ALWAYS click Details first.
async function gotoForm(){
  await openFormTab("Details");
  // Details fields mount only AFTER this tab switch; poll instead of trusting a flat settle (§3)
  for (let i=0;i<30 && (await gp('input.now-input-native')).n===0;i++){ await sleep(1000); }
}
async function setNowText(label, v){ const s=`[aria-label*="${label}"]`; await ift({action:"click",selector:s}); await ift({action:"fill",selector:s,value:v}); return (await gp(s)).p.value; }
async function setChoice(label, value){ const t=`button.now-select-trigger[aria-label="${label}"]`; await ift({action:"click",selector:t}); await sleep(700); let o=`div[role="option"][id$="-option-${value}"]`; if((await gp(o)).n===0){ o=`div[role="option"][id="${value}"]`; if((await gp(o)).n!==1) throw new Error(`ambiguous/stale choice option "${value}" (stale-option collision — see now-experience.md §6.3) — clear stale nodes or use the Table API`); } await ift({action:"click",selector:o}); await sleep(500); return (await gp(t)).p.textContent; }
async function setReference(label, q){ const f=`[aria-label*="${label}"]`; await ift({action:"click",selector:f}); await ift({action:"type",selector:f,value:q,delay:80,append:false}); for(let i=0;i<10;i++){await sleep(500); if((await gp('li[role="option"]')).n>0)break;} await ift({action:"click",selector:'li[role="option"]:not(.now-typeahead-pill)'}); await sleep(700); return (await gp(f)).p.value; }
async function setSwitch(label, want){ const s=`input.now-toggle[role="switch"][aria-label="${label}"]`; if((await gp(s)).p.checked!==want){ await ift({action:"click",selector:s}); await sleep(300);} return (await gp(s)).p.checked; }
```

---

## 9. Gotchas (all verified on SOW; release-checked across two instances)
- 🧭 **The form is on the Details tab** — Overview is read-only summary cards; field anchors read 0 until you `click button.now-tab[aria-label="Details"]` (§0). #1 source of "fill does nothing".
- 🐢 **Hydration is two-phase** — text ~20s, interactive components ~45–60s cold (~7s warm). Poll `button.now-tab[aria-label="Details"]`, coarse retries, never a fixed sleep or a 30× tight loop (wasted time + context). A List→record round-trip usually forces a stuck mount (but not viewport-induced stalls — see next bullet).
- 🖥️ **Small viewports can stall the interactive wave indefinitely** — `resize` to desktop/fullhd **before** navigating (verified: >110s stall at default size vs 7s after fullhd resize; the List→record round-trip did NOT unstick it).
- 👻 **Deleted record = silent blank tab** (“Component is not configured”, no error) — masquerades as hydration failure; `GET` the record via API first. Stale chrome tabs keep dead sys_ids across sessions.
- 📑 **Details may be sectioned with collapsed sections** — expand `span.sn-section-header.collapsable` before trusting field counts/anchors (selects 1→7 after expanding on a 2026 build).
- 🆔 **Class names are release-dependent** — census the live page; anchor on role + accessible name + `now-*` class, not a memorized exact class.
- 🟢 **Selectors pierce shadow** (`get_properties`/`wait_for`/`click`/`fill`/`type`/`dispatch_event`). **No coordinates.**
- 🔻 **Descendant combinators don't cross WEB-COMPONENT shadow** (`now-date-time input`=0) — but DO work inside one tree (`[role="gridcell"] a`, `[role="listbox"] [role="option"]`).
- 🔢 **`get_properties` = first match only, `match_count` reliable (pierces) but counts hidden matches** — read `visible` for visibility (section-collapse check); cannot read aria-label/role/name values back.
- ⛔ **Synthetic edits don't persist** (§4) — tab never goes dirty, values revert, Save fires only telemetry (no record `PUT`), `sys_updated_on` unmoved. **Persist via Table API.**
- 🚪 **Dirty page → native "Leave site?" dialog** freezes the tool (§4); journal/compose **drafts** are the usual culprit. `navigate` auto-accepts (discards); re-navigate to clear; screenshot to confirm.
- 🔁 **Choice option id schemes vary** (`id="<value>"` vs `id$="-option-<value>"`) and **stale options linger & collide** across opens — verify a choice by the **trigger's `textContent`**, prefer the `-option-<value>` suffix, fresh-navigate to clear staleness, or set via API.
- 🔤 **Typeaheads need `type`, not `fill`** (fill yields 0 results). Reference results = `li[role="option"]`; pills = `li.now-typeahead-pill` (removal → API).
- 🎚️ **Switch:** read `.checked`, not `.value` (always "on").
- 📊 **The SOW related/list grid is an HTML `<table>`** — data-row links = `[role="gridcell"] a` / `td a` (≡ record number); `[role="row"]` is **absent** (0 even with data); header links = `tr a`/`th a`.
- 📅 **Date** = `now-date-time`; not selector-addressable → use the API.
- 🧭 **Left rail / compose tabs:** rail state via `is-selected` (no `value` here); compose sub-tabs + stacked-view render **Overview-only** and duplicate — trust `is-selected`, not `visible`.
- 🏢 **Workspace availability varies** — a `/now/<workspace>` route can 404 if that workspace isn't installed (e.g. only SOW was installed on the test instance); discover via `GET sys_ux_app_config`.

---
*Verified non-destructively on a live Service Operations Workspace (`/now/sow/record/incident/…`): two-phase hydration + readiness poll; the Overview-read-only vs Details-editable tab/view model; form-tab / left-rail / open-record-strip / side-panel / related-list-switcher / **populated-grid row-open** navigation; text, textarea, choice (State→In Progress via `id$="-option-2"`, with the stale-option collision reproduced), single reference (Caller via `type`), multi-pill (Watch list 0→1), switch, section-collapse-via-`visible`, and date-host inspection; a network-level Save→persistence probe showing UI edits are display-only (Save fires only `/api/now/uxmetrics/interactions`, `sys_updated_on` unmoved); and a generality cross-check across change_request & problem. Cross-checked against an earlier run on a second instance/release that confirmed the model with release-specific selector differences. Re-verified (2026-06, third build): Details gating, text fill, choice via the GENERATED `id$="-option-<value>"` scheme (Impact 3→1, trigger textContent flipped), reference per-char `type` (Caller → "Abel Tuter"), Save persisting nothing (API-confirmed `sys_updated_on` unmoved), rail `is-selected` flips — plus three new traps: viewport-dependent hydration stall, deleted-record silent blank, and the sectioned/collapsed Details form.*
