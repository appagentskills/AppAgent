// Generate a unique CSS selector for an element (for deep mode visible text)
// Tries id, aria-label, data-* attrs, name attr, then builds nth-child path
// S0C6-02: returns {selector, unique}; unique:false = no selector that resolves only to el was found
function getUniqueSelectorInfo(el, root, scan) {   // S0C6-05: scan = optional per-scan memo {root, memo: Map, roots}
    if (!el || el.nodeType !== 1) return { selector: '', unique: false };
    var scope = root || el.ownerDocument;
    // S0C6-02: shadow/iframe-piercing matches (light DOM, same-origin iframes, open shadow roots)
    var deepAll = function(r, s) {
        var out = [];
        try { var d = r.querySelectorAll(s); for (var k = 0; k < d.length; k++) out.push(d[k]); } catch(e) { return out; }
        try { var fr = r.querySelectorAll('iframe'); for (var f = 0; f < fr.length; f++) { try { if (fr[f].contentDocument) out = out.concat(deepAll(fr[f].contentDocument, s)); } catch(e) {} } } catch(e) {}
        try { var hs = r.querySelectorAll('*'); for (var h = 0; h < hs.length; h++) { if (hs[h].shadowRoot) out = out.concat(deepAll(hs[h].shadowRoot, s)); } } catch(e) {}
        return out;
    };
    // Unique = resolves only to target; the light pre-check is a cheap early exit (deep includes light)
    var _uniq = function(sel, target) {
        try {
            // S0C6-05: per-scan memo (iframe_tool deep walker): the roots deepAll visits are collected once
            // per scan and each selector's first 2 deep matches are memoized (shadow duplicates share selectors)
            if (scan && scan.root === scope) {
                var mm = scan.memo.get(sel);
                if (!mm) {
                    if (!scan.roots) {
                        scan.roots = [];
                        var addRoots = function(r) {
                            scan.roots.push(r);
                            try { var fr = r.querySelectorAll('iframe'); for (var f = 0; f < fr.length; f++) { try { if (fr[f].contentDocument) addRoots(fr[f].contentDocument); } catch(e) {} } } catch(e) {}
                            try { var hs = r.querySelectorAll('*'); for (var h = 0; h < hs.length; h++) { if (hs[h].shadowRoot) addRoots(hs[h].shadowRoot); } } catch(e) {}
                        };
                        addRoots(scope);
                    }
                    mm = [];
                    for (var i = 0; i < scan.roots.length && mm.length < 2; i++) {
                        var d = scan.roots[i].querySelectorAll(sel);   // bad CSS throws -> catch -> false
                        for (var k = 0; k < d.length && mm.length < 2; k++) mm.push(d[k]);
                    }
                    scan.memo.set(sel, mm);
                }
                return mm.length === 1 && mm[0] === target;
            }
            if (scope.querySelectorAll(sel).length > 1) return false;
            var m = deepAll(scope, sel);
            return m.length === 1 && m[0] === target;
        } catch(e) { return false; }
    };
    // S0C6-04: is sel valid CSS? (a raw tag such as Word's <o:p> is not). CSS.escape replaces cssSafe,
    // which left leading digits unescaped (#1x is invalid).
    var _parses = function(sel) {
        try { (el.ownerDocument || document).createDocumentFragment().querySelector(sel); return true; } catch(e) { return false; }
    };
    // 1) ID-based (best case)
    if (el.id && !/\s/.test(el.id)) {
        try {
            var idSel = '#' + CSS.escape(el.id);
            if (_uniq(idSel, el)) return { selector: idSel, unique: true };   // S0C6-03: deep count, so a shadow/iframe twin is not unique
        } catch(e) {}
    }
    // 2) Try aria-label
    var ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) {
        var sel = el.tagName.toLowerCase() + '[aria-label="' + CSS.escape(ariaLabel) + '"]';
        try { if (_uniq(sel, el)) return { selector: sel, unique: true }; } catch(e) {}
    }
    // 3) Try data-* attributes
    var attrs = el.attributes;
    for (var i = 0; i < attrs.length; i++) {
        if (attrs[i].name.indexOf('data-') === 0 && attrs[i].value) {
            var sel = el.tagName.toLowerCase() + '[' + attrs[i].name + '="' + CSS.escape(attrs[i].value) + '"]';
            try { if (_uniq(sel, el)) return { selector: sel, unique: true }; } catch(e) {}
        }
    }
    // 4) Try name attribute (for form elements)
    var name = el.getAttribute('name');
    if (name) {
        var sel = el.tagName.toLowerCase() + '[name="' + CSS.escape(name) + '"]';
        try { if (_uniq(sel, el)) return { selector: sel, unique: true }; } catch(e) {}
    }
    // 5) Build nth-of-type path from closest identifiable ancestor
    var parts = [];
    var current = el;
    var depth = 0, unique = false;   // S0C6-02: climb until the path is unique (cap 15)
    while (current && current.nodeType === 1 && depth++ < 15) {
        var tag = current.tagName.toLowerCase();
        if (tag === 'html' || tag === 'body') break;
        if (current.id && !/\s/.test(current.id) && _uniq('#' + CSS.escape(current.id), current)) {   // S0C6-02: unique ids only
            parts.unshift('#' + CSS.escape(current.id));
            break;
        }
        // S0C6-03: a shadow root's top-level child is positioned among the root's children (climb stops there)
        var parent = current.parentElement || (current.parentNode && current.parentNode.nodeType === 11 ? current.parentNode : null);
        if (parent) {
            var siblings = parent.children;
            var sameTag = [];
            for (var j = 0; j < siblings.length; j++) {
                if (siblings[j].tagName === current.tagName) sameTag.push(siblings[j]);
            }
            if (sameTag.length === 1) {
                var cls = current.className && typeof current.className === 'string' ? current.className.trim().split(/\s+/).filter(function(c) {
                    return c.length > 1 && !/^ng-|^x-|^ui-/.test(c) && !/^active$|^focus$|^hover$/.test(c);
                })[0] : '';
                parts.unshift(cls ? tag + '.' + CSS.escape(cls) : tag);
            } else {
                var idx = sameTag.indexOf(current) + 1;
                parts.unshift(tag + ':nth-of-type(' + idx + ')');
            }
        } else {
            parts.unshift(tag);
        }
        current = parent;
        if ((unique = _uniq(parts.join(' > '), el))) break;
    }
    var finalSel = parts.join(' > ');
    // S0C6-04: an unparseable path (raw tag such as Word's <o:p>) -> escaped tag:nth-of-type parts only
    if (finalSel && !_parses(finalSel)) {
        parts = [];
        for (var rc = el, rd = 0; rc && rc.nodeType === 1 && rd++ < 15; rc = rc.parentElement) {
            var rt = rc.tagName.toLowerCase();
            if (rt === 'html' || rt === 'body') break;
            var rn = 1;
            for (var rp = rc.previousElementSibling; rp; rp = rp.previousElementSibling) { if (rp.tagName === rc.tagName) rn++; }
            parts.unshift(CSS.escape(rt) + ':nth-of-type(' + rn + ')');
            if ((unique = _uniq(parts.join(' > '), el))) break;
        }
        finalSel = parts.join(' > ');
    }
    var result = finalSel || el.tagName.toLowerCase();
    return { selector: result, unique: unique || _uniq(result, el) };
}

function getUniqueSelector(el, root) { return getUniqueSelectorInfo(el, root).selector; }
