# Feature Déroulement

A **déroulement** is a structured walkthrough of what happens when a user interacts with a feature. You write the prose first, then you **execute** checks against it. Writing forces you to face what you actually wired. Running `deroulement.js` catches the claims you only *believed*: invented symbols, wrong line numbers, unwired functions, dead arms, weak tests.

Modes:
- **Audit (top-down):** start from the user's actions and trace forward to find bugs.
- **Reverse (bottom-up):** start from the code and build the input and state that fire every branch arm.
- **Fix-verification:** re-trace each fix through the new code and look for regressions.

## When
- After you build or change a user-facing feature (button, panel, tool, flow, state machine, click handler, render path).
- **Before you declare a fix done**, and before a PR.
- When the user says "déroule", "walk through", "trace", "simulate", "did you hook up X?", or "cover every branch".
- Purely internal changes (rename, comment) can skip it, but say so explicitly.

## Research basis: why prose alone is not enough
- **Self-Debugging** (Chen et al., arXiv 2304.05128): a model that only explains its code gains about +2–3%. With execution feedback it gains up to about +12%.
- **Chain-of-Verification** (2309.11495): answer each verification question *independently* of the draft, and fewer hallucinated facts survive.
- **CodeT** (2207.10397) and **AlphaCodium** (2401.08500): generated tests plus iterating on real execution results beat single-pass reasoning.
- **Agentless** (2407.01489): simple localize → repair → validate pipelines work when the validate step is a real run.
- **Fagan inspection:** a checklist-driven, staged review with a recorded defect log. That is the ancestor of this audit structure and of the ledger.
- **Mutation testing:** a check that cannot tell a mutated function from the original proves nothing.

**The finding:** executed or external signals beat self-narration. So every déroulement ends with a run of `deroulement.js` and a claims ledger, not just a confident paragraph.

## Process (mandatory order)
1. **Read the code and the spec.** Build the Cast.
2. **Draft the prose** (audit structure below). Put every symbol in single backticks: `fn()`, `fn:123`, `.class`, `#id`, `path/file.js:10`. The helper checks only backticked tokens.
3. **Run the executable phase** (next section) on the changed files and the prose.
4. **Probe** the main scenario and the edge cases. For a function with **more than 5 branch points**, also run reverse mode R1–R6 and **mutation-lite**.
5. **Build the claims ledger** (`D.format(rep)`). Fix or retract every refuted claim, then re-run.
6. **Done-gate:** `rep.gate.pass === true` (0 refuted). The final answer must list **every unverified claim** explicitly (`rep.gate.unverified`) with a reason. Never hide them.

## Executable phase: `deroulement.js`
It is a plain helper next to this file. It is not a tool. It has no dependencies (only RegExp, Function, DOMParser and CSSStyleSheet), and every result is JSON.

**In-repo (AppAgent workspace, js_eval or tests):**
```js
var D = await runFile('skills/feature-deroulement/deroulement.js');
var FILES = ['<changed-file-1>.js', '<changed-file-2>.css'];      // PLACEHOLDERS: replace with your changed files
if (FILES.some(function (f) { return /^</.test(f); })) throw new Error('replace the placeholder FILES first');
var rep = await D.run({
  files: FILES,                                               // an unreadable file is a refuted row
  workspace: 'owner/AppAgent::main',                          // live grep/read/diff/ls
  prose: DRAFT,                                               // your prose, with backticked symbols
  probes: [{ file: 'src/js/ui/280-foo.js', fn: 'renderFoo', inputs: [[{ items: [1] }], [{ items: [] }]],
             edge: true, stubs: { escapeHtml: function (s) { return String(s); } } }],
  mutation: [{ file: 'src/js/ui/280-foo.js', fn: 'fooState', cases: [{ args: ['a'], expect: 1 }, { args: [''], expect: 0 }] }]
});
return { summary: rep.summary, refuted: rep.gate.refuted, unverified: rep.gate.unverified, md: D.format(rep) };
```
Alternative: `run_js_file {path:'skills/feature-deroulement/deroulement.js', args:{run:true, files:[...], prose:'...'}}` returns the report directly.

