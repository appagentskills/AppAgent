---
name: feature-deroulement
description: Mandatory mental walkthrough (déroulement) the agent performs after building or modifying any user-facing feature. Surfaces wiring bugs, hallucinated symbols, and missed edge cases by forcing the agent to narrate the full lifecycle in prose with named functions, files, CSS classes, and grep-verified references. Includes a reverse-mode (branch-coverage) pass mandatory whenever the changed code has more than 5 branch points.
---

# Feature Déroulement

A **déroulement** is a structured mental walkthrough — in prose — of what happens when a user interacts with a feature. No tests, no harness, no renderer. The act of writing it forces you to confront what you actually wired vs. what you assume is wired, and that's where bugs surface.

Used in three modes:
- **Audit mode (top-down):** start from user actions, trace forward to find bugs.
- **Reverse mode (bottom-up):** start from the code, derive the input/state required to fire every branch. Catches dead arms, impossible conditions, and scenarios the top-down pass missed.
- **Fix-verification mode:** after fixing bugs, re-trace each scenario through the new code to confirm the fix works and doesn't regress anything.

The two analysis modes are complementary. **Audit mode** answers "do realistic users hit a bug?" **Reverse mode** answers "is any code path unreachable, or reachable only by something we forgot to think about?" Use both on anything non-trivial.

## When to do this

Trigger automatically:
- After implementing a new feature (button, panel, tool, flow).
- After modifying any user-facing behavior (state machine, click handler, render path).
- **Before declaring a fix done** — fix-verification déroulement is mandatory.
- Before pushing a PR.
- When the user asks to "déroule", "walk through", "trace", or "simulate" a scenario.

**Reverse mode is the default for anything branchy.** After completing audit mode, count branch points (see Process step 5) — if >5 in the changed code, reverse mode is mandatory, not optional. Don't wait to be asked. Audit mode answers "does the user happy-path work"; reverse mode answers "is every `else` reachable, defensive, or a hidden bug." Real bug density on the second pass is consistently non-zero on guard-heavy code.

If a change is purely internal (refactor, rename, comment) and has no user-visible behavior, a déroulement is optional — say so explicitly.

## Depth — three axes you tune per scenario

Déroulement is not uniform. You match granularity to where the bugs hide. Three independent dials:

### Axis 1 — Breadth (how many scenarios)

Function of state-machine size + branch points. Heuristic: **1 happy + 1 modifier + 1 negative per state, hard cap ~12.** List the rest in a "Skipped scenarios" section so the user can ask for any. For a feature with N states, scenarios beyond ~3·N are usually theater.

In **reverse mode** the breadth is dictated by branch count, not state count — see the Reverse Mode section.

### Axis 2 — Trace granularity (within a scenario)

Pick per-step, not per-scenario. Four levels:

| Level | What it looks like | When to use |
|---|---|---|
| **L1 — Function-call** | "User clicks → `onActionButtonClick` → `startAction` → `runAgent`" | Pass-through plumbing, well-named, low-risk glue |
| **L2 — Step-by-step** | "`startAction:377` sets `state='running'`, calls `persistActionState`, then `notifyActionStateChanged`" | Default for most steps |
| **L3 — Line-by-line** | "Line 351 existing-check, line 357 dismiss old, line 362 new chatId, line 377 assign activeActions[actionId] = {…}" | State mutators, validators, guards, anything where ordering or off-by-one matters |
| **L4 — Branch-by-branch** | Every `if`/`switch` arm enumerated, including the `else` that does nothing | Tool dispatch, click routers, switch-on-state patterns |

A healthy mix on a medium feature: ~70% L2, ~20% L3 on the high-risk functions, ~10% L1 on glue and ~5% L4 on routers. Tracing everything at L3 buries the signal. Tracing everything at L1 misses off-by-ones.

**Where to spend L3/L4 budget:** state mutators, guard expressions, validation, switch-on-state. **Where L1 is fine:** renderers, leaf utilities, well-tested helpers, IDB writes.

