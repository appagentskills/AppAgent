# list-collector (glide_list) — select2 multi tag input

⚠️ **Reality check:** On Service Portal / Employee Center (`/esc`) a "List Collector" (variable type **glide_list**) does **NOT** render as the classic slushbucket dual-list. There are **no Available/Selected panes and no →/← arrows** — those exist only in the platform back-end UI. On `/esc` it is a **select2 multi-select tag input**, same family as `select2.md`.

**Verified on** a live Employee Center catalog item form (`/esc?id=sc_cat_item&sys_id=<item_sys_id>`) with a List Collector (`glide_list`) field.

> Shared helpers (`ift`, `gp`, `sleep`) come from `select2.md` — reuse them.

## It's just a select2 multi

- Anchor: `#s2id_sp_formfield_<varname>` (carries class `select2-container-multi`).
- Mechanically identical to **`addMultiChip` in `select2.md`**. This file documents the glide_list specifics.

## Add an item (async, server-filtered)

The list queries the server per keystroke, so **type per-character** to trip the debounced search, then commit the highlighted top result.

```javascript
async function addToListCollector(C, query){    // mechanically identical to addMultiChip
  const input = C + " .select2-input";                 // inline search field inside .select2-choices
  await ift({action:"wait_for", selector_visible:C, timeout:10000});
  await ift({action:"click", selector: input});
  await ift({action:"type", selector: input, value: query, delay:50});   // per-character -> fires the async server search
  // Poll the body-level drop. ⚠️ A COLD glide_list search (the first one on a fresh form) can sit in
  // "Searching…" for well over 8s before results land, so wait up to ~15s AND keep waiting while the
  // spinner row #select2-drop li.select2-searching is present — only FAIL FAST on an explicit
  // "no results" (else a non-matching query just burns the timeout with an opaque failure).
  let ready = false;
  for (let i=0; i<60; i++){                             // ~15s @ 250ms (cold first search can exceed 8s)
    if ((await gp("#select2-drop li.select2-highlighted")).match_count > 0){ ready = true; break; }
    if ((await gp("#select2-drop .select2-no-results")).match_count > 0)
      throw new Error("No matches for '"+query+"' — a sys_user list matches the DISPLAY NAME, not username (use 'Abel', not 'admin').");
    // still spinning (.select2-searching)? expected on a cold server search — keep waiting, don't bail
    await sleep(250);
  }
  if (!ready) throw new Error("list results never appeared for '"+query+"' (cold search exceeded ~15s)");
  // commit the highlighted (TOP) result:
  await ift({action:"dispatch_event", selector:"#select2-drop li.select2-highlighted .select2-result-label", event:"mouseup"});
  // equivalent fallback: dispatch_event keydown key:"Enter" on `input` — also commits the top row
  await ift({action:"wait_for", selector_gone:"#select2-drop"});
}
```

- **Make `query` specific** so the wanted item is the **first** result — both `mouseup` and `Enter` commit the **highlighted top row**. Arrow-down first if you need a lower row. **The query matches the START of the reference's DISPLAY value (starts-with typeahead), not the back-end key** — a `sys_user` list finds "Abel Tuter" when you type the **leading** token ("Abel", "Abel Tut", or "System Administrator"), *not* the username "abel"/"admin", **and not a middle/last word**: typing the surname "Tuter" returns **No matches** (verified live). Always query from the **beginning** of the display name.
- A one-shot `fill` may NOT trigger the async search — use `type` with a delay.
- **Keep the query SHORT.** Per-character `type` over `iframe_tool` is slow (~28s measured for the 20-char "System Administrator"). Use the shortest uniquely-matching **leading** substring of the display name (e.g. "Abel" for "Abel Tuter" — **not** the surname "Tuter", which matches nothing under the starts-with typeahead) so your target is still the highlighted **top** row while minimizing typing time.

## Confirm / read / remove

- **Added** → a tag `li.select2-search-choice` (id `s2id_autogen*_choice_<sysId>`) appears in `C .select2-choices`, **and** the hidden value input `#sp_formfield_<varname>` becomes a **CSV of sys_ids**.
- **Read value:** `#sp_formfield_<varname>` `.value` (comma-separated sys_ids).
- **Remove a tag:** plain `click` on `C .select2-search-choice-close` (the × on the tag) — clears that sys_id from the CSV.

## Gotchas (verified)

- **Not a slushbucket** — don't look for arrows / dual panes on `/esc`; they don't exist here.
- **Type per-character** (`type`, delay ~50ms); one-shot `fill` may not fire the debounced server search.
- **Cold first search CAN be slow — but it's variable, not guaranteed.** One verified run saw the first glide_list query sit in `#select2-drop li.select2-searching` ("Searching…") for **>8s**; a re-verification run on another instance saw the cold search resolve in **~0.3s** (the ~3.5s of per-char typing itself absorbed the server latency). Treat the **~15s poll as an upper bound, not an expectation**: keep waiting while `.select2-searching` is present; only fail fast on `.select2-no-results`. (The original 8s/40-iteration window timed out on a cold search and threw an opaque "list results never appeared".)
- **A no-results search is ALSO slow to say so** — `.select2-no-results` took ~4–5s to render after typing (verified). Poll for it inside the same loop; don't assert "no results" immediately after typing. After a no-results search, dispatch `keydown` `Escape` on the select2 input to close the drop before driving chips or other fields.
- **Commit the highlighted top row** — make the query specific (or arrow-down first), or you add the wrong item.
- **Starts-with typeahead — query the BEGINNING of the display name (verified live).** "Abel" → "Abel Tuter"; the surname "Tuter" → explicit **No matches**. The list matches the *start* of the display value, so leading tokens work and middle/last words don't (unless the instance is configured for contains-search). ⚠️ Earlier guidance here suggested a surname like "Tuter" — that was **wrong**; use a leading token like "Abel".
- **Value is a hidden CSV text input**, not a `<select multiple>` — `select_option` does not apply.
- **Autogen ids are unstable** (`s2id_autogen2`…) — always scope via `#s2id_sp_formfield_<varname>`.
- **Validity:** on this widget `#submit-btn` is `ng-disabled="disableControls()"` (a processing flag) and stays enabled even when empty — **don't trust the button here**; read the hidden value / tag presence instead. (See the validity caveat in `SKILL.md`.)

---
*Verified on a live Employee Center List Collector field:* two items added & removed; the hidden value updated to the selected sys_ids and cleared on remove. Commit via `mouseup` on the result label confirmed working (also `keydown Enter`). *Re-verified (starts-with):* `addToListCollector(C,"Abel")` committed the user's sys_id, while the surname "Tuter" returned **No matches** — query the leading token.

*Re-verified end-to-end (2026-06, second instance):* "Abel" added (hidden CSV = the user's sys_id), "Tuter" → `.select2-no-results` after ~4.7s, chip remove cleared the CSV to `""`. Cold search resolved in ~0.3s on this run — confirming cold-search slowness is variable (poll window = upper bound).
