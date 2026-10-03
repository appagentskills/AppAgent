// PREFIX-STABILITY: every request is rebuilt from stored chat rows, and the
// Anthropic thinking signatures + prompt cache bind to the exact bytes before
// them. These tests pin the request-time parts that used to drift:
//   - the update-ledger block (app/020 buildAPIMessages, row.ledgerBlock)
//   - the pasted-long-message reference (app/020, row.sentApiContent)
//   - the system prompt date + ACTIVE SKILLS order (core/110)
//   - the per-part fingerprint diagnostics (app/010)
//   - stamps surviving a page->SW chat adopt (worker/130 _swCarryPrefixStamps)
var T = { tags: ['unit'], timeout: 5000 };
var HEADER = "Updates since the user's last message:";
var quiet = { log: function() {}, warn: function() {}, error: function() {}, info: function() {} };
function snap(x) { return JSON.stringify(x); }

describe('prefix stability: update-ledger block is frozen on its anchor row', function() {
    var m, chats, saves;
    beforeEach(async function() {
        chats = { root: { id: 'root', messages: [] } }; saves = 0;
        m = await loadModules(['src/js/app/020-api-messages.js', 'src/js/core/095-handle-registry.js', 'src/js/core/097-sub-agent-registry.js'], { lenient: true, globals: {
            self: {}, window: fakeWindow(), chrome: fakeChrome(), Platform: { isWorker: true },
            chats: chats, pausedChats: {}, runningChatIds: {}, pendingInjectionsByChatId: {},
            isChatPaused: function() { return false; }, runAgent: function() { return Promise.resolve(); },
            saveChatsToStorage: function() { saves++; return Promise.resolve(); }, openDatabase: function() { return new Promise(function() {}); },
            console: quiet
        }});
    });
    function report(id, name, summary) {
        var text = m._withWakeFinalReminder('Sub-agent "' + name + '" (' + id + ') reported (done):\n' + summary
            + '\n\u2014 full report via await_handle("h_' + id + '") or agent_status.');
        return m._noticeRow(text, [m._subNoticeMeta('final', id, name, 'done', summary, text)]);
    }
    function rows() {
        return [
            { role: 'user', content: 'audit X' },
            { role: 'assistant', content: 'dispatched Alpha and Beta' },
            report('sub_a', 'Alpha', 'Alpha found 3 bugs'),
            { role: 'assistant', content: 'noted Alpha' },
            report('sub_b', 'Beta', 'Beta found nothing')
        ];
    }

    test('anchor moves to a real user row: the old anchor keeps exactly the same bytes', function() {
        var r = rows(); chats.root.messages = r;
        var req1 = m.buildAPIMessages(r, 'root');
        var anchor = r[4];
        assert.ok(typeof anchor.ledgerBlock === 'string' && anchor.ledgerBlock.indexOf(HEADER) === 0, 'block frozen on the stored anchor row');
        assert.strictEqual(saves, 1, 'exactly one stamp save through saveChatsToStorage');
        assert.strictEqual(req1[4].content, anchor.content + '\n\n' + anchor.ledgerBlock, 'sent content = row content + frozen block');
        assert.strictEqual(snap(m.buildAPIMessages(r, 'root')), snap(req1), 'rebuild is byte-identical');
        assert.strictEqual(saves, 1, 'rebuild with the stamp already present does not save again');
        r.push({ role: 'assistant', content: 'digest' }, { role: 'user', content: 'thanks, now fix them' });
        assert.strictEqual(m._buildUpdateLedger(r), null, 'real user anchor computes no new ledger');
        var req2 = m.buildAPIMessages(r, 'root');
        assert.strictEqual(snap(req2.slice(0, req1.length)), snap(req1), 'request prefix byte-identical after the anchor moved');
        assert.strictEqual(req2[req2.length - 1].content, 'thanks, now fix them', 'new user row untouched');
        assert.strictEqual(saves, 1, 'no ledger computed after the move -> no extra save');
    }, T);

    test('current anchor already carrying a ledgerBlock sends that exact block (no recompute, no save)', function() {
        var r = rows(); chats.root.messages = r;
        var ledger = m._buildUpdateLedger(r);
        assert.strictEqual(ledger.anchorIdx, 4, 'row 4 IS the current anchor with a live ledger');
        assert.notStrictEqual(ledger.block, 'SENTINEL-BLOCK');
        r[4].ledgerBlock = 'SENTINEL-BLOCK';
        var req = m.buildAPIMessages(r, 'root');
        assert.strictEqual(req[4].content, r[4].content + '\n\n' + 'SENTINEL-BLOCK', 'stored block wins over the freshly computed one');
        assert.strictEqual(r[4].ledgerBlock, 'SENTINEL-BLOCK', 'stored block never overwritten');
        assert.strictEqual(saves, 0, 'nothing to stamp -> no save');
    }, T);

    test('anchor moves to a newer wake row: old block replayed verbatim, new block only on the new anchor', function() {
        var r = rows(); chats.root.messages = r;
        var req1 = m.buildAPIMessages(r, 'root');
        var frozen = r[4].ledgerBlock;
        r.push({ role: 'assistant', content: 'noted Beta' }, report('sub_c', 'Gamma', 'Gamma done'));
        var req2 = m.buildAPIMessages(r, 'root');
        assert.strictEqual(snap(req2.slice(0, req1.length)), snap(req1), 'every earlier message unchanged');
        assert.strictEqual(r[4].ledgerBlock, frozen, 'old anchor block never recomputed');
        var newRow = r[r.length - 1];
        assert.ok(typeof newRow.ledgerBlock === 'string' && newRow.ledgerBlock.indexOf(HEADER) === 0, 'new anchor frozen too');
        // Recompute-proof: even if the window would now list other items, the stored string wins.
        r[4].ledgerBlock = HEADER + '\n- frozen';
        assert.strictEqual(m.buildAPIMessages(r, 'root')[4].content, r[4].content + '\n\n' + HEADER + '\n- frozen');
    }, T);
});