Reverse mode forces L4 by definition — you are enumerating arms.

### Axis 3 — Read-or-trust (per called function)

For each function the trace mentions, decide: read its body, or trust its name?

- **Read the body** when it's the function being tested, when it mutates state, or when its name is generic (`handle*`, `process*`, `update*`, `manage*`).
- **Trust the name** when it's a leaf utility already verified elsewhere (`escapeHtml`, `getBoundingClientRect`) or when it's named so specifically there's no ambiguity (`persistActionState` → IDB write).

If you trust a name and turn out to be wrong, that's the bug the gap pass should catch. **Spot-check trusted calls during the gap pass** with one grep each.

The Action audit produced 2 false positives because I trusted CSS-by-proximity ("I'd have seen it if it existed") instead of dropping to L2-with-literal-grep. That class of failure motivates the negative-claim rule.

## Mandatory structure (audit mode)

### 1. Scope
One sentence: feature, paths covered, branch/files. State the spec source: dedicated doc, data-model comment, system-prompt blurb, or tool definition.

### 2. Cast
Table of every symbol referenced: function name, file:line, role.

### 3. Scenarios — happy path(s)
Per step:
- What the user sees.
- What code runs (function name + file:line, at the granularity dictated by Axis 2).
- What state mutates.
- Which CSS rule fires (selector + file:line).
- How re-renders happen.

### 4. Scenarios — modifiers / variants
Paused, interrupted, disabled, collapsed, error overlay.

### 5. Negative paths
Three-column table: **Path | Where it's handled | Risk if broken**. ≥6 entries: invalid input, concurrent calls, backwards transition, missing dependency, permission denied, stale reference.

### 6. Gap pass
Numbered list (3+) of glossed-over points. Most valuable section. Empty = didn't try.

### 7. Verified bug list (if bugs found)
Table: **# | Severity | Location | Issue | Verification evidence**. No evidence = no bug.

## Reverse mode (branch-coverage déroulement)

Goal: for every conditional in the changed/audited code, construct the **minimal scenario** (input + prior state + environment) that drives execution into each arm — including the empty `else`. Code paths with no constructible scenario are dead, unreachable, or guarded by something you missed; either way that's a finding.

This is the dual of audit mode. Audit mode walks forward from a user action. Reverse mode walks **backward from a line of code** to the world-state needed to reach it.

### When to use it

**Default:** any function with branch count > 5 in the changed/audited region. Don't wait to be asked.

Stronger triggers (run reverse mode even on smaller functions):
- Routers / dispatchers with switch-on-state.
- Validators and guards (anything with cascading `if`/`return`).
- State machines where transitions depend on multiple flags.
- Code you suspect contains a dead arm.
- Whenever audit mode wraps up and you can't articulate why each `else` branch exists.

Skip it (audit-mode coverage is enough) on:
- Pure renderers with no mutation.
- Leaf utilities (≤2 branches).
- Pass-through glue.

### Mandatory structure

#### R1. Branch inventory
Enumerate every decision point in the target file/function set. Table:

| # | File:line | Construct | Arms | Notes |
|---|---|---|---|---|
| 1 | `actions.js:377` | `if (existing && existing.chatId !== chatId)` | T / F | guards re-entry from another tab |
| 2 | `actions.js:412` | `switch (state)` | running / stuck / done / error / default | 5 arms |
| 3 | `actions.js:455` | `a.label?.length > 60 ? clamp : keep` | clamp / keep | string |

Include ternaries, short-circuit `&&`/`||` used for control flow, optional chaining where it skips a call, and default-parameter expressions. Don't include trivial null-coalesce on display strings.

#### R2. Scenario per arm
For each arm, **one row**:

