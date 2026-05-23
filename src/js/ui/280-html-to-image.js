// Screenshot capture functions
var _screenshotDataUrl = null;
var _htiFontCache = null; // pre-cached @font-face CSS for screenshot capture
var _SCREENSHOT_SKIP_TAGS = { SCRIPT: 1, STYLE: 1, LINK: 1, NOSCRIPT: 1, META: 1 };
function screenshotFilter(node) {
    if (node.nodeType !== 1) return true;
    if (_SCREENSHOT_SKIP_TAGS[node.tagName]) return false;
    return true;
}

// -- Font collection --
// Collects @font-face rules from all stylesheets (same-origin, cross-origin,
// @import'ed), fetches font files, and returns CSS with fonts inlined as data URLs.
var _cssFetchCache = {};

function _fetchCSSText(url) {
    if (_cssFetchCache[url]) return _cssFetchCache[url];
    _cssFetchCache[url] = fetch(url).then(function(r) { return r.text(); }).then(function(text) {
        return { url: url, cssText: text };
    });
    return _cssFetchCache[url];
}

function _resolveUrl(url, baseUrl) {
    if (!url || url.startsWith('data:')) return url;
    try { return new URL(url, baseUrl).href; } catch (e) { return url; }
}

function _fetchAsDataURL(url) {
    return fetch(url).then(function(r) {
        return r.blob();
    }).then(function(blob) {
        return new Promise(function(resolve) {
            var reader = new FileReader();
            reader.onload = function() { resolve(reader.result); };
            reader.onerror = function() { resolve(url); };
            reader.readAsDataURL(blob);
        });
    }).catch(function() { return url; });
}

function _embedFontUrls(cssText, baseUrl) {
    var urlRegex = /url\(["']?([^"')]+)["']?\)/g;
    var locs = cssText.match(/url\([^)]+\)/g) || [];
    var jobs = locs.map(function(loc) {
        var inner = loc.replace(urlRegex, '$1');
        if (inner.startsWith('data:')) return Promise.resolve();
        var resolved = _resolveUrl(inner, baseUrl);
        return _fetchAsDataURL(resolved).then(function(dataUrl) {
            cssText = cssText.split(loc).join('url(' + dataUrl + ')');
        });
    });
    return Promise.all(jobs).then(function() { return cssText; });
}

function _fetchAndExtractFonts(url) {
    return _fetchCSSText(url)
        .then(function(meta) { return _embedFontUrls(meta.cssText, meta.url); })
        .then(function(cssText) {
            var blocks = [];
            var re = /@font-face\s*\{[^}]*\}/gi;
            var m;
            while ((m = re.exec(cssText)) !== null) blocks.push(m[0]);
            return blocks.join('\n');
        })
        .catch(function() { return ''; });
}

function collectFontCSS(rootElement) {
    var doc = rootElement.ownerDocument || rootElement;
    var sheets = [];
    try { sheets = Array.prototype.slice.call(doc.styleSheets); } catch (e) {}
    if (sheets.length === 0) return Promise.resolve('');

    var deferreds = [];

    sheets.forEach(function(sheet) {
        try {
            var rules = Array.prototype.slice.call(sheet.cssRules || []);
            rules.forEach(function(rule) {
                if (rule.type === CSSRule.IMPORT_RULE && rule.href) {
                    deferreds.push(_fetchAndExtractFonts(rule.href));
                }
            });
            // Uses rule.type instead of instanceof — works across iframe contexts
            rules.forEach(function(rule) {
                if (rule.type === CSSRule.FONT_FACE_RULE) {
                    var baseUrl = sheet.href || doc.location.href;
                    deferreds.push(_embedFontUrls(rule.cssText, baseUrl).catch(function() { return ''; }));
                }
            });
        } catch (e) {
            // Cross-origin stylesheet: fetch and extract @font-face blocks
            if (sheet.href) deferreds.push(_fetchAndExtractFonts(sheet.href));
        }
    });

    return Promise.all(deferreds).then(function(results) {
        return results.filter(Boolean).join('\n');
    });
}

// === Inline html-to-image (based on v1.11.13, toSvg only) ===
// Font embedding uses collectFontCSS above.