describe('prefix stability: pasted long message replays the first-sent string', function() {
    var m, chats;
    beforeEach(async function() {
        chats = { root: { id: 'root', messages: [] } };
        m = await loadModules(['src/js/app/020-api-messages.js', 'src/js/core/100-cached-results.js'], { lenient: true, globals: {
            self: {}, window: fakeWindow(), chrome: fakeChrome(), Platform: { isWorker: true },
            chats: chats, saveChatsToStorage: function() { return Promise.resolve(); }, console: quiet
        }});
    });

    test('second build == first send, even when the cache entry is gone (no new id)', function() {
        var lim = Number(m.getCacheCharLimit()) || 16000;
        var big = new Array(Math.ceil(lim / 20) + 50).join('pasted line of text\n');
        var r = [{ role: 'user', content: big }]; chats.root.messages = r;
        var first = m.buildAPIMessages(r, 'root')[0].content;
        assert.ok(first.indexOf('[User pasted a long message') === 0, 'first send is the cached reference');
        assert.strictEqual(r[0].sentApiContent, first, 'exact first-sent string stored on the row');
        var id = r[0].cachedContentId;
        assert.strictEqual(m.buildAPIMessages(r, 'root')[0].content, first, 'replay with cache entry present');
        delete chats.root.cachedToolResults[id];
        assert.strictEqual(m.buildAPIMessages(r, 'root')[0].content, first, 'replay with cache entry missing');
        assert.strictEqual(r[0].cachedContentId, id, 'no new content id minted');
        assert.strictEqual(Object.keys(chats.root.cachedToolResults).length, 0, 'no new cache entry');
    }, T);

    test('legacy row (cachedContentId + live cache entry, no sentApiContent) is frozen on first build', function() {
        var lim = Number(m.getCacheCharLimit()) || 16000;
        var big = new Array(Math.ceil(lim / 20) + 50).join('pasted line of text\n');
        chats.root.cachedToolResults = { cache_legacy: { id: 'cache_legacy', toolName: 'user_message', fullContent: big, size: big.length } };
        var r = [{ role: 'user', content: big, cachedContentId: 'cache_legacy' }]; chats.root.messages = r;
        var HDR = '[User pasted a long message \u2014 cached]\n';
        var first = m.buildAPIMessages(r, 'root')[0].content;
        assert.strictEqual(first.indexOf(HDR), 0, 'legacy reference synthesized');
        assert.strictEqual(JSON.parse(first.slice(HDR.length))._cached_user_message.content_id, 'cache_legacy', 'existing id reused');
        assert.strictEqual(r[0].sentApiContent, first, 'synthesized string frozen on the row');
        assert.strictEqual(r[0].sentApiSrcLen, big.length);
        assert.strictEqual(r[0].sentApiSrcHash, m._sentSrcHash(big));
        delete chats.root.cachedToolResults.cache_legacy;
        assert.strictEqual(m.buildAPIMessages(r, 'root')[0].content, first, 'identical after the cache entry is gone');
        assert.strictEqual(r[0].cachedContentId, 'cache_legacy', 'no new id minted');
        assert.deepStrictEqual(Object.keys(chats.root.cachedToolResults), [], 'no new cache entry');
    }, T);

    test('evicted chat: stamp flags _dirtyWhileEvicted so the evicted-put guard re-saves', function() {
        chats.root._payloadsEvicted = true;
        var lim = Number(m.getCacheCharLimit()) || 16000;
        var r = [{ role: 'user', content: new Array(Math.ceil(lim / 20) + 50).join('pasted line of text\n') }]; chats.root.messages = r;
        m.buildAPIMessages(r, 'root');
        assert.strictEqual(chats.root._dirtyWhileEvicted, true);
    }, T);
});