| Branch # / arm | Trigger scenario (state + input) | Reachable? | Observable effect | Already covered by audit scenario? |
|---|---|---|---|---|
| 1·T | Tab A has action `foo` running; Tab B calls `startAction('foo')` | ✅ | Tab A's record dismissed, Tab B claims it | yes — "concurrent claim" |
| 1·F | Fresh `startAction('foo')`, no existing record | ✅ | Normal start path | yes — happy path |
| 2·default | `state` is any value not in {running, stuck, done, error} | ❓ | Falls through, no UI update | **no** — investigate: is this dead? |

Trigger scenario must be **constructible** — concrete state + concrete call/input. "Some weird state" is not a scenario.

**Sub-arm hygiene:** when a single branch number has multiple meaningful sub-arms (e.g. "≤60 / >60 / missing" for a clamp+default expression, or "T-with-X / T-with-Y" for a compound condition), enumerate each sub-arm on its own row. "Variant of X — already covered" is a corner-cut and the cutting-corners check will flag it.

#### R3. Unreachable / suspect arms
Promote every `❓` and `❌` from R2 here. For each:
1. **Why I think it's unreachable** (one sentence).
2. **Three search variants** showing no caller can produce the required state (negate-the-negation rule).
3. **Verdict:** dead / defensive / reachable-by-bug / reachable-via-path-I-missed.

Defensive code (`default:` that just `return`s) is fine — note it and move on. **Dead code that mutates state is a bug.** Reachable-by-bug means the only way to enter the arm is via a separate bug — log both.

#### R4. Combinatorial blow-up handling
If two branches are independent (`if (A) … if (B) …`), you have 4 combinations, not 2. Don't enumerate all 2^N — instead:
1. List combinations explicitly only for **interacting** flags (one's outcome changes the other's effect).
2. For independent flags, note "branches are independent; covered separately."
3. Pairwise (all-pairs) coverage is enough; full combinatorial is theater.

#### R5. Mapping back to audit scenarios
Two-column reconciliation:

| Audit scenario | Branches it exercises |
|---|---|
| Happy path | 1·F, 2·running, 3·keep |
| Concurrent tab claim | 1·T, 2·running |
| Long label | 3·clamp |

After this table, list **branches not covered by any audit scenario**. These are either: (a) gaps in audit-mode breadth that need a new scenario, (b) genuinely unreachable, or (c) defensive. Classify each.

#### R6. New bugs surfaced
Anything from R3/R5 that's a real defect. Use the same verified-bug-list format as audit mode.

### Hard rules (reverse mode specific)

1. **Don't skip the empty `else`.** A missing `else` is a decision: was it intentional? An empty `else` block is also a decision: why is it there?
2. **Short-circuits count.** `x && doThing()` has two arms.
3. **Optional chaining counts** when it gates a side effect: `obj?.method()` is an `if (obj) obj.method()`.
4. **Try/catch counts.** Both the try-success and catch arms need scenarios. An empty catch is a finding.
5. **Default parameters count** if the default has observable behavior different from a passed value.
6. **Loops** count as a branch only if the body's behavior depends on iteration index/state, or if the zero-iteration case has distinct meaning. Don't enumerate every iteration.
7. **Each arm gets one concrete scenario, not a hand-wave.** "Some race condition" is not a trigger.
8. **Reachability claims need grep evidence**, same as negative claims in audit mode.
9. **Sub-arms expand inline.** "Variant of S1 — already covered" is the corner-cut. Walk the actual sequence with the actual line numbers.

### Anti-patterns

❌ "Branch 7·F is the error path." — what error, from where?
✅ "Branch 7·F: `validateInput` returns false when `payload.tasks` is non-array. Triggered by `update_action_state({tasks: 'oops'})`. Reaches `:412` early-return."

❌ Listing 64 combinations for 6 independent booleans.
✅ "Flags A,B,C interact (A gates B's effect, C overrides both). Enumerate the 5 meaningful combinations. Flags D,E,F are independent — covered separately."

