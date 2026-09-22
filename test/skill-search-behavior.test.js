// All transport and timers are local fakes. No live HTTP/tool calls.
async function searchFixture(responses) {
    var calls=[],delays=[];
    var m=await loadModules(['skills/web-search/web_search.js'],{globals:{
        executeTool:async function(name,args){
            if(name!=='web_fetch')throw new Error('unexpected tool '+name);
            calls.push({name:name,args:args});
            if(!responses.length)throw new Error('unexpected request');
            var r=responses.shift();if(r instanceof Error)throw r;return r;
        },
        fetch:function(){throw new Error('direct networking forbidden in test');},
        setTimeout:function(fn,ms){delays.push(ms);fn();return 1;}
    }});return {m:m,calls:calls,delays:delays};
}
function googleHit(url,title,snippet){return '<a href="'+url+'"><h3>'+title+'</h3></a><div class="VwiC3b">'+snippet+'</div>';}
function ddgHit(url,title,snippet){return '<a class="result__a" href="'+url+'">'+title+'</a><a class="result__snippet">'+snippet+'</a>';}
describe('web-search skill offline transport and parsing',function(){
    test('no queries returns structured error without transport',async function(){var f=await searchFixture([]);var r=await f.m.web_search({queries:[]});assert.strictEqual(r.completed,0);assert.strictEqual(r.error,'no queries provided');assert.deepStrictEqual(f.calls,[]);assert.deepStrictEqual(f.m.__unstubbed,[]);});
    test('Google requests encoded sequential queries and honors result cap and timer',async function(){
        var html=googleHit('/url?q=https%3A%2F%2Fexample.invalid%2Fa','A &amp; B','2 hours ago useful detailed snippet Read more')+googleHit('https://other.invalid','Other','A separate useful detailed snippet here');
        var f=await searchFixture([{status:200,body:html},{status:200,body:html}]);var r=await f.m.web_search({queries:['a & b','next'],max_results_per_query:1,sleep_ms:17});
        assert.strictEqual(r.completed,2);assert.strictEqual(r.total_requested,2);assert.deepStrictEqual(f.delays,[17]);
        assert.strictEqual(f.calls[0].args.method,'GET');assert.strictEqual(new URL(f.calls[0].args.url).searchParams.get('q'),'a & b');
        assert.strictEqual(new URL(f.calls[0].args.url).searchParams.get('udm'),'14');
        assert.deepStrictEqual(r.results[0].results,[{title:'A & B',url:'https://example.invalid/a',snippet:'2 hours ago useful detailed snippet...',freshness:'2 hours ago'}]);
    });
    test('Google excludes internal and non-HTTP anchors but accepts protocol-relative URLs',async function(){
        var body=googleHit('https://accounts.google.com/x','Internal','')+googleHit('javascript:bad()','Unsafe','')+googleHit('//example.invalid/a','Good','Yesterday this useful snippet was published');
        var f=await searchFixture([{status:200,body:body}]),r=await f.m.web_search({queries:['q']});assert.strictEqual(r.results[0].results.length,1);assert.strictEqual(r.results[0].results[0].url,'https://example.invalid/a');assert.strictEqual(r.results[0].results[0].freshness,'yesterday');
    });
    test('empty query entries are rejected locally and do not stop valid query',async function(){
        var f=await searchFixture([{status:200,body:googleHit('https://a.invalid','A','May 21, 2026 this long snippet is valid')}]);var r=await f.m.web_search({queries:[' ',null,42,'valid']});
        assert.strictEqual(f.calls.length,1);assert.strictEqual(r.completed,1);assert.strictEqual(r.total_requested,4);assert.deepStrictEqual(r.results.slice(0,3).map(function(x){return x.error;}),['empty query','empty query','empty query']);assert.strictEqual(r.results[3].results[0].freshness,'May 21, 2026');
    });
    [{name:'HTTP 429',response:{status:429,body:'blocked'},error:/unexpected HTTP/},{name:'soft block',response:{status:200,body:'JavaScript required'},error:/soft-block/},{name:'transport denial',response:new Error('Permission denied'),error:/fetch failed:.*Permission denied/}].forEach(function(c){
        test('Google '+c.name+' stops batch without automatic DDG fallback',async function(){var f=await searchFixture([c.response]);var r=await f.m.web_search({queries:['blocked & query','must not run']});assert.strictEqual(r.blocked,true);assert.strictEqual(r.blocked_at,0);assert.deepStrictEqual(r.remaining,['blocked & query','must not run']);assert.strictEqual(f.calls.length,1);assert.deepStrictEqual(f.delays,[]);assert.match(r.results[0].error,c.error);assert.match(r.blocked_url,/google/);});
    });
    test('Google partial success preserves completed count and only blocked suffix remains',async function(){
        var f=await searchFixture([{status:200,body:googleHit('https://a.invalid','A','A useful detailed snippet for readers')},{status:503}]);var r=await f.m.web_search({queries:['first','second','third']});assert.strictEqual(r.completed,1);assert.strictEqual(r.blocked_at,1);assert.deepStrictEqual(r.remaining,['second','third']);assert.deepStrictEqual(f.delays,[5000]);
    });
    test('DDG form body unwraps redirects and filters ads without shifting snippets',async function(){
        var html=ddgHit('https://duckduckgo.com/y.js?ad=1','Advertisement','Ad snippet')+ddgHit('//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.invalid%2Fa','Real &amp; Result','3 days ago a useful real snippet');
        var f=await searchFixture([{status:200,body:html}]);var r=await f.m.web_search({engine:'ddg',queries:['quote & space']});
        assert.strictEqual(f.calls[0].args.method,'POST');assert.strictEqual(f.calls[0].args.headers['Content-Type'],'application/x-www-form-urlencoded');assert.strictEqual(new URLSearchParams(f.calls[0].args.body).get('q'),'quote & space');
        assert.deepStrictEqual(r.results[0].results,[{title:'Real & Result',url:'https://example.invalid/a',snippet:'3 days ago a useful real snippet',freshness:'3 days ago'}]);
    });
    test('DDG rejects overlong query locally and proceeds at 499-character boundary',async function(){
        var f=await searchFixture([{status:200,body:''}]);var r=await f.m.web_search({engine:'ddg',queries:['x'.repeat(500),'x'.repeat(499)]});assert.strictEqual(f.calls.length,1);assert.match(r.results[0].error,/499 chars/);assert.strictEqual(r.completed,1);assert.deepStrictEqual(r.results[1].results,[]);
    });
    [{name:'challenge',response:{status:202},error:/bot challenge/},{name:'missing response',response:null,error:/unexpected HTTP/},{name:'transport error',response:new Error('offline'),error:/fetch failed/}].forEach(function(c){test('DDG '+c.name+' returns retry URL and halts',async function(){
        var f=await searchFixture([c.response]);var r=await f.m.web_search({engine:'ddg',queries:['a b','later']});assert.strictEqual(r.blocked,true);assert.strictEqual(r.completed,0);assert.deepStrictEqual(r.remaining,['a b','later']);assert.match(r.results[0].error,c.error);assert.match(r.blocked_url,/a%20b/);assert.strictEqual(f.calls.length,1);
    });});
    test('DDG default delay applies only between successful requests',async function(){var f=await searchFixture([{status:200,body:''},{status:200,body:''}]);var r=await f.m.web_search({engine:'ddg',queries:['one','two']});assert.deepStrictEqual(f.delays,[2000]);assert.strictEqual(r.completed,2);});
});
