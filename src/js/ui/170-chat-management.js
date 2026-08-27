// Update model display with actual model from OpenRouter response
function updateModelDisplayWithProvider(actualModel) {
    var modelNameEl = document.getElementById('model-name');
    var homeModelNameEl = document.getElementById('home-model-name');
    if (!actualModel) return;
    // Format the model name: remove provider prefix and clean up
    var displayName = actualModel;
    if (actualModel.indexOf('/') !== -1) {
        displayName = actualModel.split('/').pop(); // Get part after last /
    }
    // Capitalize and clean up common patterns
    displayName = displayName.replace(/-/g, ' ').replace(/\b\w/g, function(c) { return c.toUpperCase(); });
    if (modelNameEl) {
        var textEl = modelNameEl.querySelector('.model-name-text');
        if (textEl) textEl.textContent = displayName;
        modelNameEl.style.display = '';
    }
    if (homeModelNameEl) {
        var homeTextEl = homeModelNameEl.querySelector('.model-name-text');
        if (homeTextEl) homeTextEl.textContent = displayName;
    }
}

async function fetchCredits() {
    var creditsEl = document.getElementById('credits-display');
    var homeCreditsEl = document.getElementById('home-credits-display');

    // Show cached usage immediately to prevent layout shift
    var cachedUsage = appStorage.getItem('cachedCredits');
    if (cachedUsage) {
        if (creditsEl) {
            creditsEl.innerHTML = '<span class="credits-icon">' + UI_ICONS.money + '</span>' + cachedUsage;
            creditsEl.className = 'credits-display';
            creditsEl.style.display = '';
        }
        if (homeCreditsEl) {
            homeCreditsEl.innerHTML = '<span class="credits-icon">' + UI_ICONS.money + '</span>' + cachedUsage;
            homeCreditsEl.className = 'credits-display';
            homeCreditsEl.style.display = '';
        }
    }

    // Only show loading if no cached value
    if (!cachedUsage) {
        if (creditsEl) {
            creditsEl.innerHTML = '<span class="credits-icon">' + UI_ICONS.money + '</span>...';
            creditsEl.className = 'credits-display loading';
        }
        if (homeCreditsEl) {
            homeCreditsEl.innerHTML = '<span class="credits-icon">' + UI_ICONS.money + '</span>...';
            homeCreditsEl.className = 'credits-display loading';
        }
    }

    // Derive credits URL from current provider's endpoint (extract base up to /v1/).
    // Resolved through the named LLM-endpoint registry (legacy inline fallback).
    var provider = getProviderByName(currentProvider);
    if (!provider) return;
    var conn = resolveProviderConnection(provider);
    if (!conn.endpoint) return;

    // Claude OAuth: read rate limit headers cached from last API response (no extra network call)
    if (provider.isClaudeOAuth && typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        try {
            var rl = await new Promise(function(resolve, reject) {
                chrome.runtime.sendMessage({ type: 'claude-oauth-usage' }, function(response) {
                    if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
                    if (response && response.error) { reject(new Error(response.error)); return; }
                    resolve(response && response.data);
                });
            });
            if (!rl) throw new Error('No usage data');
            // Parse: anthropic-ratelimit-unified-5h-utilization, anthropic-ratelimit-unified-5h-reset, etc.
            var util5h = parseFloat(rl['anthropic-ratelimit-unified-5h-utilization']);
            var reset5h = rl['anthropic-ratelimit-unified-5h-reset'];
            var utilRaw = !isNaN(util5h) ? util5h : parseFloat(rl['anthropic-ratelimit-unified-7d-utilization']);
            var displayText = '', creditTitle = '', cssClass = 'credits-display';
            if (!isNaN(utilRaw)) {
                // Header value is 0-1 decimal (0.28 = 28%), convert to percentage
                var util = utilRaw <= 1 ? utilRaw * 100 : utilRaw;
                var resetStr = '';
                var resetKey = reset5h || rl['anthropic-ratelimit-unified-7d-reset'];
                if (resetKey) {
                    var resetTs = parseFloat(resetKey);
                    // Unix timestamp in seconds — convert to ms
                    var diffMs = (resetTs > 9999999999 ? resetTs : resetTs * 1000) - Date.now();
                    if (diffMs > 0) {
                        // Ceil to match fmtUsageResetIn in the popover (floor here
                        // made the pill say 3h41mn while the popover said 3 hr 42 min)
                        var diffMin = Math.ceil(diffMs / 60000);
                        var h = Math.floor(diffMin / 60);
                        var m = diffMin % 60;
                        resetStr = h > 0 ? h + 'h' + (m > 0 ? m + 'mn' : '') : m + 'mn';
                    }
                }
                displayText = Math.round(util) + '%' + (resetStr ? ' for ' + resetStr : '');
                // Surface extra usage in the tooltip too, even when 5h/7d is the
                // pill's primary value, so it's visible without waiting for the
                // plan buckets to go null.
                var euTip = parseClaudeExtraUsage(rl);
                var euTipStr = euTip ? ' \u00b7 extra usage: ' + euTip.pct.toFixed(1) + '% (' + euTip.usedStr + ' / ' + euTip.limitStr + ')' : '';
                creditTitle = util.toFixed(1) + '% used' + (resetStr ? ' \u00b7 resets in ' + resetStr : '') + euTipStr + ' | Click to refresh';
                if (util > 80) cssClass += ' error';
            } else {
                // Subscription on extra-usage only: five_hour/seven_day come back
                // null, so render the extra-usage bucket instead — percentage in
                // the pill, used credits / monthly limit in the tooltip.
                var eu = parseClaudeExtraUsage(rl);
                if (!eu) throw new Error('No utilization');
                displayText = Math.round(eu.pct) + '%';
                creditTitle = 'Extra usage: ' + eu.pct.toFixed(1) + '% used \u00b7 ' + eu.usedStr + ' / ' + eu.limitStr + ' | Click to refresh';
                if (eu.pct > 80) cssClass += ' error';
            }
            if (displayText) {
                appStorage.setItem('cachedCredits', displayText);
                // Refresh the home Credits stat card now that the cache changed —
                // renderHome() only calls updateHomeCredits() synchronously with the
                // stale cache, so a cold cache showed '—' until a full re-render.
                // updateHomeCredits null-guards its element (no-op off-home).
                if (typeof updateHomeCredits === 'function') { try { updateHomeCredits(); } catch (e) {} }
                var creditHtml = '<span class="credits-icon">' + UI_ICONS.money + '</span>' + displayText;
                if (creditsEl) { creditsEl.innerHTML = creditHtml; creditsEl.className = cssClass; creditsEl.title = creditTitle; creditsEl.style.display = ''; }
                if (homeCreditsEl) { homeCreditsEl.innerHTML = creditHtml; homeCreditsEl.className = cssClass; homeCreditsEl.title = creditTitle; homeCreditsEl.style.display = ''; }
                // Rich click dropdown (per-limit bars). The native title stays
                // for hover ('Click to refresh'); clicking refreshes + opens it.
                attachUsageTooltip(creditsEl, rl);
                attachUsageTooltip(homeCreditsEl, rl);
            }
        } catch(e) {
            console.log('Claude OAuth usage error:', e.message);
            // Keep cached value visible, don't flash error
        }
        return;
    }

    var v1Idx = conn.endpoint.indexOf('/v1/');
    if (v1Idx === -1) return;
    var creditsUrl = conn.endpoint.substring(0, v1Idx) + '/v1/credits';

    try {
        var headers = {};
        if (conn.apiKey) headers['Authorization'] = 'Bearer ' + conn.apiKey;
        var res = await fetch(creditsUrl, { method: 'GET', headers: headers, cache: 'no-store' });

        if (!res.ok) {
            throw new Error('Failed to fetch credits');
        }

        var data = await res.json();
        var displayText = '';
        var creditTitle = 'Click to refresh';
        var cssClass = 'credits-display';

        if (data.data && data.data.total_credits !== undefined) {
            // OpenRouter format
            var remaining = (data.data.total_credits - data.data.total_usage).toFixed(2);
            displayText = '$' + remaining;
            creditTitle = 'Credits: $' + data.data.total_credits.toFixed(2) + ' | Used: $' + data.data.total_usage.toFixed(2) + ' | Click to refresh';
        } else if (data.five_hour) {
            // Claude usage format
            var fiveHour = data.five_hour.utilization;
            var resetStr = '';
            if (data.five_hour.resets_at) {
                var resetTime = new Date(data.five_hour.resets_at);
                var diffMs = resetTime - Date.now();
                if (diffMs > 0) {
                    // Ceil to match fmtUsageResetIn in the popover
                    var diffMin = Math.ceil(diffMs / 60000);
                    var h = Math.floor(diffMin / 60);
                    var m = diffMin % 60;
                    resetStr = h > 0 ? h + 'h' + (m > 0 ? m + 'mn' : '') : m + 'mn';
                }
            }
            displayText = Math.round(fiveHour) + '%' + (resetStr ? ' for ' + resetStr : '');
            creditTitle = fiveHour.toFixed(1) + '% used' + (resetStr ? ' \u00b7 resets in ' + resetStr : '') + ' | Click to refresh';
            if (fiveHour > 80) cssClass += ' error';
            // Same rich tooltip for the direct claude-usage-format endpoint —
            // its limits array is raw (ISO resets_at, scope.model.display_name),
            // which claudeUsageModelFromRl also understands.
            if (Array.isArray(data.limits) && data.limits.length) {
                var rlLike = { 'appagent-usage-limits': JSON.stringify(data.limits) };
                setTimeout(function() { attachUsageTooltip(creditsEl, rlLike); attachUsageTooltip(homeCreditsEl, rlLike); }, 0);
            }
        }

        if (!displayText) return;

        appStorage.setItem('cachedCredits', displayText);
        // Same as the OAuth path above: push the fresh value into the home
        // Credits stat card (null-guarded no-op when home isn't rendered).
        if (typeof updateHomeCredits === 'function') { try { updateHomeCredits(); } catch (e) {} }
        var creditHtml = '<span class="credits-icon">' + UI_ICONS.money + '</span>' + displayText;

        if (creditsEl) {
            creditsEl.innerHTML = creditHtml;
            creditsEl.className = cssClass;
            creditsEl.title = creditTitle;
            creditsEl.style.display = '';
        }
        if (homeCreditsEl) {
            homeCreditsEl.innerHTML = creditHtml;
            homeCreditsEl.className = cssClass;
            homeCreditsEl.title = creditTitle;
            homeCreditsEl.style.display = '';
        }
    } catch (e) {
        console.error('Failed to fetch credits:', e);
        if (creditsEl) {
            creditsEl.innerHTML = '<span class="credits-icon">' + UI_ICONS.money + '</span>Error';
            creditsEl.className = 'credits-display error';
        }
        if (homeCreditsEl) {
            homeCreditsEl.innerHTML = '<span class="credits-icon">' + UI_ICONS.money + '</span>Error';
            homeCreditsEl.className = 'credits-display error';
        }
    }
}