❌ "The default case is unreachable." (no grep)
✅ "The `default:` arm at `:438` requires `state ∉ {running, stuck, done, error}`. `executeUpdateActionState:312` validates against that exact enum and rejects others. Grep for `state =` shows 4 assignment sites, all from the enum. Verdict: defensive, safe to leave."

❌ "Variant of S1 — verified above."
✅ Walk the sequence with the new args. Especially when sub-arms (default values, missing fields, edge numerics) differ from S1.

## Mandatory structure (fix-verification mode)

For EACH fix, ALL FIVE — not just some:

1. **Diff summary** — function + new file:line.
2. **Before trace** — what the bug looked like.
3. **After trace** — STEP-BY-STEP through the new code path. Same Axis-2 granularity rules. **Two-line summary is not an after-trace.** Default L2; drop to L3 on the changed lines.
4. **Regression candidates** — ≥3 ways the fix could break things. Mark each ✅ / ⚠️ / 🐞.
5. **Acknowledged limitations** — what the fix doesn't cover.

After all per-fix entries, **second pass at the whole-change level**:
- Stale comments / dead-code references to anything you removed?
- Bypass paths re-introducing the bug elsewhere (other call sites, imports, agent-facing tools)?
- Function signatures or contracts you changed that callers depend on?

**If the fix changed a conditional** (added/removed a branch, flipped a guard, changed an enum), run a mini reverse pass on just that conditional: scenario for each new arm, scenario for each old arm to confirm it still triggers.

## Hard rules — anti-hallucination

1. **Every function name and file:line must be real.** Verify via `grep` or `read` BEFORE writing.
2. **Every CSS class must be real.** Grep the selector. Quote file:line.
3. **Every state machine transition must be traceable** to the line that performs the mutation.
4. **Don't claim "and then it re-renders"** without naming the listener, function, and DOM nodes.
5. **Deduplicate similar flows by reference,** not copy-paste.
6. **Cite line numbers as `file:line` ranges.**
7. **"X is called from Y" needs a grep showing the call site.** A definition is not proof of use. Confirm a call expression separately.

## Negative-claim verification

Negative claims (X is missing, broken, dead, unhandled) carry higher proof burden — they fail silently.

1. **Grep for the literal symbol you say is missing**, not adjacent symbols.
2. **Quote the empty (or non-empty) result.**
3. **Negate-the-negation:** assume X exists; try three search variants before concluding it doesn't.
4. **For "dead code":** count call expressions separately from the definition.
5. **For "no validation":** read the function top-to-bottom for guards, `Math.min`, `.substring`, `.indexOf`, enum checks.
6. **For "unreachable arm":** see Reverse mode R3 — three search variants showing no caller can produce the required state.

## Bug-finding hygiene

1. List as **candidates** first.
2. **Verification pass** — batched in `js_eval`.
3. **Promote only verified ones.** Demote false positives explicitly with `❌ FALSE POSITIVE — see grep`.
4. **Score yourself.** "X candidates, Y confirmed, Z debunked." 100% suspicious; 70–90% healthy; <50% slow down.
5. **Re-verify before fixing** — some weird-looking behavior is intentional per the spec.

## Cutting-corners self-check (before publishing a fix-verification)

This was added because I cut corners and the user had to ask if I'd actually walked every fix. Self-check:

1. Count regression candidates per fix. Below 3 = redo.
2. After-trace under ~50 words on a non-trivial fix = you summarized. Expand.
3. Did you grep for bypass paths for any fix changing a guard or validation?
4. Did you re-read changed comments? Edits that delete or rename functions often leave stale references nearby.
5. Did you walk a user through the full lifecycle once more after the fix?
6. **If you ran reverse mode:** did every `❓` from R3 get resolved to dead/defensive/reachable, with grep evidence?
7. **Did you skip reverse mode?** If branch count >5 in the changed code, you owe one. "It looked simple" is not a reason — count the branches.
8. **Sub-arm hygiene:** any scenario in your walkthrough that says "variant of X — already covered"? Expand it. The cases that look like variants are exactly where sub-arms (default values, missing optional fields, numeric edges) differ from the parent.

