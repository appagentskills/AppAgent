// ============================================================
// i18n DOM layer (panel page only): src/js/ui/245-i18n-dom.js
// Builds on core/025-i18n.js (t, i18nInit, i18nLang, i18nDir, resolveI18nLanguage,
// I18N_LANGUAGES). Every call into it is typeof-guarded, so this file degrades to a
// no-op (English) when the core layer is missing.
//
// Exports:
//   applyI18n(root)                translate [data-i18n] / [data-i18n-attr] under root
//                                  (default: document); returns the number of elements touched
//   i18nNormalizeKey(s)            the KEY RULE below (the string extractor uses the same rule)
//   i18nApplyCurrent()             mirror + <html lang dir> + applyI18n(document) for the active language
//   i18nBootApply(initP, ms)       core/120 init: bounded wait (I18N_BOOT_DEADLINE_MS) for i18nInit()
//                                  + the IDB preference, then i18nApplyCurrent(); a late load
//                                  (wedged IDB) re-applies and re-renders
//   refreshI18nViews()             re-render the current view + chat list, buttons, action
//                                  placements and the model display
//   i18nLanguageOptionsHtml(sel)   the <option> list for Settings > Language ('auto' + I18N_LANGUAGES)
//   syncSettingsPanelLanguage()    refill the gear quick-settings picker (#settings-panel-language,
//                                  body.html) from the same option list + the stored preference;
//                                  called on panel open (ui/130) and by refreshI18nViews()
//   normalizeAppLanguagePref(code) 'auto' or a known language code (anything else -> 'auto')
//   setAppLanguage(code)           Settings > Language AND quick-settings onchange (serialized switches)
//   appLanguagePref                the stored preference ('auto' or a code)
//
// Rules:
// - NEVER reload the panel to switch language (a reload trips worker/120:286-290 and its
//   30s TTL at :64-67). A switch RE-RENDERS, in this order: IDB setSetting('uiLanguage', pref)
//   -> appStorage mirror -> <html lang dir> -> i18nInit() -> refreshI18nViews() (re-render, then
//   applyI18n(document) over the fresh markup) -> post {type: 'ui-language'} to the SW (worker/130) LAST.
// - KEY RULE: key = String(s).replace(/\s+/g, ' ').trim(), taken per OWN non-whitespace text
//   node of a [data-i18n] element (child elements are untouched; the node's leading/trailing
//   whitespace is kept) and per attribute named in data-i18n-attr="title,placeholder,aria-label".
//   Text-node values are already entity-decoded by the HTML parser. When t(key) === key the
//   original is restored byte-for-byte. Originals live in WeakMaps; a node or attribute that code
//   rewrote since the last apply becomes the new source.
// - MIRROR: appStorage 'uiLanguage' = the RESOLVED code and 'uiLanguageDir' = 'ltr' | 'rtl'
//   (read by the head.html inline script for the first paint). The IDB setting 'uiLanguage'
//   holds the PREFERENCE ('auto' or a code).
// ============================================================

var appLanguagePref = 'auto';
var I18N_BOOT_DEADLINE_MS = 3000;
var _i18nTextOrig = (typeof WeakMap === 'function') ? new WeakMap() : null;
var _i18nAttrOrig = (typeof WeakMap === 'function') ? new WeakMap() : null;
var _i18nSwitchChain = Promise.resolve();
var _i18nPrefGen = 0; // bumped by every setAppLanguage switch: a slower boot read of the IDB pref must not overwrite it

function i18nNormalizeKey(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }

function _i18nTr(key) { if (typeof t !== 'function') return key; try { var v = t(key); return typeof v === 'string' ? v : key; } catch (e) { return key; } }

function _i18nTranslateTextNode(node) {
    var cur = node.nodeValue, rec = _i18nTextOrig ? _i18nTextOrig.get(node) : null;
    var orig = (rec && rec.applied === cur) ? rec.orig : cur; // rewritten by code => new source
    var key = i18nNormalizeKey(orig); if (!key) return false;
    var tr = _i18nTr(key), next = orig;
    if (tr !== key) { var lead = orig.match(/^\s*/)[0], trail = orig.match(/\s*$/)[0]; next = lead + tr + trail; }
    if (next !== cur) node.nodeValue = next;
    if (_i18nTextOrig) _i18nTextOrig.set(node, { orig: orig, applied: next });
    return true;
}

function _i18nTranslateAttrs(el) {
    var names = String(el.getAttribute('data-i18n-attr') || '').split(','), recs = (_i18nAttrOrig && _i18nAttrOrig.get(el)) || {}, did = false;
    for (var i = 0; i < names.length; i++) {
        var name = names[i].trim(); if (!name || !el.hasAttribute(name)) continue;
        var cur = el.getAttribute(name), rec = recs[name], orig = (rec && rec.applied === cur) ? rec.orig : cur;
        var key = i18nNormalizeKey(orig); if (!key) continue;
        var tr = _i18nTr(key), next = (tr === key) ? orig : tr;
        if (next !== cur) el.setAttribute(name, next);
        recs[name] = { orig: orig, applied: next }; did = true;
    }
    if (_i18nAttrOrig) _i18nAttrOrig.set(el, recs);
    return did;
}

