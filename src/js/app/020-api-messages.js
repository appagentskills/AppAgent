// SUB-NOTICE-META (B part 2b/2c): an injected sub-agent notice row that
// reaches the model in full (maybeCacheUserContent never caches it) and
// renders as cards (250's cached-pill gate). Only notices shown in the
// PARENT chat count: sub→parent reports (final, need_input 'mid'),
// lifecycle, sub→parent agent_message. Parent→sub inbox drains ('[N
// message(s) from parent / inbox]', core/097 _formatInboxDrain /
// _inboxDrainMeta — the instruction is uncapped) keep today's caching.
//  - Rows with subNotices: content minus each parent-chat notice's exact
//    meta.text span (removed once) is what the user added (typed text or
//    an attachment label — hasUserText is set for both). Not cached while
//    that remainder is <= the cache limit; cached as today only when the
//    user's own part alone exceeds it. No locatable parent-chat notice
//    (drain-only / drifted meta) → the legacy rule.
//  - Legacy rows: no hasUserText, not an inbox drain, and a report /
//    lifecycle shape (_hasLegacySubNoticeShape below).
// B part 2c: the whole predicate lives HERE, with no ui/175 dependency, so
// it answers the same in the worker bundle (buildAPIMessages; build/build.js
// WORKER_SHARED_FILES has no ui/175) and in the page (250's cached-pill
// gate): a row the model gets in full never renders as a cached pill.
// C3: a REAL user row — role 'user' that is organic (not injected) or an
// injected row carrying real user text merged in (hasUserText:true, e.g.
// text typed mid-run coalesced with a queued sub-agent notice). Injected-
// only rows (sub-agent reports, lifecycle/wake notices) are NOT user turns.
// Shared file (page + SW bundles); callers typeof-guard it with the same
// inline fallback.
function _isRealUserRow(m) {
    return !!m && m.role === 'user' && (!m.injected || m.hasUserText === true);
}

