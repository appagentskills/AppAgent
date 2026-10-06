'use strict';
// Real shared layout markup/state functions and browser computed CSS, not string pins.
var layoutCss = await loadFile('src/css/19b-widget-library.css');
var tokenCss = await loadFile('src/css/00-tokens.css');
var darkCss = await loadFile('src/css/01-dark-theme.css');
function escapeLayout(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;'); }
describe('Gallery / Rows selected appearance', function() {
    ['light','dark'].forEach(function(theme) {
        ['rows','gallery'].forEach(function(selection) {
            test(theme + ': ' + selection + ' selection agrees with aria and leaves other toggles unchanged', async function() {
                var oldTheme=document.documentElement.getAttribute('data-theme');
                var style=document.createElement('style'), root=document.createElement('div');
                style.textContent=tokenCss+'\n'+darkCss+'\n'+layoutCss+'\n* { transition: none !important; }';
                document.head.appendChild(style); document.body.appendChild(root);
                document.documentElement.setAttribute('data-theme',theme);
                try {
                    var m=await loadModules(['src/js/ui/045-page-layout.js'],{globals:{document:document,escapeHtml:escapeLayout,UI_ICONS:{list:'list'}}});
                    root.innerHTML=m.pageLayoutToggleHtml('setLayout')+'<div class="segmented-toggle dashboard-mode-toggle"><button class="active">Dashboard</button><button>Library</button></div>';
                    m.pageLayoutSyncButtons(root,selection);
                    var group=root.querySelector('.widget-library-layout'), active=group.querySelector('.active'), inactive=group.querySelector('button:not(.active)');
                    assert.strictEqual(active.dataset.layout,selection);
                    assert.strictEqual(active.getAttribute('aria-pressed'),'true');assert.strictEqual(inactive.getAttribute('aria-pressed'),'false');
                    var probe=document.createElement('div');root.appendChild(probe);
                    function tokenColor(token){probe.style.backgroundColor='var('+token+')';return getComputedStyle(probe).backgroundColor;}
                    var a=getComputedStyle(active),b=getComputedStyle(inactive),g=getComputedStyle(group);
                    assert.strictEqual(a.backgroundColor,tokenColor('--primary-lighter'));
                    probe.style.color='var(--primary)';assert.strictEqual(a.color,getComputedStyle(probe).color);
                    assert.strictEqual(g.backgroundColor,tokenColor('--bg-white'));
                    assert.strictEqual(b.backgroundColor,'rgba(0, 0, 0, 0)','inactive is neutral, showing wrapper');
                    assert.ok(a.boxShadow.indexOf('inset')>=0,'selected outline inset retained');
                    assert.strictEqual(a.fontWeight,'600');
                    var other=getComputedStyle(root.querySelector('.dashboard-mode-toggle .active'));
                    assert.strictEqual(other.backgroundColor,tokenColor('--bg-white'));assert.strictEqual(other.boxShadow,'none');
                    assert.strictEqual(other.fontWeight,'500');
                    // The hidden test sandbox cannot acquire real keyboard focus.
                    active.focus();
                    assert.strictEqual(getComputedStyle(active).backgroundColor,tokenColor('--primary-lighter'),'attempted focus does not alter selection styles');
                    m.pageLayoutSyncButtons(root,selection==='rows'?'gallery':'rows');
                    assert.strictEqual(active.getAttribute('aria-pressed'),'false');assert.strictEqual(inactive.getAttribute('aria-pressed'),'true');
                    assert.strictEqual(getComputedStyle(inactive).backgroundColor,tokenColor('--primary-lighter'));
                } finally {
                    root.remove();style.remove();
                    if(oldTheme==null)document.documentElement.removeAttribute('data-theme');else document.documentElement.setAttribute('data-theme',oldTheme);
                }
            },{tags:['unit']});
        });
    });
});
