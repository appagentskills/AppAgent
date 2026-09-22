// Entire skill evaluated against a strict local web_fetch dispatcher.
async function docsFixture(responses){
    var calls=[];
    var m=await loadModules(['skills/servicenow-docs/search_docs.js'],{globals:{executeTool:async function(name,args){if(name!=='web_fetch')throw new Error('unexpected tool '+name);calls.push(args);if(!responses.length)throw new Error('unexpected request');var r=responses.shift();if(r instanceof Error)throw r;return r;},fetch:function(){throw new Error('direct HTTP prohibited');}}});
    return {m:m,calls:calls};
}
function docsSearchResponse(topics){return {success:true,body:JSON.stringify({results:[{}, {entries:[{}].concat(topics.map(function(t){return {topic:t};}))}]})};}
function docsTopic(title){return {title:title,mapId:'map/a',contentId:'topic?x',htmlExcerpt:'<b>A &amp; B</b>',metadata:[{key:'ft:prettyUrl',values:['release/topic.html']}]};}
describe('ServiceNow docs skill offline behavior',function(){
    test('required query and read identifiers fail locally',async function(){var f=await docsFixture([]);assert.strictEqual((await f.m.search_docs({})).error,'query is required for search');assert.strictEqual((await f.m.search_docs({action:'read',map_id:'m'})).success,false);assert.strictEqual(f.calls.length,0);assert.deepStrictEqual(f.m.__unstubbed,[]);});
    test('read encodes path components and strips scripts/styles/entities',async function(){
        var f=await docsFixture([{success:true,body:'<script>bad()</script><style>bad{}</style><h1>A &amp; B</h1><p>&lt;x&gt; &quot;q&quot; &#39;s&#39;&nbsp;done</p>'}]);var r=await f.m.search_docs({action:'read',map_id:'a/b',content_id:'x?y'});
        assert.strictEqual(f.calls[0].url,'https://www.servicenow.com/docs/api/khub/maps/a%2Fb/topics/x%3Fy/content');assert.strictEqual(r.content,'A & B <x> "q" \'s\' done');assert.strictEqual(r.map_id,'a/b');
    });
    test('read returns transport failure unchanged',async function(){var denied={success:false,error:'Permission denied'},f=await docsFixture([denied]);assert.deepStrictEqual(await f.m.search_docs({action:'read',map_id:'m',content_id:'c'}),denied);assert.strictEqual(f.calls.length,1);});
    test('search sends paging JSON, normalizes topics and skips eager read when disabled',async function(){
        var t=docsTopic('Title'),f=await docsFixture([docsSearchResponse([t])]);var r=await f.m.search_docs({query:'ACL & flow',limit:3,page:2,read_first:false});assert.strictEqual(f.calls.length,1);assert.strictEqual(f.calls[0].method,'POST');assert.deepStrictEqual(JSON.parse(f.calls[0].body),{query:'ACL & flow',paging:{perPage:3,page:2},contentLocale:'en-US'});
        assert.deepStrictEqual(r.results,[{source:'docs',title:'Title',excerpt:'A & B',map_id:'map/a',content_id:'topic?x',url:'https://www.servicenow.com/docs/r/release/topic.html'}]);
    });
    test('default first-topic read preserves remaining result metadata',async function(){
        var a=docsTopic('First'),b=docsTopic('Second');b.metadata=[];var f=await docsFixture([docsSearchResponse([a,b]),{success:true,body:'<p>Full content</p>'}]);var r=await f.m.search_docs({query:'flow'});
        assert.strictEqual(f.calls.length,2);assert.strictEqual(r.title,'First');assert.strictEqual(r.content,'Full content');assert.strictEqual(r.other_results[0].title,'Second');assert.strictEqual(r.other_results[0].url,'');assert.strictEqual(r.other_results[0].map_id,'map/a');assert.match(f.calls[1].url,/maps\/map%2Fa\/topics\/topic%3Fx\/content$/);
    });
    test('first-topic read failure is surfaced as content with search metadata retained',async function(){var f=await docsFixture([docsSearchResponse([docsTopic('First')]),{success:false,error:'HTTP 403'}]);var r=await f.m.search_docs({query:'q'});assert.strictEqual(r.success,true);assert.strictEqual(r.content,'HTTP 403');assert.strictEqual(r.title,'First');});
    test('community query escapes LIQL apostrophes and truncates stripped excerpts',async function(){
        var f=await docsFixture([{success:true,body:JSON.stringify({status:'success',data:{items:[{subject:'Answer',view_href:'https://fixture.invalid/post',body:'<script>bad()</script><p>'+('x'.repeat(220))+'</p>'}]}})}]);var r=await f.m.search_docs({query:"O'Brien",source:'community',limit:2});
        var q=new URL(f.calls[0].url).searchParams.get('q');assert.match(q,/MATCHES 'O''Brien' LIMIT 2$/);assert.strictEqual(r.content.length,200);assert.strictEqual(r.content,'x'.repeat(200));assert.strictEqual(r.title,'Answer');assert.strictEqual(f.calls.length,1);
    });
    test('both combines official and community results without unnecessary read',async function(){
        var f=await docsFixture([docsSearchResponse([docsTopic('Doc')]),{success:true,body:JSON.stringify({status:'success',data:{items:[{subject:'Post',body:'<p>Community</p>',view_href:'https://fixture.invalid'}]}})}]);var r=await f.m.search_docs({query:'q',source:'both',read_first:false});assert.deepStrictEqual(r.results.map(function(x){return x.source;}),['docs','community']);assert.strictEqual(f.calls.length,2);assert.strictEqual(r.results[1].excerpt,'Community');
    });
    [{success:false,error:'HTTP 500'},{success:true,body:'{malformed'},{success:true,body:'{}'}].forEach(function(response,i){test('docs unsuccessful or malformed response '+i+' becomes no-results error',async function(){var f=await docsFixture([response]);assert.deepStrictEqual(await f.m.search_docs({query:'q'}),{success:false,error:'No results found'});assert.strictEqual(f.calls.length,1);});});
    test('failed official docs still permits community fallback in both mode',async function(){
        var f=await docsFixture([{success:false,error:'offline'},{success:true,body:JSON.stringify({status:'success',data:{items:[{subject:'Fallback',body:'Readable'}]}})}]);var r=await f.m.search_docs({query:'q',source:'both'});assert.strictEqual(r.title,'Fallback');assert.strictEqual(r.content,'Readable');assert.strictEqual(f.calls.length,2);
    });
    test('community malformed JSON is no-results, thrown permission denial propagates without retry',async function(){
        var f=await docsFixture([{success:true,body:'not JSON'}]);assert.strictEqual((await f.m.search_docs({query:'q',source:'community'})).success,false);
        var g=await docsFixture([new Error('Permission denied')]);await assert.rejects(g.m.search_docs({query:'q',source:'both'}),/Permission denied/);assert.strictEqual(g.calls.length,1);
    });
});
