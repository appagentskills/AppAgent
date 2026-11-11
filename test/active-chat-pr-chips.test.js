// Active Chats card PR chips (tools/120-actions.js): _jobsCardPrs aggregates
// the chat's + its sub-agents' PRs (message scan + durable meta.prs stamps),
// deduped by URL, with open/merged/closed state; _jobsCardPrChipsHtml renders
// the pill row ('' when no PRs).
var EX = await runFile('test/extract.js', { i18n: false });
describe('active chat card PR chips (tools/120-actions.js)', function() {
    var M = null;
    async function load() {
        if (M) return M;
        var fakeDoc = { addEventListener: function() {}, removeEventListener: function() {}, querySelector: function() { return null; }, querySelectorAll: function() { return []; }, getElementById: function() { return null; }, createElement: function() { return { style: {}, classList: { add: function() {}, remove: function() {} }, setAttribute: function() {}, appendChild: function() {} }; }, body: { appendChild: function() {}, classList: { add: function() {}, remove: function() {} } } };
        M = await loadModules(['src/js/tools/120-actions.js'], { lenient: true, globals: { window: fakeWindow({ document: fakeDoc }), chrome: fakeChrome(), document: fakeDoc } });
        assert.strictEqual(typeof M._jobsCardPrs, 'function');
        assert.strictEqual(typeof M._jobsCardPrCardsHtml, 'function');
        return M;
    }
    var U = 'https://github.com/o/r/pull/';
    function setup(m, opts) {
        var s = m.__scope;
        s.t = function(x) { return x; };
        s.escapeHtml = function(x) { return String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); };
        s.chats = { parent: { id: 'parent', messages: [] }, chat_sub_a: { id: 'chat_sub_a', messages: [] } };
        var scans = opts.scans || {};
        s.getPushedPRsForChat = function(c) { return (scans[c.id] || []).map(function(p) { return Object.assign({}, p); }); };
        s.getSubAgentChatsForChat = function() { return [{ chatId: 'chat_sub_a', name: 'a', chat: s.chats.chat_sub_a }]; };
        s._sidebarMetaPRs = opts.meta || [];
        s._sidebarPRState = opts.live || {};
        s.refreshed = 0;
        s._refreshSidebarPRStates = function() { s.refreshed++; };
        s._refreshSidebarMetaPRs = function() {};
        // The real shared sidebar renderer (ui/120-ui-utils.js), evaluated from
        // source and injected -- the chat cards must render the SAME markup.
        s.renderPrSidebarItemHtml = opts.renderer;
    }
    var R = null;
    async function renderer() {
        if (R) return R;
        var src = await loadFile('src/js/ui/120-ui-utils.js');
        var a = src.indexOf('function renderPrSidebarItemHtml(');
        var b = a < 0 ? -1 : EX.blockFrom(src, a).end - 2;   // code-mask end (test/extract.js)
        var esc = function(x) { return String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); };
        var icons = { gitBranch: '<i>b</i>', gitMerge: '<i>m</i>', spinner: '<i>s</i>', close: '<i>x</i>', externalLink: '<i>e</i>' };
        R = new Function('escapeHtml', 't', 'UI_ICONS', src.slice(a, b + 2) + '\nreturn renderPrSidebarItemHtml;')(esc, function(x) { return x; }, icons);
        return R;
    }
    it('returns empty row when the chat tree has no PRs', async function() {
        var m = await load();
        setup(m, {});
        assert.deepStrictEqual(m._jobsCardPrs('parent'), []);
        assert.strictEqual(m._jobsCardPrCardsHtml('parent'), '');
    });
    it('aggregates parent + sub PRs, dedupes by URL, resolves state', async function() {
        var m = await load();
        setup(m, {
            scans: {
                parent: [{ url: U + '1176', number: 1176, title: 'P' }],
                chat_sub_a: [{ url: U + '1177', number: 1177, title: 'S' }, { url: U + '1176', number: 1176, title: 'dup' }]
            },
            meta: [
                { url: U + '1178', number: 1178, chatId: 'chat_sub_gone', root_chat_id: 'parent', state: 'closed' },
                { url: U + '1176', number: 1176, chatId: 'parent', merged_at: '2026-10-17T00:00:00Z' },
                { url: U + '9999', number: 9999, chatId: 'other_chat' }
            ],
            live: { }
        });
        var prs = m._jobsCardPrs('parent');
        assert.deepStrictEqual(prs.map(function(p) { return p.number + ':' + p.state; }), ['1176:merged', '1177:open', '1178:closed']);
        assert.strictEqual(prs[0].title, 'P');
    });
    it('live _sidebarPRState wins over meta stamp', async function() {
        var m = await load();
        setup(m, { scans: { parent: [{ url: U + '5', number: 5 }] }, meta: [{ url: U + '5', number: 5, state: 'closed' }], live: { } });
        m.__scope._sidebarPRState[U + '5'] = 'merged';
        assert.strictEqual(m._jobsCardPrs('parent')[0].state, 'merged');
    });
    it('renders the chat sidebar PR cards (shared renderer) in the card drawer', async function() {
        var m = await load();
        var r = await renderer();
        setup(m, { scans: { parent: [{ url: U + '1176', number: 1176, title: 'T' }], chat_sub_a: [{ url: U + '1177', number: 1177 }] }, live: {}, renderer: r });
        m.__scope._sidebarPRState[U + '1176'] = 'merged';
        var html = m._jobsCardPrCardsHtml('parent');
        assert.strictEqual(html.indexOf('<div class="pr-sidebar-list jobs-card-prs">'), 0, html);
        // Byte-identical to what the sidebar renders, plus the stopPropagation guard.
        assert.ok(html.indexOf(r({ url: U + '1176', number: 1176, title: 'T' }, 'merged', { stopPropagation: true })) > 0, html);
        assert.ok(html.indexOf('<a class="pr-sidebar-item" href="' + U + '1176" target="_blank"') > 0, html);
        assert.ok(html.indexOf('pr-sidebar-state merged') > 0, html);
        assert.ok(html.indexOf('class="pr-sidebar-merge-btn" data-pr-url="' + U + '1177"') > 0, html); // open -> merge button
        assert.ok(html.indexOf('<span class="wsf-ws"') > 0, 'sub-agent PR carries the worker chip');
        assert.ok(html.indexOf('onclick="event.stopPropagation()"') > 0);
        assert.strictEqual(m.__scope.refreshed, 1);
        // Sidebar call shape (no opts) has no anchor onclick.
        assert.strictEqual(r({ url: U + '1', number: 1, title: 'x' }, 'open').indexOf('<a class="pr-sidebar-item" href="' + U + '1" target="_blank" rel="noopener noreferrer" title="' + U + '1">'), 0);
    });
    it('home panel patch swaps only changed cards when the skeleton is unchanged', async function() {
        var m = await load();
        var cards = [{ id: 'a', html: '<div class="jobs-expand-card" data-chat-id="a">A1</div>' }, { id: 'b', html: '<div class="jobs-expand-card" data-chat-id="b">B1</div>' }];
        function page(cs) { return '<div class="x">' + cs.map(function(c) { return c.html; }).join('') + '</div>'; }
        var swaps = [], full = 0;
        var els = { a: { getAttribute: function() { return 'a'; } }, b: { getAttribute: function() { return 'b'; } } };
        Object.keys(els).forEach(function(k) { Object.defineProperty(els[k], 'outerHTML', { set: function(v) { swaps.push(k + '=' + v); } }); });
        var container = { querySelectorAll: function() { return [els.a, els.b]; } };
        Object.defineProperty(container, 'innerHTML', { set: function() { full++; } });
        assert.strictEqual(m._homeChatsPatch(container, page(cards), cards), false); // first paint: full
        var next = [cards[0], { id: 'b', html: '<div class="jobs-expand-card" data-chat-id="b">B2</div>' }];
        assert.strictEqual(m._homeChatsPatch(container, page(next), next), true);
        assert.deepStrictEqual(swaps, ['b=' + next[1].html]);
        assert.strictEqual(full, 1);
        // Membership/order change -> skeleton differs -> full replace.
        assert.strictEqual(m._homeChatsPatch(container, page([next[1], next[0]]), [next[1], next[0]]), false);
        assert.strictEqual(full, 2);
    });
    it('home panel patch falls back to a full paint when the live DOM lost the cards', async function() {
        var m = await load();
        var cards = [{ id: 'a', html: '<div class="jobs-expand-card" data-chat-id="a">A1</div>' }];
        var full = 0, live = [];
        var container = { querySelectorAll: function() { return live; } };
        Object.defineProperty(container, 'innerHTML', { set: function() { full++; } });
        var html = '<div>' + cards[0].html + '</div>';
        m._homeChatsPatch(container, html, cards);
        // Same skeleton + same cards, but the container was emptied meanwhile
        // (e.g. modal closed): must repaint, not "patch" nothing.
        assert.strictEqual(m._homeChatsPatch(container, html, cards), false);
        assert.strictEqual(full, 2);
    });
    it('card patch replaces only the changed child and syncs root attributes (real DOM)', async function() {
        if (typeof document === 'undefined' || !document.createElement('template').content) { skipTest('no real DOM'); return; }
        var m = await load();
        var realDoc = document;
        var prevDoc = m.__scope.document;
        m.__scope.document = realDoc;
        try {
            function card(cls, body, ring) {
                return '<div class="jobs-expand-card ' + cls + '" data-chat-id="a"><div class="jobs-expand-card-head">H</div><div class="jobs-expand-card-actions">' + ring + '</div><div class="jobs-expand-card-body">' + body + '</div></div>';
            }
            var host = realDoc.createElement('div');
            var v1 = card('state-running', 'p1', 'r1');
            host.innerHTML = v1;
            var el = host.firstElementChild;
            var head = el.children[0], actions = el.children[1], body = el.children[2];
            var v2 = card('state-done', 'p2', 'r1');
            m._homeChatsPatchCard(el, v1, v2);
            assert.strictEqual(host.firstElementChild, el, 'card root node kept');
            assert.strictEqual(el.children[0], head, 'unchanged head kept');
            assert.strictEqual(el.children[1], actions, 'unchanged actions rail kept');
            assert.notStrictEqual(el.children[2], body, 'changed body swapped');
            assert.strictEqual(el.children[2].textContent, 'p2');
            assert.strictEqual(el.className, 'jobs-expand-card state-done');
            assert.strictEqual(host.innerHTML, v2);
            // Different child layout -> whole-card swap.
            var v3 = '<div class="jobs-expand-card" data-chat-id="a"><div class="jobs-expand-card-head">H</div></div>';
            m._homeChatsPatchCard(el, v2, v3);
            assert.strictEqual(host.innerHTML, v3);
        } finally {
            m.__scope.document = prevDoc;
        }
    });
    it('card patch swaps a changed child through outerHTML so CSP-polyfill handlers bind (real DOM)', async function() {
        if (typeof document === 'undefined' || !document.createElement('template').content) { skipTest('no real DOM'); return; }
        var m = await load();
        var realDoc = document;
        var prevDoc = m.__scope.document;
        m.__scope.document = realDoc;
        try {
            function card(pinCls) {
                return '<div class="jobs-expand-card" data-chat-id="a"><div class="jobs-expand-card-head">H</div>' +
                    '<div class="jobs-expand-card-actions"><button class="jobs-row-btn jobs-pin-btn' + pinCls + '" data-x="pin">p</button></div>' +
                    '<div class="jobs-expand-card-body">B</div></div>';
            }
            var host = realDoc.createElement('div');
            var v1 = card(''), v2 = card(' pinned');
            host.innerHTML = v1;
            var el = host.firstElementChild;
            var rail = el.children[1];
            // Stand-in for csp-polyfill.js: it binds on* handlers ONLY for markup
            // inserted via innerHTML/outerHTML/insertAdjacentHTML. Record that
            // the changed rail went through that hook (a moved <template> node
            // would bypass it and keep dead buttons).
            var hooked = [];
            var proto = Object.getOwnPropertyDescriptor(Element.prototype, 'outerHTML');
            Object.defineProperty(rail, 'outerHTML', { configurable: true, get: function() { return proto.get.call(this); }, set: function(v) { hooked.push(v); proto.set.call(this, v); } });
            m._homeChatsPatchCard(el, v1, v2);
            assert.strictEqual(hooked.length, 1, 'changed rail replaced via outerHTML');
            assert.ok(hooked[0].indexOf('jobs-pin-btn pinned') > 0, hooked[0]);
            assert.strictEqual(host.innerHTML, v2);
            assert.strictEqual(el.children[0].textContent, 'H');
        } finally {
            m.__scope.document = prevDoc;
        }
    });
    it('repro: render -> card click (read/current change) -> patch -> rail buttons still fire under the real CSP polyfill', async function() {
        if (typeof document === 'undefined' || typeof window === 'undefined' || !document.createElement('template').content) { skipTest('no real DOM'); return; }
        var m = await load();
        var realDoc = document;
        var prevDoc = m.__scope.document;
        var P = Element.prototype;
        var saved = {
            inner: Object.getOwnPropertyDescriptor(P, 'innerHTML'),
            outer: Object.getOwnPropertyDescriptor(P, 'outerHTML'),
            adj: P.insertAdjacentHTML,
            setAttr: P.setAttribute
        };
        var hits = [];
        window.__tOpen = function(id) { hits.push('open:' + id); };
        window.__tPin = function(id) { hits.push('pin:' + id); };
        window.__tDismiss = function(id) { hits.push('dismiss:' + id); };
        m.__scope.document = realDoc;
        try {
            // Install the REAL extension polyfill (inline on* -> data-_ev-* + bound listeners).
            new Function(await loadFile('src/platform/extension/csp-polyfill.js'))();
            function card(cls, ring) {
                var b = function(fn, label) { return '<button class="jobs-row-btn ' + label + '" onclick="event.stopPropagation();' + fn + '(\'a\')">' + label + '</button>'; };
                return '<div class="jobs-expand-card' + cls + '" data-chat-id="a"><div class="jobs-expand-card-head">H</div>' +
                    '<div class="jobs-expand-card-actions">' + b('__tOpen', 'open') + '<span class="jobs-row-ctx">' + ring + '</span>' + b('__tPin', 'jobs-pin-btn') + b('__tDismiss', 'jobs-card-dismiss') + '</div>' +
                    '<div class="jobs-expand-card-body">B</div></div>';
            }
            var host = realDoc.createElement('div');
            realDoc.body.appendChild(host);
            var v1 = card(' jobs-unread', '10%');
            host.innerHTML = '<div class="cards">' + v1 + '</div>';
            var sel = function(c) { return host.querySelector('.jobs-expand-card-actions .' + c); };
            sel('jobs-pin-btn').click();
            assert.deepStrictEqual(hits, ['pin:a'], 'first render: buttons work');
            // Card click -> chat becomes current/read -> its markup (classes + rail) changes -> per-card patch.
            var v2 = card(' is-current jobs-read', '11%');
            m._homeChatsPatchCard(host.querySelector('.jobs-expand-card'), v1, v2);
            assert.ok(host.querySelector('.jobs-expand-card').classList.contains('jobs-read'));
            assert.ok(!host.querySelector('[data-_ev-click]'), 'no unbound data-_ev-click left behind');
            hits.length = 0;
            sel('open').click(); sel('jobs-pin-btn').click(); sel('jobs-card-dismiss').click();
            assert.deepStrictEqual(hits, ['open:a', 'pin:a', 'dismiss:a'], 'buttons still fire after the patch');
            host.remove();
        } finally {
            Object.defineProperty(P, 'innerHTML', saved.inner);
            Object.defineProperty(P, 'outerHTML', saved.outer);
            P.insertAdjacentHTML = saved.adj;
            P.setAttribute = saved.setAttr;
            delete window.__tOpen; delete window.__tPin; delete window.__tDismiss;
            m.__scope.document = prevDoc;
        }
    });
    it('unread finished card shows the dot IN PLACE of the check; read card keeps the check', async function() {
        var m = await load();
        var s = m.__scope;
        s.t = function(x) { return x; };
        s.escapeHtml = function(x) { return String(x); };
        s.escapeJsString = function(x) { return String(x); };
        s.UI_ICONS = { check: '<i>ck</i>', spinner: '<i>sp</i>', chat: '', close: '', bell: '' };
        s.currentChatId = 'other';
        s.getFinishedChatBell = function() { return null; };
        s._jobsChatState = function() { return 'done'; };
        s._jobsAccordionBodyHtml = function() { return ''; };
        s._jobsProgressBadgeHtml = function() { return ''; };
        s._jobsCardPrCardsHtml = function() { return ''; };
        s._jobsAccWorkersHtml = function() { return ''; };
        s._jobsChatTitleText = function(c) { return c.id; };
        s.chats = { a: { id: 'a', title: 'a', messages: [], lastResponseAt: 2, lastViewedAt: 1 } };
        var unseen = true;
        var setUnseen = function(v) { unseen = v; s.chats.a.lastViewedAt = v ? 1 : 3; };
        var head = function(h) { return h.slice(h.indexOf('jobs-expand-card-head'), h.indexOf('jobs-expand-card-actions')); };
        var u = head(m._jobsExpandCardHtml({ id: 'a' }));
        assert.ok(u.indexOf('jobs-row-check') === -1, 'no check on unread: ' + u);
        assert.strictEqual(u.split('jobs-unread-dot').length - 1, 1, 'exactly one dot: ' + u);
        assert.ok(u.indexOf('jobs-unread-dot') < u.indexOf('jobs-expand-card-title'), 'dot takes the leading check slot');
        setUnseen(false);
        var r = head(m._jobsExpandCardHtml({ id: 'a' }));
        assert.ok(r.indexOf('jobs-row-check') > 0 && r.indexOf('jobs-unread-dot') === -1, r);
        setUnseen(true);
        // Shared indicator/signals untouched: running keeps its spinner, and the
        // dropdown rows keep check + trailing dot.
        assert.ok(m._jobsStateIndicatorHtml('running', 'a').indexOf('jobs-row-spinner') > 0, 'running indicator unchanged');
        assert.ok(m._jobsStateIndicatorHtml('done', 'a').indexOf('jobs-row-check') > 0);
        assert.ok(m._jobsRowSignals('a', 'done').trail.indexOf('jobs-unread-dot') > 0);
    });
    it('card CSS: pin + dismiss always visible; drawer PR cards use the card surface', async function() {
        var css = await loadFile('src/css/23-actions.css');
        assert.ok(!/\.jobs-row-btn\.jobs-(pin-btn|card-dismiss)[^{]*\{[^}]*opacity:\s*0[;\s]/.test(css), 'no hover-reveal opacity:0 on pin/dismiss');
        assert.ok(/\.jobs-expand-card \{[^}]*--jobs-card-bg: var\(--bg-white\);[^}]*background: var\(--jobs-card-bg\)/.test(css), 'base card owns --jobs-card-bg');
        assert.ok(/\.jobs-expand-card\.is-current \{[^}]*--jobs-card-bg: var\(--bg-elevated/.test(css));
        assert.ok(!/\.jobs-expand-card\.jobs-read \{[^}]*background/.test(css), 'read cards are not greyed');
        assert.ok(/\.jobs-card-prs \.pr-sidebar-item \{[^}]*background: var\(--jobs-card-bg/.test(css), 'PR cards follow the card');
        var side = await loadFile('src/css/11-version.css');
        assert.ok(side.indexOf('jobs-card-bg') === -1, 'sidebar PR card styles untouched');
    });
    it('status pill sits on its own row under the title (head stays one card child)', async function() {
        var m = await load();
        var s = m.__scope;
        s.t = function(x) { return x; };
        s.escapeHtml = function(x) { return String(x); };
        s.escapeJsString = function(x) { return String(x); };
        s.UI_ICONS = { check: '<i>ck</i>', spinner: '<i>sp</i>', chat: '', close: '', bell: '' };
        s.currentChatId = 'other';
        s.getFinishedChatBell = function() { return null; };
        s._jobsChatState = function() { return 'running'; };
        s._jobsAccordionBodyHtml = function() { return ''; };
        // _jobsProgressBadgeHtml is module-internal: drive it via its deps.
        // (module functions can't be stubbed via __scope: a user-paused chat
        // gets the real 'Paused' badge through chatBadgeStateFor).
        s.isChatPaused = function() { return true; };
        s._jobsCardPrCardsHtml = function() { return ''; };
        s._jobsAccWorkersHtml = function() { return ''; };
        s._jobsChatTitleText = function(c) { return c.id; };
        s.chats = { a: { id: 'a', title: 'a', messages: [], pausedByUser: true } };
        var html = m._jobsExpandCardHtml({ id: 'a' });
        var tp = document.createElement('template'); tp.innerHTML = html;
        var card = tp.content.firstElementChild;
        var kids = Array.prototype.map.call(card.children, function(k) { return k.className; });
        assert.deepStrictEqual(kids, ['jobs-expand-card-head', 'jobs-expand-card-actions', 'jobs-expand-card-body'], 'card children unchanged');
        var head = card.children[0];
        var hk = Array.prototype.map.call(head.children, function(k) { return k.className.split(' ')[0]; });
        assert.strictEqual(hk.length, 3, 'indicator, title line, pill: ' + JSON.stringify(hk));
        assert.ok(/^jobs-row-(check|spinner|dot|bell)$|^jobs-unread-dot$/.test(hk[0]), 'leading indicator first: ' + hk[0]);
        assert.deepStrictEqual(hk.slice(1), ['jobs-expand-card-titleline', 'jobs-row-state-badge'], 'title line, then pill');
        assert.ok(head.querySelector('.jobs-expand-card-titleline > .jobs-expand-card-title'), 'title inside the title line');
        assert.ok(!head.querySelector('.jobs-expand-card-titleline .jobs-row-state-badge'), 'pill NOT on the title line');
        var css = await loadFile('src/css/23-actions.css');
        assert.ok(/\.jobs-expand-card-head \{[^}]*display: grid;[^}]*grid-template-columns: auto minmax\(0, 1fr\)/.test(css), 'head is a 2-column grid');
        assert.ok(/\.jobs-expand-card-titleline \{[^}]*grid-column: 2; grid-row: 1;/.test(css), 'title line on row 1, column 2');
        assert.ok(/\.jobs-expand-card-head > \.jobs-row-state-badge \{[^}]*grid-column: 2;/.test(css), 'pill aligned with the title column (row 2)');
        assert.ok(!/\.jobs-expand-card-head \.jobs-row-state-badge \{[^}]*flex: 0 100/.test(css), 'old inline shrink rule gone');
    });
});
