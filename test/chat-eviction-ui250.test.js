// Real renderer + real DOM; storage is controlled by explicit deferred promises.
// No clocks, polling, copied renderer, or source-shape assertions.
function deferredLoad() {
    var resolve;
    var promise = new Promise(function(r) { resolve = r; });
    return { promise: promise, resolve: resolve };
}

describe('ui/250 skeleton storage failure and Retry', function() {
    test('a failed current-chat load renders exactly one alert and Retry loads again', async function() {
        var doc = document.implementation.createHTMLDocument('eviction retry');
        doc.body.innerHTML = '<div id="messages"></div><div id="input-area"><div class="empty-state">stale</div></div>';
        var chat = { id: 'cold', _messagesEvicted: true, _msgCount: 2 };
        var first = deferredLoad(), second = deferredLoad();
        var calls = [];
        var m = await loadModules(['src/js/ui/250-message-render.js'], {
            globals: {
                document: doc, window: { isRunning: false },
                chats: { cold: chat }, currentChatId: 'cold', activeStreamingChatId: null,
                _isChatInSilentHook: function() { return false; }, currentEditingWidget: null,
                getDisplayHtmlForMessage: null,
                updateContextIndicator: function() {}, updateInputPosition: function() {},
                escapeHtml: function(s) { return s; },
                ensureChatPayloads: function(id) {
                    calls.push(id);
                    if (calls.length === 1) return first.promise;
                    if (calls.length === 2) return second.promise;
                    throw new Error('unexpected third hydration');
                }
            }
        });
        var box = doc.getElementById('messages');
        function state() {
            return Array.from(box.children).map(function(row) {
                return { tag: row.tagName, role: row.getAttribute('role'), text: row.textContent,
                    children: Array.from(row.children).map(function(child) {
                        return { tag: child.tagName, text: child.textContent, type: child.getAttribute('type') };
                    }) };
            });
        }
        var loading = [{ tag: 'DIV', role: 'status', text: 'Loading messages\u2026', children: [] }];
        var message = 'Storage unavailable \u2014 chat history could not be loaded. Try restarting Chrome.';
        var failed = [{ tag: 'DIV', role: 'alert', text: message + 'Retry', children: [
            { tag: 'SPAN', text: message, type: null }, { tag: 'BUTTON', text: 'Retry', type: 'button' }
        ] }];
        m.renderMessages();
        assert.deepStrictEqual(calls, ['cold']);
        assert.deepStrictEqual(state(), loading, 'pending load has only a status row');
        assert.strictEqual(doc.querySelector('#input-area .empty-state'), null);
        // renderMessages attached its reaction before this await: resolving the
        // actual loader promise deterministically executes the failure branch first.
        first.resolve();
        await first.promise;
        assert.deepStrictEqual(chat, { id: 'cold', _messagesEvicted: true, _msgCount: 2 });
        assert.strictEqual(doc.querySelectorAll('#messages [role="alert"]').length, 1);
        assert.deepStrictEqual(state(), failed, 'exact failure row, message and Retry button');
        assert.deepStrictEqual(calls, ['cold'], 'failure does not auto-loop');
        doc.querySelector('#messages [role="alert"] button').click();
        assert.deepStrictEqual(calls, ['cold', 'cold'], 'Retry invokes the real render/load path again');
        assert.deepStrictEqual(state(), loading, 'Retry replaces rather than appends to the alert');
        second.resolve();
        await second.promise;
        assert.strictEqual(doc.querySelectorAll('#messages [role="alert"]').length, 1);
        assert.deepStrictEqual(state(), failed, 'a second miss still has exactly the same single failure row');
        assert.deepStrictEqual(calls, ['cold', 'cold']);
        assert.deepStrictEqual(m.__unstubbed, []);
    }, { tags: ['unit'] });
});
