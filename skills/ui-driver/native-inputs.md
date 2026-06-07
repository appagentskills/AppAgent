# native-inputs — text, textarea, checkbox, radio, numeric

Plain HTML controls that need no widget dance. The easy ones — but **anchoring** and the **"did it stick + clear validation"** re-read still matter on Angular forms.

> Shared helpers (`ift`, `gp`, `sleep`) are defined in `select2.md`'s helper block — reuse them; don't redefine.

## Variable types covered

| Type | Renders as | Recipe |
|---|---|---|
| Single Line Text (6), Wide Single Line (16), Email (26), IP Address (28), Masked (25) | `<input>` | `setText` |
| Multi Line Text (2) | `<textarea>` | `setText` |
| CheckBox (7), Yes/No (1, when a checkbox) | `<input type=checkbox>` | `setCheckbox` |
| Multiple Choice (3), Numeric Scale (4) | radio group | click the option label |

## Anchoring

On ESC, catalog variables render a label + input. Most reliable anchors, in order:

- **By placeholder** — some custom widgets set them: `input[placeholder="<placeholder text>"]`.
- **By container + nearby label** — catalog variable ids are generated; find the question row by its visible label text, then the input/textarea within that row.
- **By id / aria-label** — only if stable across reloads.

## Text / textarea

`fill`, then **re-read to confirm** (Angular two-way binding can lag); retry up to 3×.

```javascript
async function setText(sel, v){
  await ift({action:"wait_for", selector_visible: sel, timeout:8000});
  for (let a=0; a<3; a++){
    await ift({action:"fill", selector: sel, value: v}); await sleep(120);
    const r = await gp(sel, ["value"]);
    if (r.properties && r.properties.value === v) return true;
  }
  return false;
}
```

- `fill` fires the full keydown→input→keyup→change chain, so Angular `ng-model` and catalog `onChange` client scripts see real input.
- For **debounced** fields (a reference qualifier reacting to a text field), prefer `type` with a `delay` over `fill`.

## Checkbox

Read current state, click only if it must change, re-read to confirm.

```javascript
async function setCheckbox(idOrSel, want){
  const r = await gp(idOrSel); const cur = !!(r.properties && r.properties.checked);
  if (cur !== want){ await ift({action:"click", selector: idOrSel}); await sleep(400); }
  const r2 = await gp(idOrSel); return (!!(r2.properties && r2.properties.checked)) === want;
}
```

- If the visible box is a styled label hiding the real input, click `label[for="<id>"]`, not the hidden `<input>`.

## Radio (Multiple Choice / Numeric Scale)

⚠️ On SP the radio `<input>`s have **no `id`**, so `label[for="…"]` matches **nothing**. Each option renders as `<label class="radio-element"><input type="radio" aria-label="<text>" value="<val>"><span>text</span></label>`, all inside a **`<fieldset>`** `#sp_formfield_<varname>` (the anchor is a fieldset, *not* an input). Click the input scoped by `aria-label` (the option text) or `value`; clicking the wrapping `label.radio-element` works too. Confirm via the input's **`.checked` property**.

```javascript
async function setRadio(varName, optionText){
  const fs  = "#sp_formfield_" + varName;                              // <fieldset role="group">
  const opt = `${fs} input[type=radio][aria-label="${optionText}"]`;   // or `${fs} input[value="L"]`
  await ift({action:"wait_for", selector_visible: fs, timeout:8000});
  await ift({action:"click", selector: opt});
  await sleep(250);
  const r = await gp(opt);
  return !!(r.properties && r.properties.checked);                     // read the PROPERTY, not the attribute
}
```

Numeric Scale is a horizontal radio group `1..N` (anchor by `aria-label`/`value` the same way). Options may arrive **pre-selected** (e.g. the first choice) — read current state before assuming empty.

## Gotchas

- **Always confirm it stuck.** Binding lag is real — re-read the value and retry up to 3×.
- **Client scripts / UI policies** may clear or rewrite a field after you set it (onChange). Set fields in dependency order; re-assert at the end.
- **Validity** — do **not** trust the primary button here: the ESC SC Catalog Item button is "Order Now" / `ng-disabled="disableControls()"` and never reflects validity (see SKILL.md). Use per-field signals: a satisfied mandatory field's asterisk `#<var> span.mandatory` gains class `mandatory-filled` (aria-label flips `Required ` → `Required Filled `); an invalid field's `.field-actual` gains `has-error`. Read these classes from **`get_properties` → `properties.classList`** (now always returned), e.g. `classList.includes("has-error")` or `classList.includes("mandatory-filled")`; `get_dom`+regex remains a legacy fallback for un-updated builds.
- **⚠️ Detecting `mandatory-filled` safely.** Easiest now: read `get_properties` → `properties.classList` and test `classList.includes("mandatory-filled")` — `classList` reflects the *applied* classes, so the binding-literal trap below never arises. If you instead scrape raw markup (legacy fallback): the asterisk span carries its **`ng-class` binding literal in every state** — `ng-class="{'mandatory-filled': field.mandatory_filled()}"` — so the bare substring `mandatory-filled` is **always present**, even when unset. A naive `/mandatory-filled/` matches the binding, **and so does `/class="[^"]*mandatory-filled/`** (because `ng-class="` contains `class="`). Detect the real state instead:
  - empty asterisk:  `class="fa fa-asterisk mandatory sp-field-label-padding ng-scope"`
  - filled asterisk: the same **plus** a real trailing ` mandatory-filled`, and `aria-label` flips `Required ` → `Required Filled `
  - safest check — the aria-label flip: `/aria-label="Required Filled/.test(html)`; or capture the real `class` attribute and test *that* string (not the raw markup) for the word `mandatory-filled`.

---

*Verified on live Employee Center forms:* `setText` (text + multiline textarea) and `setCheckbox` (the raw `#sp_formfield_<var>` input, which carries the `ng-click`) proven; `setRadio` verified on a real Multiple Choice (`input[aria-label]` scoped to the `<fieldset>`). **Note:** the `label[for="mon"]`-style tile is the *day-of-week macro* in `custom-macro.md`, **not** a Multiple Choice — the two were previously conflated here.