**Generic (any environment, the source never enters your context):**
```js
var SOURCE_TEXT = 'function add(a, b) { return a + b; }\nadd(1, 2);\n';  // replace: the code under review
var DRAFT = 'On load `add()` sums its inputs.';                        // replace: your prose
var f = await executeTool('get_skill', { skill_id: 'feature-deroulement', action: 'read_file', filename: 'deroulement.js' });
if (!f || !f.success || typeof f.content !== 'string') throw new Error('deroulement.js unavailable: ' + (f && f.error) + ' (stale runtime skill copy? Reload, or use runFile in-repo)');
var AF = Object.getPrototypeOf(async function () {}).constructor, mod = { exports: {} };
var D = await new AF('module', 'exports', 'args', f.content + '\n;return module.exports;')(mod, mod.exports, {});
var rep = await D.run({ files: { 'feature.js': SOURCE_TEXT }, corpus: { 'feature.js': SOURCE_TEXT }, prose: DRAFT });
return { summary: rep.summary, refuted: rep.gate.refuted, unverified: rep.gate.unverified };
```
Pass test files through `corpus` (or leave them in `files`: `exclude` defaults to `[/^test\//]`, so they only get the parse gate), never as analysed targets: their string fixtures are not wiring. Without a diff, name the functions you changed in `functions: [...]`, otherwise functions with more than 5 branches collapse into one summary row. `functions` is added to the diff (a union); pass `functionsOnly: true` to analyse only the named functions. If `exclude` removes every file, a config row is unverified. A qualified name (`obj.run()` in prose, an inline `onclick="obj.run()"`, a listener `obj.run`) is verified only when `obj` is a repo object literal, class or `obj.run =` assignment, so `D.run()` on a `runFile()` result is unverified: cite the real object (`DEROULEMENT.run()`) or the bare function. The member must hold a function, class, arrow or identifier (`obj.run = 5` is unverified), only single-segment qualifiers resolve (`app.obj.run()` is unverified), and a missing member of a built-in (`onclick="document.nope()"`) is refuted. See `DR_LIMITATIONS` for the documented gaps. A built-in name with no repo definition (`find`, `open`) is at best `verified-builtin` (low confidence), and a definition found only under `test/` verifies nothing.

With `corpus`, lookups are offline and deterministic: it is the only code base searched. Without it, lookups go live through `loadFile` and workspace grep/diff/ls. **When grep is unavailable, or capped at 100 hits with no definition among them, the result is "unverified", never "0 hits".** That also applies to listener targets and inline HTML handlers. A lookup that throws is recorded in `rep.ioErrors` with an unverified row, a bad workspace makes file citations unverified, and `run()` never throws: an internal error is a refuted row. Probes check DOM post-conditions only for DOM/HTML producers unless you pass `domCheck: true`.

Every grep hit is judged on the **whole-file** mask of its file (comments, strings, templates and regex bodies blanked), so a symbol inside a multi-line comment or template string is never a definition or a reference. Masks are cached per run and the reads are budgeted: `maxMaskReads` (default 400) and `maskBudgetMs` (default 30000 ms). A hit whose file cannot be read, masked or reached within the budget is *unreadable*: it proves nothing either way, so its row is **unverified** (never verified, never "0 hits").