describe('prefix stability: system prompt date freeze + skills order (core/110)', function() {
    var m, chats;
    beforeEach(async function() {
        chats = { c1: { id: 'c1', messages: [] } };
        // Fixed clock (local noon): two `new Date()` calls can never straddle midnight.
        var RealDate = Date, FIXED = new RealDate(2026, 9, 2, 12, 0, 0).getTime();
        var FakeDate = function() { return arguments.length ? new (Function.prototype.bind.apply(RealDate, [null].concat([].slice.call(arguments))))() : new RealDate(FIXED); };
        FakeDate.now = function() { return FIXED; }; FakeDate.UTC = RealDate.UTC; FakeDate.parse = RealDate.parse; FakeDate.prototype = RealDate.prototype;
        m = await loadModules(['src/js/core/110-system-prompt.js'], { lenient: true, globals: {
            Date: FakeDate,
            self: {}, window: fakeWindow(), chrome: fakeChrome(), chats: chats, console: quiet,
            getDisabledTools: function() { return []; }, TOOL_DISPLAY_NAMES: {},
            getSkillsSummaryForPrompt: function() { return '\n\nACTIVE SKILLS:\n- Zed (id: zed): last\n- Alpha (id: alpha): first\n  continued\n'; }
        }});
    });

    test('date is fixed per chat on first build and reused', function() {
        var out1 = m.expandSystemPromptPlaceholders('CURRENT DATE: {{CURRENT_DATE}}', 'c1');
        assert.strictEqual(chats.c1.promptDate, 'Friday, October 2, 2026', 'date stored on the chat');
        assert.strictEqual(out1, 'CURRENT DATE: ' + chats.c1.promptDate);
        chats.c1.promptDate = 'Monday, January 1, 2024'; // as if the chat started that day
        assert.strictEqual(m.expandSystemPromptPlaceholders('CURRENT DATE: {{CURRENT_DATE}}', 'c1'), 'CURRENT DATE: Monday, January 1, 2024');
        assert.strictEqual(m._todayPromptDate(), 'Friday, October 2, 2026');
        assert.strictEqual(m._chatPromptDate('nope'), 'Friday, October 2, 2026', 'unknown chat -> today');
        assert.strictEqual(chats.nope, undefined, 'nothing stored for an unknown chat');
    }, T);

    test('ACTIVE SKILLS entries sorted by id, multi-line entries kept whole', function() {
        var s = m._sortSkillsSummary('\n\nACTIVE SKILLS:\n- Zed (id: zed): last\n- Alpha (id: alpha): first\n  continued\n');
        assert.strictEqual(s, '\n\nACTIVE SKILLS:\n- Alpha (id: alpha): first\n  continued\n- Zed (id: zed): last\n');
        assert.strictEqual(m._sortSkillsSummary(''), '');
        assert.strictEqual(m._sortSkillsSummary('\n\nACTIVE SKILLS:\n- odd entry\n- b (id: b)\n'), '\n\nACTIVE SKILLS:\n- odd entry\n- b (id: b)\n', 'unparseable -> unchanged');
        var out = m.expandSystemPromptPlaceholders('{{SKILLS_SUMMARY}}', 'c1');
        assert.ok(out.indexOf('(id: alpha)') < out.indexOf('(id: zed)'), 'prompt uses the sorted list');
    }, T);
});

describe('prefix stability: fingerprint diagnostics (app/010)', function() {
    var m;
    beforeEach(async function() {
        m = await loadModules(['src/js/app/010-llm-streaming.js'], { lenient: true, globals: {
            self: {}, window: fakeWindow(), chrome: fakeChrome(), console: quiet
        }});
    });

    test('first differing API message index vs the first send', function() {
        var a = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }];
        var f1 = m._computePrefixFingerprint('cx', 'SYS', [{ n: 1 }], a);
        assert.strictEqual(f1.firstDiff, -1); assert.strictEqual(f1.part, null); assert.strictEqual(f1.n, 2);
        var f2 = m._computePrefixFingerprint('cx', 'SYS', [{ n: 1 }], a.concat([{ role: 'user', content: 'c' }]));
        assert.strictEqual(f2.firstDiff, -1, 'append-only history: no diff');
        var b = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'B!' }, { role: 'user', content: 'c' }];
        var f3 = m._computePrefixFingerprint('cx', 'SYS', [{ n: 1 }], b);
        assert.strictEqual(f3.firstDiff, 1); assert.strictEqual(f3.part, 'messages');
        assert.strictEqual(m._computePrefixFingerprint('cx', 'SYS2', [{ n: 1 }], b).part, 'system');
        var metrics = { prefixFingerprint: f3, inputTransformations: [{ type: 'thinking_dropped', path: 'messages[1]', reason: 'prefix_binding_mismatch' }] };
        assert.ok(/first differing API message index=1/.test(m._logPrefixDiffOnDrop('cx', metrics)));
        assert.strictEqual(m._logPrefixDiffOnDrop('cx', { inputTransformations: [] }), null);
    }, T);
});

