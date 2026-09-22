// Full DOM-free production module; fetch is a strict in-memory HTTP boundary.
async function recordFixture(responder, platform) {
    var calls = [], errors = [];
    var m = await loadModules(['src/js/core/150-record-helpers.js'], {globals: {
        Platform: platform === undefined ? {instanceUrl:'https://fixture.invalid', getSessionToken:function(){return 'test-token';}} : platform,
        fetch: async function(url, options) { calls.push({url:url, options:options}); return responder(url, options); },
        console: {error:function(){errors.push(Array.from(arguments));}}
    }});
    return {m:m,calls:calls,errors:errors};
}
var recordId = 'abcdef0123456789abcdef0123456789';
function recordResponse(result) { return {ok:true,json:async function(){return {result:result};}}; }
describe('record helpers HTTP behavior', function() {
    test('scope sends instance URL, token and exact field projection', async function(){
        var f=await recordFixture(function(){return recordResponse({sys_scope:{value:'scope-id',display_value:'Label'}});});
        assert.strictEqual(await f.m.getRecordScope('sys_script',recordId),'scope-id');
        assert.strictEqual(f.calls[0].url,'https://fixture.invalid/api/now/table/sys_script/'+recordId+'?sysparm_fields=sys_scope');
        assert.deepStrictEqual(f.calls[0].options,{headers:{'X-UserToken':'test-token',Accept:'application/json'}});
        assert.deepStrictEqual(f.m.__unstubbed,[]);
    });
    test('scope accepts primitive scopes and nulls missing scopes', async function(){
        for (var row of [{sys_scope:'global'}, {}, {sys_scope:null}]) {
            var f=await recordFixture(function(){return recordResponse(row);});
            assert.strictEqual(await f.m.getRecordScope('incident',recordId),row.sys_scope || null);
        }
    });
    test('invalid path/query identifiers never reach HTTP', async function(){
        var f=await recordFixture(function(){throw new Error('unexpected HTTP');});
        for (var pair of [['incident/x',recordId],['incident?x=y',recordId],['incident',"abc^ORx"],['incident',''],['',recordId]]) {
            assert.strictEqual(await f.m.getRecordScope(pair[0],pair[1]),null);
            assert.strictEqual(await f.m.getRecordVersion(pair[0],pair[1]),null);
            assert.strictEqual(await f.m.getRecordDisplayValue(pair[0],pair[1]),pair[1].substring(0,8));
        }
        assert.strictEqual(f.calls.length,0);
    });
    test('scope HTTP denial does not parse a denied body', async function(){
        var parsed=0,f=await recordFixture(function(){return {ok:false,json:async function(){parsed++;throw new Error('denied');}};});
        assert.strictEqual(await f.m.getRecordScope('incident',recordId),null);assert.strictEqual(parsed,0);
    });
    test('version requests only latest descending update and returns row', async function(){
        var row={sys_id:'version',state:'current',sys_created_on:'2026-01-01'},f=await recordFixture(function(){return recordResponse([row]);});
        assert.deepStrictEqual(await f.m.getRecordVersion('incident',recordId),row);
        var url=new URL(f.calls[0].url);
        assert.strictEqual(url.searchParams.get('sysparm_query'),'name=incident_'+recordId+'^ORDERBYDESCsys_created_on');
        assert.strictEqual(url.searchParams.get('sysparm_limit'),'1');
        assert.strictEqual(url.searchParams.get('sysparm_fields'),'sys_id,sys_created_on,state');
    });
    test('empty version list returns null with relative URL and empty token', async function(){
        var f=await recordFixture(function(){return recordResponse([]);},{});
        assert.strictEqual(await f.m.getRecordVersion('incident',recordId),null);
        assert.match(f.calls[0].url,/^\/api\/now\/table\/sys_update_version/);
        assert.strictEqual(f.calls[0].options.headers['X-UserToken'],'');
    });
    test('display priority is name then number then description then id prefix', async function(){
        for(var entry of [[{name:'N',number:'I',short_description:'D'},'N'],[{number:'I',short_description:'D'},'I'],[{short_description:'D'},'D'],[{},recordId.slice(0,8)]]){
            var f=await recordFixture(function(){return recordResponse(entry[0]);});
            assert.strictEqual(await f.m.getRecordDisplayValue('incident',recordId),entry[1]);
            assert.match(f.calls[0].url,/sysparm_fields=sys_id,name,number,short_description&sysparm_limit=1$/);
        }
    });
    ['transport','json'].forEach(function(mode){test(mode+' errors degrade each helper and log without throwing',async function(){
        var f=await recordFixture(function(){if(mode==='transport')throw new Error('offline');return {ok:true,json:async function(){throw new Error('invalid JSON');}};});
        assert.strictEqual(await f.m.getRecordScope('incident',recordId),null);
        assert.strictEqual(await f.m.getRecordVersion('incident',recordId),null);
        assert.strictEqual(await f.m.getRecordDisplayValue('incident',recordId),recordId.slice(0,8));
        assert.strictEqual(f.calls.length,3);assert.strictEqual(f.errors.length,3);
    });});
});