// ---------------------------------------------------------------------------
// Rich usage tooltip on the credits pill — one progress bar per rate limit
// (current session, weekly all-models, weekly per-model scoped, extra usage),
// modeled after claude.ai's own usage panel.
// ---------------------------------------------------------------------------
var _usageTooltipEl = null;
var _usageTooltipOwner = null;

// Parse stored usage keys into { session, weekly: [], extra }. Accepts both the
// normalized limits shape written by normalizeClaudeUsage in background.js
// ({percent, resets_at: epochSecs, label}) and the raw claude.ai shape
// ({percent, resets_at: ISO, scope:{model:{display_name}}}). Falls back to the
// flat 5h/7d header keys when no limits array is stored.
function claudeUsageModelFromRl(rl) {
    var model = { session: null, weekly: [], extra: parseClaudeExtraUsage(rl) };
    function toMs(v) {
        if (v == null) return null;
        if (typeof v === 'number' || /^\d+(\.\d+)?$/.test(String(v).trim())) {
            var n = parseFloat(v);
            return n > 9999999999 ? n : n * 1000;
        }
        var t = Date.parse(v);
        return isNaN(t) ? null : t;
    }
    var limits = null;
    try { limits = JSON.parse(rl['appagent-usage-limits'] || 'null'); } catch(e) {}
    if (Array.isArray(limits) && limits.length) {
        limits.forEach(function(l) {
            if (!l || typeof l !== 'object') return;
            var pct = parseFloat(l.percent);
            if (isNaN(pct)) return;
            var resetsAt = toMs(l.resets_at);
            if (l.group === 'session' || l.kind === 'session') {
                model.session = { percent: pct, resetsAt: resetsAt };
            } else {
                var label = l.label || (l.scope && l.scope.model && l.scope.model.display_name);
                if (!label) label = (l.kind === 'weekly_all' || !l.kind) ? 'All models' : String(l.kind).replace(/_/g, ' ');
                model.weekly.push({ label: label, percent: pct, resetsAt: resetsAt });
            }
        });
        if (model.session || model.weekly.length) return model;
    }
    // Fallback: flat header keys only (older cached data / header-scraped)
    var u5 = parseFloat(rl['anthropic-ratelimit-unified-5h-utilization']);
    if (!isNaN(u5)) model.session = { percent: u5 <= 1 ? u5 * 100 : u5, resetsAt: toMs(rl['anthropic-ratelimit-unified-5h-reset']) };
    var u7 = parseFloat(rl['anthropic-ratelimit-unified-7d-utilization']);
    if (!isNaN(u7)) model.weekly.push({ label: 'All models', percent: u7 <= 1 ? u7 * 100 : u7, resetsAt: toMs(rl['anthropic-ratelimit-unified-7d-reset']) });
    return model;
}

function fmtUsageResetIn(ms) { // "4 hr 34 min"
    var diff = ms - Date.now();
    if (diff <= 0) return '';
    var min = Math.ceil(diff / 60000);
    var d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = min % 60;
    if (d > 0) return d + ' d ' + h + ' hr';
    if (h > 0) return h + ' hr' + (m > 0 ? ' ' + m + ' min' : '');
    return m + ' min';
}

function fmtUsageResetAt(ms) { // "Sun 5:59 AM"
    var d = new Date(ms);
    try { return d.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }); }
    catch(e) { return d.toLocaleString(); }
}

function buildUsageTooltipHtml(model) {
    function bar(pct) {
        var v = Math.max(0, Math.min(100, pct));
        var cls = v >= 90 ? ' crit' : (v >= 70 ? ' warn' : '');
        return '<div class="usage-tt-bar"><div class="usage-tt-fill' + cls + '" style="width:' + Math.max(v, 2) + '%"></div></div>';
    }
    function row(label, sub, pct) {
        return '<div class="usage-tt-row">' +
            '<div class="usage-tt-row-head"><span class="usage-tt-label">' + escapeHtml(label) + '</span><span class="usage-tt-pct">' + Math.round(pct) + '% used</span></div>' +
            bar(pct) +
            (sub ? '<div class="usage-tt-sub">' + escapeHtml(sub) + '</div>' : '') +
            '</div>';
    }
    var html = '';
    if (model.session) {
        var inStr = model.session.resetsAt ? fmtUsageResetIn(model.session.resetsAt) : '';
        // Titled like the Weekly limits / Extra usage sections below, so all
        // three sections of the dropdown read as parallel groups.
        html += '<div class="usage-tt-section menu-section-title"><span class="section-icon">' + UI_ICONS.clock + '</span>Session</div>';
        html += row('Current session', inStr ? 'Resets in ' + inStr : '', model.session.percent);
    }
    if (model.weekly.length) {
        html += '<div class="usage-tt-section menu-section-title"><span class="section-icon">' + UI_ICONS.stats + '</span>Weekly limits</div>';
        model.weekly.forEach(function(w) {
            html += row(w.label, w.resetsAt ? 'Resets ' + fmtUsageResetAt(w.resetsAt) : '', w.percent);
        });
    }
    if (model.extra) {
        html += '<div class="usage-tt-section menu-section-title"><span class="section-icon">' + UI_ICONS.money + '</span>Extra usage</div>';
        html += row(model.extra.usedStr + ' / ' + model.extra.limitStr, '', model.extra.pct);
    }
    return html;
}

