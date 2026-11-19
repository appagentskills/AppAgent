// Regression: agents created shared "handoff"/"handover" Smart Documents the
// user never asked for. The prompts that drove it (sub-agent reporting rule,
// context notices, saturation hard stop, WORKER SATURATION rule) must keep the
// handover inside report_to_parent / spawn instructions instead.

describe('no unsolicited handoff documents', function() {
    test('sub-agent reporting rule no longer steers subs to shared docs', async function() {
        var src = await loadFile('src/js/core/097-sub-agent-registry.js');
        assert.ok(src.indexOf('`shared` scope lets the parent read it') === -1, 'old shared-doc staging hint is gone');
        assert.ok(/never write a handoff\/handover document/.test(src), 'sub prompt forbids handoff docs');
        assert.ok(/stage it in a `chat`-scoped smart doc/.test(src), 'staging uses chat scope');
    }, { tags: ['unit'] });

    test('saturation hard stop no longer asks for a shared handover doc', async function() {
        var src = await loadFile('src/js/app/030-agent-loop.js');
        assert.ok(src.indexOf('Write a short handover doc') === -1, 'hard-stop doc instruction removed');
        assert.ok(src.indexOf('document create, shared scope') === -1, 'no shared-scope create instruction');
        assert.ok(/do not create a handoff\/handover document/.test(src), 'notices keep the handover in the report');
        assert.ok(src.indexOf('recommending a handoff to a fresh sub-agent') === -1, 'no ambiguous "handoff" wording in the context-full notice');
        assert.ok(src.indexOf('recommending the parent continue with a fresh sub-agent') !== -1, 'context-full notice says the parent continues');
        assert.ok(src.indexOf('recommending the parent continue any remaining work with a fresh sub-agent') !== -1, '50% notice says the parent continues');
    }, { tags: ['unit'] });

    test('orchestrator and document tool keep handovers out of documents', async function() {
        var sp = await loadFile('src/js/core/110-system-prompt.js');
        assert.ok(/passed in its spawn `instructions`/.test(sp), 'WORKER SATURATION seeds via spawn instructions');
        var tools = await loadFile('src/js/core/080-tools.js');
        assert.ok(/never on your own for handoffs\/handovers/.test(tools), 'document tool description discourages unsolicited docs');
    }, { tags: ['unit'] });

    test('chat-scoped document create fails closed instead of falling back to shared', async function() {
        var src = await loadFile('src/js/tools/110-smart-documents.js');
        assert.ok(src.indexOf("if (scope === 'chat' && !ownerChatId) scope = 'shared';") === -1, 'silent shared fallback removed');
        assert.ok(/if \(scope === 'chat' && !ownerChatId\) \{\s*return \{ success: false, code: 'CHAT_UNRESOLVED'/.test(src), 'unresolved chat scope returns CHAT_UNRESOLVED');
    }, { tags: ['unit'] });
});
