# servicenow-eval task specs (v2 — 20 tasks)

Parse the JSON in the fenced code block below.

```json
{
  "version": 2,
  "total_points": 45,
  "tasks": [
    {
      "id": "T1",
      "name": "Count active incidents",
      "category": "read",
      "points": 1,
      "prompt": "Count the currently active incidents whose short_description starts with '[EVAL-T1]'. Then create or update the system property named 'x_eval.task1.result' so its value is the count expressed as a string (e.g. \"3\").",
      "setup_script": "var gr = new GlideRecord('incident');\ngr.addQuery('short_description', 'STARTSWITH', '[EVAL-T1]');\ngr.query();\nwhile (gr.next()) gr.deleteRecord();\nvar p = new GlideRecord('sys_properties');\nif (p.get('name', 'x_eval.task1.result')) p.deleteRecord();\nvar count = 2 + Math.floor(Math.random() * 4);\nfor (var i = 1; i <= count; i++) {\n  var n = new GlideRecord('incident');\n  n.initialize();\n  n.short_description = '[EVAL-T1] Test incident ' + i;\n  n.priority = 1;\n  n.active = true;\n  n.insert();\n}\ngs.print(JSON.stringify({seeded: true}));",
      "verifier_script": "var count = 0;\nvar gr = new GlideRecord('incident');\ngr.addQuery('short_description', 'STARTSWITH', '[EVAL-T1]');\ngr.addActiveQuery();\ngr.query();\nwhile (gr.next()) count++;\nvar p = new GlideRecord('sys_properties');\nvar actual = '';\nif (p.get('name', 'x_eval.task1.result')) actual = p.value + '';\nvar pass = (actual === count + '');\ngs.print(JSON.stringify({pass: pass, expected: count + '', actual: actual}));",
      "cleanup_script": "var gr = new GlideRecord('incident');\ngr.addQuery('short_description', 'STARTSWITH', '[EVAL-T1]');\ngr.query();\nwhile (gr.next()) gr.deleteRecord();\nvar p = new GlideRecord('sys_properties');\nif (p.get('name', 'x_eval.task1.result')) p.deleteRecord();\ngs.print('cleaned');"
    },
    {
      "id": "T2",
      "name": "Create incident with specific fields",
      "category": "write",
      "points": 2,
      "prompt": "Create a new incident with these exact fields: short_description='[EVAL-T2] Server down in DC1', priority=2, category='hardware', impact=2, urgency=2. After creating it, create or update the system property 'x_eval.task2.result' with the new incident's sys_id as the value.",
      "setup_script": "var gr = new GlideRecord('incident');\ngr.addQuery('short_description', 'STARTSWITH', '[EVAL-T2]');\ngr.query();\nwhile (gr.next()) gr.deleteRecord();\nvar p = new GlideRecord('sys_properties');\nif (p.get('name', 'x_eval.task2.result')) p.deleteRecord();\ngs.print('ready');",
      "verifier_script": "var p = new GlideRecord('sys_properties');\nvar sid = '';\nif (p.get('name', 'x_eval.task2.result')) sid = p.value + '';\nvar inc = new GlideRecord('incident');\nif (!sid || !inc.get(sid)) {\n  gs.print(JSON.stringify({pass: false, expected: 'incident sys_id in property', actual: 'missing or not found: ' + sid}));\n} else {\n  var checks = {\n    short_description: (inc.short_description + '') === '[EVAL-T2] Server down in DC1',\n    priority: (inc.priority + '') === '2',\n    category: (inc.category + '') === 'hardware',\n    impact: (inc.impact + '') === '2',\n    urgency: (inc.urgency + '') === '2'\n  };\n  var failed = [];\n  for (var k in checks) if (!checks[k]) failed.push(k + '=' + inc.getValue(k));\n  var pass = failed.length === 0;\n  gs.print(JSON.stringify({pass: pass, expected: 'all 5 fields correct', actual: pass ? 'all match' : 'mismatched: ' + failed.join(', ')}));\n}",
      "cleanup_script": "var gr = new GlideRecord('incident');\ngr.addQuery('short_description', 'STARTSWITH', '[EVAL-T2]');\ngr.query();\nwhile (gr.next()) gr.deleteRecord();\nvar p = new GlideRecord('sys_properties');\nif (p.get('name', 'x_eval.task2.result')) p.deleteRecord();\ngs.print('cleaned');"
    },
    {
      "id": "T3",
      "name": "Create problem and link to incident",
      "category": "link",
      "points": 2,
      "prompt": "Find the incident with short_description='[EVAL-T3] Needs root cause analysis'. Create a new problem record with short_description='[EVAL-T3] Root cause investigation', and link it to that incident by setting the incident's problem_id field to the new problem's sys_id. Then create or update the system property 'x_eval.task3.result' with the new problem's sys_id as the value.",
      "setup_script": "var inc = new GlideRecord('incident');\ninc.addQuery('short_description', 'STARTSWITH', '[EVAL-T3]');\ninc.query();\nwhile (inc.next()) inc.deleteRecord();\nvar prb = new GlideRecord('problem');\nprb.addQuery('short_description', 'STARTSWITH', '[EVAL-T3]');\nprb.query();\nwhile (prb.next()) prb.deleteRecord();\nvar p = new GlideRecord('sys_properties');\nif (p.get('name', 'x_eval.task3.result')) p.deleteRecord();\nvar n = new GlideRecord('incident');\nn.initialize();\nn.short_description = '[EVAL-T3] Needs root cause analysis';\nn.priority = 2;\nn.active = true;\nvar sid = n.insert();\ngs.print(JSON.stringify({incident_sys_id: sid}));",
      "verifier_script": "var p = new GlideRecord('sys_properties');\nvar pid = '';\nif (p.get('name', 'x_eval.task3.result')) pid = p.value + '';\nvar prb = new GlideRecord('problem');\nif (!pid || !prb.get(pid)) {\n  gs.print(JSON.stringify({pass: false, expected: 'problem sys_id in property', actual: 'missing or not found: ' + pid}));\n} else {\n  var descOk = (prb.short_description + '') === '[EVAL-T3] Root cause investigation';\n  var inc = new GlideRecord('incident');\n  inc.addQuery('short_description', '[EVAL-T3] Needs root cause analysis');\n  inc.query();\n  if (!inc.next()) {\n    gs.print(JSON.stringify({pass: false, expected: 'seeded incident exists', actual: 'incident missing'}));\n  } else {\n    var linkOk = (inc.problem_id + '') === pid;\n    var pass = descOk && linkOk;\n    gs.print(JSON.stringify({pass: pass, expected: 'problem with desc + linked', actual: 'desc_ok=' + descOk + ', link_ok=' + linkOk}));\n  }\n}",
      "cleanup_script": "var inc = new GlideRecord('incident');\ninc.addQuery('short_description', 'STARTSWITH', '[EVAL-T3]');\ninc.query();\nwhile (inc.next()) inc.deleteRecord();\nvar prb = new GlideRecord('problem');\nprb.addQuery('short_description', 'STARTSWITH', '[EVAL-T3]');\nprb.query();\nwhile (prb.next()) prb.deleteRecord();\nvar p = new GlideRecord('sys_properties');\nif (p.get('name', 'x_eval.task3.result')) p.deleteRecord();\ngs.print('cleaned');"
    },
    {
      "id": "T4",
      "name": "Fix broken script include",
      "category": "debug",
      "points": 3,
      "prompt": "There is a script include in the global scope named 'EvalT4Util' that has a method `sumPositive(arr)` which should return the sum of the positive numbers in the given array. It currently has bugs and returns incorrect results. Fix the script include so that sumPositive works correctly for any array (including empty arrays and arrays of all negative numbers). Do NOT change the script include's name or the method's name.",
      "setup_script": "var gr = new GlideRecord('sys_script_include');\ngr.addQuery('name', 'EvalT4Util');\ngr.query();\nwhile (gr.next()) gr.deleteRecord();\nvar n = new GlideRecord('sys_script_include');\nn.initialize();\nn.name = 'EvalT4Util';\nn.api_name = 'global.EvalT4Util';\nn.sys_scope = 'global';\nn.client_callable = false;\nn.access = 'public';\nn.script = \"var EvalT4Util = Class.create();\\nEvalT4Util.prototype = {\\n    initialize: function() {},\\n    sumPositive: function(arr) {\\n        var total = 0;\\n        for (var i = 0; i <= arr.length; i++) {\\n            if (arr[i] > 0) total = total - arr[i];\\n        }\\n        return total;\\n    },\\n    type: 'EvalT4Util'\\n};\";\nvar sid = n.insert();\ngs.print(JSON.stringify({sys_id: sid}));",
      "verifier_script": "try {\n  var u = new EvalT4Util();\n  var r1 = u.sumPositive([1, -2, 3, -4, 5, -6]);\n  var r2 = u.sumPositive([]);\n  var r3 = u.sumPositive([-1, -2]);\n  var r4 = u.sumPositive([10]);\n  var expected = '9,0,0,10';\n  var actual = [r1, r2, r3, r4].join(',');\n  var pass = (actual === expected);\n  gs.print(JSON.stringify({pass: pass, expected: expected, actual: actual}));\n} catch (e) {\n  gs.print(JSON.stringify({pass: false, expected: '9,0,0,10', actual: 'error: ' + e.message}));\n}",
      "cleanup_script": "var gr = new GlideRecord('sys_script_include');\nif (gr.get('name', 'EvalT4Util')) gr.deleteRecord();\ngs.print('cleaned');"
    },
    {
      "id": "T5",
      "name": "Batch resolve incidents",
      "category": "batch",
      "points": 3,
      "prompt": "Find all active incidents whose short_description starts with '[EVAL-T5]'. For each one, set state=6 (Resolved), close_code='Solved (Permanently)', and close_notes='Resolved by eval run'. After updating all of them, create or update the system property 'x_eval.task5.result' with the count of incidents you resolved (as a string).",
      "setup_script": "var gr = new GlideRecord('incident');\ngr.addQuery('short_description', 'STARTSWITH', '[EVAL-T5]');\ngr.query();\nwhile (gr.next()) gr.deleteRecord();\nvar p = new GlideRecord('sys_properties');\nif (p.get('name', 'x_eval.task5.result')) p.deleteRecord();\nfor (var i = 1; i <= 4; i++) {\n  var n = new GlideRecord('incident');\n  n.initialize();\n  n.short_description = '[EVAL-T5] Resolvable incident ' + i;\n  n.priority = 3;\n  n.active = true;\n  n.state = 1;\n  n.insert();\n}\ngs.print(JSON.stringify({created: 4}));",
      "verifier_script": "var gr = new GlideRecord('incident');\ngr.addQuery('short_description', 'STARTSWITH', '[EVAL-T5]');\ngr.query();\nvar total = 0, ok = 0, issues = [];\nwhile (gr.next()) {\n  total++;\n  var stateOk = (gr.state + '') === '6';\n  var codeOk = (gr.close_code + '') === 'Solved (Permanently)';\n  var notesOk = (gr.close_notes + '') === 'Resolved by eval run';\n  if (stateOk && codeOk && notesOk) ok++;\n  else issues.push(gr.number + ':state=' + gr.state + ',code=' + gr.close_code);\n}\nvar p = new GlideRecord('sys_properties');\nvar reported = '';\nif (p.get('name', 'x_eval.task5.result')) reported = p.value + '';\nvar countOk = (reported === total + '');\nvar pass = (total === 4 && ok === 4 && countOk);\ngs.print(JSON.stringify({pass: pass, expected: '4 resolved with property=4', actual: 'total=' + total + ',ok=' + ok + ',reported=' + reported + (issues.length ? ',issues=' + issues.join('|') : '')}));",
      "cleanup_script": "var gr = new GlideRecord('incident');\ngr.addQuery('short_description', 'STARTSWITH', '[EVAL-T5]');\ngr.query();\nwhile (gr.next()) gr.deleteRecord();\nvar p = new GlideRecord('sys_properties');\nif (p.get('name', 'x_eval.task5.result')) p.deleteRecord();\ngs.print('cleaned');"
    },
    {
      "id": "T6",
      "name": "Create before-insert business rule",
      "category": "business_rule",
      "points": 3,
      "prompt": "Create a Business Rule on the 'incident' table named '[EVAL-T6] Uppercase desc' that runs BEFORE INSERT, is ACTIVE, and uppercases the short_description if and only if the short_description (before save) starts with '[EVAL-T6]'. (Use a script body that mutates `current.short_description`. Do not set a filter condition that would prevent it firing on insert.)",
      "setup_script": "var gr = new GlideRecord('sys_script');\ngr.addQuery('name', 'STARTSWITH', '[EVAL-T6]');\ngr.query();\nwhile (gr.next()) gr.deleteRecord();\nvar inc = new GlideRecord('incident');\ninc.addQuery('short_description', 'STARTSWITH', '[EVAL-T6]');\ninc.query();\nwhile (inc.next()) inc.deleteRecord();\ngs.print('ready');",
      "verifier_script": "var n = new GlideRecord('incident');\nn.initialize();\nn.short_description = '[EVAL-T6] test lowercase value';\nvar sid = n.insert();\nvar c = new GlideRecord('incident');\nvar actual = '';\nif (c.get(sid)) {\n  actual = c.short_description + '';\n  c.deleteRecord();\n}\nvar expected = '[EVAL-T6] TEST LOWERCASE VALUE';\nvar pass = actual === expected;\ngs.print(JSON.stringify({pass: pass, expected: expected, actual: actual}));",
      "cleanup_script": "var gr = new GlideRecord('sys_script');\ngr.addQuery('name', 'STARTSWITH', '[EVAL-T6]');\ngr.query();\nwhile (gr.next()) gr.deleteRecord();\nvar inc = new GlideRecord('incident');\ninc.addQuery('short_description', 'STARTSWITH', '[EVAL-T6]');\ninc.query();\nwhile (inc.next()) inc.deleteRecord();\ngs.print('cleaned');"
    },
    {
      "id": "T7",
      "name": "Create field-level ACL",
      "category": "acl",
      "points": 3,
      "prompt": "Create a record-level ACL that restricts WRITE access to the 'urgency' field on the 'incident' table to users with the 'itil' role. The ACL must be: type='record', operation='write', name='incident.urgency', active=true, and the 'itil' role must be required (via the sys_security_acl_role relationship). NOTE: creating ACLs requires elevated 'security_admin' privileges — elevate first if needed.",
      "setup_script": "var acl = new GlideRecord('sys_security_acl');\nacl.addQuery('name', 'incident.urgency');\nacl.addQuery('operation', 'write');\nacl.query();\nwhile (acl.next()) {\n  var rg = new GlideRecord('sys_security_acl_role');\n  rg.addQuery('sys_security_acl', acl.sys_id + '');\n  rg.query();\n  while (rg.next()) rg.deleteRecord();\n  acl.deleteRecord();\n}\ngs.print('ready');",
      "verifier_script": "var acl = new GlideRecord('sys_security_acl');\nacl.addQuery('name', 'incident.urgency');\nacl.addQuery('operation', 'write');\nacl.addQuery('active', true);\nacl.addQuery('type', 'record');\nacl.query();\nif (!acl.next()) {\n  gs.print(JSON.stringify({pass: false, expected: 'active record ACL incident.urgency write', actual: 'no matching ACL'}));\n} else {\n  var aclSid = acl.sys_id + '';\n  var rg = new GlideRecord('sys_security_acl_role');\n  rg.addQuery('sys_security_acl', aclSid);\n  rg.query();\n  var roles = [];\n  while (rg.next()) {\n    var rr = new GlideRecord('sys_user_role');\n    if (rr.get(rg.sys_user_role + '')) roles.push(rr.name + '');\n  }\n  var pass = roles.indexOf('itil') !== -1;\n  gs.print(JSON.stringify({pass: pass, expected: 'itil role linked', actual: 'roles=[' + roles.join(',') + ']'}));\n}",
      "cleanup_script": "var acl = new GlideRecord('sys_security_acl');\nacl.addQuery('name', 'incident.urgency');\nacl.addQuery('operation', 'write');\nacl.query();\nwhile (acl.next()) {\n  var rg = new GlideRecord('sys_security_acl_role');\n  rg.addQuery('sys_security_acl', acl.sys_id + '');\n  rg.query();\n  while (rg.next()) rg.deleteRecord();\n  acl.deleteRecord();\n}\ngs.print('cleaned');"
    },
    {
      "id": "T8",
      "name": "Create custom user role",
      "category": "role",
      "points": 1,
      "prompt": "Create a new user role on sys_user_role with name='x_eval_t8_reviewer' and description='Eval T8 reviewer role'.",
      "setup_script": "var r = new GlideRecord('sys_user_role');\nif (r.get('name', 'x_eval_t8_reviewer')) r.deleteRecord();\ngs.print('ready');",
      "verifier_script": "var r = new GlideRecord('sys_user_role');\nif (!r.get('name', 'x_eval_t8_reviewer')) {\n  gs.print(JSON.stringify({pass: false, expected: 'role x_eval_t8_reviewer exists', actual: 'not found'}));\n} else {\n  var desc = r.description + '';\n  var pass = desc === 'Eval T8 reviewer role';\n  gs.print(JSON.stringify({pass: pass, expected: 'Eval T8 reviewer role', actual: desc}));\n}",
      "cleanup_script": "var r = new GlideRecord('sys_user_role');\nif (r.get('name', 'x_eval_t8_reviewer')) r.deleteRecord();\ngs.print('cleaned');"
    },
    {
      "id": "T9",
      "name": "Create Service Portal widget",
      "category": "widget",
      "points": 3,
      "prompt": "Create a Service Portal widget (sp_widget) with id='eval-t9-widget' and name='Eval T9 Widget'. Its template (HTML) must contain an <h1> tag with the visible text 'Hello Eval T9'. Its CSS must include a rule for the class '.eval-t9' that sets `color: red`. Its server script must populate `data.count` with the current number of active incidents (using GlideRecord or GlideAggregate).",
      "setup_script": "var w = new GlideRecord('sp_widget');\nif (w.get('id', 'eval-t9-widget')) w.deleteRecord();\ngs.print('ready');",
      "verifier_script": "var w = new GlideRecord('sp_widget');\nif (!w.get('id', 'eval-t9-widget')) {\n  gs.print(JSON.stringify({pass: false, expected: 'sp_widget id=eval-t9-widget', actual: 'not found'}));\n} else {\n  var tpl = w.template + '';\n  var css = w.css + '';\n  var srv = w.script + '';\n  var tplOk = /<h1[^>]*>\\s*Hello Eval T9\\s*<\\/h1>/i.test(tpl);\n  var cssOk = /\\.eval-t9[^{]*\\{[^}]*red/i.test(css);\n  var srvOk = /data\\.count/.test(srv) && /incident/i.test(srv);\n  var pass = tplOk && cssOk && srvOk;\n  gs.print(JSON.stringify({pass: pass, expected: 'tpl+css+srv all valid', actual: 'tpl=' + tplOk + ',css=' + cssOk + ',srv=' + srvOk}));\n}",
      "cleanup_script": "var w = new GlideRecord('sp_widget');\nif (w.get('id', 'eval-t9-widget')) w.deleteRecord();\ngs.print('cleaned');"
    },
    {
      "id": "T10",
      "name": "Attach text file (exact bytes)",
      "category": "attachment",
      "points": 3,
      "prompt": "Find the incident with short_description='[EVAL-T10] Needs attachment'. Attach a text file to it with file_name='eval_t10.txt', content_type='text/plain', and the EXACT body bytes 'Hello from eval T10' (19 bytes UTF-8, no trailing newline). The verifier checks file_name + content_type + size_bytes=19 (since direct content read APIs are blocked on this instance, the byte length acts as the content proxy).",
      "setup_script": "var inc = new GlideRecord('incident');\ninc.addQuery('short_description', 'STARTSWITH', '[EVAL-T10]');\ninc.query();\nwhile (inc.next()) {\n  var att = new GlideRecord('sys_attachment');\n  att.addQuery('table_name', 'incident');\n  att.addQuery('table_sys_id', inc.sys_id + '');\n  att.query();\n  while (att.next()) att.deleteRecord();\n  inc.deleteRecord();\n}\nvar n = new GlideRecord('incident');\nn.initialize();\nn.short_description = '[EVAL-T10] Needs attachment';\nn.priority = 3;\nvar sid = n.insert();\ngs.print(JSON.stringify({incident_sys_id: sid}));",
      "verifier_script": "var inc = new GlideRecord('incident');\ninc.addQuery('short_description', '[EVAL-T10] Needs attachment');\ninc.query();\nif (!inc.next()) {\n  gs.print(JSON.stringify({pass: false, expected: 'seeded incident exists', actual: 'incident missing'}));\n} else {\n  var att = new GlideRecord('sys_attachment');\n  att.addQuery('table_name', 'incident');\n  att.addQuery('table_sys_id', inc.sys_id + '');\n  att.addQuery('file_name', 'eval_t10.txt');\n  att.query();\n  if (!att.next()) {\n    gs.print(JSON.stringify({pass: false, expected: 'attachment eval_t10.txt', actual: 'no attachment with that name'}));\n  } else {\n    var size = parseInt(att.size_bytes + '', 10);\n    var ct = (att.content_type + '');\n    var ctOk = ct.indexOf('text/plain') === 0;\n    var sizeOk = size === 19; // 'Hello from eval T10' is 19 bytes UTF-8\n    var pass = ctOk && sizeOk;\n    gs.print(JSON.stringify({pass: pass, expected: 'text/plain + 19 bytes', actual: 'ct=' + ct + ',size=' + size}));\n  }\n}",
      "cleanup_script": "var inc = new GlideRecord('incident');\ninc.addQuery('short_description', 'STARTSWITH', '[EVAL-T10]');\ninc.query();\nwhile (inc.next()) {\n  var att = new GlideRecord('sys_attachment');\n  att.addQuery('table_name', 'incident');\n  att.addQuery('table_sys_id', inc.sys_id + '');\n  att.query();\n  while (att.next()) att.deleteRecord();\n  inc.deleteRecord();\n}\ngs.print('cleaned');"
    },
    {
      "id": "T11",
      "name": "Find marker in noisy syslog",
      "category": "logs",
      "points": 2,
      "prompt": "The system log (table 'syslog') contains many recent entries. One of them has a message that starts with '[EVAL-T11-MARKER] ' followed by a UUID. Find that log entry, extract the UUID (the text after the space), and set the system property 'x_eval.task11.result' to that UUID. Hint: query syslog with a STARTSWITH filter on message.",
      "setup_script": "var oldLog = new GlideRecord('syslog');\noldLog.addQuery('message', 'STARTSWITH', '[EVAL-T11-MARKER]');\noldLog.query();\nwhile (oldLog.next()) oldLog.deleteRecord();\nvar oldNoise = new GlideRecord('syslog');\noldNoise.addQuery('source', 'eval-t11');\noldNoise.query();\nwhile (oldNoise.next()) oldNoise.deleteRecord();\nvar p = new GlideRecord('sys_properties');\nif (p.get('name', 'x_eval.task11.result')) p.deleteRecord();\nvar uuid = gs.generateGUID();\nfor (var i = 0; i < 15; i++) gs.info('eval-t11 noise line ' + i + ' alpha beta gamma', 'eval-t11');\ngs.info('[EVAL-T11-MARKER] ' + uuid, 'eval-t11');\nfor (var j = 0; j < 10; j++) gs.info('eval-t11 noise tail ' + j, 'eval-t11');\ngs.print(JSON.stringify({uuid_seeded: true}));",
      "verifier_script": "var log = new GlideRecord('syslog');\nlog.addQuery('message', 'STARTSWITH', '[EVAL-T11-MARKER]');\nlog.orderByDesc('sys_created_on');\nlog.setLimit(1);\nlog.query();\nif (!log.next()) {\n  gs.print(JSON.stringify({pass: false, expected: 'marker log present', actual: 'no log with marker'}));\n} else {\n  var msg = log.message + '';\n  var expected = msg.replace('[EVAL-T11-MARKER] ', '').trim();\n  var p = new GlideRecord('sys_properties');\n  var actual = '';\n  if (p.get('name', 'x_eval.task11.result')) actual = (p.value + '').trim();\n  var pass = actual === expected;\n  gs.print(JSON.stringify({pass: pass, expected: expected, actual: actual}));\n}",
      "cleanup_script": "var oldLog = new GlideRecord('syslog');\noldLog.addQuery('message', 'STARTSWITH', '[EVAL-T11-MARKER]');\noldLog.query();\nwhile (oldLog.next()) oldLog.deleteRecord();\nvar oldNoise = new GlideRecord('syslog');\noldNoise.addQuery('source', 'eval-t11');\noldNoise.query();\nwhile (oldNoise.next()) oldNoise.deleteRecord();\nvar p = new GlideRecord('sys_properties');\nif (p.get('name', 'x_eval.task11.result')) p.deleteRecord();\ngs.print('cleaned');"
    },
    {
      "id": "T12",
      "name": "Clear outbound email queue",
      "category": "queue",
      "points": 2,
      "prompt": "Find all sys_email records (the outbound email queue) whose subject starts with '[EVAL-T12]'. For each one, mark it as sent by setting its 'type' field to 'sent' (sys_email tracks queue status in the 'type' choice field: send-ready/sent/received). Then set the system property 'x_eval.task12.result' to the count of emails you cleared (as a string).",
      "setup_script": "var em = new GlideRecord('sys_email');\nem.addQuery('subject', 'STARTSWITH', '[EVAL-T12]');\nem.query();\nwhile (em.next()) em.deleteRecord();\nvar p = new GlideRecord('sys_properties');\nif (p.get('name', 'x_eval.task12.result')) p.deleteRecord();\nfor (var i = 1; i <= 5; i++) {\n  var e = new GlideRecord('sys_email');\n  e.initialize();\n  e.subject = '[EVAL-T12] Stuck email ' + i;\n  e.body = 'eval body';\n  e.recipients = 'noone@example.com';\n  e.type = 'send-ready';\n  e.state = 'ready';\n  e.insert();\n}\ngs.print(JSON.stringify({created: 5}));",
      "verifier_script": "var em = new GlideRecord('sys_email');\nem.addQuery('subject', 'STARTSWITH', '[EVAL-T12]');\nem.query();\nvar total = 0, ok = 0;\nwhile (em.next()) { total++; if ((em.type + '') === 'sent') ok++; }\nvar p = new GlideRecord('sys_properties');\nvar reported = '';\nif (p.get('name', 'x_eval.task12.result')) reported = p.value + '';\nvar pass = (total === 5 && ok === 5 && reported === total + '');\ngs.print(JSON.stringify({pass: pass, expected: '5 type=sent + reported=5', actual: 'total=' + total + ',sent=' + ok + ',reported=' + reported}));",
      "cleanup_script": "var em = new GlideRecord('sys_email');\nem.addQuery('subject', 'STARTSWITH', '[EVAL-T12]');\nem.query();\nwhile (em.next()) em.deleteRecord();\nvar p = new GlideRecord('sys_properties');\nif (p.get('name', 'x_eval.task12.result')) p.deleteRecord();\ngs.print('cleaned');"
    },
    {
      "id": "T13",
      "name": "Create UI Action",
      "category": "ui_action",
      "points": 2,
      "prompt": "Create a UI Action on the 'incident' table (sys_ui_action) with these properties: name='Eval T13 Action', action_name='eval_t13_action', table='incident', show_update=true, show_insert=false, form_button=true, active=true, and a script body containing the marker '[EVAL-T13]' (the script body itself can be any logic — just include that marker text).",
      "setup_script": "var u = new GlideRecord('sys_ui_action');\nu.addQuery('action_name', 'eval_t13_action');\nu.query();\nwhile (u.next()) u.deleteRecord();\ngs.print('ready');",
      "verifier_script": "var u = new GlideRecord('sys_ui_action');\nu.addQuery('action_name', 'eval_t13_action');\nu.query();\nif (!u.next()) {\n  gs.print(JSON.stringify({pass: false, expected: 'UI action exists', actual: 'not found'}));\n} else {\n  var tableOk = (u.table + '') === 'incident';\n  var nameOk = (u.name + '') === 'Eval T13 Action';\n  var insOk = (u.show_insert + '') === 'false';\n  var updOk = (u.show_update + '') === 'true';\n  var fbOk = (u.form_button + '') === 'true';\n  var activeOk = (u.active + '') === 'true';\n  var scriptOk = /\\[EVAL-T13\\]/.test(u.script + '');\n  var pass = tableOk && nameOk && insOk && updOk && fbOk && activeOk && scriptOk;\n  gs.print(JSON.stringify({pass: pass, expected: 'all fields correct', actual: 'tbl=' + tableOk + ',name=' + nameOk + ',ins=' + insOk + ',upd=' + updOk + ',fb=' + fbOk + ',act=' + activeOk + ',scr=' + scriptOk}));\n}",
      "cleanup_script": "var u = new GlideRecord('sys_ui_action');\nu.addQuery('action_name', 'eval_t13_action');\nu.query();\nwhile (u.next()) u.deleteRecord();\ngs.print('cleaned');"
    },
    {
      "id": "T14",
      "name": "Create onChange client script",
      "category": "client_script",
      "points": 2,
      "prompt": "Create a client script on the 'incident' table (sys_script_client) with these properties: name='Eval T14 Script', type='onChange', field='priority' (the 'Field name' column, element 'field'), table='incident', active=true, ui_type=10 (Desktop). The script body must contain the marker text '[EVAL-T14]'.",
      "setup_script": "var c = new GlideRecord('sys_script_client');\nc.addQuery('name', 'Eval T14 Script');\nc.query();\nwhile (c.next()) c.deleteRecord();\ngs.print('ready');",
      "verifier_script": "var c = new GlideRecord('sys_script_client');\nc.addQuery('name', 'Eval T14 Script');\nc.query();\nif (!c.next()) {\n  gs.print(JSON.stringify({pass: false, expected: 'client script exists', actual: 'not found'}));\n} else {\n  var typeOk = (c.type + '') === 'onChange';\n  var fieldOk = (c.getValue('field') + '') === 'priority';\n  var tableOk = (c.table + '') === 'incident';\n  var activeOk = (c.active + '') === 'true';\n  var scriptOk = /\\[EVAL-T14\\]/.test(c.script + '');\n  var pass = typeOk && fieldOk && tableOk && activeOk && scriptOk;\n  gs.print(JSON.stringify({pass: pass, expected: 'all fields correct', actual: 'type=' + typeOk + ',field=' + fieldOk + ',tbl=' + tableOk + ',act=' + activeOk + ',scr=' + scriptOk}));\n}",
      "cleanup_script": "var c = new GlideRecord('sys_script_client');\nc.addQuery('name', 'Eval T14 Script');\nc.query();\nwhile (c.next()) c.deleteRecord();\ngs.print('cleaned');"
    },
    {
      "id": "T15",
      "name": "Create email notification",
      "category": "notification",
      "points": 2,
      "prompt": "Create an email notification (sysevent_email_action) with name='Eval T15 Notification' for the 'incident' table (collection='incident'). Subject must contain '[EVAL-T15]'. Body (message_html or message) must contain the text 'Eval T15 body content'. Set active=true.",
      "setup_script": "var n = new GlideRecord('sysevent_email_action');\nn.addQuery('name', 'Eval T15 Notification');\nn.query();\nwhile (n.next()) n.deleteRecord();\ngs.print('ready');",
      "verifier_script": "var n = new GlideRecord('sysevent_email_action');\nn.addQuery('name', 'Eval T15 Notification');\nn.query();\nif (!n.next()) {\n  gs.print(JSON.stringify({pass: false, expected: 'notification exists', actual: 'not found'}));\n} else {\n  var tableOk = (n.collection + '') === 'incident';\n  var subjOk = /\\[EVAL-T15\\]/.test(n.subject + '');\n  var bodyText = (n.message + '') + '\\n' + (n.message_html + '') + '\\n' + (n.message_text + '');\n  var bodyOk = /Eval T15 body content/.test(bodyText);\n  var activeOk = (n.active + '') === 'true';\n  var pass = tableOk && subjOk && bodyOk && activeOk;\n  gs.print(JSON.stringify({pass: pass, expected: 'all fields correct', actual: 'tbl=' + tableOk + ',subj=' + subjOk + ',body=' + bodyOk + ',act=' + activeOk}));\n}",
      "cleanup_script": "var n = new GlideRecord('sysevent_email_action');\nn.addQuery('name', 'Eval T15 Notification');\nn.query();\nwhile (n.next()) n.deleteRecord();\ngs.print('cleaned');"
    },
    {
      "id": "T16",
      "name": "Group incidents by category (GlideAggregate)",
      "category": "aggregate",
      "points": 3,
      "prompt": "Count the incidents whose short_description starts with '[EVAL-T16]', GROUPED BY category. Use GlideAggregate (or any aggregation). The seeded incidents will only have categories hardware, software, and network. Set the system property 'x_eval.task16.result' to a JSON string of the form `{\"hardware\": N1, \"software\": N2, \"network\": N3}` with the exact counts.",
      "setup_script": "var gr = new GlideRecord('incident');\ngr.addQuery('short_description', 'STARTSWITH', '[EVAL-T16]');\ngr.query();\nwhile (gr.next()) gr.deleteRecord();\nvar p = new GlideRecord('sys_properties');\nif (p.get('name', 'x_eval.task16.result')) p.deleteRecord();\nvar cats = ['hardware','hardware','hardware','software','software','network'];\nfor (var i = 0; i < cats.length; i++) {\n  var n = new GlideRecord('incident');\n  n.initialize();\n  n.short_description = '[EVAL-T16] inc ' + (i+1);\n  n.category = cats[i];\n  n.insert();\n}\ngs.print(JSON.stringify({seeded: cats.length}));",
      "verifier_script": "var counts = {hardware:0, software:0, network:0};\nvar gr = new GlideRecord('incident');\ngr.addQuery('short_description', 'STARTSWITH', '[EVAL-T16]');\ngr.query();\nwhile (gr.next()) {\n  var c = gr.category + '';\n  if (counts.hasOwnProperty(c)) counts[c]++;\n}\nvar p = new GlideRecord('sys_properties');\nvar actual = '';\nif (p.get('name', 'x_eval.task16.result')) actual = p.value + '';\nvar parsed = null;\ntry { parsed = JSON.parse(actual); } catch (e) {}\nvar pass = parsed && parsed.hardware === counts.hardware && parsed.software === counts.software && parsed.network === counts.network;\ngs.print(JSON.stringify({pass: !!pass, expected: JSON.stringify(counts), actual: actual}));",
      "cleanup_script": "var gr = new GlideRecord('incident');\ngr.addQuery('short_description', 'STARTSWITH', '[EVAL-T16]');\ngr.query();\nwhile (gr.next()) gr.deleteRecord();\nvar p = new GlideRecord('sys_properties');\nif (p.get('name', 'x_eval.task16.result')) p.deleteRecord();\ngs.print('cleaned');"
    },
    {
      "id": "T17",
      "name": "Add choice list entry",
      "category": "choice",
      "points": 1,
      "prompt": "Add a new choice to the 'category' field on the 'incident' table by inserting a sys_choice record: name='incident', element='category', value='eval_t17_choice', label='[EVAL-T17] Choice'.",
      "setup_script": "var c = new GlideRecord('sys_choice');\nc.addQuery('name', 'incident');\nc.addQuery('element', 'category');\nc.addQuery('value', 'eval_t17_choice');\nc.query();\nwhile (c.next()) c.deleteRecord();\ngs.print('ready');",
      "verifier_script": "var c = new GlideRecord('sys_choice');\nc.addQuery('name', 'incident');\nc.addQuery('element', 'category');\nc.addQuery('value', 'eval_t17_choice');\nc.query();\nif (!c.next()) {\n  gs.print(JSON.stringify({pass: false, expected: 'choice exists', actual: 'not found'}));\n} else {\n  var pass = (c.label + '') === '[EVAL-T17] Choice';\n  gs.print(JSON.stringify({pass: pass, expected: '[EVAL-T17] Choice', actual: c.label + ''}));\n}",
      "cleanup_script": "var c = new GlideRecord('sys_choice');\nc.addQuery('name', 'incident');\nc.addQuery('element', 'category');\nc.addQuery('value', 'eval_t17_choice');\nc.query();\nwhile (c.next()) c.deleteRecord();\ngs.print('cleaned');"
    },
    {
      "id": "T18",
      "name": "Create custom table extending task",
      "category": "table",
      "points": 3,
      "prompt": "Create a new custom table named 'u_eval_t18' that EXTENDS the 'task' table, with label 'Eval T18 Task'. Also add ONE custom string column on it: element name 'u_marker', column label 'Marker', max length 40 (internal_type='string'). This typically requires creating a sys_db_object record + the corresponding sys_dictionary entries (or using TableUtils).",
      "setup_script": "try { var tu = new TableUtils('u_eval_t18'); if (tu.tableExists()) tu.drop(); } catch (e) {}\nvar t = new GlideRecord('sys_db_object');\nif (t.get('name', 'u_eval_t18')) t.deleteRecord();\nvar d = new GlideRecord('sys_dictionary');\nd.addQuery('name', 'u_eval_t18');\nd.query();\nwhile (d.next()) d.deleteRecord();\ngs.print('ready');",
      "verifier_script": "var t = new GlideRecord('sys_db_object');\nif (!t.get('name', 'u_eval_t18')) {\n  gs.print(JSON.stringify({pass: false, expected: 'table u_eval_t18 exists', actual: 'not found'}));\n} else {\n  var superSid = t.super_class + '';\n  var superName = '';\n  var sup = new GlideRecord('sys_db_object');\n  if (superSid && sup.get(superSid)) superName = sup.name + '';\n  var superOk = superName === 'task';\n  var f = new GlideRecord('sys_dictionary');\n  f.addQuery('name', 'u_eval_t18');\n  f.addQuery('element', 'u_marker');\n  f.query();\n  var fieldOk = false, typeOk = false;\n  if (f.next()) { fieldOk = true; typeOk = (f.internal_type + '') === 'string'; }\n  var pass = superOk && fieldOk && typeOk;\n  gs.print(JSON.stringify({pass: pass, expected: 'extends task + u_marker(string)', actual: 'super=' + superName + ',field=' + fieldOk + ',type=' + typeOk}));\n}",
      "cleanup_script": "try { var tu = new TableUtils('u_eval_t18'); if (tu.tableExists()) tu.drop(); } catch (e) {}\nvar t = new GlideRecord('sys_db_object');\nt.addQuery('name', 'u_eval_t18');\nt.query();\nwhile (t.next()) t.deleteRecord();\nvar d = new GlideRecord('sys_dictionary');\nd.addQuery('name', 'u_eval_t18');\nd.query();\nwhile (d.next()) d.deleteRecord();\ngs.print('cleaned');"
    },
    {
      "id": "T19",
      "name": "Create scheduled job (inactive)",
      "category": "scheduled_job",
      "points": 2,
      "prompt": "Create a scheduled job (sysauto_script) with name='[EVAL-T19] Scheduled Job', active=false (do NOT actually schedule it to run), run_type='daily', and a script body containing the marker text 'eval t19 ran'.",
      "setup_script": "var s = new GlideRecord('sysauto_script');\ns.addQuery('name', '[EVAL-T19] Scheduled Job');\ns.query();\nwhile (s.next()) s.deleteRecord();\ngs.print('ready');",
      "verifier_script": "var s = new GlideRecord('sysauto_script');\ns.addQuery('name', '[EVAL-T19] Scheduled Job');\ns.query();\nif (!s.next()) {\n  gs.print(JSON.stringify({pass: false, expected: 'scheduled job exists', actual: 'not found'}));\n} else {\n  var activeOk = (s.active + '') === 'false';\n  var scriptOk = /eval t19 ran/i.test(s.script + '');\n  var pass = activeOk && scriptOk;\n  gs.print(JSON.stringify({pass: pass, expected: 'inactive + marker in script', actual: 'active=' + s.active + ',script_marker=' + scriptOk}));\n}",
      "cleanup_script": "var s = new GlideRecord('sysauto_script');\ns.addQuery('name', '[EVAL-T19] Scheduled Job');\ns.query();\nwhile (s.next()) s.deleteRecord();\ngs.print('cleaned');"
    },
    {
      "id": "T20",
      "name": "Dot-walk: incidents by caller department",
      "category": "dot_walk",
      "points": 2,
      "prompt": "Count the incidents whose caller's department name starts with '[EVAL-T20]'. Use dot-walking in the GlideRecord query — i.e. add a query on 'caller_id.department.name' STARTSWITH '[EVAL-T20]'. Then set the system property 'x_eval.task20.result' to that count as a string. (Hint: the noise incidents with [EVAL-T20] in their short_description have no caller_id and should NOT be counted.)",
      "setup_script": "var oldInc = new GlideRecord('incident');\noldInc.addQuery('short_description', 'STARTSWITH', '[EVAL-T20]');\noldInc.query();\nwhile (oldInc.next()) oldInc.deleteRecord();\nvar oldUser = new GlideRecord('sys_user');\noldUser.addQuery('user_name', 'STARTSWITH', 'eval_t20_user_');\noldUser.query();\nwhile (oldUser.next()) oldUser.deleteRecord();\nvar oldDep = new GlideRecord('cmn_department');\noldDep.addQuery('name', 'STARTSWITH', '[EVAL-T20]');\noldDep.query();\nwhile (oldDep.next()) oldDep.deleteRecord();\nvar p = new GlideRecord('sys_properties');\nif (p.get('name', 'x_eval.task20.result')) p.deleteRecord();\nvar dep = new GlideRecord('cmn_department');\ndep.initialize();\ndep.name = '[EVAL-T20] Department';\nvar depSid = dep.insert();\nvar userIds = [];\nfor (var i = 1; i <= 3; i++) {\n  var u = new GlideRecord('sys_user');\n  u.initialize();\n  u.user_name = 'eval_t20_user_' + i;\n  u.first_name = 'Eval';\n  u.last_name = 'T20 User ' + i;\n  u.department = depSid;\n  userIds.push(u.insert());\n}\nfor (var j = 0; j < 3; j++) {\n  var inc = new GlideRecord('incident');\n  inc.initialize();\n  inc.short_description = '[EVAL-T20] Real incident ' + (j+1);\n  inc.caller_id = userIds[j];\n  inc.insert();\n}\nfor (var k = 0; k < 2; k++) {\n  var noise = new GlideRecord('incident');\n  noise.initialize();\n  noise.short_description = '[EVAL-T20] Noise incident (no caller) ' + k;\n  noise.insert();\n}\ngs.print(JSON.stringify({seeded: true}));",
      "verifier_script": "var gr = new GlideRecord('incident');\ngr.addQuery('caller_id.department.name', 'STARTSWITH', '[EVAL-T20]');\ngr.query();\nvar count = 0;\nwhile (gr.next()) count++;\nvar p = new GlideRecord('sys_properties');\nvar reported = '';\nif (p.get('name', 'x_eval.task20.result')) reported = p.value + '';\nvar pass = reported === count + '';\ngs.print(JSON.stringify({pass: pass, expected: count + '', actual: reported}));",
      "cleanup_script": "var inc = new GlideRecord('incident');\ninc.addQuery('short_description', 'STARTSWITH', '[EVAL-T20]');\ninc.query();\nwhile (inc.next()) inc.deleteRecord();\nvar u = new GlideRecord('sys_user');\nu.addQuery('user_name', 'STARTSWITH', 'eval_t20_user_');\nu.query();\nwhile (u.next()) u.deleteRecord();\nvar dep = new GlideRecord('cmn_department');\ndep.addQuery('name', 'STARTSWITH', '[EVAL-T20]');\ndep.query();\nwhile (dep.next()) dep.deleteRecord();\nvar p = new GlideRecord('sys_properties');\nif (p.get('name', 'x_eval.task20.result')) p.deleteRecord();\ngs.print('cleaned');"
    }
  ]
}
```
