---
name: atf-testing
description: Create, run, and inspect ServiceNow ATF (Automated Test Framework) tests programmatically — API-only, no UI clicks. Covers test/suite creation, server-side trigger, result polling, and the critical gotchas around step inputs, scope, and assertions.
---

# ATF Testing — API-Only Playbook

This skill captures the working patterns for creating and running ATF tests entirely through APIs. **No UI clicks required.** All gotchas listed here are real failures encountered in practice, with the fixes that resolved them.

## When to use this skill

- User asks to write tests for a Script Include, Business Rule, table, or scoped app
- User wants to validate platform behavior (ACLs, BRs, defaults, mandatory fields, workflows) on a real instance
- User wants tests that are **durable** (live as records on the instance, run in CI later)

For pure-logic JS testing without platform involvement, use `js_eval` simulation instead — ATF is overkill.

## The 90% workflow

For most cases, a single test = one **Run Server Side Script** step + assertions. This avoids the complex variable-input plumbing of native step types.

```
1. Enable property: sn_atf.runner.enabled = true
2. Create sys_atf_test record (in target app's scope)
3. Create sys_atf_step record (step_config = Run Server Side Script)
4. Upsert sys_variable_value records for the step's `script` and `jasmine_version` inputs
5. (Optional) Create sys_atf_test_suite + sys_atf_test_suite_test M2M records
6. Trigger via sn_atf.UserTestSuiteExecutor or sn_atf.ExecuteUserTest
7. Poll sys_atf_test_suite_result / sys_atf_test_result
```

## Critical sys_ids (stable across instances)

These are platform-internal records — same sys_ids on every ServiceNow instance.

### Step Config sys_ids

| Step Type | sys_id |
|---|---|
| Run Server Side Script | `41de4a935332120028bc29cac2dc349a` |
| Impersonate | `071ee5b253331200040729cac2dc348d` |
| Record Insert | `14872288df60220062fe6c7a4df26319` |
| Record Update | `17a72288df60220062fe6c7a4df26397` |
| Record Validation | `1f39a288df60220062fe6c7a4df2639d` |
| Record Query | `2d82e3c7531400109e02ddeeff7b12a7` |

### Input Variable sys_ids (per step config)

**Run Server Side Script:**
- `989d9e235324220002c6435723dc3484` → `script` (the actual code)
- `42f2564b73031300440211d8faf6a777` → `jasmine_version` (use `'3.1'`)

**Impersonate:**
- `586e2c4253e0220002c6435723dc3415` → `user` (sys_user sys_id)

**Record Insert:**
- `90144b535320220002c6435723dc3488` → `table`
- `dd54cf535320220002c6435723dc34fd` → `field_values` (encoded query: `f1=v1^f2=v2`)
- `9024a37f671003007ba405225685efe5` → `assert_type` (`record_successfully_inserted` or `no_record_inserted`)
- `e6e3c7535320220002c6435723dc3496` → `enforce_security` (`'true'`/`'false'`)

**Record Validation:**
- `6aad5a575360220002c6435723dc34b0` → `table`
- `52ed1e5b5360220002c6435723dc3421` → `record_id` (sys_id or step output ref)
- `ff6e125353a0220002c6435723dc3442` → `field_values` (conditions encoded query)
- `67400008676003007ba405225685efa4` → `assert_type` (`all_conditions_match`)

To verify on a different platform version: query `atf_input_variable` with `model_id=<step_config_sys_id>`.

## Reference creation script

A complete, idempotent server-side script to create a test+suite+step. **Run this in `global` scope via `servicenow_run_script`.**

