# duration — glide Duration  ✅ VERIFIED

**Applies to:** Duration (29) variables.

**Verified on** a live Employee Center catalog item form (`/esc?id=sc_cat_item&sys_id=<item_sys_id>`) with a Duration (`glide_duration`) field.

> Shared helpers (`ift`, `gp`, `sleep`) come from `select2.md` — reuse them.

## It renders as a fieldset of up to 4 text sub-inputs — *not* one formatted box

On SP/ESC a Duration variable renders a **`<fieldset id="sp_formfield_<varname>" role="group">`** wrapping **four `<input type="text">`** sub-fields (days / hours / minutes / seconds). There is **no single "3 Days 04:00:00" box and no hidden aggregate input** inside the fieldset — each sub-input is its own model part.

| Node | Selector |
|---|---|
| Container | `#sp_formfield_<varname>` — a `<fieldset>`, **not** an `<input>` (`input#sp_formfield_<varname>` matches 0) |
| Days | `#dur-days-<varname>` |
| Hours | `#dur-hours-<varname>` |
| Minutes | `#dur-minutes-<varname>` |
| Seconds | `#dur-seconds-<varname>` |

Each sub-input is `ng-model="parts[unit]" ng-change="updateDuration()"`, so a `fill` (which fires `change`) commits that part via `updateDuration()`. Read back each sub-input's `.value` — there's no aggregate to read.

## Recipe (verified)

```javascript
async function setDuration(varName, parts){            // parts = {days,hours,minutes,seconds}
  const units = ["days","hours","minutes","seconds"];
  for (const u of units){
    const sel = `#dur-${u}-${varName}`;
    if (!(await gp(sel)).match_count) continue;          // some items hide units (visibleUnits config)
    await ift({action:"wait_for", selector_visible:sel, timeout:8000});
    await ift({action:"fill", selector:sel, value:String(parts[u] ?? 0)});   // keydown..input..change -> updateDuration()
  }
  await ift({action:"dispatch_event", selector:`#dur-seconds-${varName}`, event:"blur"});
  await sleep(200);
  const out = {};
  for (const u of units){ const r = await gp(`#dur-${u}-${varName}`, ["value"]); out[u] = r.properties && r.properties.value; }
  return out;   // verified -> {days:"3", hours:"4", minutes:"30", seconds:"0"}
}
// usage: await setDuration("my_duration", {days:3, hours:4, minutes:30, seconds:0});
```

## Gotchas (verified)

- **The anchor is a `<fieldset>`, not an input** — `input#sp_formfield_<varname>` matches nothing; drive the `#dur-<unit>-<varname>` sub-inputs.
- **No aggregate field** — read back each sub-input's `.value`; there is no single hidden duration mirror inside the fieldset.
- **Some items hide units** (`visibleUnits` config) — only the rendered sub-inputs exist, so probe each `#dur-<unit>-<varname>` and skip the absent ones (the recipe's `match_count` guard does this).
- **`fill` alone commits** — each sub-input's `ng-change="updateDuration()"` fires on the `change` event that `fill` dispatches; the trailing `blur` is belt-and-suspenders.

---
*Verified on a live Employee Center Duration field:* days/hours/minutes/seconds set via `fill` each read back exactly; the fieldset `#sp_formfield_<varname>` wraps `#dur-{days,hours,minutes,seconds}-<varname>` with no aggregate input. *Re-verified end-to-end (2026-06, second instance):* `setDuration({3,4,30,0})` read back exactly; `input#sp_formfield_<var>` matched 0 (fieldset confirmed).