describe('prefix stability: content hash on the pasted-message replay (app/020)', function() {
    var m, chats, saves;
    beforeEach(async function() {
        chats = { root: { id: 'root', messages: [] } }; saves = 0;
        m = await loadModules(['src/js/app/020-api-messages.js', 'src/js/core/100-cached-results.js'], { lenient: true, globals: {
            self: {}, window: fakeWindow(), chrome: fakeChrome(), Platform: { isWorker: true },
            chats: chats, saveChatsToStorage: function() { saves++; return Promise.resolve(); }, console: quiet
        }});
    });
    function big(tag) {
        var lim = Number(m.getCacheCharLimit()) || 16000;
        return new Array(Math.ceil(lim / 20) + 50).join('pasted line of text\n') + tag;
    }

    test('stamp saves: one on first send, none on a hash replay, one on a legacy-row upgrade', function() {
        var r = [{ role: 'user', content: big('AAAA') }]; chats.root.messages = r;
        var first = m.buildAPIMessages(r, 'root')[0].content;
        assert.strictEqual(saves, 1, 'first send stamps + saves once');
        assert.strictEqual(m.buildAPIMessages(r, 'root')[0].content, first);
        assert.strictEqual(saves, 1, 'hash replay does not save');
        delete r[0].sentApiSrcHash;
        assert.strictEqual(m.buildAPIMessages(r, 'root')[0].content, first);
        assert.strictEqual(saves, 2, 'legacy upgrade via _sentSrcMatches saves the new hash');
        assert.strictEqual(m.buildAPIMessages(r, 'root')[0].content, first);
        assert.strictEqual(saves, 2, 'upgraded row replays without saving');
    }, T);

    test('a same-length in-place edit is caught by the hash (re-cached, not replayed)', function() {
        var r = [{ role: 'user', content: big('AAAA') }]; chats.root.messages = r;
        m.buildAPIMessages(r, 'root');
        assert.strictEqual(r[0].sentApiSrcHash, m._sentSrcHash(r[0].content), 'hash stamped with the first send');
        var id1 = r[0].cachedContentId;
        r[0].content = big('BBBB'); // same length, different bytes
        assert.strictEqual(r[0].content.length, r[0].sentApiSrcLen, 'length alone cannot tell');
        m.buildAPIMessages(r, 'root');
        assert.notStrictEqual(r[0].cachedContentId, id1, 'edited text re-cached under a new id');
        assert.strictEqual(r[0].sentApiSrcHash, m._sentSrcHash(r[0].content), 'hash follows the new text');
        assert.notStrictEqual(m._sentSrcHash('abcd'), m._sentSrcHash('abce'));
    }, T);

    test('legacy length-only row: accepted once, then upgraded to the hash', function() {
        var r = [{ role: 'user', content: big('AAAA') }]; chats.root.messages = r;
        var first = m.buildAPIMessages(r, 'root')[0].content;
        delete r[0].sentApiSrcHash; // a row stamped before the hash existed
        assert.strictEqual(m.buildAPIMessages(r, 'root')[0].content, first, 'legacy row replays');
        assert.strictEqual(r[0].sentApiSrcHash, m._sentSrcHash(r[0].content), 'upgraded to the hash');
        assert.strictEqual(m._sentSrcMatches({ sentApiSrcLen: 3 }, 'abcd', 'root'), false, 'length mismatch still rejects');
        assert.strictEqual(m._sentSrcMatches({ sentApiSrcLen: 4, sentApiSrcHash: m._sentSrcHash('abcd') }, 'abce', 'root'), false, 'hash row rejects a same-length edit');
    }, T);
});