// Attach (or refresh the data behind) the rich dropdown on a credits pill.
// Hover shows the native title ('Click to refresh'); clicking the pill
// refreshes usage (pill onclick in 120-init.js) AND opens this dropdown.
// When the refreshed data lands while the dropdown is open, it re-renders
// in place. Returns true when rich data is available.
function attachUsageTooltip(el, rl) {
    if (!el || !rl) return false;
    el._usageRl = rl;
    var model = claudeUsageModelFromRl(rl);
    if (!model.session && !model.weekly.length && !model.extra) return false;
    if (!el._usageTooltipWired) {
        el._usageTooltipWired = true;
        el.addEventListener('click', function() { showUsageTooltip(el); });
        // Keyboard access: the pill has role=button/tabindex — Enter/Space must
        // open the dropdown like a click does.
        el.addEventListener('keydown', function(e) {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showUsageTooltip(el); }
        });
    }
    // Live-update an open dropdown when fresh data arrives after the click
    if (_usageTooltipEl && _usageTooltipOwner === el && _usageTooltipEl.style.display === 'block') {
        _usageTooltipEl.innerHTML = buildUsageTooltipHtml(model);
    }
    return true;
}

function showUsageTooltip(el) {
    var rl = el._usageRl;
    if (!rl) return;
    var model = claudeUsageModelFromRl(rl);
    if (!model.session && !model.weekly.length && !model.extra) return;
    // Only one header dropdown open at a time (shared registry in ui/240-layout.js)
    if (typeof closeAllHeaderMenus === 'function') closeAllHeaderMenus('usage');
    if (!_usageTooltipEl) {
        _usageTooltipEl = document.createElement('div');
        // Chrome (bg/border/radius/shadow) comes from the shared .header-menu
        // class (04-header.css) so all header pill dropdowns match.
        _usageTooltipEl.className = 'usage-tooltip header-menu';
        document.body.appendChild(_usageTooltipEl);
        // Dropdown behavior: close on any click outside the pill/dropdown
        document.addEventListener('click', function(e) {
            if (!_usageTooltipEl || _usageTooltipEl.style.display !== 'block') return;
            if (_usageTooltipEl.contains(e.target)) return;
            if (_usageTooltipOwner && _usageTooltipOwner.contains(e.target)) return;
            hideUsageTooltipNow();
        });
        // Escape closes the dropdown (keyboard parity with click-outside)
        document.addEventListener('keydown', function(e) {
            if (e.key !== 'Escape') return;
            if (!_usageTooltipEl || _usageTooltipEl.style.display !== 'block') return;
            hideUsageTooltipNow();
        });
    }
    _usageTooltipOwner = el;
    _usageTooltipEl.innerHTML = buildUsageTooltipHtml(model);
    // Position exactly like the other header menus (model menu 160-notifications.js,
    // settings panel 130-data-management.js, ws dropdown 040-tools-settings.js,
    // instance picker platform-bridge.js): fixed, 4px below the pill, right edge
    // aligned to the pill's right edge (clamped 8px from the viewport edge).
    var r = el.getBoundingClientRect();
    _usageTooltipEl.style.display = 'block';
    _usageTooltipEl.style.left = 'auto';
    _usageTooltipEl.style.top = (r.bottom + 4) + 'px';
    _usageTooltipEl.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
}

function hideUsageTooltipNow() {
    if (_usageTooltipEl) _usageTooltipEl.style.display = 'none';
    _usageTooltipOwner = null;
}

// Build a renderable extra-usage summary from the stored claude usage keys
// (written by normalizeClaudeUsage in background.js). claude.ai reports
// monthly_limit/used_credits in MINOR units (divide by 10^decimal_places) and
// utilization as a 0-100 percent that may be null (then derive from used/limit).
// Returns { pct, usedStr, limitStr } or null when extra usage isn't active/usable.
function parseClaudeExtraUsage(rl) {
    if (!rl || rl['appagent-extra-usage-enabled'] === 'false') return null;
    var used = parseFloat(rl['appagent-extra-usage-used']);
    var limit = parseFloat(rl['appagent-extra-usage-limit']);
    var utilPct = parseFloat(rl['appagent-extra-usage-utilization']);
    var decimals = parseInt(rl['appagent-extra-usage-decimals'], 10);
    if (isNaN(decimals)) decimals = 2;
    var divisor = Math.pow(10, decimals);
    var pct;
    if (!isNaN(utilPct)) pct = utilPct;                 // claude.ai already 0-100
    else if (!isNaN(used) && limit > 0) pct = (used / limit) * 100;
    if (pct == null || isNaN(pct)) return null;
    var sym = claudeCurrencySymbol(rl['appagent-extra-usage-currency']);
    function money(v) { return isNaN(v) ? '?' : sym + (v / divisor).toFixed(decimals); }
    return { pct: pct, usedStr: money(used), limitStr: money(limit) };
}

function claudeCurrencySymbol(code) {
    if (!code) return '$';
    var map = { USD: '$', EUR: '\u20ac', GBP: '\u00a3', JPY: '\u00a5', CAD: 'CA$', AUD: 'A$' };
    return map[code] || (code + ' ');
}

// Live-refresh Claude OAuth usage by hitting claude.ai's cookie-authenticated usage
// endpoint (via the SW), instead of only reading rate-limit headers scraped off the
// last inference response. The SW writes claudeRateLimits, and storage.onChanged in
// platform-bridge.js re-renders through fetchCredits(). Throttled to once/60s unless
// forced (an explicit click forces). Render-only fetchCredits() never calls this, so
// there is no refresh<->render loop.
var _lastClaudeUsageRefresh = 0;
var _claudeUsageRefreshInFlight = false;
function refreshClaudeOAuthUsage(force) {
    var provider = getProviderByName(currentProvider);
    if (!provider || !provider.isClaudeOAuth) return;
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) return;
    var now = Date.now();
    if (!force && now - _lastClaudeUsageRefresh < 60000) return;
    // Even forced (click) refreshes are debounced: minimum 5s spacing, and never
    // more than one credentialed claude.ai request in flight at a time.
    if (force && now - _lastClaudeUsageRefresh < 5000) return;
    if (_claudeUsageRefreshInFlight) return;
    _claudeUsageRefreshInFlight = true;
    _lastClaudeUsageRefresh = now;
    try {
        chrome.runtime.sendMessage({ type: 'claude-oauth-usage-refresh' }, function(response) {
            _claudeUsageRefreshInFlight = false;
            if (chrome.runtime.lastError) return;
            if (response && response.error) { console.log('Claude usage refresh error:', response.error); return; }
            // On a value change, storage.onChanged already re-rendered; call fetchCredits
            // anyway for the no-change case (onChanged does not fire on identical values).
            try { fetchCredits(); } catch(e) {}
        });
    } catch(e) { _claudeUsageRefreshInFlight = false; }
}