What `run()` does:
- **(a) parse gate:** `parseGateJs` / `parseGateHtml`. Syntax, duplicate ids, inline handlers calling undefined functions, inline `<script>` bodies; the HTML walk includes the contents of `<template>`. CSS: unbalanced braces (comments and strings stripped) are refuted, and blocks the parser dropped are unverified.
- **(b) existence:** `proseSymbols` → `checkSymbols`. Functions need a definition, CSS classes need a rule, file:line citations must be in range. `crossRefs` checks that ids have a definition, JS-used classes have CSS (default `cssDir: 'src/css'`), and message types have both a sender and a handler.
- **(c) wiring:** `parseDiff` → `changedFunctions`. Each changed function must be referenced by real code outside its own body: mentions in comments, strings, `.md` files or self-recursion do not count, and references only under `test/` are unverified ("referenced only in tests"). `listeners` flags `addEventListener` inside render-like functions (re-binding risk).
- **(d)** `branches` / `matrix` gives the R1 inventory and the matrix skeleton, and sets `reverseModeRequired` when there are more than 5 branch points.
- **(e)** `probe` rebuilds the function with `__t('B#')` probes and caller stubs. It reports per-run traces, arms hit and missed, and missing stubs. A run that throws, or leaves an unhandled promise rejection (e.g. a stub returning `Promise.reject`), is recorded in `run.threw`.
- **(f)** `edgeInputs` (empty, whitespace, null, undefined, NaN, 0, -1, huge, emoji, RTL, zero-width, XSS, [], {}) and `domPostconditions` (literal `undefined`/`NaN`/`[object Object]` text, unnamed buttons, live XSS, duplicate ids).
- **(g)** `mutationTest`: negated `if`s and swapped comparison/logic operators. A survivor means a weak check or an equivalent mutant.
- **(h)** `ledger` / `format`: every claim is marked verified, refuted or unverified, with evidence and the gate. Use `entryPoints: [...]` or `waive: {name: 'reason'}` (a non-empty reason string is required) for dynamic dispatch. Both apply **only** to "defined but not referenced" wiring rows and downgrade them to unverified, never to verified. They cannot excuse a missing symbol, id, listener/inline/message handler, a parse error, an unreadable file, a failing mutation baseline or a probe failure: a waive on any other row is ignored and says so in the evidence. The only statuses are `verified`, `refuted` and `unverified` (`verified-builtin` becomes low-confidence verified); any other status in a report passed to `D.ledger` counts as **refuted**. A `claims` check that returns anything but `true`/`false` gives unverified. Add `claims: [{claim, check: bool|fn, evidence}]` for your own assertions.

**Extension UI:** probe renderers with `edge: true`. For behaviour on a real DOM, mount with `test/ui-helpers.js`:
`var U = await runFile('test/ui-helpers.js'); var m = await U.mountDom({ html, css: ['src/css/23-actions.css'] }); D.domPostconditions(m.root); m.cleanup();`
For anything that should outlive the chat, write a `test/*.test.js` case and run `run_tests`.

**Read `rep.limitations`** before trusting a green gate. There is no AST, only regexes over a lexical mask. Dynamic ids, classes and dispatch are invisible. Ternary and short-circuit arms are in the matrix but not probed. Rejections that fire more than two event-loop ticks after a probe run are missed, a malformed declaration inside a CSS rule the parser kept is not detected, and HTML built in JS strings is not parsed.

### ServiceNow variant
Tables and fields do not live in a repo, so verify them with the Table API instead of grep:
- a table exists: `sys_db_object?name=<t>`
- a field exists: `sys_dictionary?name=<t>^element=<f>`, including parents via `super_class`
- a script include, business rule or UI action exists: `sys_script_include` / `sys_script` / `sys_ui_action` by name

Feed the results into `claims: [{claim, check}]`, or inject a custom `io` (`{live, read, grep, diff, ls}`) that queries the instance. Fetch script bodies with the Table API and pass them as `files: {name: script}` + `corpus`. These still apply unchanged: **parse gate, branches/matrix, probe (stub `GlideRecord`/`gs`), mutation-lite, ledger**. Cross-refs for CSS and messages mostly do not apply.

## Audit structure
1. **Scope:** one sentence covering the feature, paths and files, and the spec source.
2. **Cast:** a table of every symbol with `file:line` and its role.
3. **Happy path:** for each step, what the user sees, what code runs (fn + file:line), which state mutates, which CSS rule fires, and how the re-render happens (listener + function + DOM nodes).
4. **Modifiers:** paused, interrupted, disabled, collapsed, error overlay.
5. **Negative paths:** a table of *Path | Where handled | Risk*, with at least 6 rows: invalid input, concurrent calls, backwards transition, missing dependency, permission denied, stale reference.
6. **Gap pass:** at least 3 glossed-over points, with a grep spot-check of each trusted call. An empty gap pass means you did not try.
7. **Verified bugs:** *# | Severity | Location | Issue | Evidence*. No evidence, no bug.

**Depth:** default to L2 (step by step). Use L3 (line by line) on mutators, guards and validators, L1 on glue, and L4 (every arm) on routers. Read the body of any function that mutates state or has a generic name (`handle*`, `update*`). Trust a name only for verified leaf utilities, and spot-check those.