```javascript
// === ATF Test creator (idempotent, single-test+suite) ===
var MARKER = '[MY-ATF-TEST]';
var TARGET_SCOPE = 'x_my_app';   // scope of the app being tested
var TEST_NAME    = MARKER + ' Default values check';
var SUITE_NAME   = MARKER + ' My App Showcase';
var TARGET_TABLE = 'x_my_app_table';

// --- step config + variable sys_ids ---
var CFG_RSS    = '41de4a935332120028bc29cac2dc349a';
var VAR_SCRIPT  = '989d9e235324220002c6435723dc3484';
var VAR_JASMINE = '42f2564b73031300440211d8faf6a777';

// --- get target scope sys_id ---
var scopeGr = new GlideRecord('sys_scope');
scopeGr.get('scope', TARGET_SCOPE);
var SCOPE_ID = scopeGr.sys_id.toString();

// --- cleanup prior runs ---
function cleanup(table, encoded) {
  var g = new GlideRecord(table);
  g.addEncodedQuery(encoded);
  g.query();
  while (g.next()) g.deleteRecord();
}
cleanup('sys_atf_test_suite', 'name=' + SUITE_NAME);
cleanup('sys_atf_test',       'name=' + TEST_NAME);
// suite_test M2M and steps cascade-delete with parent

// --- upsert helper for sys_variable_value (CRITICAL: prevents duplicates) ---
function upsertVar(stepId, variableId, value) {
  var v = new GlideRecord('sys_variable_value');
  v.addQuery('document', 'sys_atf_step');
  v.addQuery('document_key', stepId);
  v.addQuery('variable', variableId);
  v.query();
  if (v.next()) { v.value = value; v.update(); }
  else {
    var ins = new GlideRecord('sys_variable_value');
    ins.initialize();
    ins.document = 'sys_atf_step';
    ins.document_key = stepId;
    ins.variable = variableId;
    ins.value = value;
    ins.setValue('sys_scope', SCOPE_ID);
    ins.insert();
  }
}

// --- create test record (in target app scope) ---
var test = new GlideRecord('sys_atf_test');
test.initialize();
test.setValue('sys_scope', SCOPE_ID);
test.name = TEST_NAME;
test.description = 'Validates default values applied on insert';
test.active = true;
var testId = test.insert();

// --- create RSS step ---
var step = new GlideRecord('sys_atf_step');
step.initialize();
step.setValue('sys_scope', SCOPE_ID);
step.test = testId;
step.step_config = CFG_RSS;
step.order = 1;
step.active = true;
step.description = 'Insert and assert defaults';
var stepId = step.insert();

// --- attach script + jasmine version ---
upsertVar(stepId, VAR_JASMINE, '3.1');
upsertVar(stepId, VAR_SCRIPT,
"(function(outputs, steps, params, stepResult, assertEqual){\n" +
"  var g = new GlideRecord('" + TARGET_TABLE + "');\n" +
"  g.initialize();\n" +
"  g.title = 'ATF probe';\n" +
"  var id = g.insert();\n" +
"  assertEqual({name:'Insert succeeded', shouldbe:true, value:!!id});\n" +
"  var f = new GlideRecord('" + TARGET_TABLE + "');\n" +
"  f.get(id);\n" +
"  assertEqual({name:'status defaults to 1', shouldbe:'1', value:f.getValue('status')});\n" +
"  f.deleteRecord();\n" +
"})(outputs, steps, params, stepResult, assertEqual);");

// --- (optional) create suite + add this test ---
var suite = new GlideRecord('sys_atf_test_suite');
suite.initialize();
suite.setValue('sys_scope', SCOPE_ID);
suite.name = SUITE_NAME;
suite.active = true;
var suiteId = suite.insert();

var st = new GlideRecord('sys_atf_test_suite_test');
st.initialize();
st.setValue('sys_scope', SCOPE_ID);
st.test_suite = suiteId;
st.test = testId;
st.order = 1;
st.insert();

gs.print(JSON.stringify({test: testId, step: stepId, suite: suiteId}));
```

## Triggering tests programmatically (no UI)

