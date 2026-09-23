// SUB-NOTICE-META (B part 2c) review fixes, all behavioural on the REAL
// app/020 (+ ui/175 where the page bundle has it) via loadModules:
//  1  a need_input report meta (kind:'mid') renders the legacy final card;
//  2  the cache gate answers the same WITHOUT ui/175 — the worker bundle,
//     where buildAPIMessages runs — as with it;
//  3  parent->sub inbox drains over 16 KB keep today's caching;
//  4  the user's own remainder (typed text / attachment label) decides;
//  6  substring pre-checks + the legacy shape gate.
// Run: run_tests { files: ['test/sub-notice-review-fixes.test.js'] }
'use strict';
var _q = { log: function() {}, warn: function() {}, error: function() {}, info: function() {}, debug: function() {} };
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
var TAIL = '\n\u2014 full report via await_handle("h1") or agent_status.';
function report(name, id, status, summary) { return 'Sub-agent "' + name + '" (' + id + ') reported (' + status + '):\n' + summary + TAIL; }
var FINAL = report('Alpha', 'sub_a', 'done', 'All good');
var NEED = report('Alpha', 'sub_a', 'need_input', 'Which **env**?');
var LIFE = '[sub-agent lifecycle] Beta (sub_b): STUCK \u2014 no progress';
var DRAIN = '[1 message(s) from parent / inbox]\n1. Please also check the logs';
var PROSE = 'Why did Sub-agent "Alpha" go quiet? I called await_handle(h1) twice.';
var LIFE_PROSE = 'see the [sub-agent lifecycle] notes';
var BIG = 'x'.repeat(20000);
function meta(kind, text, extra) {
    return Object.assign({ kind: kind, agentId: 'sub_a', name: 'Alpha', status: 'done', summary: 'All good', text: text }, extra || {});
}
function drainMeta(text) { return { kind: 'message', agentId: 'sub_a', name: 'parent', status: 'running', summary: text, text: text }; }
async function load(withUi, extra) {
    var g = { self: {}, window: fakeWindow(), console: _q, escapeHtml: esc, chats: {},
        formatContent: function(s) { return '<md>' + esc(s) + '</md>'; }, getCacheCharLimit: function() { return 16000; } };
    Object.keys(extra || {}).forEach(function(k) { g[k] = extra[k]; });
    var files = (withUi ? ['src/js/ui/175-sub-agent-ui.js'] : []).concat(['src/js/app/020-api-messages.js']);
    return loadModules(files, { lenient: true, globals: g });
}
async function build(withUi, rows) {
    var chats = { c1: { messages: rows, cachedToolResults: {} } };
    var m = await load(withUi, { chats: chats, saveChatsToStorage: function() {},
        processUserMessageForCache: function(id, c) { return c.length > 16000 ? { contentId: 'new_id', apiContent: 'STUB' } : null; } });
    return m.buildAPIMessages(rows, 'c1');
}
function cards(html) {
    var d = new DOMParser().parseFromString('<div>' + (html || '') + '</div>', 'text/html');
    return Array.prototype.map.call(d.querySelectorAll('.sub-notice'), function(c) {
        var b = c.querySelector('.sub-notice-badge');
        return { cls: c.className, badge: b ? b.textContent.trim() : null };
    });
}
function rows() {
    return {
        legacyFinal: { role: 'user', injected: true, content: FINAL },
        legacyNeedInput: { role: 'user', injected: true, content: NEED },
        lifecycle: { role: 'user', injected: true, content: LIFE },
        finalPlusLifecycle: { role: 'user', injected: true, content: FINAL + '\n\n' + LIFE },
        typed: { role: 'user', injected: true, hasUserText: true, content: 'please retry\n\n' + FINAL },
        drain: { role: 'user', injected: true, content: DRAIN },
        drainPlusFinal: { role: 'user', injected: true, content: DRAIN + '\n\n' + FINAL },
        prose: { role: 'user', injected: true, content: PROSE },
        lifecycleProse: { role: 'user', injected: true, content: LIFE_PROSE },
        metaFinal: { role: 'user', injected: true, content: 'hi\n\n' + FINAL, subNotices: [meta('final', FINAL)] },
        metaDrain: { role: 'user', injected: true, content: DRAIN, subNotices: [drainMeta(DRAIN)] },
        metaDrifted: { role: 'user', injected: true, content: FINAL, subNotices: [meta('final', FINAL + ' (edited)')] },
        notInjected: { role: 'user', content: FINAL }
    };
}