async function updateStorageIndicator() {
    var storageEl = document.getElementById('storage-display');
    if (!storageEl) return;
    
    try {
        // Estimate IndexedDB usage via navigator.storage API
        if (navigator.storage && navigator.storage.estimate) {
            var estimate = await navigator.storage.estimate();
            var usedMB = (estimate.usage || 0) / (1024 * 1024);
            var quotaMB = (estimate.quota || 0) / (1024 * 1024);
            var remainingMB = quotaMB - usedMB;
            
            // Only show indicator if less than 5MB remaining
            if (remainingMB >= 5) {
                storageEl.style.display = 'none';
                return;
            }
            
            storageEl.style.display = '';
            var displayText = remainingMB.toFixed(1) + 'MB left';
            var className;
            
            if (remainingMB < 1) {
                className = 'storage-display critical';
            } else if (remainingMB < 3) {
                className = 'storage-display warning';
            } else {
                className = 'storage-display';
            }
            
            storageEl.innerHTML = '<span class="storage-icon">' + UI_ICONS.storage + '</span>' + displayText;
            storageEl.className = className;
            storageEl.title = 'IndexedDB Storage: ' + usedMB.toFixed(1) + 'MB used / ' + quotaMB.toFixed(0) + 'MB quota';
        } else {
            // Can't estimate - hide indicator
            storageEl.style.display = 'none';
        }
    } catch (e) {
        storageEl.style.display = 'none';
    }
}