describe('prefix stability: page->SW adopt keeps the SW stamps (worker/130)', function() {
    var api, sw, sp, chats, running;
    var port = { postMessage: function() {} };
    beforeEach(async function() {
        chats = { root: { id: 'root', messages: [] } }; running = {};
        var g = {
            self: {}, window: fakeWindow(), chrome: fakeChrome(), Platform: { isWorker: true }, console: quiet,
            chats: chats, saveChatsToStorage: function() { return Promise.resolve(); },
            runningChatIds: running, pausedChats: {}, pendingInjectionsByChatId: {},
            CHAT_META_TS_FIELDS: ['lastResponseAt', 'lastActivityAt', 'lastViewedAt', 'updatedAt', 'titleUpdatedAt'],
            CHAT_META_FLAG_FIELDS: [],
            getDisabledTools: function() { return []; }, TOOL_DISPLAY_NAMES: {},
            getSkillsSummaryForPrompt: function() { return ''; }
        };
        api = await loadModules(['src/js/app/020-api-messages.js', 'src/js/core/100-cached-results.js'], { lenient: true, globals: g });
        sp = await loadModules(['src/js/core/110-system-prompt.js'], { lenient: true, globals: g });
        sw = await loadModules(['src/js/worker/130-port-bridge.js'], { lenient: true, globals: g });
    });
    var STAMPS = ['ledgerBlock', 'sentApiContent', 'sentApiSrcLen', 'sentApiSrcHash'];
    function pageCopyWithoutStamps(chat) {
        var c = JSON.parse(JSON.stringify(chat));
        delete c.promptDate;
        c.messages.forEach(function(r) { STAMPS.forEach(function(f) { delete r[f]; }); });
        return c;
    }
    function stampedChat() {
        var lim = Number(api.getCacheCharLimit()) || 16000;
        chats.root.messages = [
            { role: 'user', content: new Array(Math.ceil(lim / 20) + 50).join('pasted line of text\n') },
            { role: 'assistant', content: 'read it' },
            { role: 'user', content: 'next', ledgerBlock: HEADER + '\n- Alpha reported (done)' }
        ];
        chats.root.promptDate = 'Monday, January 1, 2024'; // stamped when the chat started, an earlier day
        return {
            sys: sp.expandSystemPromptPlaceholders('CURRENT DATE: {{CURRENT_DATE}}', 'root'),
            msgs: snap(api.buildAPIMessages(chats.root.messages, 'root'))
        };
    }

    test('run-agent adopt round-trip: rebuilt API prefix byte-identical, promptDate kept', function() {
        var before = stampedChat();
        var row0 = chats.root.messages[0];
        assert.ok(row0.sentApiContent && row0.sentApiSrcHash, 'SW stamped the pasted row');
        assert.ok(before.msgs.indexOf('Alpha reported') !== -1, 'frozen ledger block is in the first request');
        delete chats.root.cachedToolResults[row0.cachedContentId]; // a re-synthesis would now mint a new id
        sw._swRunAgentAdopt({ chatId: 'root', chat: pageCopyWithoutStamps(chats.root) });
        assert.notStrictEqual(chats.root.messages[0], row0, 'the page copy replaced the SW rows');
        assert.strictEqual(chats.root.promptDate, 'Monday, January 1, 2024', 'SW promptDate wins over a snapshot without one');
        assert.strictEqual(chats.root.messages[0].sentApiContent, row0.sentApiContent, 'row stamp carried');
        assert.strictEqual(snap(api.buildAPIMessages(chats.root.messages, 'root')), before.msgs, 'API messages byte-identical');
        assert.strictEqual(sp.expandSystemPromptPlaceholders('CURRENT DATE: {{CURRENT_DATE}}', 'root'), before.sys, 'system prompt byte-identical');
    }, T);

    test('carry only onto the same row; never overwrites a field the snapshot has', function() {
        var prev = { promptDate: 'D1', messages: [
            { role: 'user', content: 'a', ledgerBlock: 'L' }, { role: 'user', content: 'b', sentApiContent: 'S', sentApiSrcLen: 1 },
            { role: 'user', id: 'x', content: 'c', ledgerBlock: 'Lx' }] };
        var inc = { promptDate: 'D2', messages: [
            { role: 'user', content: 'a', ledgerBlock: 'mine' }, { role: 'user', content: 'B' },
            { role: 'user', id: 'y', content: 'c' }] };
        sw._swCarryPrefixStamps(prev, inc);
        assert.strictEqual(inc.promptDate, 'D2', 'snapshot promptDate kept when present');
        assert.strictEqual(inc.messages[0].ledgerBlock, 'mine', 'existing field not overwritten');
        assert.strictEqual(inc.messages[1].sentApiContent, undefined, 'different content -> no carry');
        assert.strictEqual(inc.messages[2].ledgerBlock, undefined, 'different id -> no carry');
        assert.strictEqual(sw._swSamePrefixRow({ role: 'user', content: [{ type: 'text', text: 'q' }] }, { role: 'user', content: [{ type: 'text', text: 'q' }] }), true);
        assert.strictEqual(sw._swSamePrefixRow({ role: 'user', content: 'q' }, { role: 'assistant', content: 'q' }), false);
        assert.strictEqual(sw._swCarryPrefixStamps(null, inc), inc);
        assert.strictEqual(sw._swCarryPrefixStamps({ _deleted: true, promptDate: 'X' }, { messages: [] }).promptDate, undefined, 'tombstone skipped');
    }, T);

    test('update-chat (idle chat) round-trip: rebuilt API prefix + promptDate byte-identical', function() {
        var before = stampedChat();
        var row0 = chats.root.messages[0];
        delete chats.root.cachedToolResults[row0.cachedContentId]; // a re-synthesis would now mint a new id
        var copy = pageCopyWithoutStamps(chats.root);
        assert.strictEqual(copy.promptDate, undefined); assert.strictEqual(copy.messages[0].sentApiContent, undefined);
        sw._handlePanelMessage(port, { type: 'update-chat', chatId: 'root', chat: copy });
        assert.strictEqual(chats.root, copy, 'the page copy replaced the SW record');
        assert.strictEqual(chats.root.promptDate, 'Monday, January 1, 2024', 'SW promptDate carried');
        assert.strictEqual(chats.root.messages[0].sentApiContent, row0.sentApiContent, 'row stamp carried');
        assert.strictEqual(chats.root.messages[2].ledgerBlock, HEADER + '\n- Alpha reported (done)', 'ledger stamp carried');
        assert.strictEqual(snap(api.buildAPIMessages(chats.root.messages, 'root')), before.msgs, 'API messages byte-identical');
        assert.strictEqual(sp.expandSystemPromptPlaceholders('CURRENT DATE: {{CURRENT_DATE}}', 'root'), before.sys, 'system prompt byte-identical');
    }, T);

    test('update-chat while the chat is running is ignored (no replace)', function() {
        stampedChat();
        var rec = chats.root; running.root = true;
        sw._handlePanelMessage(port, { type: 'update-chat', chatId: 'root', chat: pageCopyWithoutStamps(rec) });
        assert.strictEqual(chats.root, rec);
    }, T);

    test('same row id with edited content: carried stamp is rejected by the hash, re-cached under a new id', function() {
        var lim = Number(api.getCacheCharLimit()) || 16000;
        var bigA = new Array(Math.ceil(lim / 20) + 50).join('pasted line of text\n') + 'AAAA';
        var bigB = bigA.slice(0, -4) + 'edited text';
        chats.root.messages = [{ role: 'user', id: 'u1', content: bigA }];
        var sentA = api.buildAPIMessages(chats.root.messages, 'root')[0].content;
        var id1 = chats.root.messages[0].cachedContentId;
        var copy = pageCopyWithoutStamps(chats.root);
        copy.messages[0].content = bigB; // page-side edit, same row id
        sw._handlePanelMessage(port, { type: 'update-chat', chatId: 'root', chat: copy });
        var row = chats.root.messages[0];
        assert.strictEqual(row.sentApiContent, sentA, 'same id -> stamp carried onto the edited row');
        var sentB = api.buildAPIMessages(chats.root.messages, 'root')[0].content;
        assert.notStrictEqual(row.cachedContentId, id1, 'new content id');
        assert.strictEqual(chats.root.cachedToolResults[row.cachedContentId].fullContent, bigB, 'new entry holds the edited text');
        assert.notStrictEqual(sentB, sentA, 'stale stamp not replayed');
        assert.strictEqual(row.sentApiContent, sentB, 'new string frozen');
        assert.strictEqual(row.sentApiSrcHash, api._sentSrcHash(bigB), 'hash follows the edited text');
        assert.strictEqual(row.sentApiSrcLen, bigB.length);
    }, T);
});

