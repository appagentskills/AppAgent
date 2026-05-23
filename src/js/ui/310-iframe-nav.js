// Generate a unique CSS selector for an element (for deep mode visible text)
// Tries id, aria-label, data-* attrs, name attr, then builds nth-child path
function getUniqueSelector(el, root) {
    if (!el || el.nodeType !== 1) return '';
    var cssSafe = function(s) { return s.replace(/([\\"\[\](){}!#$%&'*+,./:;<=>?@^`{|}~])/g, '\\$1'); };
    // 1) ID-based (best case)
    if (el.id && !/\s/.test(el.id)) {
        try {
            var idSel = '#' + cssSafe(el.id);
            if ((root || el.ownerDocument).querySelectorAll(idSel).length === 1) return idSel;
        } catch(e) {}
    }
    // 2) Try aria-label
    var ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) {
        var sel = el.tagName.toLowerCase() + '[aria-label="' + ariaLabel.replace(/"/g, '\\"') + '"]';
        try { if ((root || el.ownerDocument).querySelectorAll(sel).length === 1) return sel; } catch(e) {}
    }
    // 3) Try data-* attributes
    var attrs = el.attributes;
    for (var i = 0; i < attrs.length; i++) {
        if (attrs[i].name.indexOf('data-') === 0 && attrs[i].value) {
            var sel = el.tagName.toLowerCase() + '[' + attrs[i].name + '="' + attrs[i].value.replace(/"/g, '\\"') + '"]';
            try { if ((root || el.ownerDocument).querySelectorAll(sel).length === 1) return sel; } catch(e) {}
        }
    }
    // 4) Try name attribute (for form elements)
    var name = el.getAttribute('name');
    if (name) {
        var sel = el.tagName.toLowerCase() + '[name="' + name.replace(/"/g, '\\"') + '"]';
        try { if ((root || el.ownerDocument).querySelectorAll(sel).length === 1) return sel; } catch(e) {}
    }
    // 5) Build nth-of-type path from closest identifiable ancestor
    var parts = [];
    var current = el;
    var maxDepth = 4;
    while (current && current.nodeType === 1 && maxDepth-- > 0) {
        var tag = current.tagName.toLowerCase();
        if (tag === 'html' || tag === 'body') break;
        if (current.id && !/\s/.test(current.id)) {
            parts.unshift('#' + cssSafe(current.id));
            break;
        }
        var parent = current.parentElement;
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
                parts.unshift(cls ? tag + '.' + cls : tag);
            } else {
                var idx = sameTag.indexOf(current) + 1;
                parts.unshift(tag + ':nth-of-type(' + idx + ')');
            }
        } else {
            parts.unshift(tag);
        }
        current = parent;
    }
    var finalSel = parts.join(' > ');
    try {
        if ((root || el.ownerDocument).querySelectorAll(finalSel).length === 1) return finalSel;
    } catch(e) {}
    return finalSel || el.tagName.toLowerCase();
}