function generateId() {
    return 'chat_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

// Track pending summary request
var pendingSummaryRequest = null; // { chatId, chatTitle }

// Summarize current conversation and start a new chat with the summary
async function summarizeAndStartNewChat() {
    var chat = chats[currentChatId];
    if (!chat || !chat.messages || chat.messages.length < 3) {
        showSnackbar('Not enough conversation to summarize', 'warning');
        return;
    }
    
    // Check if agent is already running. Gate on the PER-CHAT running flag,
    // not the bare global `isRunning` — the global tracks foreground UI state
    // and can be incidentally true (e.g. after revealing a background action
    // chat then navigating away) even when THIS chat has no active stream.
    // Mirrors the sendMessage fix in app/040-send-message.js:13-16.
    // REG-F3: ALSO honor the global pair when it points at THIS chat —
    // runningChatIds is wholesale-cleared by the bus onDisconnect, so during a
    // port flap a live foreground run would otherwise slip past the per-chat
    // check and summarize would inject its prompt mid-run.
    if (runningChatIds[currentChatId] ||
        (isRunning && typeof activeStreamingChatId !== 'undefined' && activeStreamingChatId === currentChatId)) {
        showSnackbar('Please wait for the current request to complete', 'warning');
        return;
    }
    
    // Store info for after the summary is generated
    pendingSummaryRequest = {
        chatId: currentChatId,
        chatTitle: chat.title || 'Chat'
    };
    
    // Add summary request as a user message
    var summaryPrompt = 'Please provide a concise summary of this conversation for context continuity. Include:\n' +
        '1. User\'s main questions/goals\n' +
        '2. Current progress and accomplishments\n' +
        '3. Any unresolved issues or blockers\n' +
        '4. Suggested next steps\n\n' +
        'Keep it brief but comprehensive. Do not include tool call details, just outcomes. Do not use any tools for this task.';
    
    chat.messages.push({
        role: 'user',
        content: summaryPrompt,
        isSummaryRequest: true
    });
    
    saveChatsToStorage();
    renderMessages();
    
    // Run the agent to generate the summary
    stickToBottom = true;
    // FLUX-QW6: clear pause via the shared helpers — legacy global + per-chat
    // map + persisted flag (setChatPausedPersistent) + SW mirror
    // (pushPauseToggleToOffscreen) — and repaint through the SSOT
    // syncPauseButtonUI (app/020-api-messages.js). The old hand-written label
    // left pausedChats[currentChatId] set on a paused chat, so the summary
    // run was silently dropped by runAgent's pause gate while the button
    // claimed "Pause".
    paused = false;
    setChatPausedPersistent(currentChatId, false);
    pushPauseToggleToOffscreen(currentChatId, false);
    syncPauseButtonUI(currentChatId);
    await runAgent();
    
    // After agent completes, check if we need to create a new chat with the summary
    if (pendingSummaryRequest && pendingSummaryRequest.chatId === currentChatId) {
        completeSummaryAndCreateNewChat();
    }
}

// Called after agent completes a summary request to create the new chat
function completeSummaryAndCreateNewChat() {
    if (!pendingSummaryRequest) return;
    
    var chat = chats[pendingSummaryRequest.chatId];
    if (!chat || !chat.messages || chat.messages.length === 0) {
        pendingSummaryRequest = null;
        return;
    }
    
    // Find the last assistant message (the summary)
    var summary = null;
    for (var i = chat.messages.length - 1; i >= 0; i--) {
        var msg = chat.messages[i];
        if (msg.role === 'assistant' && msg.content && !msg.isSummary) {
            summary = msg.content;
            // Mark as summary so it's not counted in metrics
            msg.isSummary = true;
            break;
        }
        if (msg.role === 'user') break; // Stop if we hit user message without finding assistant
    }
    
    if (!summary) {
        showSnackbar('Failed to generate summary', 'error');
        pendingSummaryRequest = null;
        return;
    }
    
    // Create new chat with summary as first message
    var newChatId = generateId();
    var summaryMessage = '**Continuing from previous conversation:**\n\n' + summary + '\n\n---\n\nPlease continue helping me with the above context.';
    
    chats[newChatId] = {
        id: newChatId,
        title: 'Continued: ' + pendingSummaryRequest.chatTitle,
        messages: [{ role: 'user', content: summaryMessage }],
        createdAt: Date.now()
    };
    
    pendingSummaryRequest = null;
    
    currentChatId = newChatId;
    appStorage.setItem('lastChatId', currentChatId);
    // B6: focused chat changed (continue-from-summary bypasses selectChat) — keep the
    // SW's focused-chat in sync so GC doesn't reclaim a transcript the user is viewing.
    if (typeof pushFocusChatToOffscreen === 'function') pushFocusChatToOffscreen(currentChatId);
    saveChatsToStorage();
    
    versionHistory = [];
    clearUpdateSet();
    renderChatList();
    renderMessages();
    renderVersionSidebar();
    updateChatTitleHeader();
    // Reset Workers strip for the fresh chat — the new chat owns no
    // sub-agents yet, so the strip should be empty/hidden. Without this,
    // chips from the previous chat persist until the next selectChat.
    if (typeof renderWorkersStrip === 'function') {
        try { renderWorkersStrip(); } catch (e) {}
    }
    
    showSnackbar('New chat created with summary', 'success');
    
    // Auto-start agent to get AI response
    stickToBottom = true;
    // FLUX-QW6: same recipe as summarizeAndStartNewChat — currentChatId is the
    // freshly created chat here so the clears are no-ops in practice, but one
    // uniform recipe means every pause writer mutates pausedChats + the legacy
    // global together and repaints via the SSOT syncPauseButtonUI.
    paused = false;
    setChatPausedPersistent(currentChatId, false);
    pushPauseToggleToOffscreen(currentChatId, false);
    syncPauseButtonUI(currentChatId);
    runAgent();
}

function newChat() {
    // Save pending state for current context before switching
    var prevContext = getCurrentPendingContext();
    savePendingImagesForContext(prevContext);
    savePendingTextForContext(prevContext);

    // Close skills or dashboard view if open
    if (currentView === 'skills') {
        closeSkillsView();
    } else if (currentView === 'dashboard') {
        closeDashboardView();
    } else if (currentView === 'home') {
        closeHomeView();
    } else if (currentView === 'settings-page') {
        closeSettingsPageView();
    }

    // Reset UI state for new chat (don't clear pendingToolApprovals - they're per-chat)
    // newChat: resetting foreground UI state only. Background loops keep running.
    isRunning = false;
    activeStreamingChatId = null;
    pendingInjection = null;
    pendingInjectionImages = null;
    hidePauseButton();
    hideContinueButton();
    // Clear foreground-UI globals so the previous chat's state doesn't leak
    // into the fresh new chat. Two real cases were observed:
    //   - lastApiError: drives the inline error banner. If chat A blew up
    //     with an API error then the user hit "New Chat", the banner stuck
    //     to the new chat even though the new chat had never made a request.
    //   - #messages.is-streaming: drives bottom-padding / scroll pinning for
    //     the streaming UI. If chat A was mid-stream when New Chat fired,
    //     the class lingered on the messages container and the empty new
    //     chat rendered with the streaming layout active.
    // selectChat clears both via its own branch below; newChat needs the
    // same treatment since it bypasses selectChat entirely.
    lastApiError = null;
    // B14: newChat must also hide the dead Retry button + the (non-auto-dismiss)
    // error snackbar left over from the previous chat, like selectChat /
    // openChatFromHistory. Clearing only lastApiError left the button visible-but-dead
    // and the red error snackbar pinned over the empty new chat.
    if (typeof hideRetryButton === 'function') hideRetryButton();
    if (typeof hideSnackbar === 'function') hideSnackbar();
    var _newChatMessagesEl = document.getElementById('messages');
    if (_newChatMessagesEl) _newChatMessagesEl.classList.remove('is-streaming');

    currentChatId = generateId();
    chats[currentChatId] = { id: currentChatId, title: 'New Chat', messages: [], createdAt: Date.now(), isTemporary: true };

    appStorage.setItem('lastChatId', currentChatId);
    // Don't save empty chat
    versionHistory = [];
    clearUpdateSet();
    renderChatList();
    renderMessages();
    renderVersionSidebar();
    updateChatTitleHeader();
    // Reset Workers strip for the fresh new chat (no subs yet — strip
    // should hide). Same reason as in the continue-from-summary path
    // above: newChat bypasses selectChat.
    if (typeof renderWorkersStrip === 'function') {
        try { renderWorkersStrip(); } catch (e) {}
    }
    // Recompute the jobs badge + any open dropdown. getActiveChatsList()
    // now INCLUDES the focused chat (since v1.1.1 a running chat shows
    // regardless of focus), so this keeps the badge/dropdown fresh while the
    // previous chat keeps running. newChat bypasses selectChat (which got this recompute in
    // the fix #17 change), so without mirroring it here the just-backgrounded
    // running chat never shows in the badge/dropdown until some later
    // runStarted/runFinished event happens to recompute it. Same reason
    // newChat hand-copies the lastApiError / is-streaming / Workers-strip
    // resets above.
    if (typeof renderJobsBadge === 'function') {
        try { renderJobsBadge(); } catch (e) {}
    }
    if (typeof _getOpenJobsDropdown === 'function' && typeof renderJobsDropdown === 'function') {
        try { var _jdNew = _getOpenJobsDropdown(); if (_jdNew) renderJobsDropdown(_jdNew); } catch (e) {}
    }
    // Same reason as in selectChat — dismiss any popover left over from the
    // previous chat so it doesn't hover over the empty new-chat header.
    if (typeof closeChatProgressPopoverIfStale === 'function') {
        try { closeChatProgressPopoverIfStale(); } catch (e) {}
    }

    // Temporarily close the right sidebar without affecting stored state
    var sidebar = document.getElementById('version-sidebar');
    var openBtn = document.getElementById('version-sidebar-open');
    if (sidebar) sidebar.classList.remove('visible');
    if (openBtn) openBtn.classList.add('visible');
    updateInputPosition();

    // New chat starts with empty input
    var inputEl = document.getElementById('message-input');
    if (inputEl) {
        inputEl.value = '';
        inputEl.style.height = 'auto';
        inputEl.focus();
    }

    // Start with empty pending images for the new chat
    pendingImageAttachments = [];
    renderPendingImages();

    // Push browser history state
    pushHistoryState('chat', currentChatId);
    // B6: tell the SW the focused chat changed (newChat bypasses selectChat) so the
    // sub-agent GC paths don't reclaim the just-defocused chat's transcript.
    if (typeof pushFocusChatToOffscreen === 'function') pushFocusChatToOffscreen(currentChatId);
}

function selectChat(chatId, options) {
    options = options || {};
    // Save pending state for current context before switching
    var prevContext = getCurrentPendingContext();
    savePendingImagesForContext(prevContext);
    savePendingTextForContext(prevContext);

    // Mark the chat as seen — the Active Chats dropdown surfaces chats whose
    // last response the user hasn't viewed yet (lastResponseAt > lastViewedAt).
    if (chats[chatId]) {
        if (typeof dispatchChatMeta === 'function') dispatchChatMeta(chatId, { lastViewedAt: Date.now() }); // FLUX-4C lane
        if (typeof renderJobsBadge === 'function') { try { renderJobsBadge(); } catch (e) {} }
        // Viewing the chat consumes its "finished while you were elsewhere"
        // header badge entry (ui/165-finished-chat-badge.js).
        if (typeof clearUnseenFinishedChat === 'function') { try { clearUnseenFinishedChat(chatId); } catch (e) {} }
    }

    // Reset UI state for the new focused chat.
    // If THAT chat is streaming — show pause/streaming UI.
    // Otherwise, reset (but DO NOT stop any other chat's running loop).
    // Re-sync the messages container's `is-streaming` class to the target chat's
    // actual run state. Without this, the class would reflect whichever chat last
    // started/finished a run, not the chat currently in view.
    var _messagesEl = document.getElementById('messages');
    // lastApiError is a foreground-UI global (drives the error banner). Clearing
    // it on chat switch prevents an error from a previous chat bleeding into the
    // newly-viewed chat's UI; renderMessages will re-derive any per-chat error.
    lastApiError = null;
    // R-2: clear the dead Retry button + the (non-auto-dismiss) error snackbar
    // left over from the previous chat, then re-derive Retry from THIS chat's
    // persisted error (R-1 stores an unfocused foreground chat's error on the
    // chat as _lastApiError) so a previously-unfocused errored chat stays
    // recoverable when the user navigates to it.
    if (typeof hideRetryButton === 'function') hideRetryButton();
    if (typeof hideSnackbar === 'function') hideSnackbar();
    var _selErr = chats[chatId] && chats[chatId]._lastApiError;
    if (_selErr) { lastApiError = _selErr; if (typeof showRetryButton === 'function') showRetryButton(); }
    if (runningChatIds[chatId]) {
        isRunning = true;
        activeStreamingChatId = chatId;
        // Silent-hook runs (auto title/tldr/links) are invisible work — don't
        // show Pause / .is-streaming for them (same gate as runStarted in
        // 036-agent-event-handlers-page.js).
        var _selHook = typeof _isChatInSilentHook === 'function' && _isChatInSilentHook(chatId);
        if (_selHook) {
            if (typeof hidePauseButton === 'function') hidePauseButton();
        } else {
            if (_messagesEl) _messagesEl.classList.add('is-streaming');
            // Pass chatId explicitly — currentChatId hasn't been updated yet (line below)
            // so showPauseButton's syncPauseButtonUI call would otherwise read the
            // previous chat's pausedChats flag and mislabel the button.
            showPauseButton(chatId);
        }
        hideContinueButton();
        var stored = pendingInjectionsByChatId[chatId];
        if (stored) {
            pendingInjection = stored.text;
            pendingInjectionImages = stored.images;
        }
    } else {
        // Target chat is not streaming — reset foreground UI.
        // Other chats' background loops are unaffected (runningChatIds is unchanged).
        isRunning = false;
        activeStreamingChatId = null;
        if (_messagesEl) _messagesEl.classList.remove('is-streaming');
        hidePauseButton();
        pendingInjection = null;
        pendingInjectionImages = null;
        // If the chat looks interrupted (e.g. page was reloaded mid-stream), show
        // a Continue button so the user can pick up where the agent left off.
        refreshContinueButtonForChat(chatId);
    }
    currentChatId = chatId;
    appStorage.setItem('lastChatId', chatId);
    // SAGF-1: tell the SW which chat is focused so its sub-agent GC paths don't
    // reclaim a transcript the user is now viewing (SW currentChatId is null).
    if (typeof pushFocusChatToOffscreen === 'function') pushFocusChatToOffscreen(currentChatId);
    clearUpdateSet();
    loadVersionHistory();
    renderChatList();
    renderMessages();
    // MEMFIX: non-recent chats are loaded with their inline base64 payloads
    // evicted (see loadChatsFromStorage). The sync render above shows text
    // immediately (images show placeholders); rehydrate from IDB and re-render
    // once — only if the user is still viewing this chat. No-op for hydrated,
    // running, or new chats. ensureChatPayloads never rejects.
    if (typeof ensureChatPayloads === 'function' && chats[chatId] && chats[chatId]._payloadsEvicted) {
        ensureChatPayloads(chatId).then(function() {
            if (currentChatId === chatId) {
                try { renderMessages(); } catch (e) {}
            }
        });
    }
    // MEMFIX churn guard (PR #805 review, Issue 3): merely VIEWING an idle
    // chat never routes through the activity stamps (app/036 stamps only on
    // unread activity), so an old chat's recency stayed old and the sweep
    // below evicted it the moment the user switched away — A↔B switching
    // between two old chats hydrated→evicted→hydrated on every switch.
    // Stamp lastViewedAt through the FLUX-4C chat-meta lane (write-site
    // ratchet: no direct chats[id].lastViewedAt poke). dispatchChatMeta's
    // optimistic apply is SYNCHRONOUS and monotonic-max (_applyChatMetaFields,
    // app/045), so the sweep below still reads the fresh stamp via
    // chatPayloadRecencyTs, and the SW-canonical value follows (max-wins —
    // neither side can regress the other).
    if (chats[chatId] && !chats[chatId].isTemporary && typeof dispatchChatMeta === 'function') {
        try { dispatchChatMeta(chatId, { lastViewedAt: Date.now() }); } catch (e) {}
    }
    // MEMFIX (Fix C): switching chats is the natural moment a previously-
    // viewed (rehydrated) chat goes cold — run the SAME sweep the 60s tick
    // runs (payloads + text bodies, keep newest K by recency) immediately
    // instead of waiting for the next tick/boot. The sweep never touches
    // the chat we just switched TO (currentChatId guard) nor running chats.
    if (typeof sweepColdChatPayloads === 'function') {
        try { sweepColdChatPayloads(CHAT_KEEP_HYDRATED, true); } catch (e) {}
    }
    updateInputPosition();
    updateChatTitleHeader();
    // Re-verify the header connection badge on chat switch. The chat page is
    // where agent runs happen, and llm-streaming stamps 'connected' on HTTP 200;
    // without this re-check the pill keeps a stale 'connected' the new-chat/home
    // view doesn't show (home is refreshed by init + the 60s OAuth timer).
    if (typeof updateModelDisplay === 'function') { try { updateModelDisplay(); } catch (e) {} }
    // Refresh the Workers strip so chips reflect the newly-selected chat's
    // sub-agents (each parent chat has its own set). Hidden when the chat
    // owns no subs. Source: src/js/ui/175-sub-agent-ui.js.
    if (typeof renderWorkersStrip === 'function') {
        try { renderWorkersStrip(); } catch (e) {}
    }
    // Re-render the header live-action pills: the suppression rule depends on
    // whether the newly-selected chat is a sub-agent, so switching between a
    // regular chat and a sub-agent chat must trigger a recompute. Without
    // this, the pills row would only update on activeActions membership
    // changes — stale shape persists across navigation.
    if (typeof renderLiveActionPills === 'function') {
        try { renderLiveActionPills(); } catch (e) {}
    }
    // Recompute the jobs badge: getActiveChatsList() now INCLUDES the focused
    // chat (since v1.1.1 a running chat shows regardless of focus), so this
    // recompute keeps the badge count/colour fresh on switch. The badge only re-renders on
    // run start/finish events otherwise, so without this the background chat
    // never shows up in the badge/dropdown after navigation.
    if (typeof renderJobsBadge === 'function') {
        try { renderJobsBadge(); } catch (e) {}
    }
    if (typeof _getOpenJobsDropdown === 'function' && typeof renderJobsDropdown === 'function') {
        try { var _jdSel = _getOpenJobsDropdown(); if (_jdSel) renderJobsDropdown(_jdSel); } catch (e) {}
    }
    // A chat-progress popover belongs to a specific chatId. Without this, the
    // popover would hover above the new chat's header showing stale data from
    // the previous chat — _refreshOpenChatProgressPopover short-circuits on
    // chatId mismatch but never closes.
    if (typeof closeChatProgressPopoverIfStale === 'function') {
        try { closeChatProgressPopoverIfStale(); } catch (e) {}
    }
    // Close any non-chat view when selecting a chat
    if (currentView !== 'chat') {
        hideAllPanels();
        showChatView();
        currentView = 'chat';
        appStorage.setItem('currentView', 'chat');
        updateAllButtonStates();
    } else if (!sidebarCollapsed && (document.body.classList.contains('sidepanel-mode') || window.innerWidth <= 480)) {
        toggleSidebar();
    }
    // NAV-SYNC: chat→chat switches stay in the 'chat' view and bypass
    // hideAllPanels above — trigger the guarded sync here too. Safe to call
    // unconditionally: the in-flight flag is set synchronously, so a sync
    // already kicked by hideAllPanels makes this a no-op.
    if (typeof triggerNavWorkspaceSync === 'function') { try { triggerNavWorkspaceSync(); } catch (e) {} }
    // Restore pending state for the target chat
    restorePendingImagesForContext(chatId);
    restorePendingTextForContext(chatId);
    // Push browser history state
    pushHistoryState('chat', chatId);
    // Show notifications for any pending tool approvals in this chat
    // Skip if user came from "Go to chat" button (they'll handle approvals inline)
    if (!options.skipApprovalNotifications) {
        showPendingApprovalNotifications(chatId);
    }
    // B-A1: if a snackbar is already up for some other chat, recompute its copy
    // ("The agent wants to run X" vs "<title> wants to run X") so it reflects the
    // new currentChatId. Without this, the popup keeps the stale copy from the
    // chat the user came from.
    if (typeof rerenderCurrentNotification === 'function') {
        rerenderCurrentNotification();
    }
}

// `includeToolCallId` (optional): forwarded to getCurrentChatProgressState so
// the in-flight update_action_state call — whose role:'tool' result row hasn't
// been pushed yet by the agent loop — still appears in the pill. Without it,
// calling updateChatTitleHeader from inside executeUpdateActionState would
// skip the just-issued state and the pill would lag one update behind.
function updateChatTitleHeader(includeToolCallId) {
    var titleEl = document.getElementById('header-chat-title');
    if (!titleEl) return;
    var chat = chats[currentChatId];
    var title = (chat && chat.title && chat.title !== 'New Chat') ? chat.title : '';

    // Sub-agent badge — makes it instantly visible in the chat header that
    // the user is looking at a delegated worker chat, not a top-level
    // conversation. Identity only: the "↰ <parent title>" navigation
    // affordance moved onto the sub-agent self card at the top of the chat
    // (updateSubAgentSelfCard, 175-sub-agent-ui.js) — the header pill no
    // longer carries a nav segment. (The breadcrumb in the sidebar /
    // history card still has the full parent chain.)
    var subAgentBadgeHtml = '';
    if (chat && chat.isSubAgent) {
        var iconHtml = (typeof UI_ICONS !== 'undefined' && UI_ICONS.bot) ? UI_ICONS.bot : '';
        // Identity segment — plain badge, not a button.
        var badgeSeg = '<span class="chat-title-subagent-badge" title="Delegated worker chat">'
            + '<span class="chat-title-subagent-icon">' + iconHtml + '</span>'
            + '<span class="chat-title-subagent-label">Sub-agent</span>'
            + '</span>';
        subAgentBadgeHtml = ' <span class="chat-title-subagent-pill">'
            + badgeSeg
            + '</span>';
    }

    // Append a small progress state pill (running/stuck/done/error) when the
    // current chat has any update_action_state calls. Visible always — no need
    // to open the right sidebar to see what state the agent is in.
    // Live WAITING states (pending prompt_user form / tool call parked on the
    // approval modal) outrank the derived progress state — a chat waiting on
    // the user is more urgent than "finished". chatWaitingStateFor lives in
    // tools/120-actions.js (later tier, global at runtime) — typeof-guarded
    // like progressStateMeta below.
    var pillHtml = '';
    var pillState = null;
    if (typeof chatWaitingStateFor === 'function') {
        try { pillState = chatWaitingStateFor(currentChatId); } catch (e) {}
    }
    // User-paused chat (Pause button) outranks the derived progress state —
    // otherwise pausing the currently-viewed chat leaves the pill showing the
    // stale pre-pause state until the next run. _isChatUserPaused lives in
    // tools/120-actions.js (same concatenated global bundle, so the function
    // declaration is callable here) — typeof-guarded like chatWaitingStateFor
    // above; progressStateMeta has a matching 'paused' arm.
    if (!pillState && typeof _isChatUserPaused === 'function') {
        try { if (_isChatUserPaused(currentChatId)) pillState = 'paused'; } catch (e) {}
    }
    if (!pillState && typeof getCurrentChatProgressState === 'function') {
        try {
            var current = getCurrentChatProgressState(includeToolCallId);
            if (current && current.state) pillState = current.state;
        } catch (e) {}
    }
    if (pillState) {
        try {
            {
                var s = pillState;
                // Shared state meta (icon + friendly label) — progressStateMeta
                // lives in tools/120-actions.js (later tier, global scope at
                // runtime); fall back to a spinner if it's ever missing.
                var _pillMeta = (typeof progressStateMeta === 'function') ? progressStateMeta(s) : null;
                var icon = _pillMeta ? _pillMeta.icon : UI_ICONS.spinner;
                var pillLabel = _pillMeta ? _pillMeta.label : s;
                pillHtml = ' <span class="chat-title-state-pill state-' + s + '" ' +
                    'title="Progress: ' + escapeHtml(pillLabel) + ' — click for details" ' +
                    'aria-label="Progress: ' + escapeHtml(pillLabel) + ' — click for details" ' +
                    'role="button" tabindex="0" ' +
                    'onclick="onChatTitleStatePillClick(this, event)" ' +
                    'onkeydown="if(event.key===\u0027Enter\u0027||event.key===\u0027 \u0027)onChatTitleStatePillClick(this, event)">' +
                    '<span class="chat-title-state-icon">' + icon + '</span>' +
                    '<span class="chat-title-state-label">' + escapeHtml(pillLabel) + '</span>' +
                '</span>';
            }
        } catch (e) {}
    }

    if (title || pillHtml || subAgentBadgeHtml) {
        titleEl.innerHTML = (title ? escapeHtml(title) : '') + subAgentBadgeHtml + pillHtml;
    } else {
        titleEl.textContent = '';
    }

    // Header pin button — mirrors the current chat's pinned flag (same flag
    // the sidebar ⋯ menu and History cards toggle via togglePinChat). Filled
    // + always-visible when pinned; outline + hover-revealed (CSS) when not.
    // Hidden entirely when no chat is open (fresh New Chat before a message).
    var pinBtn = document.getElementById('header-pin-btn');
    if (pinBtn) {
        if (chat) {
            pinBtn.style.display = '';
            pinBtn.innerHTML = chat.pinned ? UI_ICONS.pinFilled : UI_ICONS.pin;
            pinBtn.classList.toggle('pinned', !!chat.pinned);
            var pinTip = chat.pinned ? 'Unpin chat' : 'Pin chat';
            pinBtn.title = pinTip;
            pinBtn.setAttribute('aria-label', pinTip);
            pinBtn.setAttribute('aria-pressed', chat.pinned ? 'true' : 'false');
        } else {
            pinBtn.style.display = 'none';
        }
    }

    // Keep the sub-agent self card (parent-link + live worker card above the
    // messages scroller) in sync — this runs on every chat switch and header
    // refresh, which is exactly when the card must appear/disappear.
    // Later-tier global (175-sub-agent-ui.js), so typeof-guard it.
    if (typeof updateSubAgentSelfCard === 'function') {
        try { updateSubAgentSelfCard(); } catch (e) {}
    }
}

// EXPLICIT-DELETE (SW propagation). The service worker keeps its OWN
// authoritative `chats` map (worker/115-storage.js) and re-puts every chat it
// holds at its next save (one fires at every tool boundary), so a page-only
// delete was silently undone: the row came back and survived reload.
// The SW's inbound port switch (worker/130-port-bridge.js) has no 'delete-chat'
// type, so the deletion is expressed with the EXISTING 'update-chat' type
// carrying an empty-message TOMBSTONE ({ messages: [], _deleted: true }):
//   • the SW's save desired-set filter keeps only chats with messages.length > 0,
//     so the SW can never re-put this row again, and
//   • the SW's delete-pass treats a `_deleted` tombstone as an EXPLICIT delete,
//     exempt from the wipe-guard cap/budget — so if a save that was already in
//     flight re-put the row, the next SW save removes it again, and
//   • the SW's 'update-chat' handler accepts a `_deleted` payload EVEN WHILE A
//     RUN IS REGISTERED for that chat (it is a delete command, not a stale
//     snapshot) and fires its own targeted deleteChatFromDB — without that
//     exemption the tombstone for a RUNNING chat was dropped by the
//     authoritative-writer guard and the chat resurrected.
// Posted straight on the agent bus port (_agentBusPort, app/045-agent-port-bridge-page.js)
// with an inline tombstone payload — chats[chatId] is already gone at this point.
// FOLLOW-UP: a dedicated 'delete-chat' inbound type would be the explicit
// protocol; the tombstone is the equivalent expressed with today's message set
// (and now gets the same unconditional treatment on the SW side).
// Returns TRUE only when the tombstone was actually handed to a live port.
// A dropped tombstone means the SW re-puts the row at its next save, i.e. a
// guaranteed resurrection — so callers MUST surface a false return (deleteChat
// does, next to the same snackbar the IDB-delete failure path uses).
function _notifyWorkerChatDeleted(chatId) {
    if (!chatId) return false;
    var _payload = {
        type: 'update-chat',
        chatId: chatId,
        chat: { id: chatId, messages: [], _deleted: true, deletedAt: Date.now() }
    };
    // Dead / never-opened bus (SW evicted, reconnect window): recover before
    // giving up. _openAgentBus (app/045-agent-port-bridge-page.js) assigns
    // _agentBusPort SYNCHRONOUSLY unless chrome.runtime.connect throws, and
    // it is idempotent (no-ops on a live port), so one call is enough to make
    // the post attempt below meaningful.
    if (typeof _agentBusPort === 'undefined' || !_agentBusPort) {
        try { if (typeof _openAgentBus === 'function') _openAgentBus(); } catch (eO) {}
        if (typeof _agentBusPort === 'undefined' || !_agentBusPort) return false;
    }
    try {
        _agentBusPort.postMessage(_payload);
        return true;
    } catch (e) {
        // The port died between the check and the post. onDisconnect nulls
        // _agentBusPort synchronously, so reopen once and re-post; if the
        // handle is still the stale one, the retry throws again and we report
        // the failure instead of swallowing it.
        try {
            if (typeof _openAgentBus === 'function') _openAgentBus();
            if (typeof _agentBusPort !== 'undefined' && _agentBusPort) {
                _agentBusPort.postMessage(_payload);
                return true;
            }
        } catch (e2) {}
        return false;
    }
}

async function deleteChat(chatId, e) {
    e.stopPropagation();
    var chat = chats[chatId];
    var title = chat ? chat.title : 'this chat';

    // Check if any dashboard widgets are linked to this chat
    var linkedWidgets = [];
    for (var widgetId in dashboardWidgets) {
        var widget = dashboardWidgets[widgetId];
        if (widget.chatId === chatId) {
            linkedWidgets.push(widget.title || 'Untitled Widget');
        }
    }

    var message = 'Delete "' + escapeHtml(title) + '"? This action cannot be undone.';
    if (linkedWidgets.length > 0) {
        var escapedWidgets = linkedWidgets.map(function(w) { return escapeHtml(w); });
        message = 'Delete "' + escapeHtml(title) + '"?<br><br>⚠️ <strong>Warning:</strong> This chat is linked to ' + linkedWidgets.length +
            ' dashboard widget' + (linkedWidgets.length > 1 ? 's' : '') + ':<br>• ' + escapedWidgets.join('<br>• ') +
            '<br><br>Deleting this chat will prevent these widgets from being regenerated with their original context.';
    }

    var result = await showModal('Delete Chat', message, [
        { label: 'Cancel', value: 'cancel', class: 'secondary' },
        { label: 'Delete', value: 'delete', class: 'danger' }
    ], 'danger');
    if (result !== 'delete') return;
    // EXPLICIT-DELETE: stop the run first. This is no longer what makes the
    // tombstone land (the SW now accepts a `_deleted` payload even mid-run —
    // worker/130-port-bridge.js 'update-chat'), and it deliberately is NOT
    // awaited: a mid-stream abort can take seconds to settle, and blocking the
    // delete on it would leave the user's action pending and lose it entirely
    // if the panel closed meanwhile. It is still required so the aborted run
    // stops burning tokens/tools on a chat that no longer exists.
    try {
        if (typeof runningChatIds !== 'undefined' && runningChatIds && runningChatIds[chatId]
            && typeof pushInterruptToOffscreen === 'function') {
            pushInterruptToOffscreen(chatId, false);
        }
    } catch (eInt) {}
    // Keep the record for the targeted IDB delete at the end — it needs this
    // chat's payload ids, and the map entry is about to go.
    var _deletedRecord = chats[chatId];
    delete chats[chatId];
    // SWM-TOKENLEAK: prune the per-chat pause/interrupt latest-wins token maps so a
    // chat paused-and-never-resumed then deleted doesn't leak its 4 entries forever
    // (the runFinished cleanup in app/045 only prunes on a NON-paused terminal event).
    try { if (typeof _pruneChatPauseTokens === 'function') _pruneChatPauseTokens(chatId); } catch (ePt) {}
    // MEMFIX (leak prunes): drop per-chat caches that used to survive deletion.
    // chatWidgets map (tools/080-widget-tools.js) holds the chat's widget array.
    try { if (typeof chatWidgets !== 'undefined' && chatWidgets) delete chatWidgets[chatId]; } catch (eCw) {}
    // Expanded-state maps (core/030-config.js) are keyed by chatId+':'+…
    try {
        var _pfx = chatId + ':';
        [typeof compactAreaExpandedState !== 'undefined' ? compactAreaExpandedState : null,
         typeof thinkingExpandedState !== 'undefined' ? thinkingExpandedState : null,
         typeof userMsgExpandedState !== 'undefined' ? userMsgExpandedState : null].forEach(function(map) {
            if (!map) return;
            Object.keys(map).forEach(function(k) { if (k.indexOf(_pfx) === 0) delete map[k]; });
        });
    } catch (eEs) {}
    // fileIndex pointers (tools/040-file-store.js) into the deleted chat are dead.
    try {
        if (typeof fileIndex !== 'undefined' && fileIndex && fileIndex.forEach) {
            var _deadFids = [];
            fileIndex.forEach(function(ptr, fid) { if (ptr && ptr.chatId === chatId) _deadFids.push(fid); });
            _deadFids.forEach(function(fid) { fileIndex.delete(fid); });
        }
    } catch (eFi) {}
    // EXPLICIT-DELETE: tell the service worker BEFORE the save, so its own
    // authoritative copy stops being a source of re-puts (see
    // _notifyWorkerChatDeleted above).
    var _swNotified = false;
    try { _swNotified = _notifyWorkerChatDeleted(chatId); } catch (eSw) { _swNotified = false; }
    saveChatsToStorage();
    if (currentChatId === chatId) {
        var ids = Object.keys(chats);
        ids.length > 0 ? selectChat(ids[0]) : newChat();
    } else renderChatList();
    renderHistoryPage();
    showSnackbar('Chat deleted', 'success');
    // EXPLICIT-DELETE: a tombstone that never reached the SW is a guaranteed
    // resurrection (its authoritative copy re-puts the row at the next tool
    // boundary), so it gets the SAME visible treatment as a failed IDB delete
    // below instead of being discarded silently. The 3s retry may still
    // recover it — that outcome is reported too.
    if (!_swNotified) {
        showSnackbar('Chat deleted, but the background worker could not be reached — it may come back after a reload', 'error');
    }
    // EXPLICIT-DELETE: durable, targeted removal of the row (and this chat's
    // now-unreferenced payload blobs) from IndexedDB. saveChatsToStorage above
    // is UPSERT-ONLY since PR 3 (RFC addendum — the absence-diff delete-pass
    // is gone from both realms): saves never delete, so this targeted
    // deleteChatRow('user-delete') call IS the page-side deletion.
    // Awaited AFTER the UI updates so a congested IDB can't stall the delete
    // feedback.
    if (typeof deleteChatFromDB === 'function') {
        var _delOk = await deleteChatFromDB(chatId, _deletedRecord);
        if (!_delOk) showSnackbar('Chat removed from the list, but the stored copy could not be deleted', 'error');
    }
    // One bounded re-run: covers an SW save that was already in flight when we
    // deleted (it re-puts the row before our tombstone is applied), a run whose
    // abort hadn't settled yet, and a bus that was down at delete time. Both
    // the tombstone post and the targeted delete are idempotent.
    setTimeout(function() {
        var _reNotified = false;
        try { _reNotified = _notifyWorkerChatDeleted(chatId); } catch (eR1) {}
        // Only speak up when the first attempt had already failed and the user
        // saw the error above — silence otherwise (the happy path is routine).
        if (!_swNotified) {
            showSnackbar(_reNotified
                ? 'Background worker reached — the chat deletion is durable'
                : 'The background worker is still unreachable — the deleted chat may come back after a reload',
                _reNotified ? 'success' : 'error');
        }
        // deleteChatFromDB is async: a plain try/catch around the call can only
        // catch a SYNCHRONOUS throw, so a rejected promise escaped as an
        // unhandled rejection and its false return was discarded. Handle both.
        if (typeof deleteChatFromDB !== 'function') return;
        try {
            Promise.resolve(deleteChatFromDB(chatId, _deletedRecord)).then(function(ok) {
                if (!ok) console.warn('[chat-delete] retry: targeted IDB delete of chat ' + chatId + ' did not complete');
            }, function(eR2) {
                console.error('[chat-delete] retry: targeted IDB delete failed for chat ' + chatId, eR2);
            });
        } catch (eR3) {
            console.error('[chat-delete] retry: targeted IDB delete threw for chat ' + chatId, eR3);
        }
    }, 3000);
}

function togglePinChat(chatId) {
    var chat = chats[chatId];
    if (!chat) return;
    // FLUX-4C: pinned rides the chat-meta lane — the SW is the single
    // persister. This also retires the old MEMFIX rehydrate-then-save dance
    // for payload-evicted chats: the SW read-merge-puts the stored record
    // directly, so no page-side payload rehydration is needed for a pin.
    if (typeof dispatchChatMeta === 'function') dispatchChatMeta(chatId, { pinned: !chat.pinned });
    renderChatList();
    renderVersionSidebar();
    // #720: pinning the CURRENTLY OPEN chat from the sidebar dropdown / History /
    // Jobs rows must repaint the header pin button too (filled vs outline) —
    // same follow-up togglePinCurrentChat performs (ui/210-chat-menus.js:43).
    if (chatId === currentChatId) updateChatTitleHeader();
}

function deleteChatFromSidebar() {
    if (!currentChatId) return;
    deleteChat(currentChatId, { stopPropagation: function() {} });
}
