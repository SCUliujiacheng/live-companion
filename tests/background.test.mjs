import test from 'node:test';
import assert from 'node:assert/strict';

test('pause/cancel/stop while room validation awaits cannot forward an old send',async()=>{
  for(const action of ['pause','cancel','stop','singing']){
    let handler,resolveTab;const forwarded=[];
    const stored={activeSession:{id:'session',tabId:7,roomId:'123'},room:{tabId:7,roomId:'123'},state:{status:'listening',singing:false,pending:{text:'old'}}};
    const area={setAccessLevel:async()=>{},get:async()=>stored,set:async values=>Object.assign(stored,values),remove:async keys=>{for(const k of Array.isArray(keys)?keys:[keys])delete stored[k];}};
    const event={addListener(){}};
    globalThis.chrome={
      runtime:{id:'unit',getURL:path=>`chrome-extension://unit/${path}`,onMessage:{addListener:fn=>{handler=fn;}},getContexts:async()=>[{contextType:'OFFSCREEN_DOCUMENT'}],sendMessage:async()=>({ok:true})},
      storage:{local:area,session:area},action:{onClicked:event},sidePanel:{open:async()=>{}},
      tabs:{onRemoved:event,onUpdated:event,get:()=>new Promise(r=>{resolveTab=r;}),sendMessage:async(id,msg)=>{forwarded.push(msg);return {ok:true};}},
      offscreen:{closeDocument:async()=>{}}
    };
    await import(`../extension/background.js?case=${action}`);
    const invoke=(type,sender,extra={})=>new Promise(resolve=>handler({target:'background',type,...extra},{id:'unit',url:`chrome-extension://unit/${sender}`},resolve));
    const sending=invoke('send','offscreen.html',{sessionId:'session',text:'old',messageId:'m1'});
    while(!resolveTab)await new Promise(r=>setImmediate(r));
    const cancelled=await invoke(action,'sidepanel.html',{value:true});assert.equal(cancelled.ok,true);
    resolveTab({id:7,url:'https://live.bilibili.com/123',title:'room'});
    assert.equal((await sending).ok,false,action);
    assert.equal(forwarded.filter(m=>m.type==='send').length,0,action);
  }
  delete globalThis.chrome;
});

test('stop notifies the page before waiting for storage or audio shutdown',async()=>{
  let handler,releaseRemoval;const sent=[];
  const stored={activeSession:{id:'s',tabId:7,roomId:'123'},state:{status:'listening'}};
  const event={addListener(){}};
  const area={setAccessLevel:async()=>{},get:async()=>stored,set:async()=>{},remove:()=>new Promise(r=>{releaseRemoval=r;})};
  globalThis.chrome={runtime:{id:'unit',getURL:p=>`chrome-extension://unit/${p}`,onMessage:{addListener:f=>{handler=f;}},getContexts:async()=>[],sendMessage:async()=>({ok:true})},storage:{local:area,session:area},action:{onClicked:event},tabs:{onRemoved:event,onUpdated:event,sendMessage:async(id,m)=>{sent.push(m);return {ok:true};}}};
  await import('../extension/background.js?case=stop-order');
  const stopped=new Promise(resolve=>handler({target:'background',type:'stop'},{id:'unit',url:'chrome-extension://unit/sidepanel.html'},resolve));
  while(!releaseRemoval)await new Promise(r=>setImmediate(r));
  assert.equal(sent[0]?.type,'detach');releaseRemoval();assert.equal((await stopped).ok,true);delete globalThis.chrome;
});

test('a panel state query during capture startup cannot erase the new session',async()=>{
  let handler,releaseContexts;let exists=false,contextCalls=0;
  const room={tabId:7,roomId:'123',title:'test'};
  const stored={room,state:{status:'idle',room},secrets:{chatApiKey:'test-key',transcriptionApiKey:'test-key'}};
  const event={addListener(){}};
  const area={setAccessLevel:async()=>{},get:async()=>({...stored}),set:async value=>Object.assign(stored,value),remove:async key=>{delete stored[key];}};
  globalThis.chrome={
    runtime:{id:'unit',getURL:p=>`chrome-extension://unit/${p}`,onMessage:{addListener:f=>{handler=f;}},sendMessage:async()=>({ok:true}),getContexts:async()=>{if(++contextCalls===1)return new Promise(r=>{releaseContexts=r;});return exists?[{}]:[];}},
    storage:{local:area,session:area},action:{onClicked:event},permissions:{contains:async()=>true},scripting:{executeScript:async()=>{}},
    tabs:{onRemoved:event,onUpdated:event,get:async()=>({id:7,url:'https://live.bilibili.com/123'}),sendMessage:async()=>({ok:true})},
    offscreen:{createDocument:async()=>{exists=true;},closeDocument:async()=>{exists=false;}},tabCapture:{getMediaStreamId:async()=>'test-stream'}
  };
  await import('../extension/background.js?case=start-query');
  const invoke=(type,url='sidepanel.html',extra={})=>new Promise(resolve=>handler({target:'background',type,...extra},{id:'unit',url:`chrome-extension://unit/${url}`},resolve));
  const starting=invoke('start');while(!releaseContexts)await new Promise(r=>setImmediate(r));
  const id=stored.activeSession.id;
  assert.equal((await invoke('get-state')).state.status,'starting');
  releaseContexts([]);assert.equal((await starting).ok,true);
  assert.equal((await invoke('state','offscreen.html',{sessionId:id,state:{status:'listening',room}})).ok,true);
  assert.equal((await invoke('get-state')).state.status,'listening');delete globalThis.chrome;
});

test('cancel blocks a send initiated while cancellation acknowledgement is pending',async()=>{
  let handler,releasePublish;const sent=[];
  const stored={activeSession:{id:'s',tabId:7,roomId:'123'},state:{status:'listening',singing:false,pending:{text:'old'}}};
  const event={addListener(){}};
  const area={setAccessLevel:async()=>{},get:async()=>stored,set:values=>new Promise(r=>{Object.assign(stored,values);releasePublish=r;}),remove:async()=>{}};
  globalThis.chrome={runtime:{id:'unit',getURL:p=>`chrome-extension://unit/${p}`,onMessage:{addListener:f=>{handler=f;}},getContexts:async()=>[{}],sendMessage:async()=>({ok:true})},storage:{local:area,session:area},action:{onClicked:event},tabs:{onRemoved:event,onUpdated:event,get:async()=>({id:7,url:'https://live.bilibili.com/123'}),sendMessage:async(id,m)=>{sent.push(m);return {ok:true};}}};
  await import('../extension/background.js?case=cancel-barrier');
  const invoke=(type,url,extra={})=>new Promise(resolve=>handler({target:'background',type,...extra},{id:'unit',url:`chrome-extension://unit/${url}`},resolve));
  const cancel=invoke('cancel','sidepanel.html');while(!releasePublish)await new Promise(r=>setImmediate(r));
  assert.equal((await invoke('send','offscreen.html',{sessionId:'s',text:'late',messageId:'m'})).ok,false);
  assert.equal(sent.filter(m=>m.type==='send').length,0);
  releasePublish();assert.equal((await cancel).ok,true);delete globalThis.chrome;
});
