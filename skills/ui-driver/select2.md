# select2 — reference / choice / lookup / multi pickers

The biggest win on ESC: a large share of catalog variables render as jQuery **select2**. One mechanic family drives them all.

**Applies to variable types:** Reference (8), Select Box (5), Lookup Select Box (18), Requested For (31), Table Name (40), Lookup Multiple Choice (22), Yes/No (1 when a dropdown), and any glide_list multi field (catalog **List Collector** variables — see `list-collector.md`).

**Verified on** a live Employee Center catalog item form (`/esc?id=sc_cat_item&sys_id=<item_sys_id>`) — a static Select Box, a Reference field, and a multi-select field.

## ⭐ The anchor: `#s2id_sp_formfield_<variable_name>`

Every select2 on the **standard catalog `sp_form` widget** gets a **stable container id** `#s2id_sp_formfield_<varname>` once the Angular form fully renders. *(Custom, non-catalog widgets do **not** — see the custom-widget bullet below.)* Anchor everything to it — far more robust than matching label text.

```javascript
const C = "#s2id_sp_formfield_" + varName;   // e.g. #s2id_sp_formfield_my_reference
```

- **Fallback anchor** (label known, varname not): `.select2-container:has(ul.select2-results[aria-label="<Question label>"])`. Note `aria-label` carries the **question/label text**, not the variable name.
- **⚠️ Wait for the stable container before interacting.** Some forms briefly render a *transient* autogen container (`#s2id_autogen5`, …) that Angular then replaces with `#s2id_sp_formfield_*`. Driving the transient node **silently no-ops** — the drop never opens. Always `wait_for selector_visible: C` first. (Tell-tale of a stale node: its `aria-required` still shows the un-interpolated binding `"field.required && isEmpty()"`.)
- **⚠️ Custom (non-catalog) SP widgets do NOT expose `#s2id_sp_formfield_*` at all.** That id is specific to the **standard catalog `sp_form` widget**. **Container-id rule of thumb (re-verified on a second build): select2 names its container `s2id_<underlying element id>`.** So a custom widget whose `<select>`/`<input>` has a semantic id gets a **semantic container id** (verified live: `#s2id_<elementId>`-style semantic container ids on an embedded sub-widget); a **bare autogen container** (`#s2id_autogen11`, …) appears only when the source element is **id-less** — and on that build the autogen id was **persistent** (never replaced), i.e. the real drivable node, *not* a transient trap. A **custom wrapper class** (e.g. `.select2-container.<widget-specific-class>`) exists on *some* widgets but **not all** (a second build had only `select2-container` + `ng-*` state classes) — treat it as one anchoring option, not a guarantee. **Which world am I in?** If `#s2id_sp_formfield_<var>` exists → catalog form (autogen = transient, wait for the stable id). If it doesn't → custom widget: anchor the **semantic `#s2id_<elementId>`** if present, else the persistent autogen id (label-derive it at runtime), else a custom wrapper class. Either way the **open/commit mechanic below is identical** — only the anchor changes; always verify by confirming the drop opens (`get_properties("#select2-drop").properties.visible===true`). ⚠️ select2's **internal search inputs** also get autogen ids that **re-mint per modal open** — never anchor those.

## The open / commit / close mechanic

| Step | How |
|---|---|
| **Open** (single) | `dispatch_event mousedown` on `C .select2-choice` |
| **Open** (multi) | `click` on `C .select2-choices` |
| **Commit** | `dispatch_event mouseup` on the **highlighted** result label (verified — see note) |
| **Close** | `wait_for selector_gone: "#select2-drop"` |

> **`dispatch_event` supports `mousedown`/`mouseup` as first-class events** (both are in the enum and fire **real `MouseEvent`s**) — **verified working live** (mousedown opens, mouseup commits). `keydown Enter` on the search input also commits the highlighted row (handy fallback for async multi), but Enter can submit/reload the form on some single fields — **default to `mouseup`.**

When open, select2 promotes the active dropdown to a single body-level node **`#select2-drop`** — always target that for the live list. **Open-detection gotcha:** `#select2-drop` keeps the `select2-display-none` *class* even while open → detect open via `get_properties("#select2-drop").properties.visible === true`, never by class.

