// H20 — tools of a DEACTIVATED skill must not stay callable/visible.
//  * loadActiveSkills drops tools of skills no longer in activeSkills
//  * isSkillTool / isVisibleSkillTool / executeSkillTool check activeSkills
//  * activate / deactivate push the SW 'skills-refresh' (pushSkillToolsRefreshToOffscreen)
//  * end-to-end: page deactivates -> SW realm re-runs loadActiveSkills -> the
//    SW tool list sent to the LLM (getActiveSkillTools) drops the tools.
describe('H20 inactive skill tools (core/140-skills-engine.js)', function() {
    function toolFile(name) {
        return 'var TOOL_DEFINITION = {\n' +
            '  "type": "function",\n' +
            '  "function": { "name": "' + name + '", "description": "d", "parameters": { "type": "object", "properties": {} } }\n' +
            '};\n' +
            'async function ' + name + '(args) { return { ok: true }; }\n';
    }
    function entry(name) { return { name: name, code: 'async function ' + name + '(){}', definition: { type: 'function', function: { name: name } } }; }

    // One module instance == one realm (page or SW). `idb` is shared between
    // realms like the real settings store.
    async function realm(idb, extra) {
        var calls = { push: [], helper: [], setSetting: [] };
        var g = Object.assign({
            window: fakeWindow(), chrome: fakeChrome(),
            activeSkills: {},
            skills: { a: { id: 'a' }, b: { id: 'b' } },
            getSetting: async function(k, d) { return Object.prototype.hasOwnProperty.call(idb, k) ? JSON.parse(JSON.stringify(idb[k])) : d; },
            setSetting: async function(k, v) { calls.setSetting.push(k); idb[k] = JSON.parse(JSON.stringify(v)); },
            // The module's own getSkillAssets reads the skill_assets store via
            // openDatabase(); fake that store with one tool file per skill.
            skillAssetsStoreName: 'skill_assets',
            openDatabase: async function() {
                return { transaction: function() { return { objectStore: function() { return {
                    getAll: function() {
                        var req = { result: ['a', 'b'].map(function(id) { return { skillId: id, filename: 't_' + id + '.js', type: 'js', content: toolFile('t_' + id) }; }) };
                        Promise.resolve().then(function() { if (req.onsuccess) req.onsuccess(); });
                        return req;
                    }
                }; } }; } };
            },
            renderSkillsList: function() {},
            saveSkill: async function() {},
            pushSkillToolsRefreshToOffscreen: function() { calls.push.push(JSON.parse(JSON.stringify(idb.activeSkills || null))); },
            Platform: { isWorker: true, callOffscreenHelper: async function() { calls.helper.push(arguments); return { success: true, ran: true }; } }
        }, extra || {});
        var m = await loadModules(['src/js/core/140-skills-engine.js'], { lenient: true, globals: g });
        m.__scope.Platform = g.Platform;
        return { m: m, s: m.__scope, calls: calls };
    }
    function names(defs) { return defs.map(function(d) { return d.function.name; }).sort(); }

    test('loadActiveSkills unloads tools of skills that are no longer active', async function() {
        var idb = { activeSkills: { a: {} } };
        var r = await realm(idb);
        r.m.skillTools.b = { t_b: entry('t_b') }; // stale: b was active at an earlier load
        await r.m.loadActiveSkills();
        assert.strictEqual(r.m.skillTools.b, undefined, 'stale skill b must be unloaded');
        assert.ok(r.m.skillTools.a && r.m.skillTools.a.t_a, 'active skill a is loaded');
        assert.strictEqual(r.m.isSkillTool('t_b'), false);
        assert.strictEqual(r.m.isSkillTool('t_a'), true);
    }, { tags: ['unit'] });

    test('isSkillTool / isVisibleSkillTool are false for a registered tool of an inactive skill', async function() {
        var r = await realm({});
        r.m.skillTools.b = { t_b: entry('t_b') };
        r.s.activeSkills = {};
        assert.strictEqual(r.m.isSkillTool('t_b'), false);
        assert.strictEqual(r.m.isVisibleSkillTool('t_b'), false);
        r.s.activeSkills = { b: {} };
        assert.strictEqual(r.m.isSkillTool('t_b'), true);
        assert.strictEqual(r.m.isVisibleSkillTool('t_b'), true);
        assert.strictEqual(r.m.isSkillTool('nope'), false);
    }, { tags: ['unit'] });

    test('executeSkillTool refuses an inactive skill tool with a clear error and never runs it', async function() {
        var r = await realm({});
        r.m.skillTools.b = { t_b: entry('t_b') };
        r.s.activeSkills = {};
        var res = await r.m.executeSkillTool('t_b', {}, { chatId: 'c1' }, 0);
        assert.strictEqual(res.success, false);
        assert.match(res.error, /not active/);
        assert.match(res.error, /"b"/);
        assert.strictEqual(r.calls.helper.length, 0, 'sandbox helper must not be called');
        var nf = await r.m.executeSkillTool('ghost', {}, { chatId: 'c1' }, 0);
        assert.match(nf.error, /Skill tool not found: ghost/);
        r.s.activeSkills = { b: {} };
        var ok = await r.m.executeSkillTool('t_b', {}, { chatId: 'c1' }, 0);
        assert.strictEqual(ok.ran, true, 'active skill tool still executes');
        assert.strictEqual(r.calls.helper.length, 1);
    }, { tags: ['unit'] });

    // H20 gate: executeTool's dispatcher (tools/020-tool-execution.js) must route a
    // tool of an INACTIVE skill to executeSkillTool so the model gets the clear
    // "not active" error, not the generic "Unknown tool". Uses the REAL dispatch line.
    test('executeTool dispatch gate routes an inactive skill tool to executeSkillTool (clear "not active" error)', async function() {
        var exec = await loadFile('src/js/tools/020-tool-execution.js');
        var line = exec.split('\n').filter(function(l) { return /^\s*\} else if \(isSkillTool\(name\)/.test(l); });
        assert.strictEqual(line.length, 1, 'exactly one skill-tool dispatch arm');
        assert.strictEqual(line[0].trim(), "} else if (isSkillTool(name) || (typeof getInactiveSkillToolOwner === 'function' && getInactiveSkillToolOwner(name))) {");
        var r = await realm({});
        r.m.skillTools.b = { t_b: entry('t_b') };
        r.s.activeSkills = {};
        var route = new Function('isSkillTool', 'getInactiveSkillToolOwner', 'executeSkillTool',
            'return async function(name) { if (false) { ' + line[0].trim() +
            ' return await executeSkillTool(name, {}, { chatId: "c1" }, 0); } return { success: false, error: "Unknown tool \\"" + name + "\\"" }; };')(
            r.m.isSkillTool, r.m.getInactiveSkillToolOwner, r.m.executeSkillTool);
        var inactive = await route('t_b');
        assert.strictEqual(inactive.success, false);
        assert.match(inactive.error, /not active/, 'clear skill-not-active error, not Unknown tool');
        assert.strictEqual(r.calls.helper.length, 0, 'inactive tool never runs');
        assert.match((await route('ghost')).error, /Unknown tool "ghost"/, 'unregistered names still fall through to Unknown tool');
        r.s.activeSkills = { b: {} };
        assert.strictEqual((await route('t_b')).ran, true, 'active skill tool still dispatches');
    }, { tags: ['unit'] });

    test('activateSkill / deactivateSkill push the SW refresh AFTER persisting activeSkills', async function() {
        var idb = { activeSkills: {} };
        var r = await realm(idb);
        var act = await r.m.activateSkill('a');
        assert.strictEqual(act.success, true, JSON.stringify(act));
        assert.strictEqual(r.calls.push.length, 1, 'activate pushes one refresh');
        assert.ok(r.calls.push[0] && r.calls.push[0].a, 'IDB already holds the activation when the push fires');
        var de = await r.m.deactivateSkill('a');
        assert.strictEqual(de.success, true, JSON.stringify(de));
        assert.strictEqual(r.calls.push.length, 2, 'deactivate pushes one refresh');
        assert.strictEqual(r.calls.push[1].a, undefined, 'IDB already dropped the skill when the push fires');
        // Failed activation (unknown skill) changes nothing and pushes nothing.
        var bad = await r.m.activateSkill('zzz');
        assert.strictEqual(bad.success, false);
        assert.strictEqual(r.calls.push.length, 2);
    }, { tags: ['unit'] });

    test('end-to-end: page deactivates -> SW refresh -> SW LLM tool list and dispatcher drop the tools', async function() {
        var idb = { activeSkills: { a: {}, b: {} } };
        var sw = await realm(idb);
        await sw.m.loadActiveSkills(); // SW boot
        assert.deepStrictEqual(names(sw.m.getActiveSkillTools()), ['t_a', 't_b']);
        // Page realm: its push handler delivers 'skills-refresh' to the SW,
        // whose handler (worker/130-port-bridge.js) runs loadActiveSkills().
        var pending = [];
        var page = await realm(idb, { pushSkillToolsRefreshToOffscreen: function() { pending.push(sw.m.loadActiveSkills()); } });
        await page.m.loadActiveSkills();
        var de = await page.m.deactivateSkill('b');
        assert.strictEqual(de.success, true);
        assert.strictEqual(pending.length, 1, 'deactivate reached the SW');
        await Promise.all(pending);
        assert.deepStrictEqual(names(sw.m.getActiveSkillTools()), ['t_a'], 'SW tool list sent to the LLM drops t_b');
        assert.strictEqual(sw.m.isSkillTool('t_b'), false, 'SW dispatcher no longer routes t_b');
        assert.strictEqual(sw.m.skillTools.b, undefined);
        assert.deepStrictEqual(names(page.m.getActiveSkillTools()), ['t_a'], 'page tool list drops t_b');
        // Re-activation flows back the same way.
        var act = await page.m.activateSkill('b');
        assert.strictEqual(act.success, true);
        await Promise.all(pending);
        assert.deepStrictEqual(names(sw.m.getActiveSkillTools()), ['t_a', 't_b']);
        assert.strictEqual(sw.m.isSkillTool('t_b'), true);
    }, { tags: ['unit'] });
});