describe('Fix 1 - need_input report meta renders the legacy final card (175)', function() {
    test("kind:'mid' + need_input === the legacy need_input card (same badge and label)", async function() {
        var u = await load(true);
        var legacy = u.renderSubReportNotices(NEED, [], []);
        var fromMeta = u.renderSubReportNotices(NEED, [], [], [meta('mid', NEED, { status: 'need_input', summary: 'Which **env**?' })]);
        assert.strictEqual(fromMeta, legacy);
        var got = cards(fromMeta);
        assert.strictEqual(got.length, 1);
        assert.deepStrictEqual(got, cards(legacy));
        assert.match(got[0].badge, /needs input/i);
        var progress = cards(u._subNoticeCardHtml('Alpha', 'sub_a', 'need_input', 'Which **env**?', 'mid'));
        assert.notStrictEqual(JSON.stringify(got), JSON.stringify(progress), 'not the muted progress card');
    });
    test("a kind:'mid' update that is not need_input stays a progress card", async function() {
        var u = await load(true);
        var html = u.renderSubReportNotices(NEED, [], [], [meta('mid', NEED, { status: 'running', summary: 'Which **env**?' })]);
        assert.strictEqual(html, u._subNoticeCardHtml('Alpha', 'sub_a', 'running', 'Which **env**?', 'mid'));
    });
}, { tags: ['unit'], timeout: 5000 });

describe('Fix 2 - the cache gate without ui/175 (worker bundle)', function() {
    test('020 alone: legacy final + lifecycle rows are notices; typed rows and inbox drains are not', async function() {
        var w = await load(false);
        assert.strictEqual(typeof w.renderSubReportNotices, 'undefined', 'ui/175 is not loaded');
        var r = rows();
        assert.strictEqual(w._isInjectedSubNoticeRow(r.legacyFinal), true);
        assert.strictEqual(w._isInjectedSubNoticeRow(r.legacyNeedInput), true);
        assert.strictEqual(w._isInjectedSubNoticeRow(r.lifecycle), true);
        assert.strictEqual(w._isInjectedSubNoticeRow(r.typed), false);
        assert.strictEqual(w._isInjectedSubNoticeRow(r.drain), false);
        assert.strictEqual(w._isInjectedSubNoticeRow(r.prose), false, 'notice substrings in prose are not a notice');
        assert.strictEqual(w._isInjectedSubNoticeRow(r.lifecycleProse), false);
    });
    test('every row gets the same answer with and without ui/175', async function() {
        var w = await load(false), p = await load(true);
        var r = rows();
        var names = Object.keys(r);
        var worker = names.map(function(n) { return n + ':' + w._isInjectedSubNoticeRow(r[n]); });
        var page = names.map(function(n) { return n + ':' + p._isInjectedSubNoticeRow(r[n]); });
        assert.deepStrictEqual(worker, page);
        assert.deepStrictEqual(worker, ['legacyFinal:true', 'legacyNeedInput:true', 'lifecycle:true', 'finalPlusLifecycle:true', 'typed:false',
            'drain:false', 'drainPlusFinal:false', 'prose:false', 'lifecycleProse:false', 'metaFinal:true', 'metaDrain:false',
            'metaDrifted:true', 'notInjected:false']);
    });
}, { tags: ['unit'], timeout: 5000 });

describe('Fix 3 - inbox drains over 16 KB keep today\u2019s caching', function() {
    test('meta and legacy parent->sub drains over 16 KB are cached (both bundles)', async function() {
        var D = '[1 message(s) from parent / inbox]\n1. ' + BIG;
        for (var withUi of [false, true]) {
            var metaDrain = { role: 'user', injected: true, content: D, subNotices: [drainMeta(D)] };
            var legacyDrain = { role: 'user', injected: true, content: D };
            var out = await build(withUi, [metaDrain, { role: 'assistant', content: 'ok' }, legacyDrain]);
            assert.strictEqual(out[0].content, 'STUB', 'meta drain cached, withUi=' + withUi);
            assert.strictEqual(out[2].content, 'STUB', 'legacy drain cached, withUi=' + withUi);
            assert.strictEqual(metaDrain.cachedContentId, 'new_id');
            assert.strictEqual(legacyDrain.cachedContentId, 'new_id');
        }
    });
}, { tags: ['unit'], timeout: 5000 });