describe('prefix stability: diagnostics cost + re-baseline (app/010)', function() {
    var m;
    beforeEach(async function() {
        m = await loadModules(['src/js/app/010-llm-streaming.js'], { lenient: true, globals: {
            self: {}, window: fakeWindow(), chrome: fakeChrome(), console: quiet
        }});
    });
    test('a changed message is reported once, then becomes the baseline', function() {
        var a = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }];
        m._computePrefixFingerprint('cy', 'S', [], a);
        var b = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'B' }];
        assert.strictEqual(m._computePrefixFingerprint('cy', 'S', [], b).firstDiff, 1);
        assert.strictEqual(m._computePrefixFingerprint('cy', 'S', [], b).firstDiff, -1, 'not re-reported');
        var msg = m._logPrefixDiffOnDrop('cy', { prefixFingerprint: { part: 'messages', firstDiff: 1 }, inputTransformations: [{ type: 'thinking_dropped' }] });
        assert.ok(/pre-transform apiMsgs index/.test(msg));
    }, T);
    test('inline base64 hashes by length only', function() {
        var d1 = 'data:image/png;base64,' + new Array(400).join('A'), d2 = 'data:image/png;base64,' + new Array(400).join('B');
        var p = function(u) { return m._fpPart({ role: 'user', content: [{ type: 'image_url', image_url: { url: u } }] }); };
        assert.strictEqual(p(d1), p(d2), 'same-length data URLs hash the same');
        var q = function(d) { return m._fpPart({ content: [{ type: 'image', source: { type: 'base64', data: d } }] }); };
        assert.strictEqual(q(new Array(400).join('A')), q(new Array(400).join('B')));
        assert.notStrictEqual(q(new Array(400).join('A')), q(new Array(401).join('A')), 'length still counts');
        assert.notStrictEqual(m._fpPart({ t: new Array(400).join('A') }), m._fpPart({ t: new Array(400).join('B') }), 'plain text still hashed');
    }, T);
    test('a tools change is reported as part=tools once, messages untouched', function() {
        var a = [{ role: 'user', content: 'a' }];
        m._computePrefixFingerprint('ct', 'S', [{ n: 1 }], a);
        var f = m._computePrefixFingerprint('ct', 'S', [{ n: 2 }], a);
        assert.strictEqual(f.part, 'tools'); assert.strictEqual(f.firstDiff, -1);
        assert.strictEqual(m._computePrefixFingerprint('ct', 'S', [{ n: 2 }], a).part, null, 'not re-reported');
    }, T);
    test('a shrunk history resets the baseline to the shorter request', function() {
        var A = { role: 'user', content: 'a' }, B = { role: 'assistant', content: 'b' }, C = { role: 'user', content: 'c' };
        var B2 = { role: 'assistant', content: 'b2' }, C2 = { role: 'user', content: 'c2' };
        m._computePrefixFingerprint('cs', 'S', [], [A, B, C]);
        assert.strictEqual(m._computePrefixFingerprint('cs', 'S', [], [A, B2]).firstDiff, 1, 'shrunk + changed: diff reported');
        assert.strictEqual(m._prefixFpMemo.cs.msgs.length, 2, 'baseline replaced by the shorter history');
        assert.strictEqual(m._computePrefixFingerprint('cs', 'S', [], [A, B2, C2]).firstDiff, -1, 'old index 2 no longer compared');
    }, T);
    test('memo is capped at 200 chats (oldest evicted, existing chats never evict)', function() {
        var one = [{ role: 'user', content: 'x' }];
        for (var i = 0; i < 200; i++) m._computePrefixFingerprint('k' + i, 'S', [], one);
        assert.strictEqual(Object.keys(m._prefixFpMemo).length, 200);
        m._computePrefixFingerprint('k5', 'S', [], one.concat(one));
        assert.strictEqual(Object.keys(m._prefixFpMemo).length, 200, 'update of a known chat evicts nothing');
        assert.ok(Object.prototype.hasOwnProperty.call(m._prefixFpMemo, 'k0'));
        m._computePrefixFingerprint('k200', 'S', [], one);
        assert.strictEqual(Object.keys(m._prefixFpMemo).length, 200);
        assert.strictEqual(Object.prototype.hasOwnProperty.call(m._prefixFpMemo, 'k0'), false, 'oldest chat evicted');
        assert.strictEqual(m._computePrefixFingerprint('k0', 'S2', [], [{ role: 'user', content: 'other' }]).part, null, 'evicted chat starts a fresh baseline');
    }, T);
});