function applyI18n(root) {
    root = root || (typeof document !== 'undefined' ? document : null);
    if (!root || typeof root.querySelectorAll !== 'function') return 0;
    var sel = '[data-i18n],[data-i18n-attr]', els = Array.prototype.slice.call(root.querySelectorAll(sel)), count = 0;
    if (root.nodeType === 1 && root.matches && root.matches(sel)) els.unshift(root);
    for (var i = 0; i < els.length; i++) {
        var el = els[i], did = false;
        try {
            if (el.hasAttribute('data-i18n')) for (var n = el.firstChild; n; n = n.nextSibling) { if (n.nodeType === 3 && /\S/.test(n.nodeValue) && _i18nTranslateTextNode(n)) did = true; }
            if (el.hasAttribute('data-i18n-attr') && _i18nTranslateAttrs(el)) did = true;
        } catch (e) {}
        if (did) count++;
    }
    return count;
}

function _i18nLanguages() { return (typeof I18N_LANGUAGES !== 'undefined' && Array.isArray(I18N_LANGUAGES)) ? I18N_LANGUAGES : []; }

function normalizeAppLanguagePref(code) {
    var s = String(code == null ? '' : code).trim(), low = s.toLowerCase(), list = _i18nLanguages();
    if (!s || low === 'auto') return 'auto';
    for (var i = 0; i < list.length; i++) if (String(list[i].code).toLowerCase() === low) return list[i].code;
    return 'auto';
}

function _i18nBrowserLangs() { try { if (typeof navigator === 'undefined' || !navigator) return []; if (navigator.languages && navigator.languages.length) return Array.prototype.slice.call(navigator.languages); return navigator.language ? [navigator.language] : []; } catch (e) { return []; } }
function _i18nResolve(pref) { if (typeof resolveI18nLanguage === 'function') { try { return resolveI18nLanguage(pref, _i18nBrowserLangs()) || 'en'; } catch (e) {} } return pref === 'auto' ? 'en' : pref; }
function _i18nDirFor(code) { var l = _i18nLanguages(); for (var i = 0; i < l.length; i++) if (l[i].code === code) return l[i].dir === 'rtl' ? 'rtl' : 'ltr'; return 'ltr'; }
function _i18nWriteMirror(code, dir) { try { if (typeof appStorage !== 'undefined' && appStorage) { appStorage.setItem('uiLanguage', code || 'en'); appStorage.setItem('uiLanguageDir', dir === 'rtl' ? 'rtl' : 'ltr'); } } catch (e) {} }
function _i18nSetHtmlLangDir(code, dir) { try { var h = (typeof document !== 'undefined' && document) ? document.documentElement : null; if (!h) return; h.setAttribute('lang', code || 'en'); h.setAttribute('dir', dir === 'rtl' ? 'rtl' : 'ltr'); } catch (e) {} }

function i18nApplyCurrent() {
    var code = (typeof i18nLang === 'function') ? i18nLang() : 'en', dir = (typeof i18nDir === 'function') ? i18nDir() : _i18nDirFor(code);
    _i18nWriteMirror(code, dir); _i18nSetHtmlLangDir(code, dir);
    return applyI18n(document);
}

async function _i18nLoadPref() {
    if (typeof getSetting !== 'function') return appLanguagePref;
    var gen = _i18nPrefGen;
    try { var v = normalizeAppLanguagePref(await getSetting('uiLanguage', 'auto')); if (gen === _i18nPrefGen) appLanguagePref = v; } catch (e) {}
    return appLanguagePref;
}

async function i18nBootApply(initPromise, deadlineMs) {
    var ms = (typeof deadlineMs === 'number' && deadlineMs >= 0) ? deadlineMs : I18N_BOOT_DEADLINE_MS, settled = false, timer = null;
    var work = Promise.all([Promise.resolve(initPromise).catch(function() {}), _i18nLoadPref()]).then(function() { settled = true; }, function() { settled = true; });
    await Promise.race([work, new Promise(function(r) { timer = setTimeout(r, ms); })]);
    if (timer) clearTimeout(timer);
    if (settled) { i18nApplyCurrent(); return true; }
    work.then(function() { i18nApplyCurrent(); refreshI18nViews(); }).catch(function() {}); // wedged IDB: late apply
    return false;
}