```javascript
// Run a single test
var trackerId = new sn_atf.ExecuteUserTest()
  .setTestRecordSysId('<test_sys_id>')
  .setTestRunnerSessionId(gs.getSession().getClientSessionId() || '')
  .setIsPerformance(false)
  .setPausingEnabled(false, false)
  .setUseCloudRunner(false)
  .start();

// Run a suite
var executor = new sn_atf.UserTestSuiteExecutor();
executor.setTestSuiteSysId('<suite_sys_id>');
executor.setTestRunnerSessionId(gs.getSession().getClientSessionId() || '');
executor.setIsPerformance(false);
executor.setPausingEnabled(false, false);
executor.setUseCloudRunner(false);
var trackerId = executor.start();
```

These are the same classes the OOB "Run Test" / "Run Test Suite" UI actions invoke. Discovered via `TestExecutorAjax` script include.

## Polling for results

```javascript
// For a suite (poll sys_atf_test_suite_result)
var sr = new GlideRecord('sys_atf_test_suite_result');
sr.addQuery('test_suite', SUITE_ID);
sr.orderByDesc('sys_created_on');
sr.setLimit(1);
sr.query();
if (sr.next() && sr.end_time) {
  // status = "success" | "failure" | "error" | "running"
  // Drill into individual test results:
  var tr = new GlideRecord('sys_atf_test_result');
  tr.addQuery('parent', sr.sys_id);
  tr.query();
  while (tr.next()) {
    gs.print(tr.test_name + ': ' + tr.status + '\n' + tr.output);
  }
}

// For a single test (poll sys_atf_test_result directly)
var tr = new GlideRecord('sys_atf_test_result');
tr.addQuery('test', TEST_ID);
tr.orderByDesc('sys_created_on');
tr.setLimit(1);
tr.query();
```

From the agent side, poll every 3s for ~60s max via `executeTool("servicenow_api", ...)` until `end_time` is populated.

## Critical gotchas (real failures, with fixes)

### 1. `assertTrue` / `assertFalse` don't exist
ATF's Jasmine 3.1 harness only passes **`assertEqual`** as a parameter to RSS scripts. `assertTrue` is undefined → `ReferenceError`.

```javascript
// ❌ Won't work
assertTrue({name:'is set', value: x != null});

// ✅ Works
assertEqual({name:'is set', shouldbe:true, value: (x != null)});
```

The function signature ATF actually invokes is:
```javascript
(function(outputs, steps, params, stepResult, assertEqual) { ... })
```

### 2. Duplicate `sys_variable_value` records
The platform auto-creates blank `sys_variable_value` records when a `sys_atf_step` is inserted. If your code then inserts another vv with the same `(document_key, variable)`, you end up with **duplicates** and ATF picks the wrong one (often the empty / older one).

**Always upsert** — query first, update if found, insert only if missing. See `upsertVar()` in the reference script above.

If you discover existing duplicates, dedupe with:
```javascript
// keep most recent vv per (step, variable)
var byVarPerStep = {};
var vv = new GlideRecord('sys_variable_value');
vv.addEncodedQuery('document=sys_atf_step^document_keyIN' + stepIds.join(','));
vv.orderByDesc('sys_updated_on');
vv.query();
while (vv.next()) {
  var key = vv.document_key + '|' + vv.variable;
  if (byVarPerStep[key]) vv.deleteRecord();
  else byVarPerStep[key] = true;
}
```

### 3. HTTP 414 — `servicenow_run_script` URL too long
The `script` parameter is sent in the request URI. Embedding many RSS test bodies as string literals in **one** creation script easily blows past the limit (~8KB on most instances), and you get back:

```
HTTP 414 Request-URI Too Large
```

**Fix:** Split creation across multiple `servicenow_run_script` calls — typically one call to create the suite + helpers, then one call per 2–3 tests. Pass shared IDs between calls via `gs.setProperty`:

```javascript
// === Call 1: suite + first batch ===
var SCOPE_ID = /* lookup */;
var SUITE_ID = /* insert sys_atf_test_suite */;
gs.setProperty('atf.myapp.scope_id', SCOPE_ID);
gs.setProperty('atf.myapp.suite_id', SUITE_ID);
// ... create T1, T2, T3 ...

// === Call 2: more tests ===
var SCOPE_ID = gs.getProperty('atf.myapp.scope_id');
var SUITE_ID = gs.getProperty('atf.myapp.suite_id');
// ... create T4, T5, T6 ...
```

Additional tactics that buy headroom:

- **Shorten RSS param names.** ATF passes positional args, so you can rename them inside the IIFE. The compact form is ~25% smaller per test:
  ```javascript
  "(function(o,s,p,sr,aE){ ... aE({name:'x',shouldbe:true,value:y}); })(outputs,steps,params,stepResult,assertEqual);"
  ```
- **Inline helpers, drop comments**, use single-letter locals inside the script body string.
- **Cleanup by prefix, not by exact name.** When working with a marker like `[ATF-FOO]`, use `nameSTARTSWITH[ATF-FOO]` so a single cleanup wipes the whole family without listing each test:
  ```javascript
  cleanup('sys_atf_test_suite', 'nameSTARTSWITH' + MARKER);
  cleanup('sys_atf_test',       'nameSTARTSWITH' + MARKER);
  ```
  (suite_test M2M and steps cascade-delete with their parent.)

### 4. Test scope determines runtime ACLs
RSS steps execute in the scope of the test record. If your test is in scope `A` and the table being tested is in scope `B`, the RSS script will hit cross-scope ACL denials (`Security restricted: Create operation against 'B_table' from scope 'rhino.A' has been refused`).

**Fix:** Set `sys_scope` on the test, suite, step, suite_test, and variable_value records to the **target app's scope** (the scope of the table/code being tested). For global tables, use the `global` scope sys_id (look up via `sys_scope` where `scope=global`).

### 5. Impersonated user needs the right roles
After an `Impersonate` step, subsequent steps run as that user. If the impersonated user lacks ACL access to the target table, inserts/updates fail.

For a scoped app `x_foo`, the user typically needs `x_foo.user` or `x_foo.admin` role. Grant via `sys_user_has_role` insert.

### 6. `sn_atf.runner.enabled` must be true
Default is `false`. ATF execution silently no-ops without it.

```javascript
gs.setProperty('sn_atf.runner.enabled', 'true');
```

It is a single instance-wide property — set it once per instance.

### 7. Dictionary `mandatory=true` is UI-only
`GlideRecord.insert()` ignores it. To test mandatory enforcement, use a **Form Submission** step (`sys_atf_step_config` for "Submission") instead of an RSS step doing GlideRecord inserts. RSS-based tests for mandatory fields will give false negatives. Note: Form Submission steps require a connected browser test runner, so they fall outside this skill's pure-API scope (see "What this skill deliberately does NOT cover").

### 8. Cross-step output references
The syntax `${steps.<step_sys_id>.<output>}` does **not** work as a literal string in `sys_variable_value.value` for `record_id` references. The proper format involves an output binding stored differently and is hard to get right via API.

**Recommendation:** Avoid cross-step output references. Use a single RSS step that does the insert AND the validation in one script. This keeps tests self-contained and easier to author.

### 9. Step `description` doesn't auto-update
ATF business rules try to regenerate the step description on save (using a `description_generator` script per step config). For complex configurations this can throw `IllegalStateException: Table name cannot be null`. The errors are noisy but **non-fatal** — records still save. Ignore them or set `description` explicitly.

## Authoring a multi-test suite (the realistic flow)

Most real work is **"write N tests for module X"**, not a single test. The pattern that scales:

1. **Plan the tests first** (table — defaults, BRs, integrity, edge cases). Confirm with the user before creating records.
2. **Call 1**: enable the runner, look up scope, cleanup by marker prefix, create the suite, stash IDs in `gs.setProperty`, create the first 2–3 tests, attach to suite.
3. **Call 2..N**: pull IDs from `gs.setProperty`, create more tests, attach.
4. **Trigger** the suite via `sn_atf.UserTestSuiteExecutor` (single call).
5. **Poll** `sys_atf_test_suite_result` from the agent side every ~3s until `end_time` is set, then drill into `sys_atf_test_result` for per-test status + output.

When tests fail, **read the BR / target code before "fixing" the test**. ATF assertions catch real defects — a failing test is often the *correct* outcome (e.g. a BR with `action_update=false` that was supposed to fire on update). Do not silently weaken assertions to make a suite green.

## Recommended skeleton for new ATF tests

For most testing needs, this is the simplest pattern:

```javascript
// One test = one RSS step that does setup + action + assertions + cleanup
(function(outputs, steps, params, stepResult, assertEqual) {
  // 1. Setup
  var gr = new GlideRecord('target_table');
  gr.initialize();
  gr.field_a = 'test_value';
  var sysId = gr.insert();

  // 2. Trigger the behavior under test (e.g. update that fires a BR)
  var update = new GlideRecord('target_table');
  update.get(sysId);
  update.state = '3';
  update.update();

  // 3. Assert outcomes
  var fresh = new GlideRecord('target_table');
  fresh.get(sysId);
  assertEqual({
    name: 'state changed to 3',
    shouldbe: '3',
    value: fresh.getValue('state')
  });
  assertEqual({
    name: 'completed_at populated by BR',
    shouldbe: true,
    value: fresh.getValue('completed_at') != null && fresh.getValue('completed_at') !== ''
  });

  // 4. Cleanup
  fresh.deleteRecord();
})(outputs, steps, params, stepResult, assertEqual);
```

## Useful related tables

| Table | Purpose |
|---|---|
| `sys_atf_test` | Test definition |
| `sys_atf_step` | Step within a test |
| `sys_atf_step_config` | Step type (lookup table) |
| `atf_input_variable` | Input variable definitions per step config |
| `sys_variable_value` | Values for step inputs (`document=sys_atf_step`) |
| `sys_atf_test_suite` | Group of tests |
| `sys_atf_test_suite_test` | M2M between suite and test |
| `sys_atf_test_result` | Test execution result |
| `sys_atf_test_suite_result` | Suite execution result |
| `sys_atf_agent` | Test runner browser sessions (UI tests only) |

## Discovery snippets

When porting to a new instance or unfamiliar step type, these one-liners reveal the schema:

```javascript
// Find input variables for a step config
var v = new GlideRecord('atf_input_variable');
v.addQuery('model_id', '<step_config_sys_id>');
v.query();
while (v.next()) gs.print(v.element + ' (' + v.internal_type + ', mandatory=' + v.mandatory + ') = ' + v.sys_id);

// Inspect a real test step's stored inputs
var vv = new GlideRecord('sys_variable_value');
vv.addQuery('document', 'sys_atf_step');
vv.addQuery('document_key', '<step_sys_id>');
vv.query();
while (vv.next()) {
  var ref = vv.variable.getRefRecord();
  gs.print(ref.element + ' = ' + (vv.value + '').substring(0, 200));
}
```

## What this skill deliberately does NOT cover

- **UI / Form Submission steps** — work fine but require a real browser test runner (`sys_atf_agent`) connected, which is outside pure-API scope. Use these only when testing UI policies, client scripts, or mandatory-field UI enforcement.
- **Custom step configs** — possible to define new step types via `sys_atf_step_config`, but rarely worth it. Stick to RSS for custom logic.
- **Performance test runs** — `setIsPerformance(true)` exists; results land in `sys_atf_performance_test_suite_result` with timing data. Out of scope here.
- **Cloud runner** — `setUseCloudRunner(true)`. Requires connected ServiceNow cloud runner setup.