## Reverse mode (mandatory when a changed function has more than 5 branch points)
- **R1 Inventory:** `D.branches(src, fn)` / `rep.changedFunctions[i].branches`. Include ternaries, control-flow `&&`/`||`, optional chaining that gates a side effect, try/catch, defaults with observable effect, and loops only when the zero-iteration case matters.
- **R2 One concrete scenario per arm (sub-arms on their own rows):** state + input → reachable? → observable effect → covered by an audit scenario? Then **probe it**, so the trace proves the arm is hit.
- **R3 Suspect arms:** give three search variants showing that no caller can produce the state. Verdict: dead, defensive, reachable-by-bug, or missed path. Dead code that mutates state is a bug.
- **R4 Combinations:** enumerate only interacting flags. Pairwise is enough.
- **R5 Map back:** audit scenario → arms. List the arms that no scenario covers.
- **R6 New bugs:** same format as the verified bug list.
- **Mutation-lite** on every function over 5 branches: `mutation: [{file, fn, cases}]`. Every surviving mutant is either a missing test case or an explained equivalent mutant.

Rules: never skip the empty `else`. Short-circuits count. Each arm gets a concrete trigger, never "some race". "Variant of S1, already covered" is a corner cut: expand the sub-arm.

## Fix-verification (all five, for each fix)
1. Diff summary: function and new file:line.
2. Before trace.
3. After trace, step by step (L3 on changed lines; two lines is not a trace).
4. At least 3 regression candidates, each marked ✅ / ⚠️ / 🐞.
5. Limitations.

Then a whole-change pass: stale comments, bypass paths, changed contracts. If a conditional changed, run a mini reverse pass on it **and re-run `deroulement.js`**.

## Anti-hallucination rules
1. Every function, file:line, CSS class and id must be real. The ledger checks the backticked ones. Anything else needs a grep or read you can quote.
2. Every state transition must trace to the line that mutates the state.
3. Never write "and then it re-renders" without naming the listener, the function and the DOM nodes.
4. "X is called from Y" needs a call site, not a definition. The helper's `wiring` rows count references outside the definition.
5. Cite `file:line` ranges. Deduplicate similar flows by reference.

## Negative claims (missing, dead, unhandled, unreachable)
They fail silently, so the proof burden is higher:
- Grep for the **literal** symbol and quote the result.
- Negate the negation: assume the symbol exists and try **3 search variants** first.
- For dead code, count call expressions separately from the definition.
- For "no validation", read the function top to bottom (guards, `Math.min`, `.substring`, enum checks).
- An *unverified* ledger row is **not** a negative proof. "grep unavailable" or a capped grep proves nothing.

Bug hygiene: list candidates first, verify them in one batched `js_eval`, and promote only the verified ones. Mark rejected ones `❌ FALSE POSITIVE — <evidence>`. Score yourself as "X candidates, Y confirmed, Z debunked": under 50% confirmed means slow down, and 100% is suspicious. Before fixing, re-read the spec: some weirdness is intentional.

## Self-check before you publish
1. Did `deroulement.js` run on the final code, with the gate at **0 refuted**? Is its summary in your answer?
2. Is every **unverified** claim listed with a reason?
3. Was every function with more than 5 branches probed arm by arm, and mutation-tested, with survivors explained?
4. Did edge inputs run on every renderer or validator you touched?
5. Does each fix have at least 3 regression candidates and an after-trace of more than about 50 words?
6. Did you grep for bypass paths of every guard you changed, and re-read the comments you changed?
7. Did you walk the full user lifecycle once more after the fix?
8. Are there no "variant of X" rows, and is every R3 ❓ resolved with evidence?

If any answer is no, do the deeper pass before the PR.

## Output
Markdown in chat, in this order:
- Cast
- scenarios, as numbered traces
- the tables (negatives, R1/R2, bugs, regressions)
- the **claims ledger** (`D.format(rep)`, trimmed to the relevant rows)
- **Unverified claims:** an explicit list

Aim for 200–500 lines on a medium feature. A déroulement is not a unit test, a design doc, a changelog or pseudocode: use real code and real line numbers. It is exhaustive on branches, but only pairwise on combinations.
