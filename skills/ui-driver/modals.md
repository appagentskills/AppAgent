# modals / dialogs / overlays — custom SP widget & catalog MRVS dialogs  ✅ VERIFIED (two live builds)

Catalog forms are flat, but **custom SP widgets** (and some record-producer flows) open **modals**. The component recipes (`select2.md`, `native-inputs.md`, `date-datetime-picker.md`) work **unchanged inside a modal** — a modal only changes **scoping, commit-button disambiguation, close detection, and multi-stage flow**.

**Verified on** TWO live builds: **(A)** a custom SP widget (`/esc?id=<widget_id>`) — an add-sub-record flow with a two-stage **custom** modal; **(B)** a catalog record producer whose “add a row” dialog is the standard **MRVS (Multi-Row Variable Set) Bootstrap modal** (see §6). ⚠️ The two builds **contradict each other on every concrete selector** (container class, anchors, button gating, staging, early-record) — only the **meta-rules** (profile first, scope to the modal, disambiguate the commit button, field-based close detection, re-profile after commit) are portable. Treat the per-build details below as worked examples, not constants.

> Shared helpers (`ift`, `gp`, `sleep`) come from `select2.md` — reuse them.

## 1. Don't assume Bootstrap — profile the container first

There is **no guaranteed `.modal-content` / `.modal-dialog`**. Custom widgets roll their own. Open the modal (click its trigger), then `get_dom` the overlay and identify its real container.

- Verified example: the *Add* trigger opened a custom **`.<widget>-modal`** (with its own `…-modal-header` / `…-modal-body` / `…-modal-close`, closed via an `ng-click` handler). The **second** stage opened in a **different** container — so don't hard-code one selector.
- `wait_for selector_visible` on a **field unique to the modal** (e.g. `input[placeholder="Email"]`) to confirm it's open and rendered.

## 2. Scope every field selector to the modal (or use unique anchors)

The page underneath still has its own controls. Either prefix selectors with the modal container, **or** anchor on something unique to the modal (a placeholder/label absent from the page). Native-input **placeholder anchors** (`input[placeholder="First name"]`) were the single most reliable anchor here.

## 3. ⚠️ Disambiguate the modal's commit button from the page's

The modal's **Save / Add / Submit** button is frequently a **different DOM node** than the page's primary button, and a bare `button.btn-primary` matches **both**. Separate them:

- Verified live (build A): the page's primary button was `button.btn-primary.ng-scope`; the modal's save was `button.btn-primary` **without** `ng-scope` → `button.btn-primary:not(.ng-scope)` hit the modal one. ⚠️ **`:not(.ng-scope)` is NOT a portable disambiguator** — on build B (an MRVS flow) it matched **4 of 5** `btn-primary` buttons (the MRVS “Add” row buttons are also `btn-primary` without `ng-scope`). Prefer, in order: a **unique button id** (`#mrvs_save_button` vs `#submit-btn`), **scoping under the modal container** (`.modal-content button.btn-primary`), then a separating class found via `get_properties` → `classList`.
- The modal button **may** be validity-gated for real — verified on build A: `ng-disabled="!formValid || isSubmitting || (isEditMode && !isFormDirty())"`, which flips enabled the moment the required field is valid. But on build B the MRVS save button was `ng-disabled="disableControls()"` — a **processing flag, enabled regardless of validity**. As always: **read the `ng-disabled` expression first** (`SKILL.md` golden rules) to decide whether the disabled state means anything.

## 4. Commit, then wait for CLOSE via `selector_gone`

After clicking the commit button, `wait_for selector_gone` on a **modal-unique field** (e.g. `input[placeholder="First name"]`) — not the generic container, which may be reused by the next stage.

## 5. ⚠️ Multi-stage: RE-PROFILE after every commit