If you can't answer yes to all eight, ship the deeper pass before the PR.

## Process — recommended order

1. Read the code. Build the Cast.
2. Read the spec / closest equivalent.
3. List intended scenarios (audit mode). Pick depth dials per scenario (Axes 1–3).
4. Write each scenario user-visible first, code trace second.
5. **Branch count gate.** Count decision points (`if`, `else if`, ternaries, `switch` arms, control-flow `&&`/`||`, optional-chaining-with-side-effect, try/catch) in the changed/audited region. **>5 ⇒ reverse mode is mandatory. ≤5 ⇒ inline R1+R2 in the audit pass is enough.** State the count explicitly so the user can sanity-check the decision.
6. **Reverse pass (if gated in):** R1 branch inventory → R2 scenario per arm (one row per sub-arm, no "variant of") → R3 unreachable arms → R5 mapping back → log gaps. Mandatory L4.
7. Gap pass with critical eye; spot-check trusted calls.
8. Verification pass on every bug candidate (audit + reverse).
9. Re-verify high-impact candidates before fixing.
10. Publish verified bug list.
11. If fixing: edit, build, write fix-verification with the cutting-corners check, push.

For tiny features (≤5 branches), R1+R2 inline in the audit pass is fine — don't manufacture a separate Reverse section. For anything with a switch, nested guards, or a state machine, run reverse mode as its own section.

## Output format

Markdown directly in chat. Tables for Cast, Negative paths, Verified bugs, Regression candidates, Branch inventory, Scenario per arm. Numbered lists for code traces. Inline `code` for symbols; bold for state names; italic for what the user sees. 200–500 lines for medium features; reverse-mode adds ~50–150 lines depending on branch count.

## What a good déroulement is NOT

- Not a unit test.
- Not a design doc — design comes before code.
- Not a changelog — describe behavior, not the diff.
- Not pseudocode — real code, real line numbers.
- Not exhaustive — main flows + high-risk edges, calibrated by Axis 1. **Reverse mode is exhaustive on branches but not on combinations** — pairwise, not full Cartesian.

## Trigger phrases

- "Déroule [feature]"
- "Walk me through what happens when…"
- "Trace the lifecycle of…"
- "Verify the wiring of…"
- "Did you actually hook up X?" / "Have you gone through every scenario?"
- "Check that the fix doesn't break anything" → fix-verification mode
- **"Cover every branch" / "find a scenario for each if/else" / "any dead code?" / "reverse it" → reverse mode**

But don't wait for these phrases when the branch-count gate triggers — the gate is the default.

## Worked examples

### Picking depth in practice (Action audit)
- `executeUpdateActionState` — **L3 line-by-line.** State validator, alias normalization, label clamping, timer arming. Off-by-one country.
- `onActionButtonClick` — **L4 branch-by-branch.** Switch on 7 states, each with different routing.
- `renderActionButton` — **L2 step-by-step.** Builds HTML, no mutation. Mid-risk.
- `escapeHtml`, `persistActionState` — **L1 trust + grep spot-check.** Leaf utilities.
- `getActionId` — **L3 line-by-line.** Single line, but that line is the collision hash. Read every regex.

### Reverse mode catching a dead arm
Branch inventory of `onActionButtonClick` listed 7 switch arms. R2 showed arm `state === 'queued'` had no constructible scenario — R3 grep for `state = 'queued'` returned zero assignment sites in the codebase. Verdict: dead arm left over from an earlier design. Bug filed; fix removed it. **Lesson:** the user-first audit pass walked the 4 *common* states and never noticed the 3 unused arms.