function refreshI18nViews() {
    var view = (typeof currentView !== 'undefined') ? currentView : null;
    try {
        // 'chat': the message list is NOT re-rendered here. A new message-render call site raises the
        // write-site ratchet (build/write-site-ratchet.json, build aborts); bubbles follow on their next render.
        if (view === 'home') { if (typeof renderHome === 'function') renderHome(); }
        else if (view === 'settings-page') { if (typeof renderSettingsPage === 'function') renderSettingsPage(); }
        else if (view === 'dashboard') { if (typeof renderDashboard === 'function') renderDashboard(); }
        else if (view === 'skills') { if (typeof renderSkillsList === 'function') Promise.resolve(renderSkillsList()).catch(function() {}); }
        else if (view === 'docs') { if (typeof renderDocsPage === 'function') renderDocsPage(); }
        else if (view === 'history') { if (typeof renderHistoryPage === 'function') renderHistoryPage(); }
        else if (view === 'documents') { if (typeof renderDocumentsPage === 'function') renderDocumentsPage(); }
    } catch (e) { try { console.warn('[i18n] view re-render failed:', view, e); } catch (_) {} }
    try { if (typeof renderChatList === 'function') renderChatList(); } catch (e) {}
    try { if (typeof updateAllButtonStates === 'function') updateAllButtonStates(); } catch (e) {}
    try { if (typeof renderAllActionPlacements === 'function') renderAllActionPlacements(); } catch (e) {}
    try { if (typeof updateModelDisplay === 'function') updateModelDisplay(); } catch (e) {}
    try { syncSettingsPanelLanguage(); } catch (e) {} // gear panel picker: new pref + translated 'Auto' label
    try { applyI18n(document); } catch (e) {} // static DOM + any data-i18n markup the re-render produced
    return view;
}

function _i18nEsc(s) { if (typeof escapeHtml === 'function') return escapeHtml(s); return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

function i18nLanguageOptionsHtml(selected) {
    var sel = normalizeAppLanguagePref(selected == null ? appLanguagePref : selected), list = _i18nLanguages();
    var html = '<option value="auto"' + (sel === 'auto' ? ' selected' : '') + '>' + _i18nEsc(t('Auto (browser language)')) + '</option>';
    for (var i = 0; i < list.length; i++) {
        var l = list[i] || {}, label = (l.nativeName && l.name && l.nativeName !== l.name) ? l.nativeName + ' (' + l.name + ')' : (l.nativeName || l.name || l.code);
        html += '<option value="' + _i18nEsc(l.code) + '" lang="' + _i18nEsc(l.code) + '"' + (l.code === sel ? ' selected' : '') + '>' + _i18nEsc(label) + '</option>';
    }
    return html;
}

// Gear quick-settings panel picker (#settings-panel-language in body.html). Same option list and
// same onchange (setAppLanguage) as Settings > Language, so both pickers read/write ONE preference
// (appLanguagePref / IDB 'uiLanguage'): the settings page re-renders its select from it, this refills
// the panel's. Returns true when the picker exists.
function syncSettingsPanelLanguage() {
    var sel = (typeof document !== 'undefined' && document && document.getElementById) ? document.getElementById('settings-panel-language') : null;
    if (!sel) return false;
    var pref = normalizeAppLanguagePref(appLanguagePref);
    sel.innerHTML = i18nLanguageOptionsHtml(pref);
    sel.value = pref;
    return true;
}

function _i18nNotifyWorker(pref) { try { if (typeof _agentBusPort !== 'undefined' && _agentBusPort) _agentBusPort.postMessage({ type: 'ui-language', uiLanguage: pref }); } catch (e) {} }

// Settings -> Language. Serialized so rapid switches can't finish out of order.
function setAppLanguage(code) { var run = function() { return _i18nSwitchLanguage(code); }; var p = _i18nSwitchChain.then(run, run); _i18nSwitchChain = p.catch(function() {}); return p; }

async function _i18nSwitchLanguage(code) {
    var pref = normalizeAppLanguagePref(code), resolved = _i18nResolve(pref), dir = _i18nDirFor(resolved);
    _i18nPrefGen++; appLanguagePref = pref;
    if (typeof setSetting === 'function') { try { await setSetting('uiLanguage', pref); } catch (e) {} } // 1. IDB (preference)
    _i18nWriteMirror(resolved, dir);                                                                     // 1. appStorage mirror (resolved)
    _i18nSetHtmlLangDir(resolved, dir);                                                                  // 2. <html lang dir>
    if (typeof i18nInit === 'function') { try { await i18nInit({ language: pref }); } catch (e) {} }    // 3. catalog (explicit pref: no IDB re-read)
    var active = (typeof i18nLang === 'function') ? i18nLang() : resolved;
    if (active !== resolved) { dir = (typeof i18nDir === 'function') ? i18nDir() : _i18nDirFor(active); _i18nWriteMirror(active, dir); _i18nSetHtmlLangDir(active, dir); }
    refreshI18nViews();                                                                                  // 4. re-render + applyI18n(document)
    _i18nNotifyWorker(pref);                                                                             // 5. SW last
    return active;
}