describe('prefix stability: fingerprint only on Anthropic-format requests (app/010 gate)', function() {
    async function send(model) {
        var m = await loadModules(['src/js/app/010-llm-streaming.js'], { lenient: true, globals: {
            getProviderById: function() { return { model: model, endpoint: 'https://example.test/v1', apiKey: 'k' }; },
            lastRequestMetrics: {}, getSystemPromptWithContext: function() { return 'sys'; }, getEnabledTools: function() { return []; },
            getGlobalMaxTokens: function() { return 1000; }, getGlobalThinkingBudget: function() { return 0; },
            isAdaptiveOnlyClaude: function() { return false; }, isThinkingBindingModel: function() { return false; },
            setLLMConnectionStatus: function() {}, updateModelDisplayWithProvider: function() {},
            Platform: { getReferer: function() { return 'r'; } }, console: quiet,
            fetch: function() {
                var done = false;
                return Promise.resolve({ ok: true, status: 200, body: { getReader: function() { return { read: function() {
                    if (done) return Promise.resolve({ done: true, value: undefined });
                    done = true; return Promise.resolve({ done: false, value: new TextEncoder().encode('data: [DONE]\n') });
                } }; } } });
            }
        }});
        var metrics = {}; function noop() {}
        await m.callOpenRouterStreaming('p', [{ role: 'user', content: 'q' }], noop, noop, noop, noop, null, null, 'c1', metrics);
        assert.ok(metrics.requestBody, 'request was built');
        return metrics;
    }
    test('Claude model: fingerprint computed; non-Anthropic model: skipped', async function() {
        var a = await send('anthropic/claude-opus-5');
        assert.strictEqual(a.prefixFingerprint.n, 1); assert.strictEqual(a.prefixFingerprint.firstDiff, -1);
        var o = await send('openai/gpt-5');
        assert.strictEqual(o.prefixFingerprint, undefined, 'no fingerprint for a non-Anthropic provider');
    }, { tags: ['unit'], timeout: 10000 });
});