### Reverse mode catching a missing scenario
Branch 12·F at `validate:88` (`if (!payload.tasks)` false case) was covered by every audit scenario. Branch 12·T (tasks missing) was covered by zero. R5 reconciliation flagged the gap. Added "no-tasks update" scenario to audit mode; uncovered a render crash because the empty-tasks branch dereferenced `tasks.length` two lines later. **Lesson:** R5's "branches not covered" column is where audit-mode breadth gaps surface.

### Reverse mode finding 4 issues that audit-mode missed (PR #194)
22-branch reverse pass on `executeUpdateActionState` (`53e-actions.js:219`). Audit mode had walked happy/stuck/done from the user's side and reported clean. Reverse mode surfaced: silent state coercion (off-list states quietly rewritten to `'running'` instead of erroring); `output:null` no-op (typeof null === 'object' skipped the assignment guard); done→error keeping the original dismiss timer (error visible for whatever ms remained on the done countdown); 1ms `auto_dismiss_ms` accepted (button vanishes before render). None are crashes. All four are the same shape: defensive sinks that hide agent bugs. **Lesson:** real bug density on the second pass is consistently non-zero on guard-heavy code — that's the justification for the branch-count gate at Process step 5.

### Sub-arm corner-cut caught by the user (same PR)
First pass on PR #194 wrote "S3. Variant of S1; verified above" for the auto-dismiss flow. User asked "did you really walk all of those?" Honest re-count found 5 sub-arms missed: `state`-omitted, `icon`-omitted, `label`-missing, task `label` missing, `output:42` (number). Each got its own scenario in the second pass. **Lesson:** "variant of X" is the exact shape of the corner-cut; sub-arm rules in R2 + check #8 in cutting-corners self-check both forbid it.

### False positive caught by verification
Audit claimed `state-needs_input` had no CSS. Verification grep returned 13 hits at `23-actions.css:448–462`. **Lesson:** grep for the literal symbol you say is missing.

### Behavior that LOOKS like a bug but isn't
Audit flagged `finishActionIfDone` only finalizing from `running`. Re-verification: `stuck` is the agent's "I'm blocked" signal — auto-finalizing would lie. **Lesson:** read the spec before assuming weirdness is a bug.

### Cutting corners caught by the user
First-pass fix-verification gave fixes #6 and #16 only 2 regression candidates each. Brief after-traces. Deeper pass found 2 stale comments and 4 bypass paths for the collision check. **Lesson:** the cutting-corners self-check costs 30 seconds and saves a follow-up PR.

## Anti-patterns

❌ "When the user clicks, the button updates."
✅ "`onActionButtonClick:862` reads `data-skill-id`, calls `startAction:377` which sets `activeActions[actionId].state = 'running'` and calls `notifyActionStateChanged`. The listener at `:1464` runs `refreshActionButtons` patching `className` and `.action-btn-badge` innerHTML."

❌ "There's a race condition handler somewhere."
✅ "Tab races coordinated by `BroadcastChannel('appagent-actions')` at `53e-actions.js:118`; receiver at `:151–169` deletes from `activeActions` and halts loops via `pausedChats[deletedChatId] = true`."

❌ "Fixed it, looks good."
✅ "Fixed at `53e-actions.js:443`. Before: `_dismissTimer` survived `stopAction`. After: `if (a._dismissTimer) clearTimeout(...)` at top. Regression candidates: ✅ idempotent with `dismissAction:463`; ✅ no further `update_action_state` after `stopped`; ⚠️ if it did, `:285` only re-arms on `done|error`."

❌ Tracing every step at L3.
✅ L2 default, L3 on mutators/guards/validation, L1 on glue, spot-check trusted calls in gap pass.

❌ "All branches covered" with no inventory.
✅ R1 table with file:line for every conditional, R2 row for every arm, R3 evidence for every unreachable claim.

❌ Skipping reverse mode because the function "looked simple."
✅ Count branches at Process step 5. >5 ⇒ reverse mode runs. State the count explicitly.