describe('Fix 4 - the user remainder decides', function() {
    test('attachment label + a notice over 16 KB is not cached; typed text over 16 KB is', async function() {
        var NOTICE = report('Alpha', 'sub_a', 'done', BIG);
        var LABEL = '[Attached: screenshot.png]';
        for (var withUi of [false, true]) {
            var att = { role: 'user', injected: true, hasUserText: true, content: LABEL + '\n\n' + NOTICE,
                subNotices: [meta('final', NOTICE, { summary: BIG })] };
            var typed = { role: 'user', injected: true, hasUserText: true, content: BIG + '\n\n' + FINAL, subNotices: [meta('final', FINAL)] };
            var out = await build(withUi, [att, { role: 'assistant', content: 'ok' }, typed]);
            assert.deepStrictEqual(out[0], { role: 'user', content: LABEL + '\n\n' + NOTICE }, 'notice reaches the model in full');
            assert.strictEqual(att.cachedContentId, undefined);
            assert.strictEqual(out[2].content, 'STUB', 'typed text over the limit is cached');
            assert.strictEqual(typed.cachedContentId, 'new_id');
        }
    });
    test('the same notice removed twice only once per meta; a small remainder is not cached', async function() {
        var w = await load(false);
        var two = { role: 'user', injected: true, content: FINAL + '\n\n' + FINAL, subNotices: [meta('final', FINAL)] };
        assert.strictEqual(w._isInjectedSubNoticeRow(two), true, 'remainder is one small notice');
        var bigLeft = { role: 'user', injected: true, content: FINAL + '\n\n' + BIG, subNotices: [meta('final', FINAL)] };
        assert.strictEqual(w._isInjectedSubNoticeRow(bigLeft), false, 'remainder over the limit keeps caching');
    });
}, { tags: ['unit'], timeout: 5000 });

describe('Fix 6 - pre-checks and the legacy shape gate (020)', function() {
    test('pre-checks: one flag per notice family, all false for plain text', async function() {
        var w = await load(false);
        assert.deepStrictEqual(w._subNoticePrechecks('just typing'), { final: false, life: false, inbox: false });
        assert.deepStrictEqual(w._subNoticePrechecks(FINAL), { final: true, life: false, inbox: false });
        assert.deepStrictEqual(w._subNoticePrechecks(LIFE), { final: false, life: true, inbox: false });
        assert.deepStrictEqual(w._subNoticePrechecks(DRAIN), { final: false, life: false, inbox: true });
        assert.deepStrictEqual(w._subNoticePrechecks('Sub-agent "A" said hi'), { final: false, life: false, inbox: false }, 'final needs both substrings');
    });
    test('shape gate: report / lifecycle shapes only; drains and look-alikes are not', async function() {
        var w = await load(false);
        [FINAL, NEED, LIFE, 'pre\n\n' + FINAL, report('Al (x)', 'sub_q', 'error', 'boom')].forEach(function(t) {
            assert.strictEqual(w._hasLegacySubNoticeShape(t), true, t);
            assert.strictEqual(w._hasLegacySubNoticeShape(t), true, 'stateless on a repeat call: ' + t);
        });
        [PROSE, LIFE_PROSE, DRAIN, report('Q"x', 'sub_q', 'done', 'y'), 'plain', '', null, 42].forEach(function(t) {
            assert.strictEqual(w._hasLegacySubNoticeShape(t), false, String(t));
        });
    });
    test('the gate agrees with 175 render (a card or not) for every non-drain text', async function() {
        var p = await load(true);
        [FINAL, NEED, LIFE, FINAL + '\n\n' + LIFE, PROSE, LIFE_PROSE, 'plain', report('Q"x', 'sub_q', 'done', 'y'),
            report('Al (x)', 'sub_q', 'error', 'boom')].forEach(function(t) {
            var rendered = cards(p.renderSubReportNotices(t, [], [])).length > 0;
            assert.strictEqual(p._hasLegacySubNoticeShape(t), rendered, t);
        });
    });
}, { tags: ['unit'], timeout: 5000 });
