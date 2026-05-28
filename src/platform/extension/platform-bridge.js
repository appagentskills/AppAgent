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
        if (changes.claudeRateLimits && typeof fetchCredits === 'function') {
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

    // Refresh the full instance list from background (probes all open SN tabs)
    Platform.refreshInstances = function() {
        return new Promise(function(resolve) {
            chrome.runtime.sendMessage({ type: 'list-sn-instances-detailed' }, function(response) {
                if (chrome.runtime.lastError || !response || !response.instances) {
                    resolve(Platform.instances);
                    return;
                }
                Platform.instances = response.instances.map(function(inst) {
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

    // Find a tab ID for a specific instance (for iframe_tool targeting)
    Platform.getTabForInstance = function(instanceUrl) {
        for (var i = 0; i < Platform.instances.length; i++) {
            if (Platform.instances[i].url === instanceUrl && Platform.instances[i].tabs.length > 0) {
                return Platform.instances[i].tabs[0].id;
            }
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

    // Sole authority on connection state — validates and recovers tokens
    function validateToken() {
        if (!Platform.instanceUrl) {
            _snStatusState = 'disconnected';
            updateSnStatus();
            return;
        }
        // No token — try to recover one from an open SN tab
        if (!window.sessionToken) {
            chrome.runtime.sendMessage({ type: 'list-sn-instances' }, function(response) {
                if (chrome.runtime.lastError || !response || !response.instances) return;
                var match = response.instances.filter(function(i) { return i.url === Platform.instanceUrl; })[0];
                if (!match || !match.tabs.length) {
                    _snStatusState = 'disconnected';
                    updateSnStatus();
                    return;
                }
                chrome.runtime.sendMessage({ type: 'get-instance-token', tabId: match.tabs[0].id }, function(resp) {
                    if (resp && resp.token) {
                        window.sessionToken = resp.token;
                        chrome.storage.local.set({ sessionToken: resp.token });
                        validateToken(); // Now validate the recovered token
                    } else {
                        _snStatusState = 'disconnected';
                        updateSnStatus();
                    }
                });
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
            // Token valid — verify a matching SN tab is still open
            chrome.runtime.sendMessage({ type: 'list-sn-instances' }, function(tabResp) {
                var instances = (tabResp && tabResp.instances) || [];
                var match = instances.filter(function(i) { return i.url === Platform.instanceUrl; })[0];
                _snStatusState = (match && match.tabs.length) ? 'connected' : 'disconnected';
                updateSnStatus();
            });
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
    var _instancePickerPollTimer = null;
    // Last-rendered instance list signature — used by the live-refresh poll to
    // skip re-rendering when nothing meaningful changed (avoids collapsing any
    // open per-row roles panel on every tick).
    var _instancePickerLastSig = '';

    function showInstancePicker() {
        if (_instanceDropdown) { hideInstancePicker(); return; }
        // Use detailed variant so we have the resolved username for each instance.
        chrome.runtime.sendMessage({ type: 'list-sn-instances-detailed' }, function(response) {
            if (chrome.runtime.lastError || !response) return;
            renderInstanceDropdown(response.instances || []);
            // Start a live-refresh poll so the dropdown stays in sync with the
            // background's view of open SN tabs (logout in another tab, new tab
            // opened, role change, etc.) without forcing the user to close +
            // re-open the picker.
            _startInstancePickerPoll();
        });
    }

    function hideInstancePicker() {
        if (_instancePickerPollTimer) { clearInterval(_instancePickerPollTimer); _instancePickerPollTimer = null; }
        _instancePickerLastSig = '';
        if (_instanceDropdown) {
            _instanceDropdown.remove();
            _instanceDropdown = null;
            document.removeEventListener('click', _onClickOutsideDropdown, true);
            window.removeEventListener('resize', _onWindowResizeDropdown);
        }
    }

    // Cheap signature of the instance list — stable across ticks unless something
    // the user can actually see has changed (URL set, tab count, username, role tier).
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
                    perm.tier || 'manual'
                ].join('|');
            }).join('\n');
        } catch (e) { return String(Date.now()); }
    }

    function _startInstancePickerPoll() {
        if (_instancePickerPollTimer) clearInterval(_instancePickerPollTimer);
        _instancePickerPollTimer = setInterval(function() {
            if (!_instanceDropdown) {
                clearInterval(_instancePickerPollTimer); _instancePickerPollTimer = null; return;
            }
            chrome.runtime.sendMessage({ type: 'list-sn-instances-detailed' }, function(response) {
                if (!_instanceDropdown) return;
                if (chrome.runtime.lastError || !response) return;
                var instances = response.instances || [];
                var sig = _instancesSignature(instances);
                if (sig === _instancePickerLastSig) return; // nothing the user would notice
                renderInstanceDropdown(instances);
            });
        }, 2000);
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
        if (_instanceDropdown && !_instanceDropdown.contains(e.target) && !e.target.closest('#ext-sn-status') && !e.target.closest('#home-ext-sn-status')) {
            hideInstancePicker();
        }
    }

    function renderInstanceDropdown(instances) {
        // Tear down only the DOM — keep the poll timer alive so periodic
        // re-renders triggered from inside the poll callback don't kill
        // their own ticker.
        var keepPoll = _instancePickerPollTimer;
        _instancePickerPollTimer = null; // shield from hideInstancePicker
        hideInstancePicker();
        _instancePickerPollTimer = keepPoll;
        _instancePickerLastSig = _instancesSignature(instances);
        var anchor = document.getElementById('ext-sn-status');
        if (anchor && anchor.offsetParent === null) anchor = document.getElementById('home-ext-sn-status');
        if (!anchor) {
            // Both anchors are unmounted/hidden — we can't position the dropdown.
            // Tear down the poll timer too: the keepPoll shield above preserved it
            // through hideInstancePicker, but with no anchor we have no UI to refresh.
            // Without this clear, the 2s interval would keep round-tripping to the
            // background for the lifetime of the panel.
            if (_instancePickerPollTimer) {
                clearInterval(_instancePickerPollTimer);
                _instancePickerPollTimer = null;
            }
            return;
        }

        var dd = document.createElement('div');
        dd.className = 'ext-instance-dropdown';

        if (instances.length === 0) {
            dd.innerHTML = '<div class="ext-instance-empty">No ServiceNow tabs open.<br>Open a ServiceNow page to connect.</div>';
        } else {
            instances.forEach(function(inst) {
                var isActive = inst.url === Platform.instanceUrl;
                var host = inst.url.replace(/^https?:\/\//, '').replace(/\/$/, '');
                var shortName = host.split('.')[0];
                var instPerms = instancePermissions[host] || { tier: 'manual', tools: {} };
                var currentTier = instPerms.tier || 'manual';
                var row = document.createElement('div');
                row.className = 'ext-instance-row' + (isActive ? ' active' : '');
                var openIcon = typeof UI_ICONS !== 'undefined' ? UI_ICONS.externalLink : '&#x2197;';
                var userName = inst.userName || '';
                var roles = inst.roles || [];
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
                var userSuffix = (!badgeHtml && userName)
                    ? ' <span class="ext-instance-user" title="Click to view all roles">· ' + escapeHtml(userName) + '</span>'
                    : '';
                row.innerHTML = '<span class="ext-instance-dot"></span>' +
                    '<span class="ext-instance-name" title="' + escapeHtml(host) + '">' + escapeHtml(shortName) + userSuffix + '</span>' +
                    badgeHtml +
                    '<a class="ext-instance-open" href="' + escapeHtml(inst.url) + '" target="_blank" title="Open ' + escapeHtml(host) + '">' + openIcon + '</a>' +
                    '<span class="ext-instance-tier" title="' + (currentTier === 'auto' ? 'Auto: Agent decides for write operations' : 'Manual: You control each permission') + '">' +
                        (currentTier === 'auto' ? (typeof UI_ICONS !== 'undefined' ? UI_ICONS.sparkle : '&#x2728;') + ' Auto' : (typeof UI_ICONS !== 'undefined' ? UI_ICONS.lock : '&#x1F512;') + ' Manual') +
                    '</span>' +
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
                    switchToInstance(inst);
                });

                row.querySelector('.ext-instance-test').addEventListener('click', function(e) {
                    e.stopPropagation();
                    testInstanceConnection(inst, row);
                });

                dd.appendChild(item);

                // Active + already connected: show tier immediately, no test needed
                if (isActive && _snStatusState === 'connected') {
                    var dot = row.querySelector('.ext-instance-dot');
                    if (dot) dot.className = 'ext-instance-dot ok';
                } else if (isActive) {
                    testInstanceConnection(inst, row);
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
        chrome.runtime.sendMessage({
            type: 'switch-sn-instance',
            instanceUrl: inst.url,
            tabId: inst.tabs[0].id
        }, function(response) {
            if (chrome.runtime.lastError) return;
            if (response && response.token) window.sessionToken = response.token;
            Platform.instanceUrl = inst.url;
            updateSnStatus();
            hideInstancePicker();
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

        var token = inst.token;
        if (!token) {
            panel.innerHTML = '<div class="ext-roles-empty">No active session for this instance.</div>';
            return;
        }
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
            panel.innerHTML = '<div class="ext-roles-empty">Could not load roles: ' + escapeHtml(String(err && err.message || err)) + '</div>';
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
        var _showFailed = function(label) {
            // Failed: hide tier, show Test button
            if (tier) tier.style.display = 'none';
            btn.style.display = '';
            btn.textContent = label || 'Test';
            btn.className = 'ext-instance-test fail';
            dot.className = 'ext-instance-dot fail';
            btn.disabled = false;
        };

        var doTest = function(token) {
            if (!token) {
                _showFailed('No token');
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
                    _showFailed('' + res.status);
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
                _showFailed('Error');
            });
        };

        if (isActive && window.sessionToken) {
            doTest(window.sessionToken);
        } else {
            chrome.runtime.sendMessage({
                type: 'get-instance-token',
                tabId: inst.tabs[0].id
            }, function(response) {
                doTest(response && response.token || '');
            });
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