var _SUB_INBOX_HEAD_RE = /^\[\d{1,3} message\(s\) from parent \/ inbox\]/;
var _SUB_INBOX_ANY_RE = /\[\d{1,3} message\(s\) from parent \/ inbox\]/;
// Non-global copies of ui/175 SUB_NOTICE_RE / SUB_LIFECYCLE_RE, the render
// path's shapes (.test() on a non-global regex keeps no lastIndex state).
// Keep them in sync: test/sub-notice-review-fixes.test.js checks this gate
// against 175's render.
var _SUB_NOTICE_SHAPE_RE = /Sub-agent "([^"\n]{1,200})" \(([A-Za-z0-9_-]{1,80})\) reported \(([a-z_]{1,24})\)(?::\s?([\s\S]*?))?\s*\u2014 full report via await_handle\("([^"\n]{1,120})"\) or agent_status\./;
var _SUB_LIFECYCLE_SHAPE_RE = /\[sub-agent lifecycle\] ([^\n(]{1,200}?) \(([A-Za-z0-9_-]{1,80})\): ([^\n]{1,4000})/;
// Cheap substring pre-checks (the same three as 175 renderSubReportNotices):
// almost every row fails them all and never reaches a regex.
function _subNoticePrechecks(text) {
    return {
        final: text.indexOf('Sub-agent "') !== -1 && text.indexOf('await_handle(') !== -1,
        life: text.indexOf('[sub-agent lifecycle]') !== -1,
        inbox: text.indexOf('message(s) from parent / inbox]') !== -1
    };
}
// Legacy (pre-metadata) shape of a notice shown in the PARENT chat: a
// sub->parent report or a lifecycle notice, each regex behind its pre-check.
// Parent->sub inbox drains are not a match (_isInjectedSubNoticeRow
// excludes them first: they keep today's caching).
function _hasLegacySubNoticeShape(text, pre) {
    if (typeof text !== 'string') return false;
    pre = pre || _subNoticePrechecks(text);
    return (pre.final && _SUB_NOTICE_SHAPE_RE.test(text))
        || (pre.life && _SUB_LIFECYCLE_SHAPE_RE.test(text));
}
function _isInjectedSubNoticeRow(msg) {
    if (!msg || !msg.injected || typeof msg.content !== 'string') return false;
    var t = msg.content;
    if (Array.isArray(msg.subNotices) && msg.subNotices.length > 0) {
        var rest = t, found = 0;
        for (var i = 0; i < msg.subNotices.length; i++) {
            var sn = msg.subNotices[i];
            var mt = (sn && typeof sn.text === 'string') ? sn.text : '';
            // A drain meta's text IS the parent→sub drain: it stays in the
            // cacheable remainder.
            if (!mt || _SUB_INBOX_HEAD_RE.test(mt)) continue;
            var at = rest.indexOf(mt);
            if (at === -1) continue;
            rest = rest.slice(0, at) + rest.slice(at + mt.length);
            found++;
        }
        if (found > 0) {
            var limit = (typeof getCacheCharLimit === 'function') ? getCacheCharLimit() : 16000;
            return rest.trim().length <= limit;
        }
    }
    if (msg.hasUserText === true) return false;
    var pre = _subNoticePrechecks(t);
    if (pre.inbox && _SUB_INBOX_ANY_RE.test(t)) return false;
    return _hasLegacySubNoticeShape(t, pre);
}

// C2 UPDATE LEDGER (request-time only, never persisted). On a WAKE run —
// the latest role:'user' row (the run's anchor) is injected-only
// (!_isRealUserRow) — buildAPIMessages appends ONE block to that row's
// OUTGOING content listing every update since the last real user row:
// structured sub-notice metas (final / mid / message / lifecycle — core/097
// _subNoticeMeta; parent→sub inbox drains from 'parent' are instructions,
// not updates) and UI-only sub_msg rows (passive wake_parent:false reports,
// plus agent_message callouts with no model-visible twin), which stay
// dropped from the payload themselves. Emitted only with >= 2 items or an
// item the model was never sent; a lone notice that is the anchor itself
// gets none. Normal runs (real anchor) are byte-identical. Rows after the
// anchor are ignored and earlier rows are never touched, so the block is
// deterministic for a given anchor (prefix-cache stable within a run). No
// chat row is mutated and no role:'context' row is added (those persist).
var UPDATE_LEDGER_HEADER = 'Updates since the user\'s last message:';
var _LEDGER_MAX_ITEMS = 20, _LEDGER_MAX_CHARS = 2000, _LEDGER_LINE_MAX = 200;
function _ledgerHeadline(s) {
    var lines = String(s == null ? '' : s).split('\n');
    for (var i = 0; i < lines.length; i++) {
        var l = lines[i].replace(/^\s*(?:#{1,6}\s+|[-*>]\s+)/, '').replace(/\s+/g, ' ').trim();
        if (l) return l;
    }
    return '';
}
function _ledgerRowItems(row) {
    var out = [];
    if (!row) return out;
    if (row.role === 'sub_msg') {
        var passive = row.kind === 'passive_report';
        out.push({ kind: passive ? 'passive report' : 'message', agentId: row.subAgentId || null, name: row.subAgentName || null,
            status: row.status || null, headline: _ledgerHeadline(row.text), unsent: true,
            twinOf: passive ? null : String(row.text == null ? '' : row.text) });
        return out;
    }
    if (row.role !== 'user' || _isRealUserRow(row) || !Array.isArray(row.subNotices)) return out;
    row.subNotices.forEach(function(sn) {
        if (!sn || typeof sn !== 'object') return;
        if (sn.kind === 'message' && (!sn.agentId || sn.agentId === 'parent')) return;
        out.push({ kind: sn.kind || 'notice', agentId: sn.agentId || null, name: sn.name || null, status: sn.status || null,
            headline: _ledgerHeadline(sn.summary), summary: String(sn.summary == null ? '' : sn.summary) });
    });
    return out;
}
function _ledgerLine(it) {
    var who = (it.name && it.agentId && it.name !== it.agentId) ? it.name + ' (' + it.agentId + ')' : (it.agentId || it.name || 'sub-agent');
    var line = '- [' + it.kind + (it.unsent ? ', not sent to you before' : '') + '] ' + who
        + (it.status ? ' \u2014 ' + it.status : '') + (it.headline ? ': ' + it.headline : '');
    return line.length > _LEDGER_LINE_MAX ? line.slice(0, _LEDGER_LINE_MAX - 1) + '\u2026' : line;
}
// Newest items win: <= 20 lines and <= ~2000 chars, older ones counted in
// one leading "…N earlier" line.
function _formatUpdateLedger(items) {
    var lines = [], used = UPDATE_LEDGER_HEADER.length, kept = 0;
    for (var i = items.length - 1; i >= 0 && kept < _LEDGER_MAX_ITEMS; i--) {
        var l = _ledgerLine(items[i]);
        if (used + 1 + l.length + (i > 0 ? 48 : 0) > _LEDGER_MAX_CHARS) break;
        lines.unshift(l); used += 1 + l.length; kept++;
    }
    var omitted = items.length - kept;
    if (omitted > 0) lines.unshift('- \u2026' + omitted + ' earlier update' + (omitted === 1 ? '' : 's') + ' not listed');
    return UPDATE_LEDGER_HEADER + '\n' + lines.join('\n');
}
// LEGACY TWIN: a pre-#968 build delivered an agent_message's model-visible
// notice as an injected row of only role/content/injected (no subNotices
// meta), content = core/097 agentMessage to:'parent' '[sub-agent lifecycle]
// <name> (<agentId>): sent a message: ' + the text flattened
// (/\s*\n+\s*/g -> ' ') and capped at 3800 (a #969-build row may add a
// _withWakeFinalReminder line). True when such a row in msgs[start..end]
// contains this callout's notice, i.e. the callout WAS sent. Anchored on
// BOTH edges: the flat text never contains '\n' and whatever may follow a
// notice (the reminder line, the '\n\n' coalescing join) starts with '\n',
// so a hit counts only at end-of-row or right before a '\n' ("Done" is not
// "Done with phase 1"); every occurrence in the row is tried. Rows with a
// non-empty subNotices are left to the meta-twin filter, so windows without
// legacy rows are byte-identical. Self-contained: the worker bundle has no
// ui/175.
function _ledgerLegacyTwinSent(msgs, start, end, agentId, text) {
    var flat = String(text == null ? '' : text).replace(/\s*\n+\s*/g, ' ').slice(0, 3800);
    if (!agentId || !flat) return false;
    var needle = '(' + agentId + '): sent a message: ' + flat;
    for (var k = start; k <= end; k++) {
        var r = msgs[k];
        if (!r || r.role !== 'user' || _isRealUserRow(r)) continue;
        if (Array.isArray(r.subNotices) && r.subNotices.length > 0) continue;
        if (typeof r.content !== 'string') continue;
        for (var at = r.content.indexOf(needle); at !== -1; at = r.content.indexOf(needle, at + 1)) {
            var next = at + needle.length;
            if (next === r.content.length || r.content.charAt(next) === '\n') return true;
        }
    }
    return false;
}
// C-gate: after-response hook rows (isHookMessage: role 'user', NOT
// injected — worker/020-page-stubs.js) are neither the anchor nor a window
// boundary (same convention as findHookAnswerSpan and the progress-hook
// walk). Otherwise a hook run between two wake runs truncated the window at
// the hook row, and a hook run's own request dropped the wake anchor's block
// (payload prefix changed -> prefix-cache miss).
function _isLedgerBoundaryRow(m) { return _isRealUserRow(m) && m.isHookMessage !== true; }
// {anchorIdx, block, count} or null (normal run / nothing worth listing).
function _buildUpdateLedger(msgs) {
    if (!Array.isArray(msgs)) return null;
    var ai = -1;
    for (var i = msgs.length - 1; i >= 0; i--) { if (msgs[i] && msgs[i].role === 'user' && msgs[i].isHookMessage !== true) { ai = i; break; } }
    if (ai === -1 || _isRealUserRow(msgs[ai])) return null;
    var start = ai;
    while (start > 0 && !_isLedgerBoundaryRow(msgs[start - 1])) start--;
    var items = [];
    for (var k = start; k <= ai; k++) items.push.apply(items, _ledgerRowItems(msgs[k]));
    // An agent_message sub_msg callout whose model-visible twin (kind
    // 'message' meta, same sub, same summary) is in the window is listed once.
    items = items.filter(function(it) {
        if (it.twinOf == null) return true;
        return !items.some(function(o) { return o.twinOf == null && o.kind === 'message' && o.agentId === it.agentId && o.summary === it.twinOf; });
    });
    // A callout left without a meta twin whose notice a pre-#968 build
    // delivered in the window (_ledgerLegacyTwinSent) was sent too: it is
    // listed as a plain [message] item.
    items.forEach(function(it) {
        if (it.twinOf != null && it.unsent && _ledgerLegacyTwinSent(msgs, start, ai, it.agentId, it.twinOf)) { it.unsent = false; it.twinOf = null; }
    });
    var unsent = items.some(function(it) { return it.unsent; });
    if (items.length < 2 && !unsent) return null;
    return { anchorIdx: ai, block: _formatUpdateLedger(items), count: items.length };
}
function _appendLedgerBlock(content, block) {
    if (!block) return content;
    if (typeof content === 'string') return content + '\n\n' + block;
    if (Array.isArray(content)) return content.concat([{ type: 'text', text: block }]);
    return content;
}
// C2b: core/097 _withWakeFinalReminder appends a reminder line to EVERY wake
// notice, so a coalesced row with N notices repeats it N times. Outgoing
// USER content keeps ONE whole-line copy (the last); persisted rows and
// their meta.text spans are untouched. The literal lives ONLY in 097 (its
// helper stays self-contained — standalone-extracted by
// test/chat-streaming-worker-dialogue.test.js); the line is derived from it.
function _wakeFinalReminderLine() {
    if (typeof _withWakeFinalReminder !== 'function') return '';
    var s = String(_withWakeFinalReminder(''));
    return s.charAt(0) === '\n' ? s.slice(1) : s;
}
function _collapseReminderText(text, line) {
    if (typeof text !== 'string' || !line) return text;
    var first = text.indexOf(line);
    if (first === -1 || text.indexOf(line, first + line.length) === -1) return text;
    var lines = text.split('\n'), last = lines.lastIndexOf(line);
    if (last === -1) return text;
    var out = lines.filter(function(l, i) { return l !== line || i === last; });
    return out.length === lines.length ? text : out.join('\n');
}
function _collapseWakeReminders(content, line) {
    if (!line) return content;
    if (typeof content === 'string') return _collapseReminderText(content, line);
    if (!Array.isArray(content)) return content;
    var changed = false;
    var parts = content.map(function(p) {
        if (!p || p.type !== 'text' || typeof p.text !== 'string') return p;
        var t = _collapseReminderText(p.text, line);
        if (t === p.text) return p;
        changed = true;
        return Object.assign({}, p, { text: t }); // keeps cache_control etc.
    });
    return changed ? parts : content;
}

function buildAPIMessages(chatMessages, chatId) {
    // Clone messages to avoid mutating originals
    var cloned = chatMessages.map(function(m) { return Object.assign({}, m); });
    // C2: request-time update ledger (null on normal runs).
    // typeof-guarded: some tests extract buildAPIMessages standalone.
    var _ledger = (typeof _buildUpdateLedger === 'function') ? _buildUpdateLedger(chatMessages) : null;

    // Helper: substitute a cache reference for any user message content that exceeds
    // the cache limit. Mirrors how oversized tool results are cached. Mutates the
    // ORIGINAL message (not the clone) to persist the cachedContentId across renders.
    function maybeCacheUserContent(originalMsg, content) {
        if (typeof content !== 'string') return content;
        if (typeof processUserMessageForCache !== 'function') return content;
        if (!chatId) return content;
        // SUB-NOTICE-META (B part 2b): an injected sub-agent notice row is
        // never cached — the model gets the full notice, even when a stale
        // cachedContentId is on the row (a cached notice read as "[User
        // pasted a long message]"). Typed-text rows, normal user rows and
        // context rows are untouched.
        if (originalMsg && originalMsg.role === 'user' && typeof _isInjectedSubNoticeRow === 'function' && _isInjectedSubNoticeRow(originalMsg)) return content;
        // Already cached on a previous turn? Reuse the existing reference.
        if (originalMsg && originalMsg.cachedContentId) {
            var chat = chats[chatId];
            if (chat && chat.cachedToolResults && chat.cachedToolResults[originalMsg.cachedContentId]) {
                var existing = chat.cachedToolResults[originalMsg.cachedContentId];
                var sizeKB = Math.round((existing.size || content.length) / 1024);
                var limitKB = Math.round((typeof getCacheCharLimit === 'function' ? getCacheCharLimit() : 16000) / 1024);
                var totalLines = (existing.fullContent || content).split('\n').length;
                return '[User pasted a long message — cached]\n' + JSON.stringify({
                    _cached_user_message: {
                        message: 'USER MESSAGE CACHED: ' + sizeKB + 'KB, ' + totalLines + ' lines (limit: ' + limitKB + 'KB). Use cached_content_read/search/outline with content_id "' + originalMsg.cachedContentId + '".',
                        content_id: originalMsg.cachedContentId,
                        size: sizeKB + 'KB',
                        totalLines: totalLines
                    }
                }, null, 2);
            }
        }
        var cached = processUserMessageForCache(chatId, content);
        if (!cached) return content;
        if (originalMsg) originalMsg.cachedContentId = cached.contentId;
        // Persist the new cachedContentId on the chat
        try { if (typeof saveChatsToStorage === 'function') saveChatsToStorage(); } catch (e) {}
        return cached.apiContent;
    }

    var result = cloned.map(function(m, idx) {
        var original = chatMessages[idx];
        if (m.role === 'user') {
            var _uc = maybeCacheUserContent(original, m.content);
            if (_ledger && idx === _ledger.anchorIdx) _uc = _appendLedgerBlock(_uc, _ledger.block);
            return { role: 'user', content: _uc };
        }
        if (m.role === 'assistant') {
            var msg = { role: 'assistant' };
            if (m.content) msg.content = m.content;
            if (m.tool_calls) msg.tool_calls = m.tool_calls;
            // reasoning_details replay policy — ONE regime for every model /
            // provider: every COMPLETED assistant turn replays its stored
            // reasoning_details (thinking blocks, encrypted reasoning items) on
            // every request. Per-provider transforms decide what to do with them:
            //   • Anthropic (transformMessageToAnthropic, background.js): thinking
            //     blocks with a signature → `thinking` blocks. Fable 5.1+ REQUIRES
            //     every prior block (chained; dropping one mid-history invalidates
            //     every block after it — with block_binding drop_block the API
            //     then silently drops them and reports input_transformations).
            //     Older Claude models: the API ignores previous-turn thinking
            //     ("Keep sending the full history and let the API decide on each
            //     request ... no error, not billed" — preserved-thinking docs),
            //     so replaying is free and keeps the history model-portable.
            //   • ChatGPT / Codex Responses (transformToResponses, background.js):
            //     `reasoning.encrypted` items (format openai-responses-v1) →
            //     `{type:'reasoning', id, summary, encrypted_content}` items
            //     ("pass back all reasoning items, function call items, and
            //     function call output items" — OpenAI reasoning guide).
            //   • OpenRouter (raw chat-completions passthrough): documented
            //     multi-turn shape ("To preserve reasoning context across multiple
            //     turns ... message.reasoning_details (array): Pass the full
            //     reasoning_details block").
            // Only leading blocks may be trimmed, which is what context trimming
            // of the OLDEST messages does. A thinking-ONLY row (aborted/interrupted
            // stream that never produced text or a tool call) is NOT replayed —
            // it was never a completed turn, and a thinking-only assistant
            // message (especially as the LAST message) is not a valid request
            // shape; the empty-message filter below then drops the row.
            if (m.reasoning_details && m.reasoning_details.length > 0 && (msg.content || msg.tool_calls)) {
                msg.reasoning_details = m.reasoning_details;
            }
            // Anthropic content-block order captured at stream time (see
            // 010-llm-streaming.js). Consumed only by transformMessageToAnthropic,
            // which validates it against content/tool_calls/reasoning_details and
            // falls back to legacy ordering on any mismatch. callOpenRouterStreaming
            // strips it for every non-Claude-OAuth provider.
            if (Array.isArray(m.block_order) && m.block_order.length > 0 && (msg.content || msg.tool_calls)) {
                msg.block_order = m.block_order;
            }
            // Skip empty assistant messages (streaming placeholders) - they have no content,
            // no tool_calls, and no reasoning. Sending them causes hangs with image+tool combos.
            if (!msg.content && !msg.tool_calls && !msg.reasoning_details) return null;
            return msg;
        }
        if (m.role === 'tool') return { role: 'tool', tool_call_id: m.tool_call_id, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) };
        if (m.role === 'browser_context') return { role: 'user', content: '[Browser Context] The user is viewing a page in the embedded browser at URL: ' + m.url + '. When they ask about "this page" or "the page", they are referring to this URL.' };
        // Handle screenshot messages - convert to multimodal user message with image
        if (m.role === 'screenshot') {
            var screenshotLabel = m.name || m.description || 'screenshot';
            // Providers only accept inline data: URLs (converted to base64
            // source for Anthropic) or real https URLs in image blocks —
            // anything else (undefined/'' from an evicted-but-not-rehydrated
            // screenshot row, chrome-extension://, blob:, http://) is a hard
            // 400 (Anthropic: "Only HTTPS URLs are supported"). If the
            // payload is missing (hydration failed / backing file GC'd),
            // degrade to a text placeholder instead of crashing the run.
            var _ssSrc = (typeof m.base64 === 'string') ? m.base64 : '';
            if (_ssSrc.indexOf('data:') !== 0 && _ssSrc.indexOf('https://') !== 0) {
                return { role: 'user', content: '[image no longer available: ' + screenshotLabel + ']' };
            }
            return {
                role: 'user',
                content: [
                    { type: 'text', text: '[Screenshot captured: ' + screenshotLabel + (m.width && m.height ? ' (' + m.width + 'x' + m.height + ')' : '') + ']\nAnalyze this image to help the user. Describe what you see and identify any issues, UI elements, or relevant details.' },
                    { type: 'image_url', image_url: { url: _ssSrc } }
                ]
            };
        }
        // Handle PDF messages - send full file every time, don't rewrite history
        if (m.role === 'pdf') {
            var pdfLabel = m.name || m.description || 'document.pdf';
            var pdfFilename = pdfLabel.endsWith('.pdf') ? pdfLabel : pdfLabel + '.pdf';
            // Same eviction guard as the screenshot arm above: an evicted pdf
            // row without base64 would send file_data: undefined (provider 400).
            if (typeof m.base64 !== 'string' || !m.base64) {
                return { role: 'user', content: '[PDF no longer available: ' + pdfLabel + ']' };
            }
            return {
                role: 'user',
                content: [
                    { type: 'text', text: '[PDF attached: ' + pdfLabel + ']' },
                    { type: 'file', file: { filename: pdfFilename, file_data: m.base64 } }
                ]
            };
        }
        // Handle file attachments (spreadsheets, etc.) - inform Agent to use read_attached_file tool
        if (m.role === 'file') {
            var fileLabel = m.name || 'file';
            var fileSize = m.size ? ' (' + formatFileSize(m.size) + ')' : '';
            var fileIdNote = m.file_id ? ' (file_id: ' + m.file_id + ')' : '';
            return {
                role: 'user',
                content: '[File attached: ' + fileLabel + fileSize + fileIdNote + ']\nUse the read_attached_file tool or get_file tool to read this file\'s content.'
            };
        }
        // Handle context messages (document references, etc.)
        if (m.role === 'context') return { role: 'user', content: maybeCacheUserContent(original, m.content) };
        // sub_report rows are a UI-only callout in the parent transcript:
        // they record what a sub-agent told the parent via report_to_parent /
        // agent_message-to-parent. The same payload reaches the parent model
        // through await_handle's tool result (terminal reports) — echoing it
        // here would double-feed and break the strict assistant↔tool turn
        // alternation when injected mid tool-result chain. Drop them.
        if (m.role === 'sub_report') return null;
        return null;
    }).filter(Boolean);

    // Anthropic invariant: no two consecutive user messages (strict role
    // alternation). Sub-agent chats can break this when (a) spawn_sub_agent
    // creates a chat with [user(task)] and the pool is full, then
    // agent_message pushes another user message before the loop ever runs,
    // or (b) wakeSubAgent drains the inbox onto a chat whose last message
    // was already a user row. Parent chats can also break it when a
    // sub_report row (dropped above) was sandwiched between two user rows.
    // Merge consecutive same-role string-content user messages into a
    // single concatenated message so the API request stays well-formed.
    var merged = [];
    for (var mi = 0; mi < result.length; mi++) {
        var cur = result[mi];
        var prev = merged.length ? merged[merged.length - 1] : null;
        if (prev && prev.role === 'user' && cur.role === 'user'
            && typeof prev.content === 'string' && typeof cur.content === 'string') {
            prev.content = prev.content + '\n\n' + cur.content;
            continue;
        }
        merged.push(cur);
    }
    // C2b: one reminder line per outgoing user message (after the merge, so
    // consecutive rows joined above collapse too). Same reference = no change.
    var _remLine = (typeof _wakeFinalReminderLine === 'function') ? _wakeFinalReminderLine() : '';
    if (_remLine && typeof _collapseWakeReminders === 'function') {
        for (var di = 0; di < merged.length; di++) {
            if (merged[di].role !== 'user') continue;
            var _dc = _collapseWakeReminders(merged[di].content, _remLine);
            if (_dc !== merged[di].content) merged[di] = Object.assign({}, merged[di], { content: _dc });
        }
    }
    return merged;
}

// Single source of truth for the pause button's visible label. Read pause state
// for the given chat and set the button HTML accordingly. Idempotent — safe to
// call from any cleanup or render site without thinking about previous state.
function syncPauseButtonUI(chatId) {
    var pauseBtn = document.getElementById('pause-btn');
    if (!pauseBtn) return;
    var id = chatId || currentChatId;
    // Per-chat: do NOT consult global `paused` — it would mislabel the button on a
    // chat that was never paused, just because some other chat was paused earlier.
    var isPaused = !!(id && pausedChats[id] === true);
    pauseBtn.innerHTML = isPaused
        ? '<span class="btn-icon">' + UI_ICONS.play + '</span>Resume'
        : '<span class="btn-icon">' + UI_ICONS.pause + '</span>Pause';
}

function togglePause() {
    // Per-chat pause: only halts the chat the user is currently looking at, not
    // every running chat (background Action chats stay running). The global `paused`
    // is kept in sync with the foreground chat for legacy UI bits that still read it.
    var chatId = currentChatId;
    if (!chatId) return;
    // Per-chat ONLY. Do NOT read the legacy global `paused` here — if another chat
    // was paused earlier, this chat would inherit that flag and Resume would fire
    // a fresh runAgent() the user never asked for (B-2).
    var wasPaused = pausedChats[chatId] === true;
    var nowPaused = !wasPaused;
    // Persist the user-pause on the chat record too (chat.pausedByUser) so the
    // paused state survives a panel reload — see setChatPausedPersistent
    // (core/030-config.js); loadChatsFromStorage rehydrates pausedChats from it.
    setChatPausedPersistent(chatId, nowPaused);
    // Mirror foreground state into the legacy global so legacy reads (after-response
    // hooks, browser-notification gate) reflect the focused chat. Background chats
    // that pause/resume independently do NOT touch the global — their loops only
    // consult `pausedChats[chatId]` via `isChatPaused`.
    paused = nowPaused;
    syncPauseButtonUI(chatId);

    if (nowPaused) {
        // Stop the in-flight stream / tool immediately so Pause feels responsive.
        // The agent loop catches the AbortError as a user-abort, drops the partial
        // assistant message, then exits cleanly because pausedChats[chatId] is now true
        // (the loop's `while (!isChatPaused(chatId))` condition fails next iteration).
        // POST-OFFSCREEN-RELOCATION: the stream / interrupt resolvers live in the
        // offscreen runtime, not on this page — the maps below are empty in the
        // page bundle. We still call them defensively (no-ops) AND push the
        // pause state over the bus so offscreen aborts on its side.
        var ac = currentStreamAbortControllers[chatId];
        if (ac && typeof ac.abort === 'function') {
            try { ac.abort(); } catch (e) {}
        }
        var interruptFn = interruptResolversByChatId[chatId];
        if (typeof interruptFn === 'function') {
            try { interruptFn(); } catch (e) {}
        }
        // PR-PAUSE (B2): propagate=true — the USER paused this chat, so its
        // live sub-agent subtree stands down too (SW: pauseDescendantsOfChat).
        // Only this button path sets the flag; stop/dismiss halts do not.
        if (typeof pushPauseToggleToOffscreen === 'function') {
            pushPauseToggleToOffscreen(chatId, true, undefined, undefined, true);
        }
        if (typeof pushInterruptToOffscreen === 'function') {
            pushInterruptToOffscreen(chatId, false);
        }
        // B-A2: also unblock any approval the loop is parked on. Without this,
        // pausing a chat that's awaiting tool approval is a no-op — the loop stays
        // parked on the resolver promise, and Resume can't re-enter because the
        // original loop never exited (early-return in runAgent on runningChatIds).
        // Resolve with `false` (denied) so the loop falls through to its next pause
        // check and exits cleanly. Inline approval messages remain `pending` in the
        // transcript so the user can re-approve after Resume.
        rejectPendingApprovalsForChat(chatId);
        return;
    }

    // Resuming: tell offscreen the pause flag is cleared (propagate=true → the
    // SW re-queues the subs THIS chat's Pause parked, via
    // resumeDescendantsOfChat), then kick off a fresh run via the shim if this
    // chat isn't already known-running.
    if (typeof pushPauseToggleToOffscreen === 'function') {
        pushPauseToggleToOffscreen(chatId, false, undefined, undefined, true);
    }
    // SWM-T5: bump the interrupt generation too, so a stale interrupt(false) retry
    // chain armed during a port-down window can't survive resume and abort the run.
    if (typeof _supersedeInterruptToggle === 'function') _supersedeInterruptToggle(chatId);
    if (wasPaused && !nowPaused && !runningChatIds[chatId]) {
        runAgent();
    }
}

function showPauseButton(chatId) {
    var pauseBtn = document.getElementById('pause-btn');
    if (pauseBtn) pauseBtn.classList.add('visible');
    // Always sync the label when revealing — prevents stale "Pause" leaking in when
    // the chat is actually paused (e.g. cross-tab navigation back to a paused chat).
    // Forward the explicit chatId so callers that haven't yet updated `currentChatId`
    // (e.g. selectChat reveals the new chat's pause state BEFORE assigning currentChatId)
    // get the correct label. Without this, syncPauseButtonUI's `chatId || currentChatId`
    // fallback reads the stale-previous chat's pausedChats flag and mislabels the button.
    syncPauseButtonUI(chatId);
    // Pause and Continue are mutually exclusive — only one can be shown at a time.
    hideContinueButton();
}

function hidePauseButton() {
    var pauseBtn = document.getElementById('pause-btn');
    if (pauseBtn) pauseBtn.classList.remove('visible');
}

function showRetryButton() {
    var retryBtn = document.getElementById('retry-btn');
    if (retryBtn) {
        retryBtn.classList.add('visible');
        // PR-PAUSE (R6): see showContinueButton — Retry re-issues the FAILED
        // request; it is never shown alongside Continue.
        retryBtn.title = 'Retry the failed request';
    }
    hideContinueButton();
}

function hideRetryButton() {
    var retryBtn = document.getElementById('retry-btn');
    if (retryBtn) retryBtn.classList.remove('visible');
}

function showContinueButton() {
    var btn = document.getElementById('continue-btn');
    if (btn) {
        btn.classList.add('visible');
        // PR-PAUSE (R6): self-explanatory affordance — Continue resumes an
        // interrupted run, Retry re-issues a FAILED request. They used to be
        // shown together after an errored run and both just called runAgent.
        btn.title = 'Resume the interrupted run';
    }
    // Pause and Continue are mutually exclusive.
    hidePauseButton();
    // PR-PAUSE (R6): so is Retry — an errored chat shows Retry only.
    if (typeof hideRetryButton === 'function') hideRetryButton();
}

function hideContinueButton() {
    var btn = document.getElementById('continue-btn');
    if (btn) btn.classList.remove('visible');
}

function retryLastCall() {
    if (!lastApiError) return;
    // Target the chat that actually errored, not whatever the user is
    // currently looking at. Without this, retrying a 429 after the user
    // switched chats kicks runAgent on the wrong chat (no-op for the
    // error context, surprise loop on the other).
    var targetChatId = lastApiError.chatId || currentChatId;
    hideRetryButton();
    // Continue and Retry can both be visible after an errored runFinished
    // (the handler shows Continue when the chat is interrupted). If Retry
    // doesn't dismiss Continue, the user clicks Retry, sees nothing change
    // (Continue still sitting there, no spinner), and clicks Continue
    // assuming Retry was broken. Mirror continueAgent: hide both.
    hideContinueButton();
    // RETRY-F2-SNACK: hide the non-auto-dismiss error snackbar (selectChat/newChat do this too).
    if (typeof hideSnackbar === 'function') hideSnackbar();
    lastApiError = null;
    // B13: also clear the errored chat's persisted per-chat copy (set by R-2) so the
    // jobs badge / dropdown row don't stay red after a focused Retry. runStarted also
    // clears it, but do it now to avoid a transient stale-error flash.
    if (targetChatId && chats[targetChatId] && typeof dispatchChatMeta === 'function') dispatchChatMeta(targetChatId, { _lastApiError: null }); // FLUX-4C lane
    // Defensive paused-state reset — matches continueAgent. A 429 itself
    // doesn't set pausedChats, but if a stale pause flag survives from
    // earlier in the session, runAgent's `while (!isChatPaused)` gate
    // trips immediately and the retry silently no-ops. This is the
    // single difference that made Continue "work" where Retry didn't.
    paused = false;
    if (targetChatId && typeof pausedChats !== 'undefined') {
        // Clear the persisted pausedByUser flag too so the pause doesn't
        // resurrect on the next panel reload.
        setChatPausedPersistent(targetChatId, false);
    }
    if (typeof syncPauseButtonUI === 'function') {
        syncPauseButtonUI(targetChatId);
    }
    // Fire immediately. The previous 1000ms setTimeout gave no visible
    // feedback and made Retry feel dead — by the time the loop kicked
    // off, the user had already clicked Continue. The SW-side run-agent
    // handler is idempotent (early-returns when runningChatIds[chat] is
    // set), so there's no double-loop risk if the user double-clicks.
    // RETRY-F2-BADGE: synchronous badge/dropdown repaint, mirroring retryChat (RETRY1-F1).
    if (typeof renderJobsBadge === 'function') { try { renderJobsBadge(); } catch (e2) {} }
    if (typeof _getOpenJobsDropdown === 'function' && typeof renderJobsDropdown === 'function') {
        try { var _jdRetryLast = _getOpenJobsDropdown(); if (_jdRetryLast) renderJobsDropdown(_jdRetryLast); } catch (e2) {}
    }
    runAgent(targetChatId);
}

// R-3 (partial): chat-targeted retry primitive for an UNFOCUSED chat's
// persisted API error (chats[id]._lastApiError, set by R-1). retryLastCall
// above reads the GLOBAL lastApiError — only the focused chat updates that — so
// it can't retry a background/unfocused chat's error without first navigating
// there. This reads the per-chat copy and re-runs that specific chat.
// runAgent(overrideChatId) already accepts a chatId, so no adaptation is needed.
// B15 wired this up: the jobs-dropdown per-chat Retry button calls retryChat
// (onclick=retryChat at tools/120-actions.js:2024) and the badge/dropdown surface
// an unfocused chat's API error. So this is now the chat-targeted retry used by
// the jobs dropdown's per-chat Retry button — no longer the deferred/unused half
// of R-3. R-1 + R-2 restore recoverability for the FOCUSED chat (navigating to
// the errored chat re-shows the toolbar Retry); retryChat handles the
// unfocused/background-chat case directly from the dropdown.
function retryChat(chatId) {
    var e = chats[chatId] && chats[chatId]._lastApiError;
    if (!e) return;
    // B13: only touch the GLOBAL (toolbar Retry source) when this chat is focused —
    // otherwise retrying a background chat's error clobbers the focused chat's.
    if (chatId === currentChatId) {
        // RETRY-F1-GAP: F1 repainted only the dropdown/badge; the focused chat kept a live toolbar
        // Retry + error snackbar AND this used to RE-ARM the global lastApiError toward the chat
        // being retried. Consume it and hide the toolbar surface, mirroring retryLastCall/selectChat.
        lastApiError = null;
        if (typeof hideRetryButton === 'function') hideRetryButton();
        if (typeof hideContinueButton === 'function') hideContinueButton();
        // RETRY-F2-SNACK: also hide the non-auto-dismiss error snackbar (selectChat/newChat do this too).
        if (typeof hideSnackbar === 'function') hideSnackbar();
    }
    if (typeof dispatchChatMeta === 'function') dispatchChatMeta(chatId, { _lastApiError: null }); // consumed — clear so badge/dropdown row don't stay red (FLUX-4C lane)
    // RETRY1-F1: re-render the jobs badge + open dropdown synchronously, mirroring
    // selectChat (170:547-552) and newChat (170:420-425). Without this, if
    // runStarted never fires (SW guard sees a stale isRunning, or the SW is
    // mid-eviction) the dropdown keeps a red error row + a now-dead Retry button.
    if (typeof renderJobsBadge === 'function') { try { renderJobsBadge(); } catch (e2) {} }
    if (typeof _getOpenJobsDropdown === 'function' && typeof renderJobsDropdown === 'function') {
        try { var _jdRetry = _getOpenJobsDropdown(); if (_jdRetry) renderJobsDropdown(_jdRetry); } catch (e2) {}
    }
    runAgent(chatId);
}

// Continue an interrupted run (e.g. after a page reload mid-stream).
// Behaves the same as retryLastCall but doesn't depend on lastApiError —
// the agent loop's own interrupted-tool-call logic stitches the conversation
// back together.
function continueAgent() {
    hideContinueButton();
    hideRetryButton();
    // RETRY-F1: hide the non-auto-dismiss error snackbar (mirrors retryLastCall @:267,
    // retryChat @:324, selectChat/newChat). Without this, Continue resumes the run but
    // leaves the pinned API-error snackbar sitting on screen.
    if (typeof hideSnackbar === 'function') hideSnackbar();
    lastApiError = null;
    paused = false;
    // Defensive: skip if no chat is selected. (`pausedChats` is module-level and
    // always defined — the previous `&& pausedChats` guard was dead code.)
    if (!currentChatId) return;
    // Clears the persisted pausedByUser flag too (survives-reload pause state).
    setChatPausedPersistent(currentChatId, false);
    // Use the single source of truth for the label rather than a manual innerHTML
    // write — keeps every render path consistent (e.g. if syncPauseButtonUI is
    // ever extended with extra state, continueAgent picks it up for free).
    syncPauseButtonUI(currentChatId);
    runAgent();
}

// B-A2: resolve any pending approval promise for the given chat with `false` so
// a parked agent loop can exit cleanly when the user pauses. The approval message
// in the transcript is mutated to `denied` so the inline render and the resulting
// tool_result are consistent (otherwise the inline block stays `pending` while
// the agent sees a denial — confusing for the user). The inline block keeps the
// approval as part of the conversation history so the user has a record of what
// was queued and abandoned.
function rejectPendingApprovalsForChat(chatId) {
    if (!chatId || typeof pendingToolApprovals !== 'object') return;
    var keys = Object.keys(pendingToolApprovals);
    var chat = chats[chatId];
    var changed = false;
    for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        var entry = pendingToolApprovals[k];
        if (!entry || entry.chatId !== chatId) continue;
        // Mark the inline message denied (with a marker so we can distinguish
        // pause-driven denials from explicit user denials in future code).
        if (chat && chat.messages && chat.messages[entry.approvalIndex]) {
            var m = chat.messages[entry.approvalIndex];
            if (m && m.role === 'approval' && m.status === 'pending') {
                m.status = 'denied';
                m.deniedByPause = true;
                changed = true;
            }
        }
        try { entry.resolve(false); } catch (e) {}
        delete pendingToolApprovals[k];
    }
    if (changed && typeof saveChatsToStorage === 'function') {
        try { saveChatsToStorage(); } catch (e) {}
    }
}

// Detect whether a chat looks like it was interrupted mid-stream.
// True when: there's no active agent loop for this chat AND the conversation
// ends in a state that needs the agent to take another turn (streaming flag
// still set, dangling tool calls, trailing user/tool message, etc.).
//
// Auxiliary attachment roles (screenshot/pdf/file/context/browser_context) are
// transcript-only — they're appended after a user/tool/assistant turn and don't
// themselves indicate a turn boundary. The deferredScreenshots batch in
// `runAgent` (`56-agent-loop.js:701-708`) pushes them AFTER tool results, so an
// interrupted run can leave the chat ending on an aux role. Walk backward past
// aux roles to find the last "real" message, then apply the standard logic.
var _AUX_ROLES_FOR_INTERRUPTION = ['screenshot', 'pdf', 'file', 'context', 'browser_context'];
// Answer-card hook tools (see ANSWER_CARD_TOOLS in 030-agent-loop.js): when a
// turn consists ONLY of these and all succeed, the loop intentionally ends the
// run right after recording their results (`_answerCardOnlyTurn` break) — no
// final LLM round-trip. That leaves the transcript ending on role:'tool'
// messages for a chat that finished NORMALLY. Skip completed (non-placeholder)
// answer-card results in the walk-back so they don't read as an interrupted
// run; placeholders (`_placeholder: true`, hook never actually ran) still
// count as interruption.
var _ANSWER_CARD_TOOLS_FOR_INTERRUPTION = { set_chat_title: true, set_tldr: true, set_links: true, set_caveat: true };
function isChatInterrupted(chat) {
    if (!chat || !chat.id || !Array.isArray(chat.messages) || chat.messages.length === 0) return false;
    if (typeof runningChatIds !== 'undefined' && runningChatIds[chat.id]) return false;
    var msgs = chat.messages;
    // Walk back past auxiliary attachment roles and completed answer-card hook
    // results. If the chat is entirely aux (impossible in practice — always
    // preceded by a user msg — but defensive), treat as not interrupted.
    var lastIdx = msgs.length - 1;
    while (lastIdx >= 0) {
        var _wm = msgs[lastIdx];
        if (_AUX_ROLES_FOR_INTERRUPTION.indexOf(_wm.role) >= 0) { lastIdx--; continue; }
        // Only skip GENUINE results: abandoned/interrupted markers (written by
        // recordToolResult on pause/interrupt, which deletes _placeholder) start
        // with '[Tool call ' — those mean the hook turn was cut short and MUST
        // count as an interruption so Continue is offered.
        if (_wm.role === 'tool' && _wm.name && _ANSWER_CARD_TOOLS_FOR_INTERRUPTION[_wm.name] && !_wm._placeholder &&
            !(typeof _wm.content === 'string' && _wm.content.indexOf('[Tool call ') === 0)) { lastIdx--; continue; }
        break;
    }
    if (lastIdx < 0) return false;
    var last = msgs[lastIdx];
    if (last.role === 'user') return true;
    if (last.role === 'tool') return true;
    if (last.role === 'assistant') {
        if (last.isStreaming) return true;
        if (last.tool_calls && last.tool_calls.length > 0) {
            // Any tool_call without a matching tool result after this assistant message
            // means the loop didn't finish processing tools.
            for (var i = 0; i < last.tool_calls.length; i++) {
                var tcId = last.tool_calls[i].id;
                var found = false;
                // Search the range AFTER the assistant message for a matching tool result.
                // (Aux messages between lastIdx and msgs.length-1 are skipped naturally
                // because they have role !== 'tool'.)
                for (var j = msgs.length - 1; j > lastIdx; j--) {
                    var m = msgs[j];
                    if (m.role === 'tool' && m.tool_call_id === tcId) { found = true; break; }
                }
                if (!found) return true;
            }
        }
    }
    return false;
}

// Show the Continue button if the chat is interrupted, otherwise hide it.
// Call this when entering a chat or after init to surface the Continue affordance.
function refreshContinueButtonForChat(chatId) {
    if (!chatId || typeof chats === 'undefined' || !chats[chatId]) {
        hideContinueButton();
        return;
    }
    // PR-PAUSE (R6): Retry and Continue are now mutually exclusive. When the
    // chat has a recorded API error, Retry owns the affordance (it re-issues
    // the failed request and clears the error); Continue is only offered for a
    // clean interruption. Previously both could be visible at once and both
    // simply called runAgent(chatId), which read as one of them being broken.
    var _errForChat = (typeof lastApiError !== 'undefined' && lastApiError && lastApiError.chatId === chatId)
        || !!(chats[chatId] && chats[chatId]._lastApiError);
    if (_errForChat) {
        hideContinueButton();
    } else if (isChatInterrupted(chats[chatId])) {
        showContinueButton();
    } else {
        hideContinueButton();
    }
}
