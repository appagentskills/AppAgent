// MV3 CSP Inline Handler Polyfill
// Chrome MV3 blocks inline event handlers (onclick="...") in extension pages.
// This polyfill intercepts innerHTML, insertAdjacentHTML, and setAttribute to
// transform on* attributes into data attributes BEFORE they reach the DOM,
// then binds them via addEventListener with a mini handler interpreter.
//
// This handles dynamically-created HTML in JavaScript.
// Static HTML handlers are extracted at build time separately.

(function() {
    'use strict';

    // Security: blocklist of dangerous function/property names to prevent XSS escalation.
    // The polyfill executes inline handlers in the main page context — if attacker-controlled
    // HTML reaches innerHTML, these blocks prevent calling dangerous APIs.
    var _BLOCKED_NAMES = { eval:1, Function:1, fetch:1, XMLHttpRequest:1, WebSocket:1, Worker:1,
        SharedWorker:1, ServiceWorker:1, importScripts:1, chrome:1, browser:1 };
    var _BLOCKED_PROPS = { __proto__:1, constructor:1, prototype:1 };

    function _isBlockedPath(name) {
        var parts = name.split('.');
        if (_BLOCKED_NAMES[parts[0]]) return true;
        for (var i = 0; i < parts.length; i++) {
            if (_BLOCKED_PROPS[parts[i]]) return true;
        }
        return false;
    }

    var RE = /(\s)(on([a-z]+))="([^"]*)"/g;

    function txHTML(html) {
        return typeof html === 'string' ? html.replace(RE, '$1data-_ev-$3="$4"') : html;
    }

    // --- Override innerHTML ---
    var _innerDesc = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
    Object.defineProperty(Element.prototype, 'innerHTML', {
        set: function(html) {
            _innerDesc.set.call(this, txHTML(html));
            _scanAll(this);
        },
        get: _innerDesc.get,
        configurable: true
    });

    // --- Override outerHTML ---
    // Same treatment as innerHTML: replacing a node via outerHTML must not let
    // raw on* attributes reach the DOM (e.g. the incremental message renderer
    // patches the tail message with tailEl.outerHTML = ...). Transform the
    // markup, then scan ONLY the replacement nodes (the span between the old
    // node's siblings) so we never re-traverse the whole parent subtree.
    var _outerDesc = Object.getOwnPropertyDescriptor(Element.prototype, 'outerHTML');
    Object.defineProperty(Element.prototype, 'outerHTML', {
        set: function(html) {
            var parent = this.parentNode;
            var prev = this.previousSibling, next = this.nextSibling;
            _outerDesc.set.call(this, txHTML(html));
            if (!parent || !parent.querySelectorAll) return;
            var n = prev ? prev.nextSibling : parent.firstChild;
            while (n && n !== next) {
                if (n.nodeType === 1) { _scanEl(n); _scanAll(n); }
                n = n.nextSibling;
            }
        },
        get: _outerDesc.get,
        configurable: true
    });

    // --- Override insertAdjacentHTML ---
    var _origInsertAdj = Element.prototype.insertAdjacentHTML;
    Element.prototype.insertAdjacentHTML = function(pos, html) {
        _origInsertAdj.call(this, pos, txHTML(html));
        var root = (pos === 'beforeend' || pos === 'afterbegin') ? this : this.parentElement;
        if (root) _scanAll(root);
    };

    // --- Override setAttribute for on* ---
    var _origSetAttr = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function(name, value) {
        if (/^on[a-z]/.test(name)) {
            _origSetAttr.call(this, 'data-_ev-' + name.slice(2), value);
            _bind(this, name.slice(2), value);
        } else {
            _origSetAttr.call(this, name, value);
        }
    };

    // --- Scan and bind ---
    function _scanAll(root) {
        if (!root) return;
        var els = root.querySelectorAll('*');
        for (var i = 0; i < els.length; i++) _scanEl(els[i]);
    }

    function _scanEl(el) {
        var rm = [];
        for (var i = 0; i < el.attributes.length; i++) {
            var a = el.attributes[i];
            if (a.name.indexOf('data-_ev-') === 0) {
                _bind(el, a.name.slice(9), a.value);
                rm.push(a.name);
            }
        }
        for (var i = 0; i < rm.length; i++) el.removeAttribute(rm[i]);
    }

    function _bind(el, ev, code) {
        el.addEventListener(ev, function(event) {
            try { _exec(code, this, event); }
            catch (e) { console.warn('[CSP polyfill] Handler error:', e.message, '\nCode:', code.substring(0, 100)); }
        });
    }

    // --- Mini handler interpreter ---
    // Handles: fn(), fn('a'), fn(event), fn(this), fn(a,b), event.stopPropagation(),
    //          if(event.key==='Enter')fn(), document.getElementById('x').click(),
    //          multi-statements separated by ;, this.property, return false

    function _exec(code, el, ev) {
        // Smart split by ; respecting brackets and strings
        var stmts = [], cur = '', dep = 0, inS = false, sC = '';
        for (var i = 0; i < code.length; i++) {
            var c = code[i];
            if (inS) {
                cur += c;
                if (c === '\\' && i + 1 < code.length) cur += code[++i];
                else if (c === sC) inS = false;
            } else if (c === '\'' || c === '"') {
                inS = true; sC = c; cur += c;
            } else if (c === '(' || c === '{' || c === '[') {
                dep++; cur += c;
            } else if (c === ')' || c === '}' || c === ']') {
                dep--; cur += c;
            } else if (c === ';' && dep === 0) {
                if (cur.trim()) stmts.push(cur.trim());
                cur = '';
            } else { cur += c; }
        }
        if (cur.trim()) stmts.push(cur.trim());
        for (var i = 0; i < stmts.length; i++) _run(stmts[i], el, ev);
    }

    function _run(s, el, ev) {
        // return false / return
        if (s === 'return false' || s === 'return') return;

        // event.stopPropagation() / event.preventDefault()
        if (s === 'event.stopPropagation()') { ev.stopPropagation(); return; }
        if (s === 'event.preventDefault()') { ev.preventDefault(); return; }

        // this.property = value (e.g. this.value = '')
        var thisProp = s.match(/^this\.(\w+)\s*=\s*(.+)$/);
        if (thisProp) { el[thisProp[1]] = _val(thisProp[2].trim(), el, ev); return; }

        // if(cond)action
        var ifm = s.match(/^if\((.+?)\)(\w.+)$/);
        if (ifm) { if (_cond(ifm[1], ev)) _run(ifm[2], el, ev); return; }

        // document.getElementById('x').click()
        var gm = s.match(/^document\.getElementById\('([^']+)'\)\.(click|focus|blur)\(\)$/);
        if (gm) { var t = document.getElementById(gm[1]); if (t) t[gm[2]](); return; }

        // document.getElementById('x').scrollTop = N
        var gsm = s.match(/^document\.getElementById\('([^']+)'\)\.(\w+)\s*=\s*(.+)$/);
        if (gsm) { var t = document.getElementById(gsm[1]); if (t) t[gsm[2]] = _val(gsm[3].trim(), el, ev); return; }

        // setTimeout(function(){...}, N)
        var stm = s.match(/^setTimeout\(function\(\)\s*\{([\s\S]+)\}\s*,\s*(\d+)\)$/);
        if (stm) { var body = stm[1], delay = parseInt(stm[2]); setTimeout(function() { _exec(body, el, ev); }, delay); return; }

        // fn(args) - simple (no nested parens in args)
        var cm = s.match(/^([a-zA-Z_$][\w$.]*)\(([^)]*)\)$/);
        if (cm) { _call(cm[1], cm[2], el, ev); return; }

        // fn(args with nested parens)
        var cm2 = s.match(/^([a-zA-Z_$][\w$.]*)\(([\s\S]+)\)$/);
        if (cm2) { _call(cm2[1], cm2[2], el, ev); return; }

        // Unmatched - log for debugging
        console.warn('[CSP polyfill] Unmatched handler statement:', s.substring(0, 120));
    }

    function _call(name, argsStr, el, ev) {
        if (_isBlockedPath(name)) {
            console.warn('[CSP polyfill] Blocked call to dangerous function:', name);
            return;
        }
        // Handle dotted paths like window.open
        var fn;
        if (name.indexOf('.') !== -1) {
            var parts = name.split('.');
            fn = window;
            for (var i = 0; i < parts.length && fn; i++) fn = fn[parts[i]];
        } else {
            fn = window[name];
        }
        if (typeof fn === 'function') {
            fn.apply(el, _args(argsStr, el, ev));
        } else {
            console.warn('[CSP polyfill] Function not found:', name);
        }
    }

    function _cond(c, ev) {
        var parts = c.split('||');
        for (var i = 0; i < parts.length; i++) {
            var p = parts[i].trim();
            var km = p.match(/event\.key==='([^']*)'/);
            if (km && ev.key === km[1]) return true;
        }
        return false;
    }

    function _args(str, el, ev) {
        if (!str || !str.trim()) return [];
        var result = [], cur = '', dep = 0, inS = false, sC = '';
        for (var i = 0; i < str.length; i++) {
            var c = str[i];
            if (inS) {
                cur += c;
                if (c === '\\' && i + 1 < str.length) cur += str[++i];
                else if (c === sC) inS = false;
            } else if (c === '\'' || c === '"') {
                inS = true; sC = c; cur += c;
            } else if (c === '(' || c === '{' || c === '[') {
                dep++; cur += c;
            } else if (c === ')' || c === '}' || c === ']') {
                dep--; cur += c;
            } else if (c === ',' && dep === 0) {
                result.push(_val(cur.trim(), el, ev));
                cur = '';
            } else { cur += c; }
        }
        if (cur.trim()) result.push(_val(cur.trim(), el, ev));
        return result;
    }

    function _val(v, el, ev) {
        if (v === 'event') return ev;
        if (v === 'this') return el;
        if (v === 'true') return true;
        if (v === 'false') return false;
        if (v === 'null') return null;
        if (v === 'undefined') return undefined;
        if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
        if ((v[0] === '\'' || v[0] === '"') && v[v.length - 1] === v[0]) {
            return v.slice(1, -1).replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        }
        // this.property (e.g. this.value, this.checked)
        if (v.indexOf('this.') === 0) {
            var prop = v.slice(5);
            if (/^[\w$.]+$/.test(prop)) {
                var ref = el;
                var parts = prop.split('.');
                for (var i = 0; i < parts.length && ref != null; i++) ref = ref[parts[i]];
                return ref;
            }
        }
        // Resolve bare identifiers and dotted paths from window scope
        if (/^[a-zA-Z_$][\w$.]*$/.test(v)) {
            if (_isBlockedPath(v)) return v;
            var parts = v.split('.');
            var ref = window;
            for (var i = 0; i < parts.length && ref != null; i++) ref = ref[parts[i]];
            if (ref !== undefined) return ref;
        }
        // Handle function expressions embedded via .toString() (e.g. "function changeProvider(v) { ... }")
        // Extract the name and resolve from window scope
        if (/^function\s/.test(v)) {
            var fnName = v.match(/^function\s+([a-zA-Z_$][\w$]*)/);
            if (fnName && typeof window[fnName[1]] === 'function') return window[fnName[1]];
        }
        return v;
    }
})();
