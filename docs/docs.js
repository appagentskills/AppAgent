// github.io documentation page driver.
// Fetches README.md (project overview) followed by documentation.md, parses
// both with parseDocsMarkdown (from docs-renderer.js, shared with the
// extension bundle), and renders the combined content + right-side outline.
// In-app "[label](app:funcName)" links are rendered as plain text since there
// is no extension runtime here.

(function() {
    var README_URL = 'README.md';
    var DOC_URL = 'documentation.md';

    function fetchAndRender() {
        Promise.all([
            fetch(README_URL, { cache: 'no-cache' }).then(function(r) {
                // README is optional — if it's missing on Pages, fall through to docs.
                return r.ok ? r.text() : '';
            }).catch(function() { return ''; }),
            fetch(DOC_URL, { cache: 'no-cache' }).then(function(r) {
                if (!r.ok) throw new Error('HTTP ' + r.status + ' fetching ' + DOC_URL);
                return r.text();
            }),
        ])
            .then(function(parts) { render(mergeReadmeIntoDocs(parts[0], parts[1])); })
            .catch(function(err) {
                var main = document.getElementById('docs-main');
                if (main) main.innerHTML = '<div class="docs-error">Failed to load documentation: ' + escapeHtml(err.message) + '</div>';
            });
    }

    function escapeHtml(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function render(md) {
        var parsed = parseDocsMarkdown(md);
        var main = document.getElementById('docs-main');
        var outlineHost = document.getElementById('docs-outline-container');
        main.innerHTML = parsed.html;
        outlineHost.outerHTML = buildDocsOutlineHtml(parsed.toc, '');

        wireOutlineDrawer();

        // Wire up nav anchors (both in TOC and inside content). On mobile,
        // clicking a TOC entry also closes the drawer.
        document.querySelectorAll('[data-docs-anchor]').forEach(function(el) {
            el.addEventListener('click', function(e) {
                e.preventDefault();
                var id = el.getAttribute('data-docs-anchor');
                var target = document.getElementById(id);
                if (target) {
                    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    history.replaceState(null, '', '#' + id);
                }
                closeOutline();
            });
        });

        // app:funcName links don't work outside the extension — make them inert
        // and add a tooltip explaining why.
        document.querySelectorAll('[data-app-action]').forEach(function(el) {
            el.classList.add('docs-link-disabled');
            el.setAttribute('title', 'Available inside the AppAgent extension');
            el.addEventListener('click', function(e) { e.preventDefault(); });
        });

        // Initial scroll if a hash is present.
        if (location.hash) {
            var t = document.getElementById(location.hash.slice(1));
            if (t) t.scrollIntoView({ block: 'start' });
        }

        // Highlight TOC entry on scroll.
        wireScrollSpy();
    }

    function wireOutlineDrawer() {
        var toggle = document.getElementById('outline-toggle');
        var backdrop = document.getElementById('outline-backdrop');
        var outline = document.getElementById('docs-outline');
        if (!toggle || !backdrop || !outline) return;

        toggle.addEventListener('click', function() {
            outline.classList.contains('open') ? closeOutline() : openOutline();
        });
        backdrop.addEventListener('click', closeOutline);
        document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape') closeOutline();
        });
    }

    function openOutline() {
        var toggle = document.getElementById('outline-toggle');
        var backdrop = document.getElementById('outline-backdrop');
        var outline = document.getElementById('docs-outline');
        if (!outline) return;
        outline.classList.add('open');
        if (backdrop) { backdrop.hidden = false; backdrop.classList.add('visible'); }
        if (toggle) toggle.setAttribute('aria-expanded', 'true');
    }

    function closeOutline() {
        var toggle = document.getElementById('outline-toggle');
        var backdrop = document.getElementById('outline-backdrop');
        var outline = document.getElementById('docs-outline');
        if (outline) outline.classList.remove('open');
        if (backdrop) {
            backdrop.classList.remove('visible');
            // Hide after the transition so it doesn't intercept clicks.
            setTimeout(function() { if (!backdrop.classList.contains('visible')) backdrop.hidden = true; }, 220);
        }
        if (toggle) toggle.setAttribute('aria-expanded', 'false');
    }

    function wireScrollSpy() {
        var sections = Array.prototype.slice.call(document.querySelectorAll('section.docs-section[id]'));
        var navItems = {};
        document.querySelectorAll('[data-docs-anchor]').forEach(function(el) {
            navItems[el.getAttribute('data-docs-anchor')] = el;
        });
        if (!sections.length) return;

        function update() {
            var scrollY = window.scrollY + 120;
            var active = sections[0];
            for (var i = 0; i < sections.length; i++) {
                if (sections[i].offsetTop <= scrollY) active = sections[i];
                else break;
            }
            Object.keys(navItems).forEach(function(id) {
                navItems[id].classList.toggle('active', id === active.id);
            });
        }
        window.addEventListener('scroll', update, { passive: true });
        update();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', fetchAndRender);
    } else {
        fetchAndRender();
    }
})();
