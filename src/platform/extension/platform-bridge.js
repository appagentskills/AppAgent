// AppAgent Chrome Extension - Platform Bridge
// Sets up window.sessionToken and Platform overrides for extension context
// Runs on an extension page with full chrome.* API and localStorage access

(function() {
    'use strict';

    // Browser notification when agent finishes in the background
    Platform.sendNotification = function(opts) {
        chrome.runtime.sendMessage({
            type: 'show-notification',
            title: opts.title || 'AppAgent',
            message: opts.message || '',
            chatId: opts.chatId || ''
        });
    };

    // Load session info from chrome.storage (set by content script)
    // Store as a promise so init() can wait for it
    Platform.ready = new Promise(function(resolve) {
        chrome.storage.local.get(['sessionToken', 'userName', 'instanceUrl'], function(data) {
            window.sessionToken = data.sessionToken || '';
            Platform.instanceUrl = data.instanceUrl || '';
            if (data.userName) {
                window.NOW = window.NOW || {};
                window.NOW.user_name = data.userName;
            }

            resolve();
        });
    });

    // Wrap window.onload (already set to init by app code) to wait for session data
    var _origOnload = window.onload;
    window.onload = function(ev) {
        Platform.ready.then(function() {
            // DOM is now ready — validate token and update status
            validateToken();
            if (typeof _origOnload === 'function') _origOnload(ev);
        });
    };

    // Listen for storage changes (when user visits a ServiceNow page, token gets updated)
    chrome.storage.onChanged.addListener(function(changes) {
        if (changes.sessionToken) {
            window.sessionToken = changes.sessionToken.newValue || '';
        }
        if (changes.instanceUrl) {
            Platform.instanceUrl = changes.instanceUrl.newValue || '';
        }
        if (changes.sessionToken || changes.instanceUrl) {
            validateToken();
        }
        if (changes.userName) {
            window.NOW = window.NOW || {};
            window.NOW.user_name = changes.userName.newValue || '';
        }
        // Auto-update usage display when rate limit headers arrive from API responses
        // (claudeRateLimits: anthropic-ratelimit-* scrape; openaiRateLimits: x-codex-*
        // scrape after each Codex response — makes the pill appear without a manual refresh)
        if ((changes.claudeRateLimits || changes.openaiRateLimits) && typeof fetchCredits === 'function') {
            fetchCredits();
        }
        // Refresh multi-instance registry when SN connection changes
        if (changes.sessionToken || changes.instanceUrl) {
            Platform.refreshInstances();
        }
    });

    // --- Multi-instance token registry ---
    // Tracks tokens/users for ALL connected instances, not just the active one
    Platform.instances = []; // [{ url, shortName, token, userName, tabs }]

    // Reconcile a raw probe list with the active session token. The active instance
    // is the one this panel actually holds a live token for (window.sessionToken); a
    // tab probe that transiently can't read g_ck (tab discarded by Chrome Memory
    // Saver, scripting blocked, no readable main-world context) returns an empty token
    // for it, which would wrongly render it "signed out" in the picker even though we
    // are connected — and contradicts the header pill, which keys off the session
    // token. Patch the active entry to reflect the token we actually hold (inserting it
    // if the probe missed the origin entirely). Mirrors the SW Platform stub's
    // refreshInstances guard and getTokenForInstance, which already trust the active
    // session token unconditionally.
    function _reconcileActiveToken(list) {
        list = list || [];
        if (!Platform.instanceUrl || !window.sessionToken) return list;
        var norm = _normUrl(Platform.instanceUrl);
        // Carry the active instance's already-resolved identity (roles/userName) forward
        // from the live registry: the tab probe returns them empty for the active
        // instance (g_ck unreadable), but _ensureActiveRoles patches Platform.instances
        // once fetched, so reuse that so the badge survives subsequent refreshes.
        var prevActive = (Platform.instances || []).filter(function(p) { return p && _normUrl(p.url) === norm; })[0];
        var seen = false;
        list.forEach(function(i) {
            if (i && _normUrl(i.url) === norm) {
                seen = true;
                if (!i.token) i.token = window.sessionToken;
                if ((!i.roles || !i.roles.length) && prevActive && prevActive.roles && prevActive.roles.length) i.roles = prevActive.roles;
                if (!i.userName && prevActive && prevActive.userName) i.userName = prevActive.userName;
            }
        });
        if (!seen) {
            list.push({ url: Platform.instanceUrl, tabs: [], userName: (prevActive && prevActive.userName) || '', roles: (prevActive && prevActive.roles) || [], token: window.sessionToken });
        }
        return list;
    }

    // The tab probe can't read g_ck for the active instance, so its roles come back
    // empty and the privilege badge (admin / security_admin) is missing even though we
    // hold a usable session token. Fetch the role list directly via window.sessionToken
    // (same query as the per-row roles panel), patch the registry + the passed list, and
    // re-render so the badge appears. Guarded to fire at most once per instance so the
    // re-render can't loop.
    var _activeRolesFetchedFor = '';
    function _ensureActiveRoles(inst, instances) {
        if (!inst || inst.url !== Platform.instanceUrl || !window.sessionToken) return;
        if (inst.roles && inst.roles.length) return;
        if (_activeRolesFetchedFor === inst.url) return;
        _activeRolesFetchedFor = inst.url;
        var url = inst.url + '/api/now/table/sys_user_has_role'
            + '?sysparm_query=user=javascript:gs.getUserID()'
            + '&sysparm_fields=role.name'
            + '&sysparm_limit=500';
        _origFetch.call(window, url, {
            method: 'GET',
            headers: { 'X-UserToken': window.sessionToken, 'Accept': 'application/json' },
            credentials: 'include'
        }).then(function(res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.json();
        }).then(function(data) {
            var rows = (data && data.result) || [];
            var roles = [];
            for (var i = 0; i < rows.length; i++) {
                var name = rows[i] && rows[i]['role.name'];
                if (name && roles.indexOf(name) === -1) roles.push(name);
            }
            if (!roles.length) return;
            (Platform.instances || []).forEach(function(p) { if (p && p.url === inst.url) p.roles = roles; });
            inst.roles = roles;
            if (_instanceDropdown) renderInstanceDropdown(instances);
        }).catch(function() { _activeRolesFetchedFor = ''; });
    }

    // Refresh the full instance list from background (probes all open SN tabs)
    Platform.refreshInstances = function() {
        return new Promise(function(resolve) {
            chrome.runtime.sendMessage({ type: 'list-sn-instances-detailed' }, function(response) {
                if (chrome.runtime.lastError || !response || !response.instances) {
                    resolve(Platform.instances);
                    return;
                }
                var _reconciled = _reconcileActiveToken(response.instances);
                Platform.instances = _reconciled.map(function(inst) {
                    var host = inst.url.replace(/^https?:\/\//, '').replace(/\/$/, '');
                    return {
                        url: inst.url,
                        shortName: host.split('.')[0],
                        host: host,
                        token: inst.token || '',
                        userName: inst.userName || '',
                        roles: inst.roles || [],
                        tabs: inst.tabs || [],
                        isActive: inst.url === Platform.instanceUrl
                    };
                });
                _cacheInstances(_reconciled); // keep the picker's instant-open cache warm
                resolve(Platform.instances);
            });
        });
    };

    // Resolve a short name or URL to a full instance URL
    // Accepts: "dev12345", "dev12345.service-now.com", "https://dev12345.service-now.com"
    Platform.resolveInstanceUrl = function(nameOrUrl) {
        if (!nameOrUrl) return Platform.instanceUrl;
        // Already a full URL
        if (nameOrUrl.startsWith('http')) return nameOrUrl.replace(/\/$/, '');
        // Has dots — treat as hostname
        if (nameOrUrl.indexOf('.') !== -1) return 'https://' + nameOrUrl.replace(/\/$/, '');
        // Short name — check cached instances only (don't guess domain)
        for (var i = 0; i < Platform.instances.length; i++) {
            if (Platform.instances[i].shortName === nameOrUrl) return Platform.instances[i].url;
        }
        // No match found — return null so callers can report a clear error
        return null;
    };

    // Synchronous access to the active-instance session token.
    // In the page bundle this mirrors `window.sessionToken`. The Service
    // Worker has its own implementation that reads from chrome.storage.local.
    // Always prefer Platform.getSessionToken() over `window.sessionToken` so
    // shared code (tool implementations) works in either context.
    Platform.getSessionToken = function() {
        return (typeof window !== 'undefined' && window.sessionToken) || '';
    };

    // Worker-portable referer accessor. callLLMStreaming uses this for the
    // HTTP-Referer header. In the page bundle we use the SN instance URL when
    // known, falling back to the side-panel URL. The offscreen worker bundle
    // overrides this to return a stable static referer because window.location
    // in offscreen points at offscreen.html (not useful for OpenRouter logs).
    Platform.getReferer = function() {
        return Platform.instanceUrl || (typeof window !== 'undefined' ? window.location.href : '');
    };

    // Get a token for a specific instance URL (uses cache, falls back to background probe)
    Platform.getTokenForInstance = function(instanceUrl) {
        // Check active instance first
        if (instanceUrl === Platform.instanceUrl && window.sessionToken) {
            return Promise.resolve(window.sessionToken);
        }
        // Check cached instances
        for (var i = 0; i < Platform.instances.length; i++) {
            if (Platform.instances[i].url === instanceUrl && Platform.instances[i].token) {
                return Promise.resolve(Platform.instances[i].token);
            }
        }
        // Ask background to probe a fresh token from a tab
        return new Promise(function(resolve) {
            chrome.runtime.sendMessage({ type: 'get-token-for-instance', instanceUrl: instanceUrl }, function(response) {
                if (chrome.runtime.lastError || !response || !response.token) {
                    resolve('');
                    return;
                }
                // Update cache
                var found = false;
                for (var i = 0; i < Platform.instances.length; i++) {
                    if (Platform.instances[i].url === instanceUrl) {
                        Platform.instances[i].token = response.token;
                        if (response.userName) Platform.instances[i].userName = response.userName;
                        found = true;
                        break;
                    }
                }
                if (!found) {
                    var host = instanceUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
                    Platform.instances.push({
                        url: instanceUrl,
                        shortName: host.split('.')[0],
                        host: host,
                        token: response.token,
                        userName: response.userName || '',
                        tabs: [],
                        isActive: instanceUrl === Platform.instanceUrl
                    });
                }
                resolve(response.token);
            });
        });
    };

    // Find a tab ID for a specific instance (for iframe_tool targeting).
    // When a target URL is given, only return a tab already sitting on that page
    // (same origin + path) — returning an arbitrary tab would let the caller
    // navigate away a tab the user is actively using, bypassing the adoption
    // safeguards in iframe_tool. With no match, return null so the caller's own
    // (guarded) adoption / tab-creation logic decides.
    Platform.getTabForInstance = function(instanceUrl, targetUrl) {
        for (var i = 0; i < Platform.instances.length; i++) {
            if (Platform.instances[i].url !== instanceUrl || Platform.instances[i].tabs.length === 0) continue;
            var tabs = Platform.instances[i].tabs;
            if (targetUrl) {
                try {
                    var _tgt = new URL(targetUrl);
                    var _tgtPath = _tgt.pathname.replace(/\/+$/, '');
                    for (var j = 0; j < tabs.length; j++) {
                        try {
                            var _tu = new URL(tabs[j].url);
                            if (_tu.origin === _tgt.origin && _tu.pathname.replace(/\/+$/, '') === _tgtPath) return tabs[j].id;
                        } catch (e) {}
                    }
                    return null;
                } catch (e) {}
            }
            return tabs[0].id;
        }
        return null;
    };

    // Refresh instances on load and periodically
    Platform.ready.then(function() {
        Platform.refreshInstances();
    });
    setInterval(function() { Platform.refreshInstances(); }, 2 * 60 * 1000);

    // --- Status indicators ---
    var _snStatusState = 'unknown'; // 'connected', 'disconnected', 'unknown'

    // Pure renderer — displays whatever _snStatusState says
    function updateSnStatus() {
        var els = [document.getElementById('ext-sn-status'), document.getElementById('home-ext-sn-status')];

        if (!Platform.instanceUrl) {
            _snStatusState = 'disconnected';
            els.forEach(function(el) {
                if (!el) return;
                el.className = 'ext-status ext-sn-status disconnected';
                el.innerHTML = '<span class="ext-status-dot"></span>Not connected';
                el.title = 'No ServiceNow instance. Open a ServiceNow page in another tab.';
                el.style.display = '';
            });
            return;
        }

        var host = Platform.instanceUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
        var shortName = host.split('.')[0];
        var isOk = _snStatusState === 'connected';
        var instPerms = (typeof instancePermissions !== 'undefined' && instancePermissions[host]) || { tier: 'manual' };
        var tierLabel = instPerms.tier === 'auto' ? 'Auto' : 'Manual';

        els.forEach(function(el) {
            if (!el) return;
            el.className = 'ext-status ext-sn-status' + (isOk ? '' : ' disconnected');
            el.innerHTML = '<span class="ext-status-dot"></span>' + escapeHtml(shortName) +
                (isOk ? ' <span class="ext-status-tier">' + escapeHtml(tierLabel) + '</span>' : '');
            el.title = isOk ? 'Connected to ' + host + ' (' + tierLabel + ' mode)' : 'Disconnected from ' + host;
            el.style.display = '';
        });
    }
    // Expose on window: the core bundle (loadToolPermissions in ui/070-dashboard-ui.js,
    // saveInstancePermissions in ui/080-scope.js, the tier toggle in ui/140-dropdowns.js)
    // re-renders the header tier pill via a guarded `typeof updateSnStatus === 'function'`
    // call. Those callers live OUTSIDE this IIFE, so without this assignment the guard
    // reads 'undefined' and silently no-ops — the pill keeps showing the stale 'Manual'
    // rendered by validateToken() before the async IDB load of instancePermissions
    // completed, even though the saved tier is 'auto' (and the picker dropdown,
    // which renders later inside this IIFE, correctly shows 'Auto').
    window.updateSnStatus = updateSnStatus;

    // Sole authority on connection state — validates and recovers tokens
    function validateToken() {
        if (!Platform.instanceUrl) {
            _snStatusState = 'disconnected';
            updateSnStatus();
            return;
        }
        // No token — try to recover one: an open SN tab's g_ck first, else the
        // cached heartbeat token (the background's get-token-for-instance probes
        // tabs and then falls back to the per-origin instanceTokens cache). A
        // tab-less but heartbeat-connected active instance must NOT render as
        // Disconnected in the header while the picker shows it green; only mark
        // disconnected when neither a tab nor a cached token exists.
        if (!window.sessionToken) {
            chrome.runtime.sendMessage({ type: 'get-token-for-instance', instanceUrl: Platform.instanceUrl }, function(resp) {
                if (chrome.runtime.lastError) return;
                if (resp && resp.token) {
                    window.sessionToken = resp.token;
                    chrome.storage.local.set({ sessionToken: resp.token });
                    validateToken(); // Now validate the recovered token
                } else {
                    _snStatusState = 'disconnected';
                    updateSnStatus();
                }
            });
            return;
        }
        _origFetch.call(window, Platform.instanceUrl + '/api/now/uisession/touch-session', {
            method: 'POST',
            headers: { 'X-UserToken': window.sessionToken, 'Content-Type': 'application/json', 'Accept': 'application/json' },
            credentials: 'include'
        }).then(function(res) {
            if (res.status === 401) {
                window.sessionToken = '';
                _snStatusState = 'disconnected';
                updateSnStatus();
                return;
            }
            // The touch-session POST above did NOT return 401, so the session is
            // still alive server-side. Keep the instance marked connected even when
            // every tab has been closed — the user may have closed the tab without
            // paying attention, and the heartbeat keeps the session warm. A truly
            // dead session returns 401 above and is marked disconnected.
            _snStatusState = 'connected';
            updateSnStatus();
        }).catch(function() {
            // Network error — leave status as-is
        });
    }

    // Check on load, visibility change, and every 5 minutes
    document.addEventListener('visibilitychange', function() {
        if (!document.hidden) {
            validateToken();
        }
    });
    setInterval(validateToken, 5 * 60 * 1000);

    function updateActiveTabStatus(info) {
        // Active tab indicator is hidden — keep data updated for internal use only
        var el = document.getElementById('active-tab-url');
        if (!el) return;
        if (info && info.url) {
            var label = info.url;
            try { label = new URL(label).hostname + new URL(label).pathname; } catch(e) {}
            if (label.length > 50) label = label.substring(0, 48) + '...';
            el.textContent = label;
            el.title = info.url || '';
        } else {
            el.textContent = 'No active tab';
            el.title = '';
        }
    }

    function escapeHtml(s) {
        var d = document.createElement('div');
        d.textContent = s;
        return d.innerHTML;
    }

    // Listen for active tab changes from background
    chrome.runtime.onMessage.addListener(function(msg) {
        if (msg.type === 'active-tab-changed') {
            updateActiveTabStatus(msg);
        }
    });

    // Query initial active tab info
    chrome.runtime.sendMessage({ type: 'get-active-tab-info' }, function(response) {
        if (chrome.runtime.lastError) return;
        if (response) updateActiveTabStatus(response);
    });

    // Intercept fetch — resolve relative SN URLs to full URLs with token
    var _origFetch = window.fetch;
    window.fetch = function(url, opts) {
        if (typeof url === 'string' && url.startsWith('/')) {
            if (!Platform.instanceUrl) {
                return Promise.reject(new Error('No ServiceNow instance connected. Visit a ServiceNow page first.'));
            }
            var fullUrl = Platform.instanceUrl + url;
            opts = opts || {};
            opts.headers = opts.headers || {};
            opts.headers['X-UserToken'] = window.sessionToken || '';
            opts.credentials = 'include';

            var doFetch = function() {
                opts.headers['X-UserToken'] = window.sessionToken || '';
                return _origFetch.call(window, fullUrl, opts).then(function(res) {
                    if (res.status === 401) {
                        _snStatusState = 'disconnected';
                        updateSnStatus();
                        return _refreshToken().then(function(newToken) {
                            if (!newToken) {
                                return _openSnForLogin().then(function(loginToken) {
                                    if (!loginToken) return res;
                                    opts.headers['X-UserToken'] = loginToken;
                                    return _origFetch.call(window, fullUrl, opts);
                                });
                            }
                            updateSnStatus();
                            opts.headers['X-UserToken'] = newToken;
                            return _origFetch.call(window, fullUrl, opts).then(function(retryRes) {
                                if (retryRes.status === 401) {
                                    return _openSnForLogin().then(function(loginToken) {
                                        if (!loginToken) return retryRes;
                                        opts.headers['X-UserToken'] = loginToken;
                                        return _origFetch.call(window, fullUrl, opts);
                                    });
                                }
                                return retryRes;
                            });
                        });
                    }
                    if (_snStatusState !== 'connected') {
                        _snStatusState = 'connected';
                        updateSnStatus();
                    }
                    return res;
                });
            };

            if (!window.sessionToken) {
                return _refreshToken().then(function(token) {
                    if (!token) {
                        return _openSnForLogin().then(function(loginToken) {
                            if (!loginToken) return Promise.reject(new Error('Authentication timed out.'));
                            return doFetch();
                        });
                    }
                    return doFetch();
                });
            }
            return doFetch();
        }
        return _origFetch.call(window, url, opts);
    };

    // Refresh token by extracting g_ck from an open ServiceNow tab
    function _refreshToken() {
        return new Promise(function(resolve) {
            chrome.runtime.sendMessage({ type: 'refresh-sn-token' }, function(response) {
                if (chrome.runtime.lastError || !response || !response.token) {
                    resolve(null);
                    return;
                }
                window.sessionToken = response.token;
                resolve(response.token);
            });
        });
    }

    // Open a ServiceNow page for the user to log in, wait for new token
    function _openSnForLogin() {
        var oldToken = window.sessionToken || '';
        return new Promise(function(resolve) {
            chrome.runtime.sendMessage({ type: 'open-sn-for-login' }, function() {
                if (chrome.runtime.lastError) { resolve(null); return; }
                var attempts = 0;
                var poll = setInterval(function() {
                    attempts++;
                    if (attempts > 120) { clearInterval(poll); resolve(null); return; }
                    _refreshToken().then(function(token) {
                        if (token && token !== oldToken) {
                            clearInterval(poll);
                            resolve(token);
                        }
                    });
                }, 2000);
            });
        });
    }

    // Browser action proxy - routes iframe_tool actions through background service worker
    // All actions (including screenshot) go through background so it can target the correct tab
    // targetTabId is read from the current chat so each chat targets its own tested tab
    Platform.sendBrowserAction = function(action, args) {
        var targetTabId = null;
        if (typeof chats !== 'undefined' && typeof currentChatId !== 'undefined' && chats[currentChatId]) {
            targetTabId = chats[currentChatId].targetTabId || null;
        }
        return new Promise(function(resolve) {
            chrome.runtime.sendMessage({
                type: 'browser-action',
                action: action,
                args: args,
                targetTabId: targetTabId
            }, function(response) {
                resolve(response || { error: chrome.runtime.lastError && chrome.runtime.lastError.message || 'No response' });
            });
        });
    };

    // --- Instance picker dropdown ---
    var _instanceDropdown = null;
    // Cache of the last detailed instance list we received. Lets us render the
    // dropdown INSTANTLY from known values on open, then quietly reconcile — so
    // opening never blocks on the (network-heavy) detailed probe. Persisted to
    // storage so even the first open after a reload shows the last-known list.
    var _instancesCache = null;
    var _INSTANCES_CACHE_KEY = 'snInstancesCache';

    // How long a closed / signed-out instance stays visible in the picker after we
    // last saw it live. Past this window it is evicted from the cache entirely.
    var _INSTANCE_RETENTION_MS = 24 * 60 * 60 * 1000; // 1 day

    // Store a slim copy (only what the dropdown renders — no tokens) in memory and
    // in chrome.storage so it survives panel reloads. Instances that drop out of the
    // live probe (tab closed / signed out) are RETAINED as disconnected until they
    // age out, so they keep showing — at the end of the list — instead of vanishing.
    // Normalize an instance URL for identity comparisons — strips trailing slashes
    // so e.g. "https://x.service-now.com" (live tab origin) and
    // "https://x.service-now.com/" (older persisted entry) merge into ONE picker row
    // instead of rendering duplicates with the same host.
    function _normUrl(u) { return String(u || '').replace(/\/+$/, ''); }

    // Per-instance "disabled for agent" flags. Persisted in chrome.storage.local
    // under `disabledInstances` (map of normalized URL -> true) so the tool layer
    // (list_instances + the disabled-instance guard in tools/020-tool-execution.js)
    // can read the same source of truth from either the page bundle or the
    // service worker. Semantics: the AGENT must never use a disabled instance;
    // the USER can still open/switch to it manually from the picker.
    var _disabledInstances = {};
    var _DISABLED_INSTANCES_KEY = 'disabledInstances';
    try {
        chrome.storage.local.get(_DISABLED_INSTANCES_KEY, function(d) {
            _disabledInstances = (d && d[_DISABLED_INSTANCES_KEY]) || {};
            // Hydration races the first render: clear the signature so the next
            // refresh/render can't be short-circuited into keeping a row that
            // was drawn before the flags loaded (isInstanceDisabled fails open
            // until this callback runs).
            _instancePickerLastSig = '';
        });
    } catch (e) {}
    function isInstanceDisabled(url) { return !!_disabledInstances[_normUrl(url)]; }
    function setInstanceDisabled(url, disabled) {
        var u = _normUrl(url);
        if (disabled) _disabledInstances[u] = true; else delete _disabledInstances[u];
        try { var _o = {}; _o[_DISABLED_INSTANCES_KEY] = _disabledInstances; chrome.storage.local.set(_o); } catch (e) {}
    }
    // Expose for other page modules (this file is an IIFE).
    window.isInstanceDisabled = isInstanceDisabled;
    window.setInstanceDisabled = setInstanceDisabled;

    // Tombstones for just-removed instances: a detailed probe already in
    // flight when the user clicked remove would otherwise re-persist the URL
    // (its response was built BEFORE the background deleted the
    // instanceTokens entry) and the row would pop right back. Honoured by
    // _cacheInstances / _seedRenderList / _withRetainedInstances for 10s \u2014
    // by then the deletion has landed and the next probe stays clean.
    var _recentlyRemoved = {};
    var _REMOVED_TOMBSTONE_MS = 10000;
    function _isRecentlyRemoved(u) {
        var t = _recentlyRemoved[u];
        if (!t) return false;
        if (Date.now() - t > _REMOVED_TOMBSTONE_MS) { delete _recentlyRemoved[u]; return false; }
        return true;
    }

    function _cacheInstances(list) {
        if (!list) return;
        var now = Date.now();
        var merged = {};
        // 1) Carry existing cache entries forward as DISCONNECTED (no live tab) and
        //    keep their old lastSeen so they continue to age out. Legacy entries with
        //    NO lastSeen are stamped `now` so they age out from here instead of being
        //    evicted instantly (keeps eviction consistent with _seedRenderList, which
        //    retains lastSeen-less entries). Still-live ones are
        //    fully replaced with fresh data in step 2.
        (_instancesCache || []).forEach(function(c) {
            if (!c || !c.url) return;
            var u = _normUrl(c.url);
            if (_isRecentlyRemoved(u)) return;
            merged[u] = { url: u, tabs: [], userName: c.userName || '', roles: c.roles || [], connected: false, lastSeen: c.lastSeen || now };
        });
        // 2) Upsert everything currently live with a fresh lastSeen + latest details.
        (list || []).forEach(function(i) {
            if (!i || !i.url) return;
            var u = _normUrl(i.url);
            if (_isRecentlyRemoved(u)) return;
            merged[u] = { url: u, tabs: i.tabs || [], userName: i.userName || '', roles: i.roles || [], connected: !!i.token, lastSeen: now };
        });
        // 3) Drop anything not seen within the retention window.
        var cutoff = now - _INSTANCE_RETENTION_MS;
        _instancesCache = Object.keys(merged).map(function(k) { return merged[k]; })
            .filter(function(c) { return (c.lastSeen || 0) >= cutoff; });
        try { var _o = {}; _o[_INSTANCES_CACHE_KEY] = _instancesCache; chrome.storage.local.set(_o); } catch (e) {}
    }

    // Build the picker's render list from a fresh live probe: the live instances
    // (which still carry tokens for roles/test) plus any cached-but-no-longer-live
    // instances rendered as disconnected "signed out" rows. Connected first.
    function _withRetainedInstances(liveList) {
        liveList = (liveList || []).filter(function(i) { return i && !_isRecentlyRemoved(_normUrl(i.url)); });
        var liveUrls = {};
        liveList.forEach(function(i) { if (i && i.url) liveUrls[_normUrl(i.url)] = true; });
        var retained = (_instancesCache || []).filter(function(c) {
            return c && c.url && !liveUrls[_normUrl(c.url)];
        }).map(function(c) {
            return { url: c.url, tabs: [], userName: c.userName || '', roles: c.roles || [], connected: false, retained: true };
        });
        return _orderInstances(liveList.concat(retained));
    }

    // Render list for a cache-seeded open (before the live probe returns): mark any
    // entry we have no live session for AND no open tab as a signed-out row, so the
    // instant-open view matches what the reconciling refresh will show.
    function _seedRenderList(seed) {
        var cutoff = Date.now() - _INSTANCE_RETENTION_MS;
        seed = (seed || []).filter(function(i) {
            return i && (!i.lastSeen || i.lastSeen >= cutoff) && !_isRecentlyRemoved(_normUrl(i.url));
        });
        return _orderInstances(seed.map(function(i) {
            if (!i) return i;
            var connected = !!(i.token || i.connected);
            var hasTab = !!(i.tabs && i.tabs.length);
            if (!connected && !hasTab) {
                return { url: i.url, tabs: [], userName: i.userName || '', roles: i.roles || [], connected: false, retained: true };
            }
            return i;
        }));
    }

    // Deterministic display order: connected instances first, signed-out last,
    // alphabetical by URL within each group. Deterministic (not probe order) so the
    // cache-seeded open and the reconciling refresh yield the same signature and
    // never flicker a re-render when nothing actually changed.
    function _orderInstances(list) {
        return (list || []).filter(Boolean).slice().sort(function(a, b) {
            var ac = (a.token || a.connected) ? 0 : 1;
            var bc = (b.token || b.connected) ? 0 : 1;
            if (ac !== bc) return ac - bc;
            return String(a.url || '').localeCompare(String(b.url || ''));
        });
    }

    // Hydrate the cache from storage at startup so the very first open (before any
    // live probe returns) can still show the last-known instances instead of a
    // "checking…" placeholder. Guarded so it never clobbers fresher in-memory data.
    try {
        chrome.storage.local.get(_INSTANCES_CACHE_KEY, function(d) {
            var stored = (d && d[_INSTANCES_CACHE_KEY]) || [];
            if (!stored.length) return;
            if (!_instancesCache || !_instancesCache.length) {
                _instancesCache = stored;
                return;
            }
            // A live refresh beat hydration: fold in stored entries the fresh
            // list doesn't know about so retained instances aren't evicted.
            // The live probe has ALREADY run and did not see these entries, so
            // they have no live session right now — fold them in as disconnected
            // rather than trusting a connected flag persisted by a prior session.
            var known = {};
            _instancesCache.forEach(function(c) { if (c && c.url) known[_normUrl(c.url)] = true; });
            stored.forEach(function(c) {
                if (!c || !c.url || known[_normUrl(c.url)]) return;
                _instancesCache.push({ url: _normUrl(c.url), tabs: [], userName: c.userName || '', roles: c.roles || [], connected: false, lastSeen: c.lastSeen || 0 });
            });
        });
    } catch (e) {}
    // Last-rendered instance list signature — used to skip re-rendering when
    // nothing meaningful changed (avoids collapsing an open per-row roles panel
    // or flickering when a refresh returns identical data).
    var _instancePickerLastSig = '';
    // The instance list the CURRENTLY mounted dropdown DOM was built from. The
    // remove \u2715 confirms through an ASYNC dialog (showConfirmModal), so by the
    // time the user clicks Confirm the per-row forEach closure's `instances`
    // array can be a render behind (a window-focus _refreshInstancePicker may
    // have swapped the DOM meanwhile). _removeInstanceEntry re-renders from this
    // instead of the stale closure list.
    var _lastRenderedInstances = [];

    // ── Remove-confirm in-flight guard ──────────────────────────────────────
    // The picker paints ABOVE the shared confirm dialog (--z-dropdown 10011 vs
    // --z-modal 10006, css/00-tokens.css:173,178). The tokens are deliberately NOT
    // reordered: --z-modal also backs .jobs-expand-overlay (css/23-actions.css:1747)
    // and the whole ladder is load-bearing elsewhere (documented order in
    // css/00-tokens.css:163-168, "stay below --z-modal/--z-snackbar" in
    // css/25-ws-files.css:16, Escape precedence in js/core/120-init.js:216-220) —
    // lifting the modal over 10011 would also lift it over --z-snackbar (10010) and
    // force --z-tooltip to move again. So the picker is neutralised locally instead.
    // While a remove confirm is awaiting an answer this flag:
    //   (a) refuses to open a SECOND dialog — there is a single global
    //       modalResolve (ui/220-notification-system.js:656,782), so a second
    //       showConfirmModal overwrites the first resolver and the first promise
    //       would dangle forever (rapid double-click on ✕, or ✕ on another row);
    //   (b) marks the dropdown .confirm-pending (css/04-header.css:235) +
    //       `inert`, which makes it click-through and un-tabbable, so no row can
    //       run switchToInstance while an aria-modal dialog is open — and clicks
    //       landing in the overlap region reach the dialog underneath.
    var _removeConfirmPending = false;

    // Read the flag through this: it is only trusted while the shared dialog is
    // actually on screen. If some OTHER modal steals modalResolve our promise
    // never settles, and a bare boolean would leave the picker inert forever —
    // reading it in that state heals the flag instead.
    function _isRemoveConfirmPending() {
        if (!_removeConfirmPending) return false;
        var ov = document.getElementById('modal-overlay');
        if (ov && ov.classList.contains('show')) return true;
        // Sweep 753-773 (F2-stale-pending-inert-dropdown): heal through the
        // setter so a mounted dropdown also sheds .confirm-pending + inert —
        // the bare boolean left the picker click-through until it was closed
        // and reopened (the \u2715 that allegedly self-heals it was itself
        // unclickable, and the focus-refresh signature short-circuit skips a
        // re-render because the signature ignores pending state).
        _setRemoveConfirmPending(false); // stale — no dialog is up
        return false;
    }

    function _setRemoveConfirmPending(pending) {
        _removeConfirmPending = !!pending;
        if (!_instanceDropdown) return;   // closed meanwhile — re-applied on the next render
        if (_removeConfirmPending) _instanceDropdown.classList.add('confirm-pending');
        else _instanceDropdown.classList.remove('confirm-pending');
        _instanceDropdown.inert = _removeConfirmPending;
    }

    function showInstancePicker() {
        if (_instanceDropdown) { hideInstancePicker(); return; }
        // Only one header dropdown open at a time (shared registry in ui/240-layout.js)
        if (typeof closeAllHeaderMenus === 'function') closeAllHeaderMenus('instances');
        // Open INSTANTLY from the last-known instance list so the dropdown never
        // waits on the network-heavy detailed probe. Prefer our persisted picker
        // cache, then the live Platform.instances registry; only show a brief
        // "checking…" placeholder when nothing is known yet (e.g. fresh install).
        var seed = (_instancesCache && _instancesCache.length) ? _instancesCache
                 : (Platform.instances && Platform.instances.length) ? Platform.instances
                 : null;
        var seeded = seed ? _seedRenderList(seed) : [];
        if (seeded.length) {
            renderInstanceDropdown(seeded);
        } else {
            // Nothing known (fresh install) or every cached entry aged past the
            // retention window — show the loading placeholder, not "no tabs".
            renderInstanceDropdown([], true);          // loading placeholder
            _instancePickerLastSig = '\u0000loading';  // force first response to re-render
        }
        // If neither status anchor was mounted, renderInstanceDropdown bailed (and
        // already called hideInstancePicker). With no dropdown there is nothing to
        // reconcile or keep in sync — don't fire a pointless probe or leak a
        // window-focus listener that would otherwise accumulate on every failed open.
        if (!_instanceDropdown) return;
        // Kick off ONE fresh detailed fetch to reconcile the cached view.
        _refreshInstancePicker();
        // Stay in sync WITHOUT polling: re-fetch only when the user returns focus
        // to the panel (e.g. after logging out / switching user in a SN tab).
        // Event-driven — so an open dropdown never fires REST calls non-stop.
        // remove-before-add keeps it idempotent (never stacks duplicate listeners).
        window.removeEventListener('focus', _refreshInstancePicker);
        window.addEventListener('focus', _refreshInstancePicker);
    }

    // One-shot detailed refresh: update the cache and re-render only when the
    // visible signature actually changed (no flicker, no needless work). An
    // in-flight guard collapses overlapping triggers (the open-time call racing a
    // window-focus event) into a single detailed probe.
    // Timestamp (0 = idle) rather than a boolean: if the callback never fires
    // (SW restart / context churn), an in-flight older than 10s is treated as
    // stale so a new probe is allowed instead of wedging refreshes forever.
    var _refreshInFlightAt = 0;
    var _REFRESH_STALE_MS = 10000;
    function _refreshInstancePicker() {
        if (_refreshInFlightAt && (Date.now() - _refreshInFlightAt) < _REFRESH_STALE_MS) return;
        _refreshInFlightAt = Date.now();
        try {
            chrome.runtime.sendMessage({ type: 'list-sn-instances-detailed' }, function(response) {
                _refreshInFlightAt = 0;
                if (chrome.runtime.lastError || !response) return;
                var instances = _reconcileActiveToken(response.instances || []);
                _cacheInstances(instances);                     // warm + persist (retains closed)
                if (!_instanceDropdown) return;                 // closed while in flight — cache already warmed
                var renderList = _withRetainedInstances(instances);
                if (_instancesSignature(renderList) === _instancePickerLastSig) return;
                renderInstanceDropdown(renderList);
            });
        } catch (e) { _refreshInFlightAt = 0; }                 // context invalidated — don't wedge future refreshes
    }

    function hideInstancePicker() {
        window.removeEventListener('focus', _refreshInstancePicker);
        _refreshInFlightAt = 0;
        _instancePickerLastSig = '';
        _teardownDropdownDom();
    }
    // Expose for the shared header-menu mutual-exclusion registry
    // (closeAllHeaderMenus in ui/240-layout.js) — this file is an IIFE.
    window.hideInstancePicker = hideInstancePicker;

    // Tear down ONLY the dropdown DOM + its element-scoped listeners. Used both
    // by hideInstancePicker (full close) and by renderInstanceDropdown (swap the
    // DOM on re-render) — kept separate so a re-render doesn't drop the
    // window-focus refresh listener that lives for the whole open session.
    function _teardownDropdownDom() {
        if (_instanceDropdown) {
            _instanceDropdown.remove();
            _instanceDropdown = null;
            document.removeEventListener('click', _onClickOutsideDropdown, true);
            window.removeEventListener('resize', _onWindowResizeDropdown);
        }
    }

    // Cheap signature of the instance list — stable unless something the user can
    // actually see has changed (URL set, tab count, username, role tier).
    function _instancesSignature(instances) {
        try {
            return instances.map(function(i) {
                var host = (i.url || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
                var perm = (typeof instancePermissions !== 'undefined' && instancePermissions[host]) || {};
                return [
                    i.url || '',
                    (i.tabs || []).length,
                    i.userName || '',
                    (i.roles || []).slice().sort().join(','),
                    (i.token || i.connected) ? 'c' : 'd',
                    perm.tier || 'manual',
                    _disabledInstances[_normUrl(i.url)] ? 'x' : ''
                ].join('|');
            }).join('\n');
        } catch (e) { return String(Date.now()); }
    }

    function _onWindowResizeDropdown() {
        if (!_instanceDropdown) return;
        var anchor = document.getElementById('ext-sn-status');
        if (anchor && anchor.offsetParent === null) anchor = document.getElementById('home-ext-sn-status');
        if (!anchor) return;
        var rect = anchor.getBoundingClientRect();
        _instanceDropdown.style.top = (rect.bottom + 4) + 'px';
        _instanceDropdown.style.right = (window.innerWidth - rect.right) + 'px';
        _instanceDropdown.style.maxWidth = Math.max(220, rect.right - 8) + 'px';
    }

    function _onClickOutsideDropdown(e) {
        // A click inside the shared confirm dialog (#modal-overlay, html/body.html:384)
        // is NOT an outside click. The remove \u2715 opens showConfirmModal ON TOP of the
        // still-open picker, and this listener runs in the CAPTURE phase \u2014 without this
        // guard the Confirm/Cancel click would tear the dropdown down before the modal
        // promise resolved, and the post-confirm re-render would then pop a picker the
        // user never reopened back onto the screen.
        if (e.target && e.target.closest && e.target.closest('#modal-overlay')) return;
        if (_instanceDropdown && !_instanceDropdown.contains(e.target) && !e.target.closest('#ext-sn-status') && !e.target.closest('#home-ext-sn-status')) {
            hideInstancePicker();
        }
    }

    // Durably forget ONE instance from the picker. Callers MUST have confirmed
    // first (showConfirmModal) \u2014 this is only the commit step, and its body is
    // unchanged from the two-step inline confirm it replaced: tombstone, purge the
    // picker cache (memory + chrome.storage.local.snInstancesCache), clear the
    // stale disabled flag, drop the background's per-origin heartbeat token, then
    // re-render + refresh the header pill.
    function _removeInstanceEntry(rawUrl) {
        var u = _normUrl(rawUrl);
        // 0) Tombstone the URL so an in-flight probe response can't re-persist it.
        _recentlyRemoved[u] = Date.now();
        // 1) Drop from the picker cache (memory + storage) so re-opens don't seed it back.
        _instancesCache = (_instancesCache || []).filter(function(c) { return c && _normUrl(c.url) !== u; });
        try { var _o = {}; _o[_INSTANCES_CACHE_KEY] = _instancesCache; chrome.storage.local.set(_o); } catch (err) {}
        // 2) Clear any stale disabled flag for the removed URL.
        setInstanceDisabled(u, false);
        // 3) Drop the background's per-origin heartbeat token so
        //    snGetInstancesDetailed stops folding the instance back in.
        try { chrome.runtime.sendMessage({ type: 'remove-sn-instance', instanceUrl: u }, function() { void chrome.runtime.lastError; }); } catch (err) {}
        // 4) Re-render immediately without the removed row \u2014 from the list the
        //    mounted DOM was built from, never a stale forEach closure. The sig reset
        //    happens unconditionally so that if the picker WAS closed while the dialog
        //    was up (header pill re-click, Escape reaching the menus), the next open
        //    re-renders instead of short-circuiting on the pre-removal signature.
        var newList = (_lastRenderedInstances || []).filter(function(i) { return i && _normUrl(i.url) !== u; });
        _instancePickerLastSig = '';
        if (_instanceDropdown) {
            renderInstanceDropdown(newList);   // also refreshes _lastRenderedInstances
        } else {
            _lastRenderedInstances = newList;
        }
        updateSnStatus();
    }

    function renderInstanceDropdown(instances, isLoading) {
        // Swap out the old DOM but keep the window-focus refresh listener alive
        // (it spans the whole open session, not a single render).
        _teardownDropdownDom();
        _instancePickerLastSig = _instancesSignature(instances);
        _lastRenderedInstances = instances || [];
        var anchor = document.getElementById('ext-sn-status');
        if (anchor && anchor.offsetParent === null) anchor = document.getElementById('home-ext-sn-status');
        if (!anchor) {
            // Both anchors are unmounted/hidden — we can't position the dropdown,
            // so fully close (also drops the focus listener).
            hideInstancePicker();
            return;
        }

        var dd = document.createElement('div');
        // Chrome (bg/border/radius/shadow) comes from the shared .header-menu
        // class (04-header.css) so all header pill dropdowns match.
        // Carry the in-flight remove-confirm state onto the fresh DOM: a
        // window-focus refresh can re-render WHILE the dialog is up, and the new
        // dropdown must stay neutralised (and drop it again once it is stale).
        var _pending = _isRemoveConfirmPending();
        dd.className = 'ext-instance-dropdown header-menu' + (_pending ? ' confirm-pending' : '');
        dd.inert = _pending;
        // Shared banded section title (round-5 unification): same band + icon
        // pattern as every other header pill dropdown.
        var _instTitleIcon = (typeof UI_ICONS !== 'undefined' && UI_ICONS.globe) ? UI_ICONS.globe : '';
        dd.innerHTML = '<div class="menu-section-title"><span class="section-icon">' + _instTitleIcon + '</span>Instances</div>';

        if (instances.length === 0) {
            dd.innerHTML += isLoading
                ? '<div class="ext-instance-empty">Checking ServiceNow connections…</div>'
                : '<div class="ext-instance-empty">No ServiceNow tabs open.<br>Open a ServiceNow page to connect.</div>';
        } else {
            instances.forEach(function(inst) {
                var isActive = inst.url === Platform.instanceUrl;
                // Connected = we hold a valid token: either a live tab's g_ck OR a cached
                // heartbeat token that still passes touch-session. Tab-less instances stay
                // connected (the heartbeat keeps the session warm for multi-instance work).
                // The background probe now reports an EMPTY token for an open-but-logged-out
                // tab, so a logged-out session correctly reads as signed-out here without a
                // tab-presence check (which would wrongly demote valid tab-less instances).
                var isConnected = !!(inst.token || inst.connected);
                // Non-connected rows (logged out while open, or closed/evicted) render as a
                // dimmed "signed out" row that OPENS on click instead of selecting.
                var signedOut = !isConnected;
                var host = inst.url.replace(/^https?:\/\//, '').replace(/\/$/, '');
                var shortName = host.split('.')[0];
                var instPerms = instancePermissions[host] || { tier: 'manual', tools: {} };
                var currentTier = instPerms.tier || 'manual';
                var hasTab = !!(inst.tabs && inst.tabs.length);
                var agentDisabled = isInstanceDisabled(inst.url);
                var row = document.createElement('div');
                row.className = 'ext-instance-row' + (isActive ? ' active' : '') + (signedOut ? ' retained' : '') + (agentDisabled ? ' agent-disabled' : '');
                var openIcon = typeof UI_ICONS !== 'undefined' ? UI_ICONS.externalLink : '&#x2197;';
                var userName = inst.userName || '';
                var roles = signedOut ? [] : (inst.roles || []);  // signed-out rows show no privilege badge
                // Privilege badge replaces username when present. Priority: security_admin > admin > snc_external.
                var badgeHtml = '';
                var shieldIcon = (typeof UI_ICONS !== 'undefined' && UI_ICONS.shield) ? UI_ICONS.shield : '&#x1F6E1;';
                var lockIcon = (typeof UI_ICONS !== 'undefined' && UI_ICONS.lock) ? UI_ICONS.lock : '&#x1F512;';
                if (roles.indexOf('security_admin') !== -1) {
                    badgeHtml = '<span class="ext-instance-role-badge danger" title="Click to view all roles">' + shieldIcon + 'security_admin</span>';
                } else if (roles.indexOf('admin') !== -1) {
                    badgeHtml = '<span class="ext-instance-role-badge warn" title="Click to view all roles">' + shieldIcon + 'admin</span>';
                } else if (roles.indexOf('snc_external') !== -1) {
                    badgeHtml = '<span class="ext-instance-role-badge muted" title="Click to view all roles">' + lockIcon + 'snc_external</span>';
                }
                var userSuffix = signedOut
                    ? ' <span class="ext-instance-signedout" title="No live session — click to open and sign in">· signed out</span>'
                    : (!badgeHtml && userName)
                        ? ' <span class="ext-instance-user" title="Click to view all roles">· ' + escapeHtml(userName) + '</span>'
                        : '';
                // Per-row agent control: rows WITH a live tab get a Disable/Enable
                // toggle (agent must never use a disabled instance); rows with NO
                // live tab get a remove \u2715 (confirmed through the extension's
                // shared confirm dialog). The remove button is hidden for the ACTIVE
                // instance so the current session can never be yanked out from under
                // the user.
                var closeIcon = (typeof UI_ICONS !== 'undefined' && UI_ICONS.close) ? UI_ICONS.close : '&#x2715;';
                var disabledPill = agentDisabled
                    ? '<span class="ext-instance-disabled-pill" title="The agent will not use this instance">disabled</span>'
                    : '';
                var controlHtml = '';
                if (hasTab || isActive) {
                    // Live-tab rows AND the active instance (even tab-less \u2014 the
                    // agent still resolves it as the default target via its cached
                    // heartbeat token) get the Disable toggle; Remove stays
                    // suppressed for the active instance.
                    controlHtml = '<button class="ext-instance-disable' + (agentDisabled ? ' on' : '') + '" title="' +
                        (agentDisabled ? 'Agent is blocked from ' + escapeHtml(host) + ' \u2014 click to re-enable' : 'Prevent the agent from using ' + escapeHtml(host)) + '">' +
                        (agentDisabled ? 'Enable' : 'Disable') + '</button>';
                } else {
                    controlHtml = '<button class="ext-instance-remove" title="Remove ' + escapeHtml(host) + ' from this list">' + closeIcon + '</button>';
                }
                row.innerHTML = '<span class="ext-instance-dot' + (isConnected ? ' ok' : '') + '"></span>' +
                    '<span class="ext-instance-name" title="' + escapeHtml(host) + '">' + escapeHtml(shortName) + userSuffix + '</span>' +
                    badgeHtml +
                    disabledPill +
                    '<a class="ext-instance-open" href="' + escapeHtml(inst.url) + '" target="_blank" title="Open ' + escapeHtml(host) + '">' + openIcon + '</a>' +
                    '<span class="ext-instance-tier" title="' + (currentTier === 'auto' ? 'Auto: Agent decides for write operations' : 'Manual: You control each permission') + '">' +
                        (currentTier === 'auto' ? (typeof UI_ICONS !== 'undefined' ? UI_ICONS.sparkle : '&#x2728;') + ' Auto' : (typeof UI_ICONS !== 'undefined' ? UI_ICONS.lock : '&#x1F512;') + ' Manual') +
                    '</span>' +
                    controlHtml +
                    '<button class="ext-instance-test" style="display:none;">Test</button>';

                // Wrap row + collapsible roles panel together so the panel sits directly below.
                var item = document.createElement('div');
                item.className = 'ext-instance-item';
                item.appendChild(row);
                var rolesPanel = document.createElement('div');
                rolesPanel.className = 'ext-instance-roles-panel';
                rolesPanel.hidden = true;
                item.appendChild(rolesPanel);

                row.addEventListener('click', function(e) {
                    if (e.target.classList.contains('ext-instance-test')) return;
                    if (e.target.closest('.ext-instance-open')) return;
                    if (e.target.closest('.ext-instance-remove') || e.target.closest('.ext-instance-disable')) return;
                    if (e.target.closest('.ext-instance-role-badge') || e.target.closest('.ext-instance-user')) {
                        // Toggle roles panel
                        e.stopPropagation();
                        toggleRolesPanel(inst, rolesPanel);
                        return;
                    }
                    if (e.target.closest('.ext-instance-tier')) {
                        // Toggle tier on click
                        e.stopPropagation();
                        var newTier = currentTier === 'manual' ? 'auto' : 'manual';
                        if (!instancePermissions[host]) instancePermissions[host] = { tier: 'manual', tools: {} };
                        instancePermissions[host].tier = newTier;
                        saveInstancePermissions();
                        renderInstanceDropdown(instances); // Re-render
                        if (typeof renderToolPermissions === 'function') renderToolPermissions();
                        updateSnStatus();
                        return;
                    }
                    if (isActive && isConnected) {
                        // Already the current, connected instance — a click just
                        // confirms the selection. Re-running switchToInstance can
                        // transiently demote it (no live tab token to hand back), so
                        // just close the picker instead of round-tripping a switch.
                        hideInstancePicker();
                        return;
                    }
                    if (!isConnected) {
                        // Logged out / closed (no live session): open the instance so
                        // the user can sign in, rather than selecting a dead session.
                        // A connected instance just gets selected as current below.
                        var openLink = row.querySelector('.ext-instance-open');
                        if (openLink) { openLink.click(); } else { window.open(inst.url, '_blank'); }
                        return;
                    }
                    switchToInstance(inst);
                });

                row.querySelector('.ext-instance-test').addEventListener('click', function(e) {
                    e.stopPropagation();
                    testInstanceConnection(inst, row);
                });

                // Disable/Enable toggle (rows WITH a live tab): flip the persisted
                // per-instance "agent may not use this" flag and re-render in place
                // (same pattern as the tier toggle above).
                var disableBtn = row.querySelector('.ext-instance-disable');
                if (disableBtn) {
                    disableBtn.addEventListener('click', function(e) {
                        e.stopPropagation();
                        setInstanceDisabled(inst.url, !isInstanceDisabled(inst.url));
                        _instancePickerLastSig = ''; // sig short-circuit must not skip the fresh render
                        renderInstanceDropdown(instances);
                        updateSnStatus();
                    });
                }

                // Remove button (rows with NO live tab): ONE click opens the
                // extension's shared confirm dialog \u2014 showConfirmModal
                // (ui/230-modals.js:59), the same helper every other destructive
                // action uses (e.g. mergeSidebarPR ui/120-ui-utils.js:458, discard
                // changes ui/115-workspace-files-sidebar.js:682). Confirm commits
                // via _removeInstanceEntry; Cancel / Escape / backdrop do nothing.
                // The picker deliberately stays OPEN behind the dialog (the modal
                // overlay is excluded in _onClickOutsideDropdown) so the row visibly
                // disappears as the dialog closes \u2014 same "surface stays, act +
                // re-render on confirm" shape as mergeSidebarPR.
                var removeBtn = row.querySelector('.ext-instance-remove');
                if (removeBtn) {
                    removeBtn.addEventListener('click', function(e) {
                        // Synchronous, BEFORE any await/then: the row click handler
                        // must never see this and switch instances.
                        e.stopPropagation();
                        // Re-entrancy: never a second dialog while one is pending.
                        // Both conditions matter — the flag covers OUR dialog (and
                        // self-heals if it went stale), the overlay probe also covers
                        // an unrelated modal that already owns the shared
                        // modalResolve, which we must not overwrite either.
                        if (_isRemoveConfirmPending()) return;
                        var _ov = document.getElementById('modal-overlay');
                        if (_ov && _ov.classList.contains('show')) return;
                        // Captured now \u2014 `inst`/`row` may be detached by a re-render
                        // while the dialog is up, so only this plain string is used after.
                        var url = inst.url;
                        var title = 'Remove ' + host + '?';
                        var msg = 'AppAgent forgets its cached session for <strong>' + escapeHtml(host) +
                            '</strong> and drops it from this list. Nothing changes on the instance itself \u2014 ' +
                            'it reappears here as soon as a ServiceNow tab for it is opened again.';
                        // Resolved LAZILY at click time. platform-bridge.js is an IIFE
                        // concatenated AFTER the page bundle (build/build.js:485,
                        // skills/extension-dev/build.js:176), so the top-level
                        // `async function showConfirmModal` is already a hoisted window
                        // global before any click can happen; the guard only covers a
                        // stripped/partial build where the page tier is absent.
                        if (typeof window.showConfirmModal === 'function') {
                            // Set BEFORE the call so the dropdown is already inert when
                            // showModal mounts the overlay; cleared in BOTH settle paths
                            // (confirm AND cancel/Escape/backdrop/reject) so the picker
                            // is usable again the moment the dialog closes.
                            _setRemoveConfirmPending(true);
                            Promise.resolve(window.showConfirmModal(title, msg, 'danger')).then(function(ok) {
                                _setRemoveConfirmPending(false);
                                if (ok) _removeInstanceEntry(url);
                            })['catch'](function() { _setRemoveConfirmPending(false); });
                            return;
                        }
                        // Fallback (dialog helper genuinely unavailable, e.g. a stripped
                        // build without the page tier): the requirement is that removal is
                        // ALWAYS confirmed through a dialog. Native window.confirm still IS
                        // a dialog, so it stays the fallback — but when even that is
                        // missing the button is a deliberate no-op: never a silent,
                        // unconfirmed removal. Synchronous + browser-modal, so it needs no
                        // in-flight guard of its own.
                        if (typeof window.confirm === 'function') {
                            if (window.confirm(title)) _removeInstanceEntry(url);
                            return;
                        }
                        try {
                            console.warn('[AppAgent] Instance remove skipped for ' + url +
                                ' \u2014 no confirm dialog available (showConfirmModal and window.confirm both missing);' +
                                ' refusing to remove without confirmation.');
                        } catch (err) {}
                    });
                }

                dd.appendChild(item);

                // Active + already connected: show tier immediately, no test needed
                if (isActive && !signedOut && _snStatusState === 'connected') {
                    var dot = row.querySelector('.ext-instance-dot');
                    if (dot) dot.className = 'ext-instance-dot ok';
                } else if (isActive && !signedOut) {
                    testInstanceConnection(inst, row);
                }
                // Active row often has empty roles (probe can't read g_ck) — fetch them
                // via the session token so the privilege badge shows for it too.
                if (isActive && !signedOut) {
                    _ensureActiveRoles(inst, instances);
                }
            });
        }

        var rect = anchor.getBoundingClientRect();
        dd.style.top = (rect.bottom + 4) + 'px';
        dd.style.right = (window.innerWidth - rect.right) + 'px';
        // Cap width to the space available from the left edge of the viewport up to the
        // anchor's right edge (with an 8px gutter), so long role names can't push the
        // dropdown off-screen to the left in narrow panels.
        dd.style.maxWidth = Math.max(220, rect.right - 8) + 'px';
        document.body.appendChild(dd);
        _instanceDropdown = dd;

        setTimeout(function() {
            document.addEventListener('click', _onClickOutsideDropdown, true);
        }, 0);
        window.addEventListener('resize', _onWindowResizeDropdown);
    }

    function switchToInstance(inst) {
        if (!inst || !inst.url) return;
        // Bind to a live tab when one is open; otherwise switch tab-less using the cached
        // heartbeat token (the background fills it in). Only fall back to opening the
        // instance when neither a tab nor a usable cached token is available.
        var tabId = (inst.tabs && inst.tabs[0] && inst.tabs[0].id) || null;
        chrome.runtime.sendMessage({
            type: 'switch-sn-instance',
            instanceUrl: inst.url,
            tabId: tabId
        }, function(response) {
            if (chrome.runtime.lastError) return;
            if (response && response.token) {
                // Persist the OUTGOING instance's token into the per-origin heartbeat
                // cache so it stays connected in the picker after we switch away. The
                // background probe folds instanceTokens entries back in for tab-less or
                // unreadable-tab instances, and the heartbeat keeps validating them
                // (dropping them on a hard 401), so this never resurrects a dead session.
                var _prevUrl = Platform.instanceUrl;
                var _prevToken = window.sessionToken;
                if (_prevUrl && _prevToken && _prevUrl !== inst.url) {
                    try {
                        chrome.storage.local.get('instanceTokens', function(d) {
                            var map = (d && d.instanceTokens) || {};
                            map[_prevUrl] = {
                                token: _prevToken,
                                userName: (window.NOW && window.NOW.user_name) || (map[_prevUrl] && map[_prevUrl].userName) || ''
                            };
                            chrome.storage.local.set({ instanceTokens: map });
                        });
                    } catch (e) {}
                }
                window.sessionToken = response.token;
                Platform.instanceUrl = inst.url;
                updateSnStatus();
                hideInstancePicker();
            } else if (!tabId) {
                // No live tab and no usable cached token — the background has already
                // committed the switch (signed-out), so treat it as a completed
                // switch-to-signed-out: reflect it in the UI, close the picker, and
                // open the instance so the user can sign in.
                Platform.instanceUrl = inst.url;
                _snStatusState = 'disconnected';
                updateSnStatus();
                hideInstancePicker();
                window.open(inst.url, '_blank');
            } else {
                // Had a tab but no token came back (logged out mid-switch): keep it active
                // and let the status/test reflect the signed-out state.
                Platform.instanceUrl = inst.url;
                updateSnStatus();
                hideInstancePicker();
            }
        });
    }

    // Toggle the per-row roles panel. On first open, fetches the full role list
    // (direct + inherited) for the instance's session user and caches it on the inst object.
    function toggleRolesPanel(inst, panel) {
        if (!panel.hidden) {
            panel.hidden = true;
            return;
        }
        panel.hidden = false;

        // Already fetched? Just re-render.
        if (inst._allRoles) {
            renderRolesPanel(panel, inst._allRoles, inst.userName);
            return;
        }

        // Render loading state
        panel.innerHTML = '<div class="ext-roles-loading">Loading roles…</div>';

        var _loadRoles = function(token) {
            var url = inst.url + '/api/now/table/sys_user_has_role'
                + '?sysparm_query=user=javascript:gs.getUserID()'
                + '&sysparm_fields=role.name,inherited'
                + '&sysparm_limit=500';
            _origFetch.call(window, url, {
                method: 'GET',
                headers: { 'X-UserToken': token, 'Accept': 'application/json' },
                credentials: 'include'
            }).then(function(res) {
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.json();
            }).then(function(data) {
                var rows = (data && data.result) || [];
                var all = [];
                for (var i = 0; i < rows.length; i++) {
                    var name = rows[i] && rows[i]['role.name'];
                    if (!name) continue;
                    all.push({ name: name, inherited: String(rows[i].inherited) === 'true' });
                }
                // Sort: direct roles first (alphabetical), then inherited (alphabetical)
                all.sort(function(a, b) {
                    if (a.inherited !== b.inherited) return a.inherited ? 1 : -1;
                    return a.name.localeCompare(b.name);
                });
                inst._allRoles = all;
                if (!panel.hidden) renderRolesPanel(panel, all, inst.userName);
            }).catch(function(err) {
                // Friendly message; keep technical detail (e.g. "HTTP 401") in the
                // tooltip only so non-technical users aren't shown raw status codes.
                var detail = String((err && err.message) || err || '');
                var msg = /401/.test(detail) ? 'Session expired — open the instance and sign in again.'
                        : 'Could not load roles. Open the instance and try again.';
                panel.innerHTML = '<div class="ext-roles-empty" title="' + escapeHtml(detail) + '">' + msg + '</div>';
            });
        };

        if (inst.token) { _loadRoles(inst.token); return; }
        // Connected row opened from the instant cache-seeded view, before the live probe
        // has re-attached a token (the persisted picker cache intentionally stores none).
        // Resolve the heartbeat token for this instance on demand instead of showing a
        // misleading "no active session"; credentials:'include' lets the GET authenticate
        // via the session cookie even if that cached token is slightly stale.
        chrome.storage.local.get('instanceTokens', function(d) {
            if (panel.hidden) return;
            var cached = (d && d.instanceTokens && d.instanceTokens[inst.url]) || null;
            if (cached && cached.token) {
                inst.token = cached.token;
                if (cached.userName && !inst.userName) inst.userName = cached.userName;
                _loadRoles(cached.token);
            } else {
                panel.innerHTML = '<div class="ext-roles-empty">Open the instance and sign in to view roles.</div>';
            }
        });
    }

    function renderRolesPanel(panel, all, userName) {
        if (!all || !all.length) {
            panel.innerHTML = '<div class="ext-roles-empty">No roles assigned.</div>';
            return;
        }
        var directCount = 0;
        for (var i = 0; i < all.length; i++) if (!all[i].inherited) directCount++;
        var inheritedCount = all.length - directCount;

        var header = '<div class="ext-roles-header">'
            + '<span class="ext-roles-title">' + escapeHtml(userName || 'Roles') + '</span>'
            + '<span class="ext-roles-count">' + directCount + ' direct'
            + (inheritedCount ? ' · ' + inheritedCount + ' inherited' : '')
            + '</span>'
            + '</div>';

        var listItems = all.map(function(r) {
            return '<li class="ext-roles-item' + (r.inherited ? ' inherited' : ' direct') + '">'
                + '<span class="ext-roles-dot"></span>'
                + '<span class="ext-roles-name">' + escapeHtml(r.name) + '</span>'
                + (r.inherited ? '<span class="ext-roles-tag">inherited</span>' : '')
                + '</li>';
        }).join('');

        panel.innerHTML = header + '<ul class="ext-roles-list">' + listItems + '</ul>';
    }

    // Map a failed connection test to a non-technical label. The raw HTTP code
    // stays in the tooltip (title) only — non-technical users should never see
    // bare numbers like "401".
    function _friendlyConnError(status) {
        if (status === 401) return { label: 'Signed out', title: 'Session expired (HTTP 401). Open the instance and sign in again, then retry.' };
        if (status === 403) return { label: 'No access',  title: 'Access denied (HTTP 403). Your account lacks permission on this instance.' };
        return { label: 'Unavailable', title: 'Connection failed (HTTP ' + status + '). Click to retry.' };
    }

    function testInstanceConnection(inst, row) {
        var btn = row.querySelector('.ext-instance-test');
        var dot = row.querySelector('.ext-instance-dot');
        var tier = row.querySelector('.ext-instance-tier');
        // While testing: hide tier, show button as loading
        if (tier) tier.style.display = 'none';
        btn.style.display = '';
        btn.textContent = '...';
        btn.disabled = true;

        var isActive = inst.url === Platform.instanceUrl;

        var _showConnected = function() {
            // Connected: show tier, hide button
            if (tier) tier.style.display = '';
            btn.style.display = 'none';
            dot.className = 'ext-instance-dot ok';
        };
        var _showFailed = function(label, title) {
            // Failed: hide tier, show the status pill (doubles as a retry button).
            if (tier) tier.style.display = 'none';
            btn.style.display = '';
            btn.textContent = label || 'Test';
            // Keep technical detail (e.g. HTTP 401) in the tooltip only — never
            // surface raw status codes to non-technical users.
            btn.title = title || 'Click to retry';
            btn.className = 'ext-instance-test fail';
            dot.className = 'ext-instance-dot fail';
            btn.disabled = false;
        };

        var doTest = function(token) {
            if (!token) {
                _showFailed('Signed out', 'Not signed in to this instance. Open it and sign in, then retry.');
                return;
            }
            _origFetch.call(window, inst.url + '/api/now/uisession/touch-session', {
                method: 'POST',
                headers: { 'X-UserToken': token, 'Content-Type': 'application/json', 'Accept': 'application/json' },
                credentials: 'include'
            }).then(function(res) {
                if (res.ok) {
                    _showConnected();
                } else {
                    var f = _friendlyConnError(res.status);
                    _showFailed(f.label, f.title);
                }
                // Sync header status for active instance
                if (isActive) {
                    if (res.ok) {
                        if (token !== window.sessionToken) window.sessionToken = token;
                        _snStatusState = 'connected';
                    } else {
                        _snStatusState = 'disconnected';
                    }
                    updateSnStatus();
                }
            }).catch(function() {
                _showFailed('Offline', 'Could not reach the instance. Check your connection and retry.');
            });
        };

        if (isActive && window.sessionToken) {
            doTest(window.sessionToken);
        } else if (inst.tabs && inst.tabs.length && inst.tabs[0]) {
            chrome.runtime.sendMessage({
                type: 'get-instance-token',
                tabId: inst.tabs[0].id
            }, function(response) {
                // Read lastError so a dead background never logs "Unchecked
                // runtime.lastError". When the tab could not be read (discarded by
                // Memory Saver — background returns an empty token) fall back to the
                // probe-attached heartbeat token instead of wrongly rendering
                // "Signed out": an open-but-logged-out tab always yields
                // inst.token === '' from the detailed probe, so this fallback can
                // never resurrect a dead session.
                var err = chrome.runtime.lastError;
                doTest((!err && response && response.token) || inst.token || '');
            });
        } else if (inst.token) {
            // Tab-less but the live probe attached a heartbeat token (#345):
            // test with it instead of wrongly rendering "Signed out".
            doTest(inst.token);
        } else {
            doTest('');   // no live tab and no token (closed / signed out) → render as signed-out
        }
    }

    // Make status indicators clickable
    Platform.ready.then(function() {
        ['ext-sn-status', 'home-ext-sn-status'].forEach(function(id) {
            var el = document.getElementById(id);
            if (el) {
                el.style.cursor = 'pointer';
                el.addEventListener('click', function(e) {
                    e.stopPropagation();
                    showInstancePicker();
                });
            }
        });
    });

    // Chrome storage helpers
    Platform.storageGet = function(keys) {
        return new Promise(function(resolve) {
            chrome.storage.local.get(keys, resolve);
        });
    };

    Platform.storageSet = function(data) {
        return new Promise(function(resolve) {
            chrome.storage.local.set(data, resolve);
        });
    };
})();
