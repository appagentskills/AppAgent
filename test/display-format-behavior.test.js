// Generator output is parsed into an inert document: no generated handlers execute.
async function displayModule(){return loadModules(['src/js/tools/090-display-templates.js']);}
function displayDoc(html){return new DOMParser().parseFromString(html,'text/html');}
describe('display generator behavior',function(){
    test('all empty generators decline rendering',async function(){var m=await displayModule();for(var name of Object.keys(m.DISPLAY_GENERATORS))assert.strictEqual(m.DISPLAY_GENERATORS[name]({}),null,name);assert.deepStrictEqual(m.__unstubbed,[]);});
    test('table escapes headers and cells while aligning numeric object/array rows',async function(){
        var m=await displayModule(),d=displayDoc(m.generateTable({columns:['<label>','Count','Flag'],rows:[['<img src=x onerror=bad()>',3,true],{'<label>':'A&B',Count:'4',Flag:false}]}));
        assert.strictEqual(d.querySelector('th').textContent,'<label>▲');assert.strictEqual(d.querySelector('img'),null);
        assert.strictEqual(d.querySelectorAll('th.num').length,1);assert.strictEqual(d.querySelectorAll('td.num').length,2);
        assert.strictEqual(d.querySelectorAll('.display-badge-green').length,1);assert.strictEqual(d.querySelectorAll('.display-badge-red').length,1);
        assert.strictEqual(d.querySelectorAll('td')[3].textContent,'A&B');
    });
    test('badge class injection falls back and null cell is a placeholder',async function(){
        var m=await displayModule(),d=displayDoc(m.generateTable({columns:['Badge','Missing'],rows:[[{badge:'<b>Open</b>',color:'blue" onmouseover="bad()'},null]]}));
        assert.strictEqual(d.querySelector('.display-badge-blue').textContent,'<b>Open</b>');assert.strictEqual(d.querySelector('[onmouseover]'),null);assert.strictEqual(d.querySelector('.display-muted').textContent,'—');
    });
    test('table and card search controls obey their distinct thresholds',async function(){
        var m=await displayModule();
        assert.strictEqual(displayDoc(m.generateTable({columns:['x'],rows:Array(5).fill(['x'])})).querySelector('.display-search'),null);
        var table=displayDoc(m.generateTable({columns:['x'],rows:Array(6).fill(['x'])}));assert.strictEqual(table.querySelector('.display-row-count').textContent,'6 rows');assert.ok(table.querySelector('.display-search'));
        assert.strictEqual(displayDoc(m.generateCardList({cards:Array(6).fill({title:'x'})})).querySelector('.display-search'),null);
        assert.ok(displayDoc(m.generateCardList({cards:Array(7).fill({title:'x'})})).querySelector('.display-search'));
    });
    test('card detail and badge are escaped and expandable only when detail exists',async function(){
        var m=await displayModule(),d=displayDoc(m.generateCardList({cards:[{title:'<b>Title</b>',subtitle:'A&B',icon:'<svg>',badge:'<i>Badge</i>',badge_color:'red" onclick="bad()',detail:'<script>bad()</script>'},{title:'Plain'}]}));
        assert.strictEqual(d.querySelectorAll('.has-detail').length,1);assert.strictEqual(d.querySelectorAll('[onclick]').length,1);assert.strictEqual(d.querySelector('script'),null);
        assert.strictEqual(d.querySelector('.display-card-detail').textContent,'<script>bad()</script>');assert.ok(d.querySelector('.display-badge-blue'));
    });
    test('checklist carries stable owner id and checked state with escaped labels',async function(){
        var m=await displayModule(),d=displayDoc(m.generateChecklist({items:['<b>A</b>',{text:'B',description:'<img>',checked:true}]},'fixture_1'));
        assert.strictEqual(d.querySelector('.display-checklist').id,'dcl_fixture_1');assert.strictEqual(d.querySelector('.display-checklist').dataset.displayId,'fixture_1');
        assert.strictEqual(d.querySelectorAll('.checked').length,1);assert.strictEqual(d.querySelector('.display-check-label').textContent,'<b>A</b>');assert.strictEqual(d.querySelector('img'),null);
    });
    test('status zero is preserved and unsafe CSS color cannot create attributes',async function(){
        var m=await displayModule(),d=displayDoc(m.generateStatusSummary({items:[{count:0,value:9,label:'<b>Count</b>',color:'red'},{value:'A&B',color:'red" onmouseover="bad()'}]}));
        assert.strictEqual(d.querySelector('.display-status-count').textContent,'0');assert.match(d.querySelector('.display-status-card').getAttribute('style'),/var\(--danger\)/);
        assert.strictEqual(d.querySelector('[onmouseover]'),null);assert.strictEqual(d.querySelectorAll('.display-status-card')[1].hasAttribute('style'),false);
    });
    test('code preserves whitespace and trailing blank line without HTML execution',async function(){
        var m=await displayModule(),d=displayDoc(m.generateCode({code:'<script>x</script>\n  return 2;\n',language:'<js>'}));
        assert.strictEqual(d.querySelectorAll('.display-line-num').length,3);d.querySelectorAll('.display-line-num').forEach(function(n){n.remove();});
        assert.strictEqual(d.querySelector('pre').textContent,'<script>x</script>\n  return 2;\n\n');assert.strictEqual(d.querySelector('script'),null);assert.strictEqual(d.querySelector('.display-code-lang').textContent,'<js>');
    });
    test('timeline aliases render with safe class tokens and detail escaping',async function(){
        var m=await displayModule(),d=displayDoc(m.generateTimeline({events:[{date:'Today',label:'<b>Ready</b>',description:'A&B',color:'green'},{title:'Next',color:'red" onclick="bad()'}]}));
        assert.strictEqual(d.querySelectorAll('.display-tl-green').length,1);assert.strictEqual(d.querySelectorAll('.has-detail').length,1);assert.strictEqual(d.querySelector('.display-tl-time').textContent,'Today');assert.strictEqual(d.querySelector('.display-tl-detail').textContent,'A&B');assert.strictEqual(d.querySelectorAll('[onclick]').length,1);
    });
    test('bar chart scales values and handles zero totals with escaped labels',async function(){
        var m=await displayModule(),d=displayDoc(m.generateChart({data:[{label:'<img>',value:5,color:'green'},{label:'B',value:10,color:'red" onmouseover="bad()'}]}));
        assert.match(d.querySelector('.display-bar-fill').getAttribute('style'),/width:50%;background:var\(--success\)/);assert.match(d.querySelectorAll('.display-bar-fill')[1].getAttribute('style'),/^width:100%$/);assert.strictEqual(d.querySelector('img'),null);
        var z=displayDoc(m.generateChart({values:[0]}));assert.strictEqual(z.querySelector('.display-bar-fill').style.width,'0%');
    });
    test('pie chart total, percentages and zero slices are finite',async function(){
        var m=await displayModule(),d=displayDoc(m.generateChart({chart_type:'pie',labels:['A','B'],values:[1,3]}));
        assert.strictEqual(d.querySelector('.display-pie-total').textContent,'4');assert.match(d.querySelector('li').textContent,/25.0%/);assert.match(d.querySelector('.display-pie').getAttribute('style'),/0deg 90deg/);
        var zero=m.generateChart({chart_type:'pie',labels:['Z'],values:[0]});assert.ok(!/NaN|Infinity/.test(zero));
    });
    test('diff explicit changes count additions/deletions and suppress deleted line numbers',async function(){
        var m=await displayModule(),d=displayDoc(m.generateDiff({file:'<f>',changes:[' unchanged','-<old>','+<new>',{type:'add',content:'A&B'}]}));
        assert.strictEqual(d.querySelector('.display-diff-stat-add').textContent,'+2');assert.strictEqual(d.querySelector('.display-diff-stat-del').textContent,'−1');assert.strictEqual(d.querySelector('.display-diff-del .display-diff-num').textContent,'');assert.strictEqual(d.querySelector('.display-diff-file').textContent,'<f>');assert.strictEqual(d.querySelector('old'),null);
    });
    test('diff old/new comparison preserves context and counts changed lines',async function(){
        var m=await displayModule(),d=displayDoc(m.generateDiff({old:'same\nold',new:'same\nnew\nextra'}));assert.strictEqual(d.querySelectorAll('.display-diff-ctx').length,1);assert.strictEqual(d.querySelectorAll('.display-diff-add').length,2);assert.strictEqual(d.querySelectorAll('.display-diff-del').length,1);
    });
    test('untrusted diff type must not inject an event attribute',async function(){
        var state={fixture:{messages:[]}},saved=0;
        var m=await loadModules(['src/js/tools/090-display-templates.js'],{globals:{chats:state,currentChatId:'fixture',activeStreamingChatId:null,saveChatsToStorage:function(){saved++;}}});
        var result=m.executeDisplay({template:'diff',changes:[{type:'add" onmouseover="attacker()',text:'safe text'}]},0,{chatId:'fixture'});
        assert.strictEqual(result.success,true);assert.strictEqual(saved,1);assert.strictEqual(state.fixture.displays[result.id].template,'diff');
        var d=displayDoc(m.renderDisplayPlaceholder(result.id));
        assert.strictEqual(d.querySelector('[onmouseover]'),null,'change.type must be constrained before insertion into class attribute');
    });
});