## Shared helpers (define once; reused by every ui-driver file)

```javascript
async function ift(a){ return await executeTool("iframe_tool", Object.assign({status_message:"drive"}, a)); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function gp(sel, inc){
  // get_properties now returns success:true + match_count:0 + properties:null on a no-match;
  // this gp() shim stays as a thin defensive normalizer (also covers older/un-updated builds)
  try { const r = await ift({action:"get_properties", selector:sel, include:inc});
        return { success: r.success !== false, match_count: r.match_count || 0, properties: r.properties || null }; }
  catch(e){ return { success:false, match_count:0, properties:null }; }
}
// open == body-level #select2-drop present AND visible:true (the select2-display-none CLASS lingers when open)
async function dropOpen(){ const p = await gp("#select2-drop"); return !!(p.properties && p.match_count>0 && p.properties.visible===true); }
```

## Three variants

### 1. Static Select Box (small fixed list) → INDEX-pick (universal default)
Read the option order, find your index, `mouseup` the nth child — this works on **every** select box regardless of whether it shows a search box.

> ⚠️ Earlier guidance said "typing never filters a static list." That's **form-dependent**: select2 hides the search box only when the option count is below `minimumResultsForSearch`. A select box *with* a search box (`#select2-drop` gets class `select2-with-searchbox`) **does** filter as you type — verified live. Index-pick still works in both cases, so default to it; reach for type-filter only after confirming a search box is present. (Data point: a **4-option** Select Box (`-- None --`/Apple/Banana/Cherry) on the tested ESC instance *still* rendered the search box — `#select2-drop` carried `select2-with-searchbox` — so even a *small* list does **not** guarantee its absence; index-pick remains the safe universal default.)

```javascript
async function pickSelectBox(C, wantedText){
  await ift({action:"wait_for", selector_visible:C, timeout:10000});
  await ift({action:"dispatch_event", selector:C+" .select2-choice", event:"mousedown"});
  await ift({action:"wait_for", selector_visible:"#select2-drop ul.select2-results > li"});
  const dom = await ift({action:"get_dom", selector:"#select2-drop .select2-results", max_length:6000});
  const html = dom.html || dom.dom || "";
  const labels = [...html.matchAll(/select2-result-label[^>]*>(?:<[^>]+>)*\s*([^<]+?)\s*</g)].map(m=>m[1].trim()).filter(Boolean);
  let idx = labels.findIndex(t => t.toLowerCase() === wantedText.toLowerCase());
  if (idx < 0) idx = labels.findIndex(t => t.toLowerCase().startsWith(wantedText.toLowerCase()));
  if (idx < 0) throw new Error("option not found among: " + labels.join(" | "));
  await ift({action:"dispatch_event", selector:`#select2-drop ul.select2-results > li:nth-child(${idx+1}) .select2-result-label`, event:"mouseup"});
  await ift({action:"wait_for", selector_gone:"#select2-drop"});
}
```

### 2. Single Reference (async server list) → type-filter
Has its own search box **inside** the drop. Type, wait for a selectable result, mouseup the highlighted one.

```javascript
async function pickReference(C, query){
  await ift({action:"wait_for", selector_visible:C, timeout:10000});
  await ift({action:"dispatch_event", selector:C+" .select2-choice", event:"mousedown"});
  await ift({action:"fill", selector:"#select2-drop input.select2-input", value:query});
  await ift({action:"wait_for", selector_visible:"#select2-drop .select2-result-selectable:not(.select2-searching)", timeout:8000});
  await ift({action:"dispatch_event", selector:"#select2-drop li.select2-highlighted .select2-result-label", event:"mouseup"});
  await ift({action:"wait_for", selector_gone:"#select2-drop"});
}
```

### 3. Multi (glide_list / lookup multiple) → inline input, repeatable
The multi has **no search box in the drop** — type into the **inline** `.select2-input` inside `C .select2-choices`. Call once per chip.

```javascript
async function addMultiChip(C, query){
  await ift({action:"wait_for", selector_visible:C, timeout:10000});
  await ift({action:"click", selector:C+" .select2-choices"});
  await ift({action:"type", selector:C+" .select2-input", value:query, delay:60});   // inline input, NOT #select2-drop
  await ift({action:"wait_for", selector_visible:"#select2-drop .select2-result-selectable:not(.select2-searching)", timeout:8000});
  await ift({action:"dispatch_event", selector:"#select2-drop li.select2-highlighted .select2-result-label", event:"mouseup"});
  await ift({action:"wait_for", selector_gone:"#select2-drop"});
  // chip now at: C + " li.select2-search-choice"  (remove via a.select2-search-choice-close)
}
```

## Read back the committed value
- **Single:** `C .select2-chosen` → `textContent` (an empty field shows `.select2-choice.select2-default`).
- **Multi:** count chips `C li.select2-search-choice`.

## Validity signal — read the field, not the button

⚠️ On the standard ESC **SC Catalog Item** widget the primary button is **"Order Now"** bound to `ng-disabled="disableControls()"` (a processing flag): it stays **enabled even when a mandatory field is empty** (verified live). **Do not** gate on `#submit-btn.disabled` here. Read validity **per field** instead:

