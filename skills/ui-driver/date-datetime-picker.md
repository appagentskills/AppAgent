# date-datetime-picker — glide Date & Date/Time

**Applies to:** Date (9) and Date/Time (10) variables. This was a long-standing gap; it's now **solved for typing**.

**Verified on** a live Employee Center catalog item form (`/esc?id=sc_cat_item&sys_id=<item_sys_id>`) with a Date/Time (`glide_date_time`) field.

## TL;DR — type it, then **blur**

`fill` the visible input with a strictly-formatted string, then dispatch a **`blur`** event. Blur is **mandatory** — the input has `ng-model-options="{updateOn:'blur', getterSetter:true}"`, so the model only commits on blur; the `change` event that `fill` fires is **ignored**.

```javascript
async function setDateField(varName, value){
  // value MUST be strict: 'YYYY-MM-DD HH:mm:ss' (Date/Time) or 'YYYY-MM-DD' (Date).
  const input = "#sp_formfield_" + varName;                 // visible input (ng-model=formattedDate)
  await ift({action:"wait_for", selector_visible: input, timeout:10000});
  await ift({action:"fill", selector: input, value: value});           // reflects in .value but NOT committed yet
  await ift({action:"dispatch_event", selector: input, event:"blur"}); // REQUIRED — updateOn:'blur' commits here
  await sleep(150);                                                     // let the model + DOM settle
  return await verifyDateField(varName, value);
}

// Robust "did it stick?" — returns {ok, committed, hasError, hint}.
async function verifyDateField(varName, value){
  const container = "#" + varName;                          // container id === variable name
  // Positive signal: the field-scoped hidden mirror equals your EXACT string. (It defaults to "now"
  // BEFORE any commit, so a value MATCH is the proof — not mere presence.)
  const hidden = await gp(container + " input.datepickerinput", ["value"]);
  const committed = !!(hidden.properties && hidden.properties.value === value);
  // Error signal: .has-error on .input-group. get_properties now returns success:true +
  // match_count:0 on a no-match (no more `undefined === 0` trap), so a real match == a real error.
  const err = await gp(container + " .input-group.has-error");
  const hasError = !!(err && err.success === true && err.match_count > 0);
  let hint = "";
  if (hasError){ const h = await gp(container + " .sp-date-format-info"); hint = (h.properties && h.properties.textContent) || ""; }
  return { ok: committed && !hasError, committed, hasError, hint };
}
// usage: await setDateField("my_datetime", "2026-06-15 14:30:00");  // {ok:true,...}
//        await setDateField("my_date",     "2026-06-15");           // {ok:true,...}
```

> One `varName` drives all three nodes: the container `#<varname>`, the visible input `#sp_formfield_<varname>`, and the field-scoped hidden mirror `#<varname> input.datepickerinput`.

## Format (strict)

| Variable type | Accepted format | Example |
|---|---|---|
| Date/Time (10) | `YYYY-MM-DD HH:mm:ss` (24-hour) | `2026-06-15 14:30:00` |
| Date (9) | `YYYY-MM-DD` | `2026-06-15` |

Locale / AM-PM strings (e.g. `15/06/2026 2:30 PM`) are **rejected**: the container goes `has-error`, `aria-invalid="true"`, and a hint span `.sp-date-format-info` appears reading *"Date in format YYYY-MM-DD HH:mm:ss"* (a handy way to read the exact expected format off any date field).

## Did it stick? (per-field validity)

After `fill` + `blur`, a **committed** value shows:
- field-scoped hidden `#<varname> input.datepickerinput` **`.value` === your exact string** — the strongest signal (⚠️ it carries a pre-set *"now"* default *before* commit, so a value **match** is the proof, not mere presence);
- field container `#<varname> .input-group` **lacks** `has-error`; input `aria-invalid="false"`;
- *(mandatory fields only)* the asterisk `#<varname> span.mandatory` gains class `mandatory-filled` (detect via the `aria-label="Required Filled"` flip, **not** a bare `mandatory-filled` regex — the `ng-class` binding literal always contains that string; see `native-inputs.md`) — it's **absent entirely** on optional fields, so don't rely on it generically.

⚠️ **Don't judge by the visible input** — it keeps whatever you typed even when rejected **and stays `ng-valid`** regardless (ngAnimate also leaves transient `*-add`/`*-remove` classes on it). Judge by the **hidden-value match + absence of `has-error`** on the container.

## Calendar popup (optional — typing is enough)

If you ever need it: open via `#<varname> button.datepickericon`, popup is `.datepicker > .datepicker-days` (Bootstrap/eonasdan). Days are `td.day > div[role="button"]`; selected = `td.day.active`. Clicking a day **commits live (no OK/Apply button)** and preserves the time component. To change the time, toggle the time view via `.picker-switch`. Typing the full string is simpler — prefer it.

## Gotchas (all verified)

- **Blur is mandatory** — `fill` alone never commits (`updateOn:'blur'`). Always `dispatch_event blur` after.
- **Strict 24-hour format** — locale/AM-PM rejected; model silently keeps the last valid value while the box shows your bad text.
- **`input.datepickerinput` is NOT field-specific** — multiple date fields on one form share it. Always scope within `#<varname>`.
- **Detect `has-error` safely** — `get_properties` on a no-match now returns `success:true` with `match_count:0` (it used to return `success:false` with **no** `match_count`, so the old `err.match_count === 0` read `undefined === 0` → **false** and falsely failed a valid commit). Treat "has error" as `err.match_count > 0`; the `gp` shim in `select2.md` still normalizes `match_count` for older builds.
- **Page-load instability** — a page may briefly redirect or re-render on first load, and a parallel click can trigger a stray navigation. Re-navigate, `wait_for selector_visible: "#sp_formfield_<varname>"`, and interact **sequentially** (not parallel) with click actions.

## Alternative: in-page native setter

If `iframe_tool` event timing is flaky, set the value in-page via the native setter + dispatch input/change/**blur** (blur still required):

```javascript
const el = document.querySelector("#sp_formfield_" + varName);
el.focus();
Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, value);
el.dispatchEvent(new Event("input",  {bubbles:true}));
el.dispatchEvent(new Event("change", {bubbles:true}));
el.dispatchEvent(new Event("blur",   {bubbles:true}));   // REQUIRED
```

---
*Verified on a live Employee Center Date/Time field:* a strict-format string set via fill+blur stuck (`ng-valid`, `mandatory-filled`, hidden input synced); a negative test with a locale string surfaced `has-error` + the format hint. Calendar popup day-click also commits live.