describe('prefix stability: SW dev-mode flag survives an SW restart (worker/130)', function() {
    var port = { postMessage: function() {} };
    function loadSw(selfObj, chromeObj) {
        return loadModules(['src/js/worker/130-port-bridge.js'], { lenient: true, globals: {
            self: selfObj, window: fakeWindow(), chrome: chromeObj, Platform: { isWorker: true }, console: quiet,
            chats: {}, saveChatsToStorage: function() { return Promise.resolve(); },
            runningChatIds: {}, pausedChats: {}, pendingInjectionsByChatId: {},
            CHAT_META_TS_FIELDS: [], CHAT_META_FLAG_FIELDS: []
        }});
    }
    // fakeChrome aliases session to local; this suite must distinguish them.
    function sessionChrome(seed, restoreGate) {
        var c = fakeChrome(), store = Object.assign({}, seed), calls = [];
        c._sessionStore = store;
        c._sessionCalls = calls;
        c.storage.session = {
            get: function(key) {
                calls.push(['get', key]);
                // Capture the read before releasing the deferred restore: a later
                // page push must beat this stale snapshot, not a fresh store read.
                var result = {};
                if (Object.prototype.hasOwnProperty.call(store, key)) result[key] = store[key];
                return restoreGate ? restoreGate.then(function() { return result; }) : Promise.resolve(result);
            },
            set: function(items) {
                calls.push(['set', Object.assign({}, items)]);
                Object.assign(store, items);
                return Promise.resolve();
            }
        };
        return c;
    }
    test('boot restores session true/false/missing, ignoring conflicting local storage', async function() {
        var cases = [
            { session: { swDevModeActive: true }, local: false, expected: true },
            { session: { swDevModeActive: false }, local: true, expected: false },
            { session: {}, local: true, expected: undefined }
        ];
        for (var row of cases) {
            var c = sessionChrome(row.session), s = {};
            c._store.swDevModeActive = row.local;
            await loadSw(s, c);
            assert.strictEqual(typeof s._swDevModeRestored.then, 'function', 'restore promise exposed for runAgent');
            await s._swDevModeRestored;
            assert.strictEqual(s._swDevModeActive, row.expected);
            assert.deepStrictEqual(c._sessionStore, row.session, 'restore never writes session storage');
            assert.deepStrictEqual(c._store, { swDevModeActive: row.local }, 'restore never changes local storage');
            assert.deepStrictEqual(c._sessionCalls, [['get', 'swDevModeActive']]);
            assert.deepStrictEqual(c._calls, [], 'restore must not read local storage');
        }
    }, T);
    test('a page push before deferred session restore beats the stale snapshot', async function() {
        var release, gate = new Promise(function(r) { release = r; });
        var c = sessionChrome({ swDevModeActive: true }, gate), s = {};
        var m = await loadSw(s, c), restored = false;
        s._swDevModeRestored.then(function() { restored = true; });
        assert.strictEqual(s._swDevModeActive, undefined, 'restore is still gated');
        assert.deepStrictEqual(c._sessionCalls, [['get', 'swDevModeActive']]);
        m._handlePanelMessage(port, { type: 'dev-mode', active: false });
        assert.strictEqual(s._swDevModeActive, false, 'page push takes effect before restore');
        assert.deepStrictEqual(c._sessionStore, { swDevModeActive: false }, 'page push writes session, not local');
        assert.deepStrictEqual(c._store, {});
        assert.strictEqual(restored, false, 'restore cannot settle before release');
        release(); await s._swDevModeRestored;
        assert.strictEqual(restored, true);
        assert.strictEqual(s._swDevModeActive, false, 'page value wins over the stale stored true');
        assert.deepStrictEqual(c._sessionStore, { swDevModeActive: false }, 'restore does not rewrite the pushed value');
        assert.deepStrictEqual(c._store, {});
        assert.deepStrictEqual(c._sessionCalls, [['get', 'swDevModeActive'], ['set', { swDevModeActive: false }]]);
        assert.deepStrictEqual(c._calls, [], 'neither restore nor push uses local storage');
    }, T);
    test("'dev-mode' message writes only session storage and a restarted SW restores it", async function() {
        var c = sessionChrome(), s = {};
        var m = await loadSw(s, c); await s._swDevModeRestored;
        m._handlePanelMessage(port, { type: 'dev-mode', active: true });
        assert.strictEqual(s._swDevModeActive, true);
        assert.deepStrictEqual(c._sessionStore, { swDevModeActive: true });
        assert.deepStrictEqual(c._store, {}, 'true must not persist in local storage');
        m._handlePanelMessage(port, { type: 'dev-mode', active: 0 });
        assert.strictEqual(s._swDevModeActive, false);
        assert.deepStrictEqual(c._sessionStore, { swDevModeActive: false });
        assert.deepStrictEqual(c._store, {}, 'false must not persist in local storage');
        m._handlePanelMessage(port, { type: 'dev-mode', active: 1 });
        assert.strictEqual(s._swDevModeActive, true);
        assert.deepStrictEqual(c._sessionStore, { swDevModeActive: true });
        assert.deepStrictEqual(c._store, {});
        var s2 = {}; await loadSw(s2, c); await s2._swDevModeRestored;
        assert.strictEqual(s2._swDevModeActive, true, 'restarted SW boots with the last session value');
        assert.deepStrictEqual(c._sessionStore, { swDevModeActive: true });
        assert.deepStrictEqual(c._store, {});
        assert.deepStrictEqual(c._sessionCalls, [
            ['get', 'swDevModeActive'], ['set', { swDevModeActive: true }],
            ['set', { swDevModeActive: false }], ['set', { swDevModeActive: true }],
            ['get', 'swDevModeActive']
        ]);
        assert.deepStrictEqual(c._calls, [], 'local storage is untouched across push and restart');
    }, T);
});
