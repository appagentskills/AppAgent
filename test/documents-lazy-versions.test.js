// D (lazy smart-document version bodies, tools/110): memory keeps every
// version's metadata but only the CURRENT body; each older version is a
// {_stub: true, _size} entry whose body stays in IndexedDB. These pin the
// data-loss guards: memory owns version membership (a deleted version is never
// resurrected, a store-only one never carried), no write ever carries a stub
// marker, a stub resolves only from its identity-matched stored entry (else it
// is dropped with a warning and pruned from memory), the lazy read paths, a
// full-body export, and import's memory shape (stubs once the write committed,
// full bodies while it is still queued).
// Harness copied from smart-documents-behavior.test.js (L6-31, L99-110): the
// real slug/file/lineage/event/IDB modules with browser IDB faked. This fake
// also records every put, can fail one get, and can serve a cursor.
describe('smart documents lazy version bodies',function(){
    var m,rows,puts,errors,warns,readError,getFail,getHook,cursorOn,cursorCalls,blobs,txLog,cursorProbe;
    function clone(x){return x===undefined?undefined:JSON.parse(JSON.stringify(x));}
    function own(o,k){return Object.prototype.hasOwnProperty.call(o,k);}
    function marked(v){return !!v&&typeof v==='object'&&(own(v,'_stub')||own(v,'_size'));}
    function stubs(doc){return doc.versions.map(function(v){return !!v&&v._stub===true;});}
    function nums(list){return list.map(function(v){return v.version;});}
    function bodies(list){return list.map(function(v){return v.content;});}
    function dropWarns(){return warns.filter(function(w){return /stored body missing or changed, version not persisted/.test(w);});}
    // Deterministic async ordering: manually-resolved deferreds, microtask hops
    // (no real sleeps) and a sentinel race so a regression fails instead of hanging.
    var SENTINEL={sentinel:true};
    function deferred(){var d={};d.promise=new Promise(function(res,rej){d.resolve=res;d.reject=rej;});return d;}
    async function ticks(n){for(var i=0;i<n;i++)await Promise.resolve();}
    function within(p,n){return Promise.race([Promise.resolve(p).then(function(v){return {value:v};},function(e){return {error:e};}),ticks(n||500).then(function(){return SENTINEL;})]);}
    // Fake setTimeout/clearTimeout on the module scope: timers fire only via fire(id).
    function fakeTimers(sc){var T={list:[],cleared:[],waiters:[]};
        function nth(ms,n){var hits=T.list.filter(function(x){return x.ms===ms;});return hits.length>=n?hits[n-1].id:0;}
        sc.setTimeout=function(fn,ms){var id=T.list.length+1;T.list.push({id:id,fn:fn,ms:ms});
            T.waiters=T.waiters.filter(function(w){var hit=nth(w.ms,w.n);if(hit)w.resolve(hit);return !hit;});return id;};
        sc.clearTimeout=function(id){T.cleared.push(id);};
        T.ids=function(ms){return T.list.filter(function(x){return x.ms===ms;}).map(function(x){return x.id;});};
        T.when=function(ms,n){var hit=nth(ms,n);if(hit)return Promise.resolve(hit);var d=deferred();T.waiters.push({ms:ms,n:n,resolve:d.resolve});return d.promise;};
        T.fire=function(id){assert.strictEqual(T.cleared.indexOf(id),-1,'timer '+id+' was cleared');T.list[id-1].fn();};
        return T;}
    // A fake .sdoc container (sdocContainerFrom accepts it as the clicked element):
    // records every diff.innerHTML write.
    function fakeContainer(id){var html='',c={nodeType:1,parentElement:null,cls:[],sets:[],
        diff:{style:{display:'none'}},body:{style:{display:''}},edit:{style:{display:''}}};
        Object.defineProperty(c.diff,'innerHTML',{get:function(){return html;},set:function(v){c.sets.push(v);html=v;}});
        c.closest=function(){return c;};c.getAttribute=function(n){return n==='data-doc-id'?id:null;};
        c.querySelector=function(s){return s==='.sdoc-diff'?c.diff:s==='.sdoc-body'?c.body:s==='.sdoc-edit'?c.edit:null;};
        c.classList={add:function(x){if(c.cls.indexOf(x)<0)c.cls.push(x);},remove:function(x){var i=c.cls.indexOf(x);if(i>=0)c.cls.splice(i,1);}};
        return c;}
    function shown(c){return [c.diff.style.display,c.body.style.display,c.edit.style.display,c.cls.slice()];}
    beforeEach(async function(){
        rows={};puts=[];errors=[];warns=[];readError=false;getFail=null;getHook=null;cursorOn=false;cursorCalls=0;blobs=[];txLog=[];cursorProbe=null;
        // Fake tx fires 'complete' once its issued requests have settled (real IDB
        // semantics) — withStore (readwrite) waits for that commit.
        var database={close:function(){},transaction:function(names,mode){if(names.indexOf('documents')>=0)txLog.push(mode);var listeners={},pending=0,committed=false;
            function settled(){pending--;queueMicrotask(function(){if(committed||pending>0)return;committed=true;(listeners.complete||[]).forEach(function(l){l({});});});}
            function request(fill){var r={};pending++;queueMicrotask(function(){fill(r);settled();});return r;}
            pending++;queueMicrotask(settled); // an empty tx still commits
            return {addEventListener:function(t,f){(listeners[t]=listeners[t]||[]).push(f);},abort:function(){},objectStore:function(){return {
            get:function(id){return request(function(r){if(getHook&&getHook(id,r))return;if(readError||(getFail&&getFail(id))){r.error=new Error('read failed');r.onerror();}else{r.result=clone(rows[id]);r.onsuccess();}});},
            getAll:function(){return request(function(r){r.result=clone(Object.values(rows));r.onsuccess();});},
            // One record per step, like a real cursor; a continue() from onsuccess keeps the tx open.
            openCursor:cursorOn?function(){cursorCalls++;var keys=Object.keys(rows),i=0,r={};
                function step(){pending++;queueMicrotask(function(){var k=keys[i++];if(cursorProbe)cursorProbe(k);r.result=k===undefined?null:{value:clone(rows[k]),continue:step};r.onsuccess();settled();});}
                step();return r;}:undefined,
            put:function(doc){puts.push(clone(doc));rows[doc.id]=clone(doc);return request(function(r){if(r.onsuccess)r.onsuccess();});},delete:function(id){delete rows[id];return request(function(r){if(r.onsuccess)r.onsuccess();});}
        };}};}};
        // Export: capture the file text; the real Blob/URL still back every other use.
        var RealBlob=typeof Blob==='function'?Blob:null,RealURL=typeof URL==='function'?URL:null;
        function FakeBlob(parts,opts){blobs.push(parts.map(String).join(''));if(RealBlob)return new RealBlob(parts,opts);}
        if(RealBlob)FakeBlob.prototype=RealBlob.prototype;
        function FakeURL(u,b){return new RealURL(u,b);}
        FakeURL.createObjectURL=function(){return 'blob:test/'+blobs.length;};FakeURL.revokeObjectURL=function(){};
        m=await loadModules(['src/js/core/095-handle-registry.js','src/js/core/097-sub-agent-registry.js','src/js/core/130-indexeddb.js','src/js/tools/040-file-store.js','src/js/app/035-agent-events.js','src/js/tools/110-smart-documents.js'],{globals:{
            STORAGE_PREFIX:'test_',self:{},indexedDB:{open:function(){var r={result:database};queueMicrotask(function(){r.onsuccess();});return r;}},
            chats:{root:{displays:{}},child:{displays:{}},sibling:{displays:{}}},activeStreamingChatId:null,currentChatId:null,
            Blob:FakeBlob,URL:FakeURL,
            console:{error:function(){errors.push([].slice.call(arguments));},warn:function(){warns.push([].slice.call(arguments).map(String).join(' '));},log:function(){},info:function(){},debug:function(){}}
        }});
    });
    afterEach(function(){
        assert.deepStrictEqual(errors,[],'No swallowed document or event errors');
        // (b) the invariant behind every test: no written entry ever carries a stub marker.
        puts.forEach(function(p){(p.versions||[]).forEach(function(v){assert.ok(!marked(v),'stub marker persisted in '+p.id+' v'+(v&&v.version));});});
    });
    function call(args,chat){return m.executeSmartDocument(args,0,{chatId:chat||'root'});}
    function body(id,i){return 'body '+i+' of '+id+' '+'#'.repeat(i);} // distinct lengths per version
    function record(id,n){var vs=[];for(var i=1;i<=n;i++)vs.push({version:i,content:body(id,i),title:'Doc '+id,author:i%2?'agent':'user',timestamp:1000+i,chatId:null});
        return {id:id,title:'Doc '+id,currentContent:body(id,n),currentVersion:n,versions:vs,displays:{},prompts:[],createdAt:1,updatedAt:2,file_id:'file_'+id,scope:'shared',ownerChatId:null};}
    // Store the full record, then load it the way every reader does (stripped): v1..v(n-1) are stubs.
    async function seed(id,n){rows[id]=record(id,n);var d=await m.loadDocumentById(id);
        assert.deepStrictEqual(stubs(d),d.versions.map(function(v){return v.version<n;}),'loaded lazily');return d;}

    // ─── (a) memory owns version membership ───
    test('(a) a version deleted from memory is not resurrected by the next save',async function(){
        var d=await seed('d',3);
        d.versions=d.versions.filter(function(v){return v.version!==2;}); // delete v2 (a stub) in memory
        await m.saveDocument(d);
        assert.deepStrictEqual(nums(rows.d.versions),[1,3]);
        assert.deepStrictEqual(bodies(rows.d.versions),[body('d',1),body('d',3)],'the v1 stub was written as its stored entry');
        assert.deepStrictEqual(nums((await m.loadDocumentById('d')).versions),[1,3],'a reload does not bring v2 back');
        assert.strictEqual(await m.sdocLoadVersionContent('d',2),null);
        assert.deepStrictEqual(await call({action:'read_version',doc_id:'d',version:2}),{success:false,error:'Version 2 not found'});
        assert.deepStrictEqual(dropWarns(),[]);
    });
    test('(a) a version only the store holds is never carried into a save',async function(){
        var d=await seed('d',2);
        rows.d.versions.push({version:3,content:'from another context',title:'Doc d',author:'user',timestamp:5000,chatId:null});
        d.currentVersion=3;d.currentContent='mine';d.versions.push({version:3,content:'mine',title:'Doc d',author:'agent',timestamp:6000,chatId:null});
        await m.saveDocument(d);
        assert.deepStrictEqual(bodies(rows.d.versions),[body('d',1),body('d',2),'mine'],'memory owns membership, as the pre-lazy blind put did');
        assert.deepStrictEqual(nums(m.smartDocuments.d.versions),[1,2,3]);
    });

    test('saveDocument uses exactly one documents readwrite transaction and no documents readonly transaction',async function(){
        var d=await seed('d',3);txLog=[];
        await m.saveDocument(d);
        assert.deepStrictEqual(txLog,['readwrite']);
        assert.deepStrictEqual(rows.d.versions,record('d',3).versions);
    });

    // ─── (b) a stub is never persisted ───
    test('(b) through create/update/update/edit every put is marker-free and every body survives',async function(){
        var c=await call({action:'create',title:'Flow',content:'one'});
        await call({action:'update',doc_id:c.doc_id,content:'two'});
        await call({action:'update',doc_id:c.doc_id,content:'three'});
        assert.strictEqual((await call({action:'edit',doc_id:c.doc_id,edits:[{find:'three',replace:'four'}]})).version,4);
        assert.deepStrictEqual(stubs(m.smartDocuments[c.doc_id]),[true,true,false,false],'the stub path ran: v1/v2 were stubs when edit saved');
        assert.deepStrictEqual(bodies(rows[c.doc_id].versions),['one','two','three','four']);
        assert.strictEqual(puts.length,4);
        puts.forEach(function(p){p.versions.forEach(function(v){assert.ok(!marked(v));assert.strictEqual(typeof v.content,'string');});});
    });
    test('(b) stray markers on a bodied entry are stripped on write',async function(){
        var d=await seed('d',2);
        d.versions[1]._stub=false;d.versions[1]._size=999; // still bodied: _stub is not true
        await m.saveDocument(d);
        assert.deepStrictEqual(rows.d.versions,record('d',2).versions);
        assert.strictEqual(d.versions.length,2);
    });
    test('(b) an unreadable stored record: a doc with stubs is not written, a stub-free doc is',async function(){
        var d=await seed('d',3),before=clone(rows.d);
        d.currentVersion=4;d.currentContent='four';d.versions.push({version:4,content:'four',title:'Doc d',author:'agent',timestamp:7000,chatId:null});
        readError=true;await m.saveDocument(d);
        assert.strictEqual(puts.length,0);assert.deepStrictEqual(rows.d,before,'the stored bodies are untouched');
        assert.ok(warns.some(function(w){return /save of d skipped: stored record unreadable/.test(w);}));
        assert.deepStrictEqual(nums(m.smartDocuments.d.versions),[1,2,3,4],'memory keeps the change');
        await m.saveDocument({id:'f',title:'F',scope:'shared',currentContent:'x',currentVersion:1,versions:[{version:1,content:'x',_size:1}],displays:{},prompts:[]});
        assert.deepStrictEqual(rows.f.versions,[{version:1,content:'x'}]);
        readError=false;await m.saveDocument(d); // readable again: the next save carries the whole history
        assert.deepStrictEqual(bodies(rows.d.versions),[body('d',1),body('d',2),body('d',3),'four']);
    });

    // ─── (c) a stub resolves only from its identity-matched stored entry ───
    test('(c) a stub whose stored entry changed is dropped with a warning and pruned from memory',async function(){
        var d=await seed('d',3);
        rows.d.versions[0].timestamp=4242; // v1 rewritten after the stub was taken
        assert.strictEqual(await m.sdocLoadVersionContent('d',1),null,'no body served for a changed entry');
        assert.strictEqual((await m.sdocLoadVersionContent('d',2)).content,body('d',2));
        await m.saveDocument(d);
        assert.deepStrictEqual(bodies(rows.d.versions),[body('d',2),body('d',3)],'never persisted body-less');
        assert.deepStrictEqual(dropWarns(),['[SmartDocs] d v1: stored body missing or changed, version not persisted']);
        assert.strictEqual(m.smartDocuments.d,d);assert.deepStrictEqual(nums(d.versions),[2,3],'memory matches disk');
    });
    test('(c) identity: same version, same metadata keys and values, a string body of the stub length',async function(){
        var breaks=[
            ['body length',function(v){v.content+='x';}],
            ['metadata value',function(v){v.title='Renamed';}],
            ['extra key',function(v){v.extra=true;}],
            ['missing key',function(v){delete v.author;}],
            ['version',function(v){v.version=9;}],
            ['stored stub',function(v){delete v.content;v._stub=true;v._size=body('d',1).length;}],
            ['non-string body',function(v){v.content=[body('d',1)];}]
        ];
        for(var i=0;i<breaks.length;i++){
            rows={};warns=[];var d=await seed('d',2);breaks[i][1](rows.d.versions[0]);
            assert.strictEqual(await m.sdocLoadVersionContent('d',1),null,breaks[i][0]);
            await m.saveDocument(d);
            assert.deepStrictEqual(nums(rows.d.versions),[2],breaks[i][0]);assert.strictEqual(dropWarns().length,1,breaks[i][0]);
            assert.deepStrictEqual(nums(d.versions),[2],breaks[i][0]+': pruned');
        }
        rows={};warns=[];var ok=await seed('d',2); // control: an untouched entry resolves
        await m.saveDocument(ok);assert.deepStrictEqual(rows.d.versions,record('d',2).versions);assert.deepStrictEqual(dropWarns(),[]);
    });
    test('(c) each stored entry backs one stub: duplicates neither collapse nor multiply',async function(){
        var meta={title:'Doc d',author:'user',timestamp:1002,chatId:null};
        rows.d=record('d',3);rows.d.versions.splice(1,1,Object.assign({version:2,content:'AAAA'},meta),Object.assign({version:2,content:'BBBB'},meta));
        var d=await m.loadDocumentById('d');assert.deepStrictEqual(stubs(d),[true,true,true,false]);
        await m.saveDocument(d);
        assert.deepStrictEqual(bodies(rows.d.versions),[body('d',1),'AAAA','BBBB',body('d',3)],'identical stubs took their own entries, in order');
        assert.deepStrictEqual(dropWarns(),[]);
        d.versions.splice(1,0,clone(d.versions[1])); // a third v2 stub; the store has two
        await m.saveDocument(d);
        assert.deepStrictEqual(bodies(rows.d.versions),[body('d',1),'AAAA','BBBB',body('d',3)],'no stored body written twice');
        assert.strictEqual(dropWarns().length,1);assert.strictEqual(d.versions.length,4,'the surplus stub is pruned');
    });

    // ─── (d) lazy reads ───
    test('(d) a stub reads back its body (sdocLoadVersionContent, read_version) without hydrating memory',async function(){
        var d=await seed('d',3),want=record('d',3).versions;
        var v1=await m.sdocLoadVersionContent('d',1);
        assert.deepStrictEqual(v1,want[0]);assert.ok(!marked(v1));assert.strictEqual(d.versions[0]._stub,true,'memory stays lazy');
        assert.strictEqual(await m.sdocLoadVersionContent('d',3),d.versions[2],'the current body is served from memory');
        assert.deepStrictEqual(await call({action:'read_version',doc_id:'d',version:2}),{success:true,doc_id:'d',version:2,content:want[1].content,title:'Doc d',author:'user',timestamp:1002});
        assert.strictEqual(m.smartDocuments.d.versions[1]._stub,true,'read_version does not hydrate memory either');
        readError=true;
        assert.strictEqual(await m.sdocLoadVersionContent('d',1),null,'an unreadable record gives null, not a throw');
        assert.strictEqual((await m.sdocLoadVersionContent('d',3)).content,body('d',3),'a bodied entry needs no read');
    });
    test('(d) null for a version memory does not list, an unknown doc, or a listed body-less entry',async function(){
        var d=await seed('d',3);
        rows.d.versions.push({version:4,content:'store only',title:'Doc d',author:'user',timestamp:9000,chatId:null});
        assert.strictEqual(await m.sdocLoadVersionContent('d',4),null,'never served from the store alone');
        assert.strictEqual(await m.sdocLoadVersionContent('d',99),null);
        assert.strictEqual(await m.sdocLoadVersionContent('nope',1),null);
        d.versions.push({version:5,title:'Doc d'});
        assert.strictEqual(await m.sdocLoadVersionContent('d',5),null);
        assert.deepStrictEqual(await call({action:'read_version',doc_id:'d',version:99}),{success:false,error:'Version 99 not found'});
    });
    function diffHtml(version){return '<div class="sdoc-diff-header"><span class="sdoc-diff-label sdoc-diff-old">v'+version+' ('+(version%2?'agent':'user')+')</span><span class="sdoc-diff-arrow">\u2192</span><span class="sdoc-diff-label sdoc-diff-new">v3 (current)</span></div><div class="sdoc-diff-body"><div class="sdoc-diff-line sdoc-line-del"><span class="sdoc-diff-prefix">-</span><span class="sdoc-diff-text">'+body('d',version)+'</span></div><div class="sdoc-diff-line sdoc-line-add"><span class="sdoc-diff-prefix">+</span><span class="sdoc-diff-text">'+body('d',3)+'</span></div></div>';}
    test('P1 compare renders the IDB-stored body of a stub',async function(){
        await seed('d',3);var c=fakeContainer('d');m.__scope.escDisplay=function(s){return String(s);};
        await m.sdocCompare('d','1',c);
        assert.deepStrictEqual(c.sets,[diffHtml(1)]);
        assert.deepStrictEqual(shown(c),['','none','none',['sdoc-diffing']]);
        assert.deepStrictEqual(stubs(m.smartDocuments.d),[true,true,false]);
    });
    test('P1 compare two quick picks render only the second even when the first finishes last',async function(){
        await seed('d',3);var c=fakeContainer('d'),requested=[deferred(),deferred()],reads=[];
        m.__scope.escDisplay=function(s){return String(s);};
        getHook=function(id,r){reads.push(r);requested[reads.length-1].resolve();return true;};
        var first=m.sdocCompare('d','1',c);await requested[0].promise;
        var second=m.sdocCompare('d','2',c);await requested[1].promise;
        assert.deepStrictEqual(c.sets,[]);
        reads[1].result=clone(rows.d);reads[1].onsuccess();await second;
        assert.deepStrictEqual(c.sets,[diffHtml(2)]);
        reads[0].result=clone(rows.d);reads[0].onsuccess();await first;
        assert.deepStrictEqual(c.sets,[diffHtml(2)]);
        assert.deepStrictEqual(shown(c),['','none','none',['sdoc-diffing']]);
    });
    test('P1 compare unreadable store renders no diff and leaves the body visible',async function(){
        await seed('d',3);var c=fakeContainer('d');readError=true;
        await m.sdocCompare('d','1',c);
        assert.deepStrictEqual(c.sets,[]);
        assert.deepStrictEqual(shown(c),['none','','',[]]);
    });
    test('(d) _sdocReadStored: a missing record resolves null, a failed read rejects (never conflated)',async function(){
        await seed('d',2);
        assert.strictEqual((await m._sdocReadStored('d')).versions.length,2);
        assert.strictEqual(await m._sdocReadStored('nope'),null,'missing');
        readError=true;await assert.rejects(m._sdocReadStored('d'),/read failed/);readError=false;
        m.__scope._dbClosingForReload=Date.now();
        await assert.rejects(m._sdocReadStored('d'),/imminent extension reload/);
        assert.strictEqual(await m.sdocLoadVersionContent('d',1),null,'the lazy read path still degrades to null, no throw');
    });
    test('(d) _sdocReadStored is bounded: a get that never settles loses to its timeout, not the sentinel',async function(){
        await seed('d',2);var T=fakeTimers(m.__scope),seen=deferred();
        m.__scope.SDOC_STORED_READ_TIMEOUT_MS=20;getHook=function(){seen.resolve();return true;};
        var result=within(m._sdocReadStored('d'));await seen.promise;
        assert.strictEqual(T.ids(20).length,1);T.fire(T.ids(20)[0]);
        var outcome=await result;assert.strictEqual(outcome===SENTINEL,false,'unsettled read lost to sentinel');
        assert.deepStrictEqual([outcome.error.name,outcome.error.message],['TimeoutError','IndexedDB read of d timed out after 20 ms']);
        seen=deferred();var lazy=within(m.sdocLoadVersionContent('d',1));await seen.promise;
        assert.strictEqual(T.ids(20).length,2);T.fire(T.ids(20)[1]);
        assert.deepStrictEqual(await lazy,{value:null});
    });
    test('(d) _sdocReadStored clears its exact timeout on success and error',async function(){
        await seed('d',2);var T=fakeTimers(m.__scope);m.__scope.SDOC_STORED_READ_TIMEOUT_MS=20;
        assert.deepStrictEqual(await within(m._sdocReadStored('d')),{value:rows.d});
        assert.deepStrictEqual(T.cleared,T.ids(20));assert.strictEqual(T.cleared.length,1);
        readError=true;var result=await within(m._sdocReadStored('d'));
        assert.strictEqual(result===SENTINEL,false);
        assert.deepStrictEqual([result.error.name,result.error.message],['Error','read failed']);
        assert.deepStrictEqual(T.cleared,T.ids(20));assert.strictEqual(T.cleared.length,2);
    });
    test('(c) a stub dropped as changed on save logs a summary warning naming the dropped versions',async function(){
        var d=await seed('d',3);
        rows.d.versions[0].timestamp=4242;rows.d.versions[1].timestamp=4343;
        await m.saveDocument(d);
        assert.deepStrictEqual(nums(d.versions),[3]);
        assert.ok(warns.some(function(w){return w==='[SmartDocs] d: 2 version(s) dropped from memory (stored body missing or changed): v1, v2';}),warns.join(' | '));
        warns=[];var e=await seed('e',2);await m.saveDocument(e);
        assert.deepStrictEqual(warns,[],'nothing dropped: no warning');
    });
    test('_sdocErrMessage: message, else name (empty DOMException message), else generic text',function(){
        assert.strictEqual(m._sdocErrMessage(new Error('boom')),'boom');
        assert.strictEqual(m._sdocErrMessage({name:'AbortError',message:''}),'AbortError');
        assert.strictEqual(m._sdocErrMessage({name:'',message:''}),'unknown error');
        assert.strictEqual(m._sdocErrMessage(null),'unknown error');
        assert.strictEqual(m._sdocErrMessage('plain'),'plain');
    });
    test('(d) read_version reports an unavailable body when the stored read fails after the reload',async function(){
        await seed('d',2);var n=0;getFail=function(){return ++n===2;}; // the dispatcher reload succeeds, the body read fails
        assert.deepStrictEqual(await call({action:'read_version',doc_id:'d',version:1}),{success:false,error:'Version 1 content is unavailable'});
        assert.strictEqual(n,2);
    });
    test('(d) loadAllDocuments strips every record on the cursor path and the getAll fallback',async function(){
        rows.d=record('d',3);rows.e=record('e',2);
        cursorOn=true;var a=await m.loadAllDocuments();
        assert.strictEqual(cursorCalls,1);assert.deepStrictEqual(a.map(stubs),[[true,true,false],[true,false]]);
        cursorOn=false;var b=await m.loadAllDocuments();
        assert.strictEqual(cursorCalls,1,'getAll fallback');assert.deepStrictEqual(b.map(stubs),[[true,true,false],[true,false]]);
        assert.strictEqual((await m.sdocLoadVersionContent('e',1)).content,body('e',1));
    });

    test('(d) cursor strips and adopts each record before the next record is read',async function(){
        rows.d=record('d',3);rows.e=record('e',2);cursorOn=true;var observations=[];
        cursorProbe=function(next){observations.push({next:next===undefined?null:next,adopted:Object.keys(m.smartDocuments).map(function(k){return [k,stubs(m.smartDocuments[k]),bodies(m.smartDocuments[k].versions)];})});};
        var result=await m.loadAllDocuments();
        assert.deepStrictEqual(observations,[{next:'d',adopted:[]},{next:'e',adopted:[['d',[true,true,false],[undefined,undefined,body('d',3)]]]},{next:null,adopted:[['d',[true,true,false],[undefined,undefined,body('d',3)]],['e',[true,false],[undefined,body('e',2)]]]}]);
        assert.deepStrictEqual(result.map(function(d){return d.id;}),['d','e']);
    });

    // S0B-09 harness (smart-documents-behavior.test.js L99-110): the real export/import
    // against the fake IDB above; only UI hooks are stubbed.
    describe('export and import',function(){
        var input,modal,snacks;
        beforeEach(function(){
            input=null;modal={answer:'cancel',calls:[]};snacks=[];var sc=m.__scope;
            sc.document={createElement:function(t){var el={tagName:t,click:function(){}};if(t==='input')input=el;return el;},getElementById:function(){return null;}};
            sc.showModal=async function(t,msg,btns){modal.calls.push({msg:msg,btns:btns.map(function(b){return b.value;})});return modal.answer;};
            sc.showSnackbar=function(msg,type){snacks.push([msg,type]);};sc.renderVersionSidebar=function(){};
            sc.escDisplay=function(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');};
        });
        async function importFile(docs){m.importDocuments();await input.onchange({target:{files:[{text:async function(){return JSON.stringify({type:'appagent-documents',version:1,documents:docs});}}]}});}
        function last(){return snacks[snacks.length-1];}
        function exported(){assert.strictEqual(blobs.length,1,'one export file');return JSON.parse(blobs[0]);}
        function fileRow(){return {id:'fresh',title:'Fresh',currentContent:'three',currentVersion:3,versions:[{version:1,content:'one',author:'agent',timestamp:11},{version:2,content:'two!',author:'user',timestamp:12},{version:3,content:'three',author:'agent',timestamp:13}]};}

        // ─── (e) export ───
        test('(e) export reads every stub body back from IDB: full bodies, no stub marker',async function(){
            await seed('d',3);await seed('e',2);
            await m.exportAllDocuments();
            assert.deepStrictEqual(last(),['Exported 2 document(s)','success']);
            var x={};exported().documents.forEach(function(doc){x[doc.id]=doc;});
            assert.ok(!/"_stub"|"_size"/.test(blobs[0]),'no stub marker in the file');
            assert.deepStrictEqual(x.d.versions,record('d',3).versions);assert.deepStrictEqual(x.e.versions,record('e',2).versions);
            assert.deepStrictEqual(Object.keys(x.d),['id','title','currentContent','currentVersion','versions','displays','prompts','createdAt','updatedAt'],'field list unchanged');
            assert.deepStrictEqual(stubs(m.smartDocuments.d),[true,true,false],'export does not hydrate memory');
            assert.strictEqual(puts.length,0,'export writes nothing');
        });
        test('(e) an unresolvable stub is left out of the export with a warning, never exported as a stub',async function(){
            await seed('d',3);rows.d.versions[0].timestamp=1;
            await m.exportAllDocuments();
            assert.deepStrictEqual(nums(exported().documents[0].versions),[2,3]);assert.ok(!/"_stub"|"_size"/.test(blobs[0]));
            assert.deepStrictEqual(dropWarns(),['[SmartDocs] d v1: stored body missing or changed, version not persisted']);
            assert.deepStrictEqual(nums(m.smartDocuments.d.versions),[1,2,3],'export never edits memory');
        });
        // A FAILED stored read (unhealthy store) is not a MISSING record: exporting the
        // stub-less remainder with a success snackbar loses history on export -> wipe -> import.
        test('(e) a failed stored-body read aborts the export with an error snackbar: no file, no success',async function(){
            await seed('d',3);await seed('e',2);getFail=function(id){return id==='e';};
            await m.exportAllDocuments();
            assert.strictEqual(blobs.length,0,'no partial file');
            assert.strictEqual(snacks.length,1);assert.strictEqual(last()[1],'error');
            assert.match(last()[0],/^Download failed: .*"Doc e".*read failed/);
            assert.deepStrictEqual(dropWarns(),[],'nothing silently dropped');
            assert.deepStrictEqual(stubs(m.smartDocuments.e),[true,false],'memory untouched');assert.strictEqual(puts.length,0);
            getFail=null;await m.exportAllDocuments(); // store healthy again: the full export goes through
            assert.deepStrictEqual(last(),['Exported 2 document(s)','success']);
            var x={};exported().documents.forEach(function(doc){x[doc.id]=doc;});
            assert.deepStrictEqual(x.e.versions,record('e',2).versions);
        });
        test('(e) the IDB reload latch (openDatabase rejects) aborts the export instead of dropping stubs',async function(){
            await seed('d',3);m.__scope._dbClosingForReload=Date.now();
            await m.exportAllDocuments();
            assert.strictEqual(blobs.length,0);
            assert.deepStrictEqual(last(),['Download failed: version history of "Doc d" could not be read: IndexedDB is closed for an imminent extension reload','error']);
            assert.deepStrictEqual(dropWarns(),[]);
        });
        test('(e) a stored-body read failing with an empty-message DOMException still names the error in the snackbar',async function(){
            await seed('d',3);
            getHook=function(id,r){r.error={name:'AbortError',message:''};r.onerror();return true;};
            await m.exportAllDocuments();
            assert.strictEqual(blobs.length,0);
            assert.deepStrictEqual(last(),['Download failed: version history of "Doc d" could not be read: AbortError','error']);
        });
        test('(e) a genuinely missing record still exports what memory holds, as before',async function(){
            await seed('d',3);delete rows.d;
            await m.exportAllDocuments();
            assert.deepStrictEqual(nums(exported().documents[0].versions),[3]);
            assert.strictEqual(dropWarns().length,2);
            assert.deepStrictEqual(last(),['Exported 1 document(s)','success']);
        });
        test('(e) a failed read does not block a doc without stubs (it needs no read)',function(){
            readError=true;
            m.smartDocuments.n={id:'n',title:'N',scope:'shared',currentContent:'b',currentVersion:1,versions:[{version:1,content:'b'}],displays:{},prompts:[],createdAt:1,updatedAt:2};
            m.exportAllDocuments();
            assert.deepStrictEqual(last(),['Exported 1 document(s)','success']);
        });
        test('(e) a doc without stubs exports synchronously (no IDB read), markers stripped',function(){
            m.smartDocuments.n={id:'n',title:'N',scope:'shared',currentContent:'b',currentVersion:2,versions:[{version:1,content:'a',_size:1},{version:2,content:'b'}],displays:{},prompts:[],createdAt:1,updatedAt:2};
            m.exportAllDocuments(); // not awaited: S0B-15 relies on this path staying synchronous
            assert.deepStrictEqual(exported().documents[0].versions,[{version:1,content:'a'},{version:2,content:'b'}]);
            assert.deepStrictEqual(last(),['Exported 1 document(s)','success']);
        });

        // ─── (f) import ───
        test('(f) a confirmed import leaves stubs in memory while IDB holds the full bodies',async function(){
            var f=fileRow();await importFile([f]);
            assert.deepStrictEqual(last(),['Imported 1 document(s) (0 replaced, 0 copied, 0 skipped)','success']);
            assert.deepStrictEqual(rows.fresh.versions,f.versions,'IDB: every body');
            var mem=m.smartDocuments.fresh;
            assert.deepStrictEqual(mem.versions,[{version:1,author:'agent',timestamp:11,_stub:true,_size:3},{version:2,author:'user',timestamp:12,_stub:true,_size:4},f.versions[2]]);
            assert.strictEqual(mem.versions[2].content,mem.currentContent);
            assert.strictEqual((await m.sdocLoadVersionContent('fresh',2)).content,'two!');
            await m.saveDocument(mem);
            assert.deepStrictEqual(rows.fresh.versions,f.versions,'a save after the import writes the whole history back');
        });
        test('(b) stub markers in an import file are stripped before the write',async function(){
            var f=fileRow();f.versions[0]._stub=true;f.versions[0]._size=3;f.versions[1]._size=1;
            await importFile([f]);
            assert.deepStrictEqual(rows.fresh.versions,fileRow().versions);
        });
        // TA4-7 congested backend (copied from smart-documents-behavior.test.js): the import's
        // readwrite tx never commits in time while the readonly probe answers, so the write is
        // left queued (slow-tx TimeoutError), not aborted.
        async function congested(){
            var sc=m.__scope,real=await m.openDatabase(),st={queued:[],listeners:{},aborted:0,real:real};
            st.db={close:function(){},transaction:function(names,mode){
                if(mode==='readwrite'&&names[0]==='documents')return {addEventListener:function(t,f){(st.listeners[t]=st.listeners[t]||[]).push(f);},abort:function(){st.aborted++;},
                    objectStore:function(){return {put:function(doc){st.queued.push(clone(doc));return {};}};}};
                var tx=real.transaction(names,mode),os=tx.objectStore;
                tx.objectStore=function(n){var s=os(n);s.count=function(){var r={};queueMicrotask(function(){r.onsuccess();});return r;};return s;};
                return tx;
            }};
            st.timers=fakeTimers(sc);sc.DB_TX_DEADLINE_WRITE_MS=20;sc.DB_TX_PROBE_TIMEOUT_MS=30;sc.db=st.db;sc._dbOpenPromise=null;
            sc.indexedDB={open:function(){var r={result:st.db};queueMicrotask(function(){r.onsuccess();});return r;}};
            return st;
        }
        test('(f) an import still queued (slow tx) keeps every body in memory, so a later save carries them',async function(){
            var st=await congested(),f=fileRow(),importing=within(importFile([f]));
            var deadline=await within(st.timers.when(20,1));assert.strictEqual(deadline===SENTINEL,false);
            st.timers.fire(deadline.value); // readonly probe replies via microtasks; never advance wall time
            assert.deepStrictEqual(await importing,{value:undefined});
            assert.strictEqual(st.timers.ids(20).length,1);
            assert.deepStrictEqual(st.timers.ids(30).map(function(id){return st.timers.cleared.indexOf(id)>=0;}),[true,true]);
            assert.strictEqual(last()[1],'warning');assert.strictEqual(st.aborted,0);assert.strictEqual(rows.fresh,undefined,'not committed');
            assert.deepStrictEqual(st.queued.map(function(d){return d.versions;}),[f.versions]);
            var mem=m.smartDocuments.fresh;
            assert.deepStrictEqual(mem.versions,f.versions,'no stubs: those bodies are not on disk yet');
            assert.strictEqual((await m.sdocLoadVersionContent('fresh',1)).content,'one');
            var sc=m.__scope;sc.db=st.real;sc._dbOpenPromise=null; // the queued write never lands; storage recovers
            await m.saveDocument(mem);
            assert.deepStrictEqual(rows.fresh.versions,f.versions,'the whole history persisted from memory');
        });
    });
});
