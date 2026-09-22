// Actual prompt_user tool. Only DOM form elements, rendering and persistence are fakes.
describe('prompt_user lifecycle',function(){
    var m,g,chats,saves,renders,sw,injected,forms;
    function field(name,type,value,required){return {getAttribute:function(a){return a==='data-field-name'?name:a==='data-field-type'?type:a==='data-required'?(required?'1':'0'):null;},tagName:type==='select'?'SELECT':'INPUT',value:value,checked:value===true,querySelector:function(){return null;},closest:function(){return {classList:{add:function(){},remove:function(){}}};}};}
    function form(fields){return {querySelectorAll:function(sel){return sel==='[data-field-name]'?fields:[];},querySelector:function(){return null;},appendChild:function(){}};}
    beforeEach(async function(){
        chats={a:{id:'a',messages:[]},b:{id:'b',messages:[]}};saves=0;renders=0;sw=[];injected=[];forms={};
        g={chats:chats,activeStreamingChatId:null,currentChatId:'a',currentView:'chat',
            document:{getElementById:function(id){return forms[id]||null;},createElement:function(){return {};}},
            setTimeout:function(){},saveChatsToStorage:function(){saves++;},renderMessages:function(){renders++;},scrollToBottomIfAllowed:function(){},
            postPromptRowToSW:function(id,row){sw.push([id,row.promptId]);},_promptResultViaSW:function(){return false;},
            recordToolResult:function(chat,tc,name,content){injected.push([chat.id,tc,JSON.parse(content)]);},runAgent:function(){return Promise.resolve();},console:console};
        m=await loadModules(['src/js/tools/100-prompt-user.js'],{globals:g});
    });
    test('rejects empty fields and unknown chats without registering resolvers',async function(){
        assert.deepStrictEqual(await m.executePromptUser({fields:[]}),{success:false,error:'fields array is required'});
        assert.strictEqual((await m.executePromptUser({fields:[{name:'q',type:'text'}]},{chatId:'missing'})).success,false);
        assert.deepStrictEqual(Object.keys(m.pendingPromptResolvers),[]);assert.deepStrictEqual(chats.a.messages,[]);
    });
    test('constrained forms gain a free-text escape hatch and replay adopts the pending row',async function(){
        var p1=m.executePromptUser({fields:[{name:'c',type:'select',options:['x']}]},{chatId:'b',toolCallId:'tc1'});await Promise.resolve();
        var row=chats.b.messages[0];assert.strictEqual(row.status,'pending');assert.strictEqual(row.fields[1].name,'free_text_response');
        assert.deepStrictEqual(sw,[['b',row.promptId]]);
        var p2=m.executePromptUser({fields:[{name:'c',type:'select',options:['x']}]},{chatId:'b',toolCallId:'tc1'});await Promise.resolve();
        assert.strictEqual(chats.b.messages.length,1);assert.strictEqual(sw.length,1);assert.strictEqual(renders,0);
        forms['prompt-form-'+row.promptId]=form([field('c','select','x'),field('free_text_response','textarea','')]);
        assert.strictEqual(m.submitPromptUser(row.promptId,'b'),true);
        var r2=await p2;
        assert.deepStrictEqual(r2.values,{c:'x',free_text_response:''});assert.strictEqual(r2._message_persist,row);
        // Replay re-arms the resolver for the SAME promptId, so the original awaiter
        // is abandoned (never settles). Documented behavior; safe only because the
        // first executor context is gone after a real reload.
        var first=await Promise.race([p1.then(function(){return 'settled';}),Promise.resolve().then(function(){return 'abandoned';})]);
        assert.strictEqual(first,'abandoned');
        assert.strictEqual(row.status,'submitted');assert.strictEqual(m.pendingPromptResolvers[row.promptId],undefined);
    });
    test('required validation blocks submit and keeps the prompt pending',async function(){
        var p=m.executePromptUser({fields:[{name:'q',type:'text',required:true}]},{chatId:'a'});await Promise.resolve();
        var row=chats.a.messages[0];forms['prompt-form-'+row.promptId]=form([field('q','text','',true),field('n','number','abc',true)]);
        assert.strictEqual(m.submitPromptUser(row.promptId,'a'),false);assert.strictEqual(row.status,'pending');
        assert.strictEqual(typeof m.pendingPromptResolvers[row.promptId],'function');
        assert.strictEqual(m.submitPromptUser('unknown','a'),false);
        m.cancelPromptUser(row.promptId,'a');var r=await p;
        assert.deepStrictEqual([r.success,r.cancelled,row.status],[false,true,'cancelled']);assert.strictEqual(injected.length,0);
    });
    test('answers after reload inject exactly one tool_result for the matching call and only for that chat',async function(){
        chats.b.messages=[{role:'prompt_user',promptId:'p9',toolCallId:'tc9',status:'pending'}];
        forms['prompt-form-p9']=form([field('q','text','yes')]);
        assert.strictEqual(m.submitPromptUser('p9','b'),true);await Promise.resolve();
        assert.deepStrictEqual(injected,[['b','tc9',{success:true,values:{q:'yes'}}]]);assert.strictEqual(renders,1);
        assert.strictEqual(chats.a.messages.length,0);
        m.cancelPromptUser('p9','b');assert.strictEqual(injected.length,2);assert.strictEqual(injected[1][2].cancelled,true);
    });
});