A modal submit may **not** be the end. Verified (build A): submitting stage A (a short first stage, e.g. Email + a type select) **immediately created the backend record** AND **auto-opened stage B** (a details stage with more fields — e.g. names, a country-code select2 + native phone input, checkboxes, more select2s) with the stage-A fields now read-only. **The full field set was not knowable from stage A.** After each commit, re-profile (`SKILL.md` Standard loop step 5).

⚠️ **Both halves of that pattern are build-specific.** Build B's MRVS modal was **single-stage** (full field set up front) and its commit was **client-side only** — it just added a row to the on-page grid and **no backend record existed** until the page-level Submit (`ORDERBYDESCsys_created_on` discovery right after a modal commit finds nothing on MRVS flows). Re-profiling after commit is still the rule — it's how you *learn* which build you're on.

## 6. ✅ The MRVS (Multi-Row Variable Set) modal — the standard catalog “add a row” dialog (verified live)

When a catalog item / record producer has a **multi-row variable set**, its “Add” button opens a **standard Bootstrap modal that is itself an `sp_form` render** — the most common modal you'll meet on catalog pages, and much more regular than a custom widget's:

- **Container:** real Bootstrap — `.modal-content` / `.modal-dialog` (1 each while open).
- **Fields:** ordinary catalog variables — every input gets `#sp_formfield_<var>` and every select2 gets `#s2id_sp_formfield_<var>`, exactly like the page form. **Scope them under `.modal-content`** to avoid colliding with same-named page fields. Placeholder anchors are typically **absent** here — use the sp_formfield ids.
- **Commit:** `#mrvs_save_button` (`ng-disabled="disableControls()"` — processing flag, **not** validity-gated). Cancel: the `ng-click="c.dismiss()"` button.
- **Commit is client-side:** the row lands in the on-page MRVS grid; **no backend record** until the page's final Submit.
- **Close detection:** `wait_for selector_gone: '.modal-content #sp_formfield_<var>'` — verified necessary: a bare `.modal-content` count **stayed 1 after close** (the container lingers in the DOM).

## Recipe sketch (build A — custom widget; for an MRVS modal commit `#mrvs_save_button` instead, see §6)

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
- **No Bootstrap guarantee either way** — profile the container: build A rolled a custom `.<widget>-modal` (plus a different container for stage B); build B's MRVS modal **was** plain Bootstrap `.modal-content`.
- **`button.btn-primary` is ambiguous** — page vs modal vs MRVS “Add” buttons; prefer unique ids (`#mrvs_save_button`) or `.modal-content` scoping; `:not(.ng-scope)` worked on one build and matched 4/5 buttons on another.
- **Multi-stage** — one submit can create the record and open the *next* modal (build A); re-profile every time.
- **Close detection** — `wait_for selector_gone` on a modal-unique field, not a shared container (verified: `.modal-content` lingers count=1 after close).
- **Early backend record is BUILD-SPECIFIC** — build A created it on stage-A submit (discover via a typed value + `ORDERBYDESCsys_created_on`); build B's MRVS commit created **nothing** until final page submit. Check the table via API before assuming either.
- **Conditionally-rendered page fields exist in the DOM with `visible:false`** before their trigger field is set (verified: Schedule start/end dates appeared — became visible — only after Location was committed). Test conditional rendering via `get_properties` → `.visible`, **not** `match_count`.

---
*Verified on a live custom SP widget (build A):* the *Add* trigger opened a custom modal; a two-stage flow (a short first stage → a details stage) created a backend record and required re-profiling between stages; the modal's commit button was disambiguated from the page's primary button via `:not(.ng-scope)`; close detected via `selector_gone` on a modal-unique field.

*Verified on a live catalog record producer (build B, 2026-06):* an “Add row” MRVS Bootstrap modal — `.modal-content` + `#sp_formfield_*` ids inside, `#mrvs_save_button` commit gated only by `disableControls()`, single-stage, client-side row add with **no** backend record until page submit, container lingering after close (field-based `selector_gone` required), and conditional page fields flipping `visible:false→true` after their trigger field committed.
