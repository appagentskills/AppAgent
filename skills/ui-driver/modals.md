# modals / dialogs / overlays — custom SP widget dialogs  ✅ VERIFIED (live custom SP widget)

Catalog forms are flat, but **custom SP widgets** (and some record-producer flows) open **modals**. The component recipes (`select2.md`, `native-inputs.md`, `date-datetime-picker.md`) work **unchanged inside a modal** — a modal only changes **scoping, commit-button disambiguation, close detection, and multi-stage flow**.

**Verified on** a live Employee Center **custom SP widget** (`/esc?id=<widget_id>`) — an **add-sub-record** flow, a two-stage custom modal.

> Shared helpers (`ift`, `gp`, `sleep`) come from `select2.md` — reuse them.

## 1. Don't assume Bootstrap — profile the container first

There is **no guaranteed `.modal-content` / `.modal-dialog`**. Custom widgets roll their own. Open the modal (click its trigger), then `get_dom` the overlay and identify its real container.

- Verified example: the *Add* trigger opened a custom **`.<widget>-modal`** (with its own `…-modal-header` / `…-modal-body` / `…-modal-close`, closed via an `ng-click` handler). The **second** stage opened in a **different** container — so don't hard-code one selector.
- `wait_for selector_visible` on a **field unique to the modal** (e.g. `input[placeholder="Email"]`) to confirm it's open and rendered.

## 2. Scope every field selector to the modal (or use unique anchors)

The page underneath still has its own controls. Either prefix selectors with the modal container, **or** anchor on something unique to the modal (a placeholder/label absent from the page). Native-input **placeholder anchors** (`input[placeholder="First name"]`) were the single most reliable anchor here.

## 3. ⚠️ Disambiguate the modal's commit button from the page's

The modal's **Save / Add / Submit** button is frequently a **different DOM node** than the page's primary button, and a bare `button.btn-primary` matches **both**. Separate them:

- Verified live: the page's primary button was `button.btn-primary.ng-scope`; the modal's save was `button.btn-primary` **without** `ng-scope` → `button.btn-primary:not(.ng-scope)` hit the modal one. (Compare both via `get_properties` → `classList` and pick a separating class, or scope under the modal container.)
- The modal button is often **validity-gated** for real — verified `ng-disabled="!formValid || isSubmitting || (isEditMode && !isFormDirty())"`, which flips enabled the moment the required field is valid. (See `SKILL.md` golden rules: read the `ng-disabled` expression to decide if the disabled state is a trustworthy signal.)

## 4. Commit, then wait for CLOSE via `selector_gone`

After clicking the commit button, `wait_for selector_gone` on a **modal-unique field** (e.g. `input[placeholder="First name"]`) — not the generic container, which may be reused by the next stage.

## 5. ⚠️ Multi-stage: RE-PROFILE after every commit

A modal submit may **not** be the end. Verified: submitting stage A (a short first stage, e.g. Email + a type select) **immediately created the backend record** AND **auto-opened stage B** (a details stage with more fields — e.g. names, a country-code select2 + native phone input, checkboxes, more select2s) with the stage-A fields now read-only. **The full field set was not knowable from stage A.** After each commit, re-profile (`SKILL.md` Standard loop step 5).

## Recipe sketch (verified shape)

```javascript
// open
await ift({action:"click", selector:"<add-button>"});                       // the dialog's trigger button
await ift({action:"wait_for", selector_visible:'input[placeholder="Email"]', timeout:10000});
// fill — reuse native-inputs / select2 recipes, scoped to modal-unique anchors
await setText('input[placeholder="Email"]', "test.user@example.com");
await pickSelectBox(".select2-container.<widget-specific-class>", "<choice value>");  // select2 recipe, CUSTOM anchor
// commit the MODAL's button (not the page's)
await ift({action:"click", selector:"button.btn-primary:not(.ng-scope)"});
// stage B appears — RE-PROFILE, then fill First/Last name, commit again, wait_for selector_gone
```

## Gotchas (all verified live)
- **No Bootstrap guarantee** — profile the container; a custom `.<widget>-modal` here, a different container for stage B.
- **`button.btn-primary` is ambiguous** — page vs modal; use a separating class (`:not(.ng-scope)`) or modal scoping.
- **Multi-stage** — one submit can create the record and open the *next* modal; re-profile every time.
- **Close detection** — `wait_for selector_gone` on a modal-unique field, not a shared container.
- **Backend record exists early** — created on stage-A submit (before enrichment); discover it via a value you typed (`ORDERBYDESCsys_created_on`) — see `SKILL.md` post-submit tip.

---
*Verified on a live custom SP widget:* the *Add* trigger opened a custom modal; a two-stage flow (a short first stage → a details stage) created a backend record and required re-profiling between stages; the modal's commit button was disambiguated from the page's primary button via `:not(.ng-scope)`; close detected via `selector_gone` on a modal-unique field.
