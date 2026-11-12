// Prompt rule: visual results (images, before/after, galleries) go in an
// html_widget (split pane), and sub-agents patch the parent's widget.
var T = { tags: ['unit'], timeout: 5000 };
var quiet = { log: function() {}, warn: function() {}, error: function() {}, info: function() {} };

describe('Visual results prompt rule', function() {
    test('OUTPUT section carries the visual-results widget rule; BRIEFS passes widget_id', async function() {
        var m = await loadModules(['src/js/core/110-system-prompt.js'], { lenient: true, globals: {
            window: fakeWindow(), chrome: fakeChrome(), console: quiet,
            getSetting: function() { return Promise.resolve(null); }, setSetting: function() { return Promise.resolve(); },
            getDisabledTools: function() { return []; }, TOOL_DISPLAY_NAMES: {}, getSkillsSummaryForPrompt: function() { return ''; },
            chats: {}
        }});
        var tpl = m.DEFAULT_SYSTEM_PROMPT_TEMPLATE;
        var out = tpl.indexOf('OUTPUT:'), next = tpl.indexOf('VERIFY YOUR WORK:');
        assert.ok(out !== -1 && next > out);
        var section = tpl.slice(out, next);
        assert.match(section, /- Visual results \(generated or edited images, before\/after, galleries, renders\) go in an html_widget, which opens in the split pane/);
        assert.match(section, /never only as file paths or links/);
        assert.match(section, /patch it as each result arrives/);
        var briefs = m.ORCHESTRATOR_POLICY_LINES.filter(function(l) { return l.indexOf('BRIEFS:') === 0; })[0];
        assert.match(briefs, /For visual deliverables, pass your widget_id so the worker patches it\./);
    }, T);

    test('sub-agent preamble tells workers to patch the parent widget', async function() {
        var src = await loadFile('src/js/core/097-sub-agent-registry.js');
        var start = src.indexOf('var SUB_AGENT_PREAMBLE = [');
        var end = src.indexOf("].join('\\n');", start);
        assert.ok(start !== -1 && end > start);
        var block = src.slice(start, end);
        assert.match(block, /- Visual results: if your task names the parent\\'s widget \(widget_id\), patch that widget \(html_widget action=patch\)/);
    }, T);
});