// -- Scroll simulation --
// Patches getComputedStyle to inject negative margins simulating scroll offsets.
// Returns a restore function.
var _SHIFT_SKIP = { SCRIPT: 1, STYLE: 1, LINK: 1, NOSCRIPT: 1, META: 1, BR: 1, TEMPLATE: 1 };
var _BLOCK_DISPLAYS = { block: 1, flex: 1, grid: 1, table: 1, 'list-item': 1, 'flow-root': 1, 'inline-block': 1, 'inline-flex': 1, 'inline-grid': 1, 'inline-table': 1 };

function patchScrollStyles(targetNode) {
    var doc = targetNode.ownerDocument || targetNode;
    var win = doc.defaultView || window;
    // Collect scrolled elements and all window contexts (shadow roots + iframes)
    var scrollMap = new Map();
    var allWindows = new Set([window, win]);
    (function walk(root) {
        if (!root || !root.querySelectorAll) return;
        var els = root.querySelectorAll('*');
        for (var i = 0; i < els.length; i++) {
            var el = els[i];
            if (el.scrollTop > 0 || el.scrollLeft > 0) {
                // Only apply scroll simulation if element has overflow that clips content
                // Skip documentElement/body - their scroll is viewport-level, not container-level
                if (el === doc.documentElement || el === doc.body) continue;
                var cs = win.getComputedStyle(el);
                var ovX = cs.overflowX, ovY = cs.overflowY;
                // Only simulate scroll for containers with clipping overflow
                var clipsX = ovX === 'hidden' || ovX === 'scroll' || ovX === 'auto';
                var clipsY = ovY === 'hidden' || ovY === 'scroll' || ovY === 'auto';
                if ((el.scrollTop > 0 && clipsY) || (el.scrollLeft > 0 && clipsX)) {
                    scrollMap.set(el, {
                        top: clipsY ? el.scrollTop : 0,
                        left: clipsX ? el.scrollLeft : 0
                    });
                }
            }
            if (els[i].shadowRoot) walk(els[i].shadowRoot);
            if (els[i].tagName === 'IFRAME') {
                try {
                    var subDoc = els[i].contentDocument;
                    if (subDoc) {
                        if (subDoc.defaultView) allWindows.add(subDoc.defaultView);
                        walk(subDoc);
                    }
                } catch (e) {}
            }
        }
    })(doc);
    // Save original getComputedStyle for each window
    var origGCSMap = new Map();
    allWindows.forEach(function(w) { origGCSMap.set(w, w.getComputedStyle); });
    function getOrigGCS(el) {
        var w = el.ownerDocument && el.ownerDocument.defaultView;
        if (w && origGCSMap.has(w)) return { fn: origGCSMap.get(w), win: w };
        return { fn: origGCSMap.get(win), win: win };
    }
    // Build per-child shift map - find first block-level child to apply negative margin
    var childShiftMap = new Map();
    scrollMap.forEach(function(scroll, el) {
        if (scroll.top === 0 && scroll.left === 0) return;
        var found = false;
        (function descend(node) {
            // Get children: slot assigned elements, shadow root children, or regular children
            var kids = (node.assignedElements ? node.assignedElements({ flatten: true }) : null)
                    || (node.children ? node.children : []);
            for (var i = 0; i < kids.length && !(found && scroll.left === 0); i++) {
                var kid = kids[i];
                if (_SHIFT_SKIP[kid.tagName]) continue;
                var g = getOrigGCS(kid), cs = g.fn.call(g.win, kid);
                if (cs.position === 'fixed' || cs.position === 'absolute' || cs.position === 'sticky' || cs.display === 'none') continue;
                // Non-block: descend into it (contents, shadow root, or inline wrapper)
                if (!_BLOCK_DISPLAYS[cs.display]) { descend(kid.shadowRoot || kid); continue; }
                childShiftMap.set(kid, { top: found ? 0 : scroll.top, left: scroll.left });
                found = true;
            }
        })(el);
    });
    // Patched getComputedStyle: proxies style objects for scroll containers and shifted children
    function patchedGCS(el, pseudo) {
        var gcs = getOrigGCS(el);
        var style = gcs.fn.call(gcs.win, el, pseudo);
        if (pseudo) return style;
        // Scrolled containers: hide overflow so cloned content doesn't spill
        if (scrollMap.has(el)) {
            return new Proxy(style, {
                get: function(target, prop) {
                    if (prop === 'overflow' || prop === 'overflowX' || prop === 'overflowY') return 'hidden';
                    if (prop === 'getPropertyValue') {
                        return function(p) {
                            if (p === 'overflow' || p === 'overflow-x' || p === 'overflow-y') return 'hidden';
                            return target.getPropertyValue(p);
                        };
                    }
                    var val = target[prop];
                    return typeof val === 'function' ? val.bind(target) : val;
                }
            });
        }
        // Shifted children: inject negative margins to simulate scroll offset.
        var shift = childShiftMap.get(el);
        if (shift && (shift.top > 0 || shift.left > 0)) {
            return new Proxy(style, {
                get: function(target, prop) {
                    if (shift.top > 0 && (prop === 'marginTop' || prop === 'marginBlockStart')) {
                        return ((parseInt(target.marginTop, 10) || 0) - shift.top) + 'px';
                    }
                    if (shift.left > 0 && (prop === 'marginLeft' || prop === 'marginInlineStart')) {
                        return ((parseInt(target.marginLeft, 10) || 0) - shift.left) + 'px';
                    }
                    if (prop === 'getPropertyValue') {
                        return function(p) {
                            if (shift.top > 0 && (p === 'margin-top' || p === 'margin-block-start')) {
                                return ((parseInt(target.getPropertyValue('margin-top'), 10) || 0) - shift.top) + 'px';
                            }
                            if (shift.left > 0 && (p === 'margin-left' || p === 'margin-inline-start')) {
                                return ((parseInt(target.getPropertyValue('margin-left'), 10) || 0) - shift.left) + 'px';
                            }
                            return target.getPropertyValue(p);
                        };
                    }
                    var val = target[prop];
                    return typeof val === 'function' ? val.bind(target) : val;
                }
            });
        }
        return style;
    }
    allWindows.forEach(function(w) { w.getComputedStyle = patchedGCS; });
    return function() {
        origGCSMap.forEach(function(origFn, w) { w.getComputedStyle = origFn; });
    };
}

