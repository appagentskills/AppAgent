// Full real IIFE; capture Chrome/runtime and window/message listeners.
// DOM is detached/inert. Script tags are observed but never executed as MAIN-world code.
async function contentFixture(html,win,extraGlobals){
    var doc=new DOMParser().parseFromString(html||'<html><head></head><body></body></html>','text/html');
    var listeners=[],messages=[],effects=[],scripts=[];
    var w=win||{location:{href:'https://fixture.invalid',reload:function(){effects.push('reload');}},history:{back:function(){effects.push('back');},forward:function(){effects.push('forward');}},innerWidth:800,innerHeight:600};
    w.addEventListener=function(type,fn){if(type!=='message')throw new Error('unexpected event '+type);messages.push(fn);};
    w.HTMLInputElement=HTMLInputElement;w.HTMLTextAreaElement=HTMLTextAreaElement;
    var originalCreate=doc.createElement.bind(doc);doc.createElement=function(tag){var el=originalCreate(tag);if(tag==='script')scripts.push(el);return el;};
    var globals={window:w,document:doc,Event:Event,KeyboardEvent:KeyboardEvent,chrome:{runtime:{onMessage:{addListener:function(fn){listeners.push(fn);}}}},MouseEvent:function(type,opts){return new MouseEvent(type,Object.assign({},opts,{view:null}));}};
    if(extraGlobals)Object.assign(globals,extraGlobals);
    var m=await loadModules(['src/platform/extension/content-script.js'],{globals:globals});
    return {doc:doc,win:w,listeners:listeners,messages:messages,effects:effects,scripts:scripts,m:m,globals:globals,
        action:function(action,args){var replies=[];var keep=listeners[0]({type:'browser-action',action:action,args:args||{}},{},function(r){replies.push(r);});return {response:replies[0],replies:replies,keep:keep};},
        post:function(data,source){messages[0]({source:source===undefined?w:source,data:data});}};
}
describe('content script real dispatch',function(){
    test('installs once, ignores foreign message type, and reports unknown actions',async function(){
        var f=await contentFixture();assert.strictEqual(f.listeners.length,1);assert.strictEqual(f.messages.length,1);assert.strictEqual(f.scripts.length,0,'no inline <script>: interceptors are MAIN-world injected by background.js');assert.strictEqual(f.win.__appagentContentScriptInjected,true);
        await loadModules(['src/platform/extension/content-script.js'],{globals:f.globals});assert.strictEqual(f.listeners.length,1);assert.strictEqual(f.scripts.length,0,'no inline <script>: interceptors are MAIN-world injected by background.js');
        var responses=[];assert.strictEqual(f.listeners[0]({type:'unrelated'},{},function(r){responses.push(r);}),undefined);assert.deepStrictEqual(responses,[]);
        assert.deepStrictEqual(f.action('unknown').response,{error:'Unknown action: unknown'});assert.deepStrictEqual(f.m.__unstubbed,[]);
    });
    test('page info and navigation route to browser effects exactly once',async function(){var f=await contentFixture('<title>Fixture</title>');assert.deepStrictEqual(f.action('get_page_info').response,{success:true,url:'https://fixture.invalid',title:'Fixture',viewportWidth:800,viewportHeight:600});['go_back','go_forward','reload'].forEach(function(a){assert.strictEqual(f.action(a).response.success,true);});assert.deepStrictEqual(f.effects,['back','forward','reload']);});
    test('nested gsft_main supplies inner DOM and URL but keeps outer title',async function(){
        var f=await contentFixture('<title>Outer</title><iframe id="gsft_main"></iframe>'),inner=new DOMParser().parseFromString('<p>Inner</p>','text/html'),frame=f.doc.getElementById('gsft_main');
        Object.defineProperty(frame,'contentDocument',{value:inner});Object.defineProperty(frame,'contentWindow',{value:{location:{href:'https://fixture.invalid/inner'}}});
        assert.match(f.action('get_dom').response.html,/<p>Inner<\/p>/);assert.strictEqual(f.action('get_page_info').response.url,'https://fixture.invalid/inner');assert.strictEqual(f.action('get_page_info').response.title,'Outer');
    });
    test('cross-origin gsft_main access falls back instead of throwing',async function(){var f=await contentFixture('<p>Outer</p><iframe id="gsft_main"></iframe>'),frame=f.doc.getElementById('gsft_main');Object.defineProperty(frame,'contentDocument',{get:function(){throw new Error('cross-origin');}});Object.defineProperty(frame,'contentWindow',{get:function(){throw new Error('cross-origin');}});assert.match(f.action('get_dom').response.html,/<p>Outer<\/p>/);assert.strictEqual(f.action('get_page_info').response.url,'https://fixture.invalid');});
    test('get_dom validates selectors, returns indexed match count and truncates',async function(){
        var f=await contentFixture('<div class="item">One</div><div class="item">Two</div>');var r=f.action('get_dom',{selector:'.item',match_index:1,max_length:12}).response;assert.strictEqual(r.match_count,2);assert.strictEqual(r.html,'<div class="\n... [truncated]');
        var missing=f.action('get_dom',{selector:'.item',match_index:2}).response;assert.strictEqual(missing.success,false);assert.strictEqual(missing.match_count,2);assert.match(missing.error,/match_index=2/);assert.match(f.action('get_dom',{selector:'['}).response.error,/Invalid CSS selector/);
    });
    test('get_dom discovers matches inside open shadow roots',async function(){var f=await contentFixture('<div class="target">Light</div><section id="host"></section>'),host=f.doc.getElementById('host');host.attachShadow({mode:'open'}).innerHTML='<span class="target">Shadow</span>';var r=f.action('get_dom',{selector:'.target',match_index:1}).response;assert.strictEqual(r.match_count,2);assert.strictEqual(r.html,'<span class="target">Shadow</span>');});
    test('fill prefers open modal, bypasses value tracker and emits user-input chain',async function(){
        var f=await contentFixture('<input class="target" value="background"><dialog open><input class="target"></dialog>'),el=f.doc.querySelector('dialog input'),events=[],focused=0,scrolled=0;
        var trackedWrites=0,nativeValue=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value');Object.defineProperty(el,'value',{get:function(){return nativeValue.get.call(this);},set:function(){trackedWrites++;}});
        el.focus=function(){focused++;};el.scrollIntoView=function(){scrolled++;};['keydown','keypress','input','keyup','change'].forEach(function(type){el.addEventListener(type,function(e){events.push([e.type,e.bubbles,e.key||null]);});});
        var r=f.action('fill',{selector:'.target',value:'Hello!'});assert.strictEqual(r.keep,true);assert.strictEqual(r.response.success,true);assert.strictEqual(el.value,'Hello!');assert.strictEqual(trackedWrites,0);assert.strictEqual(f.doc.querySelector('input').value,'background');assert.strictEqual(focused,1);assert.strictEqual(scrolled,1);assert.deepStrictEqual(events.map(function(x){return x[0];}),['keydown','keypress','input','keyup','change']);assert.strictEqual(events[0][2],'!');assert.ok(events.every(function(x){return x[1];}));
    });
    test('select_option chooses by text and emits change only on a match',async function(){var f=await contentFixture('<select id="s"><option value="a">Alpha</option><option value="b">Beta</option></select>'),el=f.doc.getElementById('s'),events=0;el.addEventListener('change',function(){events++;});var r=f.action('select_option',{selector:'#s',text:'Beta'}).response;assert.deepStrictEqual([r.selectedValue,r.selectedText],['b','Beta']);assert.strictEqual(el.value,'b');var missing=f.action('select_option',{selector:'#s',value:'missing'}).response;assert.deepStrictEqual(missing.availableOptions,[{value:'a',text:'Alpha'},{value:'b',text:'Beta'}]);assert.strictEqual(events,1);});
    test('dispatch rejects missing/unknown event and missing target without effects',async function(){var f=await contentFixture('<button id="b">B</button>'),count=0;f.doc.getElementById('b').addEventListener('click',function(){count++;});assert.match(f.action('dispatch_event',{selector:'#b'}).response.error,/required/);assert.match(f.action('dispatch_event',{selector:'#b',event:'error'}).response.error,/not allowed/);assert.match(f.action('dispatch_event',{selector:'#missing',event:'click'}).response.error,/Element not found/);assert.strictEqual(count,0);});
    test('mouseenter emits non-bubbling mouse event followed by bubbling compatibility event',async function(){var f=await contentFixture('<button id="b">B</button>'),el=f.doc.getElementById('b'),events=[];el.getBoundingClientRect=function(){return {left:10,top:20,width:20,height:40};};['mouseenter','mouseover'].forEach(function(t){el.addEventListener(t,function(e){events.push(e);});});assert.strictEqual(f.action('dispatch_event',{selector:'#b',event:'mouseenter'}).response.success,true);assert.deepStrictEqual(events.map(function(e){return [e.type,e.bubbles];}),[['mouseenter',false],['mouseover',true]]);assert.ok(events[0] instanceof MouseEvent);assert.deepStrictEqual([events[0].clientX,events[0].clientY],[20,40]);});
    test('console collection rejects foreign windows, caps at 100 and drains',async function(){var f=await contentFixture();f.post({type:'appagent-console',level:'log',message:'foreign'},{});for(var i=0;i<105;i++)f.post({type:'appagent-console',level:'warn',message:String(i)});var logs=f.action('get_console_logs').response.logs;assert.strictEqual(logs.length,100);assert.strictEqual(logs[0].message,'5');assert.strictEqual(logs[99].level,'warn');assert.strictEqual(typeof logs[0].timestamp,'number');assert.deepStrictEqual(f.action('get_console_logs').response.logs,[]);});
    test('network collection keeps failure status and drains independently from console',async function(){var f=await contentFixture();f.post({type:'appagent-console',level:'error',message:'still here'});for(var i=0;i<101;i++)f.post({type:'appagent-network',method:'POST',url:'https://fixture.invalid/'+i,status:0,duration:i});var r=f.action('get_network_requests').response.requests;assert.strictEqual(r.length,100);assert.strictEqual(r[0].url,'https://fixture.invalid/1');assert.strictEqual(r[99].status,0);assert.strictEqual(r[99].duration,100);assert.deepStrictEqual(f.action('get_network_requests').response.requests,[]);assert.strictEqual(f.action('get_console_logs').response.logs.length,1);});
    test('viewport style is created, updated in place and removed',async function(){var f=await contentFixture();assert.strictEqual(f.action('viewport_emulate',{enable:true,width:400}).response.success,true);var el=f.doc.getElementById('__appagent_viewport_emulate');assert.match(el.textContent,/400px/);f.action('viewport_emulate',{enable:true,width:600});assert.strictEqual(f.doc.querySelectorAll('#__appagent_viewport_emulate').length,1);assert.match(el.textContent,/600px/);f.action('viewport_emulate',{enable:false});assert.strictEqual(f.doc.getElementById('__appagent_viewport_emulate'),null);});
    test('click on an SVG icon inside a button reaches the button (S0C4-01)', async function(){
        var f = await contentFixture('<button id="b"><svg><path id="p"></path></svg></button>'), clicks = [];
        f.doc.getElementById('b').addEventListener('click', function(e){ clicks.push(e.target.id); });
        var r = f.action('click', { selector:'#p' }).response;
        assert.strictEqual(r.success, true); assert.strictEqual(r.element.tag, 'path'); assert.deepStrictEqual(clicks, ['p']);
    });
    test('fill/type into contenteditable writes text; a non-editable target errors (S0C4-02)', async function(){
        var f = await contentFixture('<div id="ce" contenteditable="true">old</div><div id="d">static</div><button id="btn">B</button><ul><li id="li">L</li></ul>'), ce = f.doc.getElementById('ce'), d = f.doc.getElementById('d'), btn = f.doc.getElementById('btn'), li = f.doc.getElementById('li'), ev = 0, ceIn = 0;
        [d, btn, li].forEach(function(n){ ['input','keydown','keypress','keyup','change'].forEach(function(t){ n.addEventListener(t, function(){ ev++; }); }); });
        ce.addEventListener('input', function(){ ceIn++; });
        var r1 = f.action('fill', { selector:'#ce', value:'hello' }).response; assert.strictEqual(r1.success, true); assert.strictEqual(ce.textContent, 'hello'); assert.ok(ceIn >= 1, 'fill fires input on #ce');
        var n1 = ceIn;
        var r2 = f.action('type', { selector:'#ce', value:'hi', delay:0 }).response; assert.strictEqual(r2.success, true); assert.strictEqual(ce.textContent, 'hi'); assert.ok(ceIn > n1, 'type fires input on #ce');
        var r3 = f.action('fill', { selector:'#d', value:'x' }).response; assert.strictEqual(r3.success, false); assert.match(r3.error, /not editable/);
        var r4 = f.action('type', { selector:'#d', value:'x', delay:0 }).response; assert.strictEqual(r4.success, false);
        ['#btn','#li'].forEach(function(sel){ var rf = f.action('fill', { selector:sel, value:'hello' }).response, rt = f.action('type', { selector:sel, value:'hi', delay:0 }).response;
            assert.strictEqual(rf.success, false, sel + ' fill'); assert.match(rf.error, /not editable/); assert.strictEqual(rt.success, false, sel + ' type'); assert.match(rt.error, /not editable/); });
        assert.strictEqual(btn.hasAttribute('value'), false); assert.strictEqual(li.value, 0);
        assert.strictEqual(d.textContent, 'static'); assert.strictEqual(ev, 0);
    });
    test('iframe-tool twin editable predicate/setter mirror the content script (S0C4-02)', async function(){
        var m = await runFile('src/js/tools/010-iframe-tool.js'), isEd = m._ifIsEditableTarget, setV = m._ifSetEditableValue;
        assert.strictEqual(typeof isEd, 'function'); assert.strictEqual(typeof setV, 'function');
        var doc = new DOMParser().parseFromString('<div id="ce" contenteditable="true"><p id="kid">old</p></div><div id="d">static</div><input id="i"><textarea id="t"></textarea><select id="s"><option value="a">A</option><option value="b">B</option></select><div id="off" contenteditable="false">x</div>', 'text/html');
        function $(id){ return doc.getElementById(id); }
        assert.deepStrictEqual(['ce','kid','d','i','t','s','off'].map(function(id){ return isEd($(id)); }).concat([isEd(null), isEd(doc.createTextNode('x'))]), [true,true,false,true,true,true,false,false,false]);
        var doc2 = new DOMParser().parseFromString('<button id="btn">B</button><ul><li id="li">L</li></ul><select><option id="opt">o</option></select><output id="out"></output><progress id="pr"></progress><meter id="me"></meter><data id="da" value="1">d</data><now-input id="ni"></now-input>', 'text/html'), ni = doc2.getElementById('ni'); ni.value = '';
        assert.deepStrictEqual(['btn','li','opt','out','pr','me','da','ni'].map(function(id){ return isEd(doc2.getElementById(id)); }), [false,false,false,false,false,false,false,true], 'built-ins exposing value are not editable; custom value hosts are');
        var win = { HTMLInputElement: HTMLInputElement, HTMLTextAreaElement: HTMLTextAreaElement };
        setV($('ce'), 'hello', win); assert.strictEqual($('ce').textContent, 'hello');
        setV($('i'), 'v1', win); assert.strictEqual($('i').value, 'v1');
        setV($('t'), 'v2', win); assert.strictEqual($('t').value, 'v2');
        setV($('s'), 'b', win); assert.strictEqual($('s').value, 'b');
    });
    test('iframe-tool twin fill/type guard: built-ins error with no events, input and custom hosts still fill (S0C4-02)', async function(){
        var doc = new DOMParser().parseFromString('<button id="btn">B</button><ul><li id="li">L</li></ul><div id="d">static</div><input id="i"><now-input id="ni"></now-input>', 'text/html'), ev = 0;
        var win = { Event: Event, KeyboardEvent: KeyboardEvent, HTMLInputElement: HTMLInputElement, HTMLTextAreaElement: HTMLTextAreaElement, getComputedStyle: function(){ return { display: 'block', visibility: 'visible', opacity: '1' }; } };
        var m = await loadModules(['src/js/tools/010-iframe-tool.js'], { globals: { window: win, DOMParser: DOMParser, dashboardWidgets: {}, currentChatId: 'c', getWidgetById: function(){ return { id: 'w' }; }, getWidgetIframe: function(){ return { contentDocument: doc, contentWindow: win }; } } });
        function run(a){ return m._executeIframeToolImpl(Object.assign({ widget_id: 'w' }, a)); }
        ['btn','li','d'].forEach(function(id){ ['keydown','keypress','input','keyup','change'].forEach(function(t){ doc.getElementById(id).addEventListener(t, function(){ ev++; }); }); });
        var sels = ['#btn','#li','#d'];
        for (var k = 0; k < sels.length; k++) {
            var rf = await run({ action: 'fill', selector: sels[k], value: 'hello' }), rt = await run({ action: 'type', selector: sels[k], value: 'hi', delay: 0 });
            assert.strictEqual(rf.success, false, sels[k] + ' fill: ' + JSON.stringify(rf)); assert.match(rf.error, /not editable/); assert.strictEqual(rt.success, false, sels[k] + ' type'); assert.match(rt.error, /not editable/);
        }
        assert.strictEqual(ev, 0); assert.strictEqual(doc.getElementById('btn').hasAttribute('value'), false); assert.strictEqual(doc.getElementById('li').value, 0); assert.strictEqual(doc.getElementById('d').textContent, 'static');
        var ok1 = await run({ action: 'fill', selector: '#i', value: 'hello' }); assert.strictEqual(ok1.success, true, JSON.stringify(ok1)); assert.strictEqual(doc.getElementById('i').value, 'hello');
        var ni = doc.getElementById('ni'); ni.value = '';
        var ok2 = await run({ action: 'fill', selector: '#ni', value: 'x' }); assert.strictEqual(ok2.success, true, JSON.stringify(ok2)); assert.strictEqual(ni.value, 'x');
    }, { tags: ['unit'] });
    test('wait_for re-resolves gsft_main per poll; url_matches sees the frame URL (S0C4-04)', async function(){
        var f = await contentFixture('<iframe id="gsft_main"></iframe>'), frame = f.doc.getElementById('gsft_main');
        var docA = new DOMParser().parseFromString('<p>Loading</p>', 'text/html'), docB = new DOMParser().parseFromString('<p>Ready now</p>', 'text/html'), cur = docA;
        Object.defineProperty(frame, 'contentDocument', { get: function(){ return cur; } });
        Object.defineProperty(frame, 'contentWindow', { value: { location: { href: 'https://fixture.invalid/incident.do?sys_id=abc123' } } });
        var r = f.action('wait_for', { text: 'Ready now', timeout: 2000, poll: 10 });
        assert.strictEqual(r.replies.length, 0, 'first poll must not match docA');
        cur = docB;   // in-frame navigation replaced the document
        for (var i = 0; i < 150 && !r.replies.length; i++) await sleep(20);
        assert.strictEqual(r.replies[0] && r.replies[0].success, true, JSON.stringify(r.replies[0]));
        var u = f.action('wait_for', { url_matches: 'sys_id=abc123', timeout: 0 }).response;
        assert.strictEqual(u && u.success, true, JSON.stringify(u));
    }, { timeout: 10000 });
    test('invalid selector / bad args return an immediate error (S0C4-08)', async function(){
        function noThrow(fn, label){ try { return fn(); } catch(e) { throw new Error(label + ' threw out of the listener: ' + e.message); } }
        var win = { location: { href: 'https://fixture.invalid' }, history: {}, innerWidth: 800, innerHeight: 600,
            getComputedStyle: function(){ return { display: 'block', visibility: 'visible', opacity: '1', getPropertyValue: function(p){ return p === 'color' ? 'rgb(1, 2, 3)' : ''; } }; } };
        var f = await contentFixture('<div id="p" class="c">x</div><select id="s"><option>a</option></select>', win);
        ['click', 'fill', 'type', 'dispatch_event', 'select_option'].forEach(function(action){
            var r = noThrow(function(){ return f.action(action, { selector: 'a[href=', event: 'click', value: 'a', text: 'a' }); }, action);   // ('a[href' is valid in Chromium: EOF closes the bracket)
            assert.strictEqual(r.replies.length, 1, action + ' must answer synchronously');
            assert.ok(/^Invalid selector: a\[href= \(/.test(r.response && r.response.error), action + ': ' + JSON.stringify(r.response));
        });
        var t0 = Date.now(), w = f.action('wait_for', { selector_visible: 'div[', timeout: 5000 });
        for (var i = 0; i < 5 && !w.replies.length; i++) await sleep(10);
        assert.ok(w.replies.length === 1 && Date.now() - t0 < 50, 'wait_for must answer within 50 ms, not poll to the timeout: ' + JSON.stringify(w.replies));
        assert.ok(w.replies[0].success === false && /Invalid selector: div\[/.test(w.replies[0].error), JSON.stringify(w.replies[0]));
        var g = f.action('wait_for', { selector_gone: 'p:nth-child(', timeout: 5000 });
        assert.ok(g.replies.length === 1 && /Invalid selector/.test(g.replies[0].error), JSON.stringify(g.replies));
        var p = noThrow(function(){ return f.action('get_properties', { selector: '#p', properties: 'color' }); }, 'get_properties string');
        assert.strictEqual(p.response && p.response.success, true, JSON.stringify(p.response));
        assert.deepStrictEqual(p.response.properties.computedStyle, { color: 'rgb(1, 2, 3)' });
        var bad = noThrow(function(){ return f.action('get_properties', { selector: '#p', properties: { color: 1 } }); }, 'get_properties object');
        assert.ok(bad.response && bad.response.success === false && /properties must be/.test(bad.response.error), JSON.stringify(bad.response));
        var s = noThrow(function(){ return f.action('set_style', { selector: '#p', className: {} }); }, 'set_style');
        assert.ok(s.response && s.response.success === false && /className must be a string/.test(s.response.error), JSON.stringify(s.response));
        assert.strictEqual(f.doc.getElementById('p').className, 'c', 'a rejected className leaves the element untouched');
        // Safety net: any other synchronous throw in a handler becomes an error reply, not a dropped message.
        var replies = [];
        noThrow(function(){ return f.listeners[0]({ type: 'browser-action', action: 'click', args: null }, {}, function(r){ replies.push(r); }); }, 'click with null args');
        assert.ok(replies.length === 1 && replies[0].success === false && /^click failed: /.test(replies[0].error), JSON.stringify(replies));
    }, { tags: ['unit'] });
    test('get_properties include attributes returns attributes (S0C4-09)', async function(){
        var win = { location: { href: 'https://fixture.invalid' }, history: {}, innerWidth: 800, innerHeight: 600,
            getComputedStyle: function(){ return { display: 'block', visibility: 'visible', opacity: '1', getPropertyValue: function(){ return ''; } }; } };
        var long = new Array(601).join('z');
        var f = await contentFixture('<a id="l" href="/x" data-k="v">x</a><input id="pw" type="password" value="hunter2"><div id="big" title="' + long + '"></div>', win);
        var want = { id: 'l', href: '/x', 'data-k': 'v' };
        var def = f.action('get_properties', { selector: '#l' }).response;
        assert.deepStrictEqual(def && def.properties && def.properties.attributes, want, 'default include: ' + JSON.stringify(def));
        var only = f.action('get_properties', { selector: '#l', include: ['attributes'] }).response;
        assert.deepStrictEqual(only.properties.attributes, want);
        assert.strictEqual(only.properties.styles, undefined, 'styles were not requested');
        assert.ok(only.properties.rect && 'value' in only.properties, 'rect and value stay present');
        var styles = f.action('get_properties', { selector: '#l', include: ['styles'] }).response;
        assert.ok(styles.properties.styles && !('attributes' in styles.properties), JSON.stringify(styles.properties));
        var pw = f.action('get_properties', { selector: '#pw' }).response;
        assert.strictEqual(pw.properties.attributes.value, '[redacted]');
        assert.strictEqual(JSON.stringify(pw).indexOf('hunter2'), -1, 'a secret value never leaves the page');
        assert.strictEqual(f.action('get_properties', { selector: '#big' }).response.properties.attributes.title.length, 500, 'values are capped at 500 chars');
    }, { tags: ['unit'] });
});
describe('content script secret redaction (S0C4-03)',function(){
    function secretWin(){return {location:{href:'https://fixture.invalid'},history:{},innerWidth:800,innerHeight:600,getComputedStyle:function(){return {display:'block',visibility:'visible',opacity:'1',getPropertyValue:function(){return '';}};}};}
    test('password values never leave the page (S0C4-03)', async function(){
        var win = secretWin();
        var f = await contentFixture('<input type="password" id="p" value="Hunter2!"><input type="password" id="e" placeholder="Your password">', win, { CSS: CSS });
        f.doc.getElementById('p').getBoundingClientRect = function(){ return { x:0, y:0, left:0, top:0, right:10, bottom:10, width:10, height:10 }; };
        var simple = f.action('get_visible_text', {}).response, deep = f.action('get_visible_text', { deep:true }).response, props = f.action('get_properties', { selector:'#p' }).response;
        assert.strictEqual(simple.success, true, JSON.stringify(simple).slice(0, 300)); assert.match(simple.text, /\[password\]/); assert.match(simple.text, /Your password/);
        assert.strictEqual(deep.success, true, JSON.stringify(deep).slice(0, 300)); assert.ok(deep.visibleElements.some(function(e){ return e.id === 'p' && e.text === '[redacted password]'; }), JSON.stringify(deep).slice(0, 300));
        assert.strictEqual(props.success, true, JSON.stringify(props).slice(0, 300)); assert.strictEqual(props.properties.value, '[redacted]'); assert.strictEqual(props.properties.hasValue, true);
        [simple, deep, props].forEach(function(r){ var s = JSON.stringify(r); assert.ok(s.indexOf('Hunter2!') === -1, 'secret leaked: ' + s.slice(0, 200)); });
    }, { tags: ['unit'] });
    test('autocomplete secrets are redacted but plain inputs are untouched (S0C4-03)', async function(){
        var f=await contentFixture('<input type="text" id="o" autocomplete="one-time-code" value="424242"><input type="text" id="t" value="visible-text">',secretWin(),{CSS:CSS});
        var otp=f.action('get_properties',{selector:'#o'}).response,plain=f.action('get_properties',{selector:'#t'}).response,text=f.action('get_visible_text',{}).response.text;
        assert.strictEqual(otp.success,true);assert.strictEqual(otp.properties.value,'[redacted]');assert.strictEqual(otp.properties.hasValue,true);assert.ok(JSON.stringify(otp).indexOf('424242')===-1);
        assert.strictEqual(plain.success,true);assert.strictEqual(plain.properties.value,'visible-text');assert.strictEqual('hasValue' in plain.properties,false);
        assert.match(text,/visible-text/);assert.ok(text.indexOf('424242')===-1,'otp leaked: '+text);
    }, { tags: ['unit'] });
    test('get_dom redacts secret value attributes in selector and whole-document modes (S0C4-03)', async function(){
        var form='<form id="f"><input name="u" value="bob"><input type="password" id="p" value="Hunter2!"><input autocomplete="ONE-TIME-CODE" id="o" value="424242"></form>';
        var f=await contentFixture(form,secretWin(),{CSS:CSS,DOMParser:DOMParser});
        var sel=f.action('get_dom',{selector:'#p'}).response,sub=f.action('get_dom',{selector:'#f'}).response,whole=f.action('get_dom',{}).response;
        var red='<form id="f"><input name="u" value="bob"><input type="password" id="p" value="[redacted]"><input autocomplete="ONE-TIME-CODE" id="o" value="[redacted]"></form>';
        assert.strictEqual(sel.success,true,JSON.stringify(sel).slice(0,300));assert.strictEqual(sel.html,'<input type="password" id="p" value="[redacted]">');
        assert.strictEqual(sub.html,red);assert.strictEqual(whole.success,true);assert.strictEqual(whole.html,'<html><head></head><body>'+red+'</body></html>');
        [sel,sub,whole].forEach(function(r){var s=JSON.stringify(r);assert.ok(s.indexOf('Hunter2!')===-1&&s.indexOf('424242')===-1,'secret leaked: '+s.slice(0,200));});
        assert.strictEqual(f.doc.getElementById('p').getAttribute('value'),'Hunter2!','live page must not be mutated');
        // No secret value attribute: no inert copy is made (a DOMParser use would throw) and output is byte-identical.
        var plain=await contentFixture('<div id="d"><input id="t" value="visible"><input type="password" id="e" value=""></div>',secretWin(),{CSS:CSS,DOMParser:function(){throw new Error('inert copy without a secret');}});
        assert.strictEqual(plain.action('get_dom',{selector:'#d'}).response.html,plain.doc.getElementById('d').outerHTML);
        assert.strictEqual(plain.action('get_dom',{}).response.html,plain.doc.documentElement.outerHTML);
    }, { tags: ['unit'] });
    test('iframe-tool twin predicate mirrors the content-script secret rules (S0C4-03)', async function(){
        var m=await runFile('src/js/tools/010-iframe-tool.js'),f=m._ifIsSecretInput;assert.strictEqual(typeof f,'function');
        function el(tag,type,ac){return {tagName:tag,type:type,getAttribute:function(n){return n==='autocomplete'?(ac||null):null;}};}
        assert.deepStrictEqual([f(el('INPUT','password')),f(el('INPUT','PASSWORD')),f(el('INPUT','text','one-time-code')),f(el('INPUT','text','One-Time-Code')),f(el('INPUT','text','username current-password')),f(el('INPUT','text','new-password')),f(el('INPUT','text','username')),f(el('INPUT','text')),f(el('TEXTAREA','password')),f(null)],[true,true,true,true,true,true,false,false,false,false]);
    }, { tags: ['unit'] });
    test('viewport emulation off also removes the gsft_main copy (S0C4-05)', async function(){
        var f=await contentFixture('<iframe id="gsft_main"></iframe>'),inner=new DOMParser().parseFromString('<p>x</p>','text/html'),frame=f.doc.getElementById('gsft_main'),id='__appagent_viewport_emulate';
        Object.defineProperty(frame,'contentDocument',{value:inner});
        assert.strictEqual(f.action('viewport_emulate',{enable:true,width:375}).response.success,true);
        assert.ok(f.doc.getElementById(id),'outer style applied');assert.ok(inner.getElementById(id),'gsft_main style applied');
        var off=f.action('viewport_emulate',{enable:false}).response;assert.strictEqual(off.success,true);
        assert.strictEqual(f.doc.getElementById(id),null,'outer style removed');assert.strictEqual(inner.getElementById(id),null,'gsft_main style removed too');
    }, { tags: ['unit'] });
    test('keydown/keyup dispatch creates no inline script (S0C4-07)', async function(){
        var f=await contentFixture('<button id="b">B</button>'),seen=[];
        ['keydown','keyup'].forEach(function(ev){f.doc.addEventListener(ev,function(e){seen.push(e.type+':'+e.key+':'+e.keyCode);});});
        ['keydown','keyup'].forEach(function(ev){var r=f.action('dispatch_event',{selector:'#b',event:ev,key:'Enter'}).response;assert.strictEqual(r.success,true);assert.strictEqual(r.event,ev);});
        assert.strictEqual(f.scripts.length,0,'no inline <script> for the key re-dispatch');
        assert.deepStrictEqual(seen,['keydown:Enter:13','keydown:Enter:13','keyup:Enter:13','keyup:Enter:13'],'bubbled + document re-dispatch are kept');
    }, { tags: ['unit'] });
});
// TB-1 / TB-3 (RG B4): the iframe-tool twin gets the S0C4-01 SVG click fallback, and every fill/type 'input' event is a
// composed InputEvent (insertText + data; an empty write is deleteContentBackward/null), falling back to a plain Event
// in a realm without InputEvent. Real content-script IIFE and real 010-iframe-tool.js over DOMParser fixtures.
describe('TB-1/TB-3 click fallback and InputEvent fields (content script + iframe-tool twin)', function(){
    function inputLog(el){ var log = []; el.addEventListener('input', function(e){ log.push({ isIE: e instanceof InputEvent, inputType: e.inputType, data: e.data, composed: e.composed, bubbles: e.bubbles }); }); return log; }
    function ie(inputType, data){ return { isIE: true, inputType: inputType, data: data, composed: true, bubbles: true }; }
    test('content script fill/type dispatch InputEvent insertText; the type clear is deleteContentBackward (TB-3)', async function(){
        var f = await contentFixture('<input id="i">', null, { InputEvent: InputEvent }), el = f.doc.getElementById('i'), log = inputLog(el);
        assert.strictEqual(f.action('fill', { selector: '#i', value: 'hello' }).response.success, true);
        assert.deepStrictEqual(log, [ie('insertText', 'hello')]); assert.strictEqual(el.value, 'hello');
        log.length = 0;
        assert.strictEqual(f.action('type', { selector: '#i', value: 'hi', delay: 0 }).response.success, true);
        assert.deepStrictEqual(log, [ie('deleteContentBackward', null), ie('insertText', 'h'), ie('insertText', 'i')]); assert.strictEqual(el.value, 'hi');
        assert.deepStrictEqual(f.m.__unstubbed, []);
    }, { tags: ['unit'] });
    test('content script without InputEvent falls back to a plain bubbling Event (TB-3)', async function(){
        var f = await contentFixture('<input id="i">', null, { InputEvent: undefined }), el = f.doc.getElementById('i'), seen = [];
        el.addEventListener('input', function(e){ seen.push([e.constructor === Event, e.bubbles, e.inputType]); });
        assert.strictEqual(f.action('fill', { selector: '#i', value: 'x' }).response.success, true);
        assert.strictEqual(f.action('type', { selector: '#i', value: 'y', delay: 0 }).response.success, true);
        assert.deepStrictEqual(seen, [[true, true, undefined], [true, true, undefined], [true, true, undefined]]);
        assert.strictEqual(el.value, 'y'); assert.deepStrictEqual(f.m.__unstubbed, []);
    }, { tags: ['unit'] });
    test('iframe-tool twin: an SVG click reaches the button; fill/type InputEvent fields, plain Event fallback (TB-1, TB-3)', async function(){
        var doc = new DOMParser().parseFromString('<button id="b"><svg><path id="p"></path></svg></button><input id="i">', 'text/html'), clicks = [];
        var win = { Event: Event, KeyboardEvent: KeyboardEvent, MouseEvent: MouseEvent, InputEvent: InputEvent, HTMLInputElement: HTMLInputElement, HTMLTextAreaElement: HTMLTextAreaElement, getComputedStyle: function(){ return { display: 'block', visibility: 'visible', opacity: '1' }; } };
        var m = await loadModules(['src/js/tools/010-iframe-tool.js'], { globals: { window: win, DOMParser: DOMParser, dashboardWidgets: {}, currentChatId: 'c', getWidgetById: function(){ return { id: 'w' }; }, getWidgetIframe: function(){ return { contentDocument: doc, contentWindow: win }; } } });
        function run(a){ return m._executeIframeToolImpl(Object.assign({ widget_id: 'w' }, a)); }
        doc.getElementById('b').addEventListener('click', function(e){ clicks.push([e.target.id, e.bubbles, e instanceof MouseEvent]); });
        var rc = await run({ action: 'click', selector: '#p' });
        assert.strictEqual(rc.success, true, JSON.stringify(rc)); assert.deepStrictEqual(clicks, [['p', true, true]]);
        var el = doc.getElementById('i'), log = inputLog(el);
        assert.strictEqual((await run({ action: 'fill', selector: '#i', value: 'hello' })).success, true);
        assert.strictEqual((await run({ action: 'type', selector: '#i', value: 'hi', delay: 0 })).success, true);
        assert.deepStrictEqual(log, [ie('insertText', 'hello'), ie('deleteContentBackward', null), ie('insertText', 'h'), ie('insertText', 'i')]); assert.strictEqual(el.value, 'hi');
        delete win.InputEvent; log.length = 0;
        assert.strictEqual((await run({ action: 'fill', selector: '#i', value: 'z' })).success, true);
        assert.deepStrictEqual(log.map(function(e){ return [e.isIE, e.inputType, e.bubbles]; }), [[false, undefined, true]]); assert.strictEqual(el.value, 'z');
    }, { tags: ['unit'] });
});

describe('TB-2 XHTML secret inputs + TA3-6 textarea/svg-nested secrets (content script get_dom / get_properties)', function() {
    function secretWin() { return { location: { href: 'https://fixture.invalid' }, history: {}, innerWidth: 800, innerHeight: 600, getComputedStyle: function() { return { display: 'block', visibility: 'visible', opacity: '1', getPropertyValue: function() { return ''; } }; } }; }
    // Each form the HTML serializer can emit secret s in: raw, attribute-escaped, text-escaped.
    function secretForms(doc, s) { var p = doc.createElement('p'); p.setAttribute('title', s); var attr = /title="([^"]*)"/.exec(p.outerHTML)[1]; p.textContent = s; return [s, attr, p.innerHTML]; }
    test('TB-2: an XHTML page password (tagName "input") is redacted by get_dom (selector + whole) and get_properties', async function() {
        var xdoc = new DOMParser().parseFromString('<html xmlns="http://www.w3.org/1999/xhtml"><head></head><body><form id="f"><input name="u" value="bob"/><input type="password" id="p" value="Hunter2!"/></form></body></html>', 'application/xhtml+xml');
        assert.strictEqual(xdoc.getElementById('p').tagName, 'input', 'fixture: an XHTML input reports tagName "input"');
        var f = await contentFixture(null, secretWin(), { CSS: CSS, DOMParser: DOMParser, document: xdoc });
        var sub = f.action('get_dom', { selector: '#f' }).response, whole = f.action('get_dom', {}).response, props = f.action('get_properties', { selector: '#p' }).response;
        [sub, whole, props].forEach(function(r) { var s = JSON.stringify(r); assert.strictEqual(r.success, true, s.slice(0, 300)); assert.ok(s.indexOf('Hunter2!') === -1, 'secret leaked: ' + s.slice(0, 300)); });
        [sub, whole].forEach(function(r) { assert.ok(r.html.indexOf('value="[redacted]"') !== -1 && r.html.indexOf('value="bob"') !== -1, r.html.slice(0, 300)); });
        assert.ok(whole.html.indexOf('<html') === 0 && whole.html.indexOf('<body>') !== -1, 'whole-document get_dom keeps html/body: ' + whole.html.slice(0, 200));
        assert.strictEqual(props.properties.value, '[redacted]'); assert.strictEqual(props.properties.hasValue, true);
        assert.strictEqual(xdoc.getElementById('p').getAttribute('value'), 'Hunter2!', 'live page must not be mutated');
    }, { tags: ['unit'] });
    test('TA3-6: a secret input nested under <textarea> / <svg> never reaches get_dom output, raw or escaped', async function() {
        var f = await contentFixture('<div id="d"><textarea id="ta"></textarea><svg id="sv"></svg><input type="password" id="p" value="Plain#1"></div>', secretWin(), { CSS: CSS, DOMParser: DOMParser });
        var S1 = 'P&ss"<w>rd', S2 = 'Hunter2!';
        [['ta', S1], ['sv', S2]].forEach(function(x) { var i = f.doc.createElement('input'); i.setAttribute('type', 'password'); i.setAttribute('value', x[1]); f.doc.getElementById(x[0]).appendChild(i); });
        var live = f.doc.getElementById('d').outerHTML;
        var sub = f.action('get_dom', { selector: '#d' }).response, whole = f.action('get_dom', {}).response;
        var forms = secretForms(f.doc, S1).concat(secretForms(f.doc, S2), ['Plain#1']);
        [sub, whole].forEach(function(r) {
            assert.strictEqual(r.success, true, JSON.stringify(r).slice(0, 300));
            forms.forEach(function(v) { assert.ok(r.html.indexOf(v) === -1, 'secret form ' + v + ' leaked: ' + r.html.slice(0, 400)); });
            assert.ok(r.html.indexOf('<input type="password" id="p" value="[redacted]">') !== -1, r.html.slice(0, 400));
        });
        assert.strictEqual(f.doc.getElementById('d').outerHTML, live, 'live page must not be mutated');
    }, { tags: ['unit'] });
});
