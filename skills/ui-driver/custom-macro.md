# custom-macro / UI Page variables  🔲 STUB / TODO (wildcard)

**Status:** wildcard — no single recipe. Variable types: **Custom (14)**, **Custom with Label (17)**, **UI Page (15)**.

## Why there's no one recipe

These embed an **arbitrary** widget / UI macro / UI page. The markup is bespoke per item, so you cannot pre-write a driver. They do, however, almost always **decompose into controls you already know** (select2, inputs, checkboxes, clickable tiles).

## Approach: profile, then reuse known recipes

1. `get_dom` of the variable's container at runtime.
2. Identify the real controls inside (a `.select2-container`? an `<input>`? clickable `label[for]` tiles?).
3. Drive each with the matching recipe from `select2.md` / `native-inputs.md`.
4. If the control lives in a dialog/overlay, see **`modals.md`**.

## Custom widgets may define their OWN input-type taxonomy

A custom widget can use input types that don't map 1:1 to catalog variable types. Profile the directive's `ng-switch` to learn the type, then drive with the nearest existing recipe. Verified live on a custom SP widget that defined its own `<widget>-input` taxonomy:

| Custom type | Renders as | Drive like |
|---|---|---|
| `autocomplete` | plain `<input type=text>` + its **own** debounced results dropdown (a user-search) | **reference type-filter** (`select2.md`), but the search box is the input itself, **not** `#select2-drop` |
| `choice` | jQuery select2 (single) | **select2 single** |
| `string` / `email` / `number` | native `<input>` | **native input** (`native-inputs.md`) |
| `phone` | country-code **select2** + native number input | select2 + native together |
| `boolean` | checkbox | **checkbox** |
| `upload` / `image` | file control | **attachment** (API) |

Custom 'filled'/validity state often uses a **widget-specific class** (e.g. `<widget>-form-field-filled`, mirroring catalog `mandatory-filled`) — read it via `get_properties` → `classList`.

## Known pattern

- **Day-of-week / multi-tile selectors** → clickable tile checkboxes rendered as `label[for=...]` (e.g. `label[for="mon"]`, `label[for="wed"]`); toggle via `click`. Without ≥1 tile selected, the primary button can stay disabled.

## TODO

- Catalog common custom macros and document each as encountered.