// -- SVG sanitization --
function sanitizeSvgDataUrl(svgDataUrl) {
    var svgStr = decodeURIComponent(svgDataUrl.split(',')[1] || '');
    svgStr = svgStr.replace(/[^\x09\x0A\x0D\x20-\uD7FF\uE000-\uFFFD]/g, '');
    svgStr = svgStr.replace(/<\/?\w+:\w[^>]*\/?>/g, '');
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgStr);
}

// -- PNG rendering --
function svgToPng(svgUrl, width, height, ratio) {
    return new Promise(function(resolve, reject) {
        var img = new Image();
        img.onload = function() {
            var canvas = document.createElement('canvas');
            canvas.width = width * ratio;
            canvas.height = height * ratio;
            var ctx = canvas.getContext('2d');
            ctx.scale(ratio, ratio);
            ctx.drawImage(img, 0, 0);
            var result = canvas.toDataURL('image/png');
            // Release memory: clear canvas bitmap and image src
            canvas.width = 0;
            canvas.height = 0;
            img.src = '';
            resolve(result);
        };
        img.onerror = function() { reject(new Error('SVG render failed')); };
        img.src = svgUrl;
    });
}

// -- Utilities --

var _htiMimes = {woff:'application/font-woff',woff2:'application/font-woff',ttf:'application/font-truetype',eot:'application/vnd.ms-fontobject',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',tiff:'image/tiff',svg:'image/svg+xml',webp:'image/webp'};
function _htiMimeType(url) {
    var m = /\.([^./]*?)$/g.exec(url);
    return m ? (_htiMimes[m[1].toLowerCase()] || '') : '';
}
function _htiIsDataUrl(url) { return /^data:/.test(url); }
function _htiToArray(a) { var r = []; for (var i = 0; i < a.length; i++) r.push(a[i]); return r; }
function _htiIsInstanceOf(node, type) {
    if (node instanceof type) return true;
    var p = Object.getPrototypeOf(node);
    return p ? (p.constructor.name === type.name || _htiIsInstanceOf(p, type)) : false;
}
var _htiIdCounter = 0;
function _htiUuid() {
    return 'u' + ('0000' + ((Math.random() * Math.pow(36, 4)) << 0).toString(36)).slice(-4) + (++_htiIdCounter);
}
var _htiStyleProps = null;
function _htiGetStyleProps() {
    if (!_htiStyleProps) _htiStyleProps = _htiToArray(window.getComputedStyle(document.documentElement));
    return _htiStyleProps;
}
function _htiCreateImage(url) {
    return new Promise(function(resolve, reject) {
        var img = new Image();
        img.onload = function() { resolve(img); };
        img.onerror = reject;
        img.crossOrigin = 'anonymous';
        img.decoding = 'async';
        img.src = url;
    });
}

// -- Resource fetching with cache --

var _htiResCache = {};
function _htiResourceToDataURL(url, contentType, options) {
    var key = url.replace(/\?.*/, '');
    if (/ttf|otf|eot|woff2?/i.test(key)) key = key.replace(/.*\//, '');
    if (contentType) key = '[' + contentType + ']' + key;
    if (_htiResCache[key]) return Promise.resolve(_htiResCache[key]);
    var fetchUrl = options.cacheBust ? url + (/\?/.test(url) ? '&' : '?') + Date.now() : url;
    return fetch(fetchUrl, options.fetchRequestInit)
        .then(function(r) { if (r.status === 404) throw new Error('Not found'); return r.blob(); })
        .then(function(blob) {
            return new Promise(function(resolve, reject) {
                var reader = new FileReader();
                reader.onerror = reject;
                reader.onloadend = function() { _htiResCache[key] = reader.result; resolve(reader.result); };
                reader.readAsDataURL(blob);
            });
        })
        .catch(function() { return options.imagePlaceholder || ''; });
}

function _htiEmbedCSSUrls(cssText, baseUrl, options) {
    var urls = [];
    cssText.replace(/url\((['"]?)([^'"]+?)\1\)/g, function(m, q, u) { if (!_htiIsDataUrl(u)) urls.push(u); return m; });
    if (!urls.length) return Promise.resolve(cssText);
    return urls.reduce(function(chain, resUrl) {
        return chain.then(function(css) {
            var resolved = baseUrl ? _resolveUrl(resUrl, baseUrl) : resUrl;
            return _htiResourceToDataURL(resolved, _htiMimeType(resUrl), options).then(function(dataUrl) {
                var esc = resUrl.replace(/([.*+?^${}()|[\]\\])/g, '\\$1');
                return css.replace(new RegExp('(url\\([\'"]?)(' + esc + ')([\'"]?\\))', 'g'), '$1' + dataUrl + '$3');
            }).catch(function() { return css; });
        });
    }, Promise.resolve(cssText));
}

// -- DOM cloning --

// Accumulated pseudo-element CSS rules during cloning
var _htiPseudoStyles = [];

function _htiClonePseudos(nativeNode, clonedNode) {
    var pseudos = ['before', 'after'];
    // Add placeholder for form elements that support it
    if (nativeNode.placeholder !== undefined) pseudos.push('placeholder');
    var win = nativeNode.ownerDocument.defaultView || window;
    pseudos.forEach(function(pseudo) {
        var style = win.getComputedStyle(nativeNode, '::' + pseudo);
        // For before/after check content; for placeholder check attribute exists
        if (pseudo === 'placeholder') {
            if (!nativeNode.placeholder) return;
        } else {
            var content = style.getPropertyValue('content');
            if (!content || content === 'none' || content === '') return;
        }
        var cls = _htiUuid();
        try { clonedNode.className = clonedNode.className + ' ' + cls; } catch (e) { return; }
        var css;
        if (style.cssText) {
            css = style.cssText;
            if (pseudo !== 'placeholder') css += " content: '" + content.replace(/['"]/g, '') + "';";
        } else {
            css = _htiGetStyleProps().map(function(n) {
                return n + ': ' + style.getPropertyValue(n) + (style.getPropertyPriority(n) ? ' !important' : '') + ';';
            }).join(' ');
        }
        // Store rule globally - will be injected at root level before serialization
        _htiPseudoStyles.push('.' + cls + '::' + pseudo + '{' + css + '}');
    });
}

function _htiCloneCSS(nativeNode, clonedNode) {
    var ts = clonedNode.style;
    if (!ts) return;
    var win = nativeNode.ownerDocument.defaultView || window;
    var ss = win.getComputedStyle(nativeNode);

    var rect = nativeNode.getBoundingClientRect();
    var tagName = nativeNode.tagName || '';
    var isCustomElement = tagName.includes('-');
    var shouldForceSize = isCustomElement && rect.width > 0 && rect.height > 0 &&
        ss.display !== 'inline' && ss.display !== 'contents' && ss.display !== 'none';

    if (ss.cssText) {
        ts.cssText = ss.cssText;
        ts.transformOrigin = ss.transformOrigin;
    } else {
        _htiGetStyleProps().forEach(function(name) {
            var val = ss.getPropertyValue(name);
            if (name === 'font-size' && val.endsWith('px'))
                val = (Math.floor(parseFloat(val)) - 0.1) + 'px';
            if (_htiIsInstanceOf(nativeNode, HTMLIFrameElement) && name === 'display' && val === 'inline')
                val = 'block';
            if (name === 'd' && clonedNode.getAttribute('d'))
                val = 'path(' + clonedNode.getAttribute('d') + ')';
            ts.setProperty(name, val, ss.getPropertyPriority(name));
        });
    }

    // Force exact dimensions on custom elements to prevent layout shifts in foreignObject
    if (shouldForceSize) {
        ts.setProperty('width', rect.width + 'px', 'important');
        ts.setProperty('height', rect.height + 'px', 'important');
        ts.setProperty('min-width', rect.width + 'px', 'important');
        ts.setProperty('min-height', rect.height + 'px', 'important');
        ts.setProperty('max-width', rect.width + 'px', 'important');
        ts.setProperty('max-height', rect.height + 'px', 'important');
        ts.setProperty('box-sizing', 'border-box', 'important');
    }
}

function _htiCloneSingle(node, options) {
    if (_htiIsInstanceOf(node, HTMLCanvasElement)) {
        var d = node.toDataURL();
        return d === 'data:,' ? Promise.resolve(node.cloneNode(false)) : _htiCreateImage(d);
    }
    if (_htiIsInstanceOf(node, HTMLVideoElement)) {
        if (node.currentSrc) {
            var c = document.createElement('canvas');
            c.width = node.clientWidth; c.height = node.clientHeight;
            c.getContext('2d').drawImage(node, 0, 0, c.width, c.height);
            var dataUrl = c.toDataURL();
            // Release canvas memory
            c.width = 0;
            c.height = 0;
            return _htiCreateImage(dataUrl);
        }
        return Promise.resolve(node.cloneNode(false));
    }
    if (_htiIsInstanceOf(node, HTMLIFrameElement)) {
        try {
            if (node.contentDocument && node.contentDocument.body) {
                // Save and restore cloned nodes tracking (iframe is separate doc, but don't reset main tracking)
                var savedCloned = _htiClonedNodes;
                return _htiCloneNode(node.contentDocument.body, options, true).then(function(result) {
                    _htiClonedNodes = savedCloned;
                    return result;
                });
            }
        } catch (e) {}
        return Promise.resolve(node.cloneNode(false));
    }
    // Replace <slot> with <span style="display:contents"> - slot has display:contents by default
    if (node.tagName && node.tagName.toUpperCase() === 'SLOT') {
        var span = document.createElement('span');
        span.style.display = 'contents';
        return Promise.resolve(span);
    }
    var isSVG = node.tagName && node.tagName.toUpperCase() === 'SVG';
    if (isSVG) {
        var clone = node.cloneNode(true);
        // Sanitize SVG paths that contain NaN values
        var paths = clone.querySelectorAll('path');
        for (var i = 0; i < paths.length; i++) {
            var d = paths[i].getAttribute('d');
            if (d && /nan/i.test(d)) {
                paths[i].setAttribute('d', d.replace(/nan/gi, '0'));
            }
        }
        return Promise.resolve(clone);
    }
    return Promise.resolve(node.cloneNode(false));
}

function _htiCloneChildren(nativeNode, clonedNode, options) {
    if (nativeNode.tagName && nativeNode.tagName.toUpperCase() === 'SVG') return Promise.resolve(clonedNode);
    var children;
    var tag = nativeNode.tagName && nativeNode.tagName.toUpperCase();
    if (tag === 'SLOT' && nativeNode.assignedNodes) {
        // Don't use flatten: true - it can cause duplicates through nested slots
        // Fallback content will be handled when slot has no assigned nodes
        var assigned = nativeNode.assignedNodes();
        children = assigned.length ? _htiToArray(assigned) : _htiToArray(nativeNode.childNodes);
    } else if (_htiIsInstanceOf(nativeNode, HTMLIFrameElement) && nativeNode.contentDocument && nativeNode.contentDocument.body) {
        children = _htiToArray(nativeNode.contentDocument.body.childNodes);
    } else {
        children = _htiToArray((nativeNode.shadowRoot || nativeNode).childNodes);
    }
    if (!children.length || _htiIsInstanceOf(nativeNode, HTMLVideoElement)) return Promise.resolve(clonedNode);
    return children.reduce(function(def, child) {
        return def.then(function() { return _htiCloneNode(child, options); })
            .then(function(cl) { if (cl) clonedNode.appendChild(cl); });
    }, Promise.resolve()).then(function() { return clonedNode; });
}

function _htiEnsureSVGSymbols(clone, options) {
    var uses = clone.querySelectorAll ? clone.querySelectorAll('use') : [];
    if (!uses.length) return Promise.resolve(clone);
    var processed = {}, jobs = [];
    for (var i = 0; i < uses.length; i++) {
        var id = uses[i].getAttribute('xlink:href');
        if (id && !clone.querySelector(id) && document.querySelector(id) && !processed[id]) {
            processed[id] = true;
            jobs.push(_htiCloneNode(document.querySelector(id), options, true));
        }
    }
    if (!jobs.length) return Promise.resolve(clone);
    // Save and restore cloned nodes tracking (SVG symbols shouldn't reset it)
    var savedCloned = _htiClonedNodes;
    return Promise.all(jobs).then(function(nodes) {
        _htiClonedNodes = savedCloned;
        var ns = 'http://www.w3.org/2000/svg';
        var svg = document.createElementNS(ns, 'svg');
        svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;display:none';
        var defs = document.createElementNS(ns, 'defs');
        svg.appendChild(defs);
        nodes.forEach(function(n) { if (n) defs.appendChild(n); });
        clone.appendChild(svg);
        return clone;
    });
}

var _htiClonedNodes = null; // Track cloned nodes to prevent duplicates
function _htiCloneNode(node, options, isRoot) {
    if (isRoot) _htiClonedNodes = new WeakSet();
    if (!isRoot && options.filter && !options.filter(node)) return Promise.resolve(null);
    // Skip if already cloned (prevents duplicates from nested slots)
    if (_htiClonedNodes && _htiClonedNodes.has(node)) return Promise.resolve(null);
    if (_htiClonedNodes && node.nodeType === 1) _htiClonedNodes.add(node);
    return _htiCloneSingle(node, options)
        .then(function(cl) { return _htiCloneChildren(node, cl, options); })
        .then(function(cl) {
            if (_htiIsInstanceOf(cl, Element)) {
                _htiCloneCSS(node, cl);
                _htiClonePseudos(node, cl);
                if (_htiIsInstanceOf(node, HTMLTextAreaElement)) cl.innerHTML = node.value;
                if (_htiIsInstanceOf(node, HTMLInputElement)) cl.setAttribute('value', node.value);
                if (_htiIsInstanceOf(node, HTMLSelectElement)) {
                    var opt = _htiToArray(cl.children).find(function(c) { return node.value === c.getAttribute('value'); });
                    if (opt) opt.setAttribute('selected', '');
                }
            }
            return cl;
        })
        .then(function(cl) { return _htiEnsureSVGSymbols(cl, options); });
}

// -- Image embedding --

function _htiEmbedImages(clonedNode, options) {
    if (!_htiIsInstanceOf(clonedNode, Element)) return Promise.resolve();
    function tryProp(name) {
        var v = clonedNode.style && clonedNode.style.getPropertyValue(name);
        if (!v) return Promise.resolve(false);
        return _htiEmbedCSSUrls(v, null, options).then(function(css) {
            clonedNode.style.setProperty(name, css, clonedNode.style.getPropertyPriority(name));
            return true;
        });
    }
    // Try each group of CSS properties; stop at first match within each group
    function tryFirst(props) {
        return props.reduce(function(chain, p) {
            return chain.then(function(done) { return done || tryProp(p); });
        }, Promise.resolve(false));
    }
    return tryFirst(['background', 'background-image'])
        .then(function() { return tryFirst(['mask', '-webkit-mask', 'mask-image', '-webkit-mask-image']); })
        .then(function() {
            var isImg = _htiIsInstanceOf(clonedNode, HTMLImageElement);
            var isSvgImg = _htiIsInstanceOf(clonedNode, SVGImageElement);
            if ((isImg && !_htiIsDataUrl(clonedNode.src)) || (isSvgImg && !_htiIsDataUrl(clonedNode.href.baseVal))) {
                var url = isImg ? clonedNode.src : clonedNode.href.baseVal;
                return _htiResourceToDataURL(url, _htiMimeType(url), options).then(function(dataUrl) {
                    return new Promise(function(resolve) {
                        clonedNode.onload = resolve;
                        clonedNode.onerror = resolve;
                        if (clonedNode.loading === 'lazy') clonedNode.loading = 'eager';
                        if (isImg) { clonedNode.srcset = ''; clonedNode.src = dataUrl; }
                        else { clonedNode.href.baseVal = dataUrl; }
                    });
                }).catch(function() {});
            }
        })
        .then(function() {
            return Promise.all(_htiToArray(clonedNode.childNodes).map(function(child) {
                return _htiEmbedImages(child, options);
            }));
        });
}

// -- SVG serialization & entry point --

// Attributes that affect visual rendering and must be kept on the clone.
var _htiKeepAttrs = { 'style': 1, 'class': 1, 'id': 1, 'src': 1, 'srcset': 1,
    'href': 1, 'xlink:href': 1, 'width': 1, 'height': 1, 'viewBox': 1,
    'xmlns': 1, 'xmlns:xlink': 1, 'd': 1, 'fill': 1, 'stroke': 1,
    'stroke-width': 1, 'transform': 1, 'opacity': 1, 'cx': 1, 'cy': 1,
    'r': 1, 'rx': 1, 'ry': 1, 'x': 1, 'y': 1, 'x1': 1, 'y1': 1,
    'x2': 1, 'y2': 1, 'dx': 1, 'dy': 1, 'points': 1, 'clip-path': 1,
    'clip-rule': 1, 'fill-rule': 1, 'fill-opacity': 1, 'stroke-opacity': 1,
    'stroke-linecap': 1, 'stroke-linejoin': 1, 'stroke-dasharray': 1,
    'stroke-dashoffset': 1, 'font-size': 1, 'font-family': 1, 'font-weight': 1,
    'text-anchor': 1, 'dominant-baseline': 1, 'alignment-baseline': 1,
    'letter-spacing': 1, 'word-spacing': 1, 'text-decoration': 1,
    'color': 1, 'stop-color': 1, 'stop-opacity': 1, 'offset': 1,
    'gradientUnits': 1, 'gradientTransform': 1, 'patternUnits': 1,
    'patternTransform': 1, 'preserveAspectRatio': 1, 'markerWidth': 1,
    'markerHeight': 1, 'refX': 1, 'refY': 1, 'orient': 1,
    'colspan': 1, 'rowspan': 1, 'span': 1, 'type': 1, 'value': 1,
    'checked': 1, 'selected': 1, 'disabled': 1, 'multiple': 1,
    'readonly': 1, 'for': 1, 'name': 1, 'loading': 1, 'placeholder': 1,
    'open': 1 };

// Strip all non-visual attributes from the cloned tree before serialization.
// XMLSerializer can fail to escape quotes inside attribute values for
// HTML-namespace elements, producing broken XML. Attributes like onclick,
// onkeydown, title, data-*, aria-* never affect pixel output, so removing
// them is safe and avoids the issue entirely.
function _htiSanitizeAttrs(root) {
    var stack = [root];
    while (stack.length) {
        var el = stack.pop();
        if (el.nodeType === 1) {
            var attrs = el.attributes;
            for (var i = attrs.length - 1; i >= 0; i--) {
                if (!_htiKeepAttrs[attrs[i].name]) el.removeAttributeNode(attrs[i]);
            }
            for (var j = el.childNodes.length - 1; j >= 0; j--) stack.push(el.childNodes[j]);
        }
    }
}

function _htiNodeToDataURL(node, width, height) {
    _htiSanitizeAttrs(node);
    var xmlns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(xmlns, 'svg');
    var fo = document.createElementNS(xmlns, 'foreignObject');
    svg.setAttribute('width', '' + width);
    svg.setAttribute('height', '' + height);
    svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
    fo.setAttribute('width', '100%');
    fo.setAttribute('height', '100%');
    fo.setAttribute('x', '0');
    fo.setAttribute('y', '0');
    svg.appendChild(fo);
    fo.appendChild(node);
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(svg));
}

function _htiToSvg(node, options) {
    options = options || {};
    var width = options.width || node.clientWidth;
    var height = options.height || node.clientHeight;
    _htiPseudoStyles = []; // Clear accumulated pseudo styles
    return _htiCloneNode(node, options, true)
        .then(function(clone) {
            // Inject accumulated pseudo-element styles (::before, ::after, ::placeholder)
            if (_htiPseudoStyles.length) {
                var ps = document.createElement('style');
                ps.appendChild(document.createTextNode(_htiPseudoStyles.join('\n')));
                if (clone.firstChild) clone.insertBefore(ps, clone.firstChild);
                else clone.appendChild(ps);
            }
            // Hide scrollbars in screenshot
            var scrollbarHideCSS = '*::-webkit-scrollbar { display: none !important; } * { scrollbar-width: none !important; -ms-overflow-style: none !important; }';
            var scrollbarStyle = document.createElement('style');
            scrollbarStyle.appendChild(document.createTextNode(scrollbarHideCSS));
            if (clone.firstChild) clone.insertBefore(scrollbarStyle, clone.firstChild);
            else clone.appendChild(scrollbarStyle);

            var fontCSS = options.fontEmbedCSS != null ? options.fontEmbedCSS : null;
            var p = (fontCSS == null && !options.skipFonts)
                ? collectFontCSS(clone).catch(function() { return ''; })
                : Promise.resolve(fontCSS || '');
            return p.then(function(css) {
                if (css) {
                    var s = document.createElement('style');
                    s.appendChild(document.createTextNode(css));
                    if (clone.firstChild) clone.insertBefore(s, clone.firstChild);
                    else clone.appendChild(s);
                }
                return clone;
            });
        })
        .then(function(clone) { return _htiEmbedImages(clone, options).then(function() { return clone; }); })
        .then(function(clone) {
            if (options.backgroundColor) clone.style.backgroundColor = options.backgroundColor;
            if (options.width) clone.style.width = options.width + 'px';
            if (options.height) clone.style.height = options.height + 'px';
            return _htiNodeToDataURL(clone, width, height);
        });
}

function showScreenshotPreview(dataUrl, title, cssWidth, cssHeight) {
    var panel = document.getElementById('screenshot-preview-panel');
    var img = document.getElementById('screenshot-preview-img');
    var titleEl = document.getElementById('screenshot-preview-title');
    var mainArea = document.getElementById('main-area');
    img.src = dataUrl;
    if (cssWidth && cssHeight) {
        img.style.width = cssWidth + 'px';
        img.style.height = cssHeight + 'px';
    } else {
        img.style.width = '';
        img.style.height = '';
    }
    titleEl.textContent = title;
    // Hide main chat area and show screenshot panel in its place
    if (mainArea) mainArea.style.display = 'none';
    panel.classList.add('visible');
    document.addEventListener('keydown', screenshotEscHandler);
}

function closeScreenshotPreview() {
    var panel = document.getElementById('screenshot-preview-panel');
    var mainArea = document.getElementById('main-area');
    var img = document.getElementById('screenshot-preview-img');
    panel.classList.remove('visible');
    // Restore main chat area
    if (mainArea) mainArea.style.display = '';
    document.removeEventListener('keydown', screenshotEscHandler);
    // Clear image src to release memory from large data URL
    if (img) img.src = '';
    _screenshotDataUrl = null;
}

function screenshotEscHandler(e) {
    if (e.key === 'Escape') closeScreenshotPreview();
}

function downloadScreenshotPreview() {
    if (!_screenshotDataUrl) return;
    var link = document.createElement('a');
    link.href = _screenshotDataUrl;
    link.download = 'screenshot-' + Date.now() + '.png';
    link.click();
}