```javascript
// an empty single select2 carries .select2-choice.select2-default; a filled one has .select2-chosen text
async function singleFilled(C){
  const chosen = await gp(C + " .select2-chosen");
  const txt = ((chosen.properties && chosen.properties.textContent) || "").trim();
  const empty = await gp(C + " .select2-choice.select2-default");   // gp normalizes match_count to 0 when absent
  return txt.length > 0 && empty.match_count === 0;
}
async function multiCount(C){ return (await gp(C + " li.select2-search-choice")).match_count; }   // chips
```

> Some *other* SC widgets (e.g. a record-producer with a "Submit" button) **do** flip `#submit-btn.disabled` with validity. Use the button only after confirming it actually toggles when you clear a required field; otherwise use the per-field reads above.

## Gotchas (all verified)
- ⭐ Anchor to `#s2id_sp_formfield_<varname>`; **wait for it** before interacting (transient autogen ids silently no-op).
- `#select2-drop` keeps `select2-display-none` while open → detect open by `.visible===true`, not class.
- Commit is **always** `mouseup` on the result label; Enter is unreliable.
- Search-box location differs: single ref & select box → inside `#select2-drop`; **multi → inline** `C .select2-input`.
- Static select box → **index-pick by default**; typing filters only when a search box is present (`select2-with-searchbox`), which is option-count dependent.
- **A static Select Box with no `-- None --` option auto-selects its FIRST choice on render** — it never carries `.select2-default`, so `singleFilled()` reads `true` *before* any user pick. The `.select2-default` empty-state signal is reliable for genuinely-empty fields (e.g. an untouched Reference), not auto-defaulted static selects; to confirm a *specific* choice, read `.select2-chosen` text.
- **Reference / list queries match the START of the DISPLAY value (starts-with typeahead), not the back-end username/number** — a `sys_user` search for "admin" returns *No matches* (display name is "System Administrator"), and so does a **middle/last word**: "Tuter" → *No matches* while the **leading** token "Abel" → "Abel Tuter" (verified live). Query the **beginning** of the display value ("Abel", "System Administrator"), specific enough that your target is the highlighted top row. (If the instance is configured for contains-search a middle word may also match — but starts-with is the default, so don't rely on a surname.)
- Only the OPEN dropdown is promoted to body-level `#select2-drop`; closed containers keep their own inline hidden `.select2-drop` child — always target `#select2-drop` for the live list.
- The open `#select2-drop` may also carry **`select2-drop-above`** (list rendered *above* the field when space below is tight) — don't bake drop-below positioning classes into selectors or assertions.

---
*Verified on a live Employee Center catalog item form:* a static Select Box (index-pick), a Reference field (type-filter), and a multi-select field (chip add). One transient-node failure was observed and resolved by waiting for the stable container.

*Re-verified end-to-end (2026-06, second instance):* `pickSelectBox` (3-option list, no `-- None --`, auto-selected first choice pre-pick exactly as the gotcha warns — and it **still** carried `select2-with-searchbox`), `pickReference("Abel")` → "Abel Tuter", `singleFilled()` both fields, and the `select2-display-none`-while-open trap. The custom-widget container-id rule (`s2id_<elementId>`) re-verified on a third, embedded sub-widget.
