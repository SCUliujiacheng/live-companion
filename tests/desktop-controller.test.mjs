import test from 'node:test';
import assert from 'node:assert/strict';
import {DesktopController} from '../desktop/controller.js';
import {normalizeSettings} from '../extension/core/settings.js';

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const candidate={action:'reply',text:'家务也开始批量处理啦',reason:'接住洗碗话题',scene:'chat',confidence:0.9,respondsToSelf:false};
function harness(overrides={}){
  let now=1_800_000_000_000;
  let saved=normalizeSettings({chat:{apiKey:'private-chat-key'},transcription:{apiKey:'private-audio-key'}});
  const calls=[],emitted=[];
  const controller=new DesktopController({
    loadSettings:async()=>saved,saveSettings:async value=>{saved=value;},clearSettings:async()=>{saved=normalizeSettings({});},
    roomCommand:async(type,payload)=>{calls.push({type,...payload});return {ok:true};},
    captureStart:async sessionId=>{calls.push({type:'capture-start',sessionId});return {ok:true};},
    captureStop:async()=>{calls.push({type:'capture-stop'});},
    emit:state=>emitted.push(state),generate:async()=>candidate,transcribe:async()=> '我都是攒两顿的碗一起洗',now:()=>now,...overrides,
  });
  return {controller,calls,emitted,advance:ms=>{now+=ms;},time:()=>now,getSaved:()=>saved};
}
async function started(t,overrides={},mode='review'){
  const h=harness(overrides);t.after(()=>h.controller.command('stop'));
  await h.controller.setRoom({roomId:'123',title:'测试直播间'});
  assert.equal((await h.controller.command('start',{mode})).ok,true);
  return h;
}
async function voice(h){await h.controller.onSegment(new Blob(['wav'],{type:'audio/wav'}),{at:h.time()});await flush();}

test('desktop starts idle, exposes settings only through explicit get-state',async()=>{
  const h=harness();const result=await h.controller.command('get-state');
  assert.equal(result.ok,true);assert.equal(result.state.status,'idle');assert.equal(result.settings.chat.apiKey,'private-chat-key');
  assert.equal(h.calls.length,0);assert.doesNotMatch(JSON.stringify(h.emitted),/private-chat-key/);
});

test('desktop refuses missing room or keys without capturing audio',async()=>{
  const h=harness();assert.equal((await h.controller.command('start',{})).ok,false);
  await h.controller.setRoom({roomId:'123',title:'测试'});
  await h.controller.command('save-settings',{settings:normalizeSettings({})});
  assert.equal((await h.controller.command('start',{})).ok,false);
  assert.equal(h.calls.some(call=>call.type==='capture-start'),false);
});

test('account-based providers can start with no API key after their own readiness validation',async t=>{
  let validated=0;
  const h=harness({loadSettings:async()=>normalizeSettings({}),validateProviders:async()=>{validated++;}});
  t.after(()=>h.controller.command('stop'));
  await h.controller.setRoom({roomId:'123'});
  assert.equal((await h.controller.command('start')).ok,true);
  assert.equal(validated,1);assert.equal(h.controller.settings.chat.apiKey,'');
});

test('provider readiness error prevents attaching or capturing and cancelling readiness cannot revive start',async t=>{
  const waiting=deferred();const h=harness({validateProviders:()=>waiting.promise});
  t.after(()=>h.controller.command('stop'));
  await h.controller.setRoom({roomId:'123'});
  const start=h.controller.command('start');await flush();await h.controller.command('stop');
  waiting.resolve();assert.equal((await start).ok,false);
  assert.equal(h.calls.some(call=>call.type==='attach'||call.type==='capture-start'),false);
});

test('desktop attaches exactly the selected room and passes a session id to capture',async t=>{
  const h=await started(t);const attach=h.calls.find(call=>call.type==='attach');
  assert.equal(h.controller.state.status,'listening');assert.equal(attach.roomId,'123');
  assert.equal(h.calls.find(call=>call.type==='capture-start').sessionId,attach.sessionId);
  assert.equal(h.controller.state.mode,'review');
});

test('desktop waits for first voice transcription before using chat context',async t=>{
  let generations=0;const h=await started(t,{generate:async()=>{generations++;return candidate;}});
  h.controller.onRoomEvents([{id:'chat1',kind:'chat',user:'朋友',text:'洗碗真麻烦'}],h.controller.sessionId);
  await h.controller.tick();assert.equal(generations,0);
  await voice(h);assert.equal(generations,1);assert.equal(h.controller.state.pending.text,candidate.text);
  h.advance(6000);await h.controller.tick();assert.equal(h.calls.filter(call=>call.type==='send').length,0);
});

test('desktop auto mode uses real policy cooldown and countdown and sends once',async t=>{
  const h=await started(t,{},'auto');await voice(h);
  h.advance(4999);await h.controller.tick();assert.equal(h.calls.some(call=>call.type==='send'),false);
  h.advance(1);await h.controller.tick();await h.controller.tick();
  assert.equal(h.calls.filter(call=>call.type==='send').length,1);assert.equal(h.controller.state.sentCount,1);
  h.advance(1000);await voice(h);assert.equal(h.controller.state.pending,null);
});

test('desktop pause aborts generation and late completion cannot create a reply',async t=>{
  const answer=deferred();let signal;const h=await started(t,{generate:async(s,e,o)=>{signal=o.signal;return answer.promise;}});
  await h.controller.onSegment(new Blob(['wav']),{at:h.time()});await flush();
  await h.controller.command('pause');assert.equal(signal.aborted,true);
  answer.resolve(candidate);await flush();assert.equal(h.controller.state.pending,null);assert.equal(h.controller.state.status,'paused');
});

test('desktop stop dispatches cancel and detach before awaiting capture shutdown',async t=>{
  const shutdown=deferred();const calls=[];
  const h=await started(t,{roomCommand:async(type,payload)=>{calls.push({type,...payload});return {ok:true};},captureStop:()=>{calls.push({type:'capture-stop'});return shutdown.promise;}});
  const stopping=h.controller.command('stop');
  assert.equal(h.controller.state.status,'idle');
  assert.deepEqual(calls.slice(-3).map(call=>call.type),['cancel-send','detach','capture-stop']);
  shutdown.resolve();assert.equal((await stopping).ok,true);
});

test('desktop stop during capture startup cannot leave audio or revive the session',async t=>{
  const capture=deferred();let starts=0,stops=0;
  const h=harness({captureStart:async()=>{starts++;return capture.promise;},captureStop:async()=>{stops++;}});
  t.after(()=>h.controller.command('stop'));await h.controller.setRoom({roomId:'123',title:'测试'});
  const opening=h.controller.command('start');await flush();assert.equal(starts,1);
  const stopping=h.controller.command('stop');capture.resolve({ok:true});
  await stopping;assert.equal((await opening).ok,false);assert.equal(h.controller.state.status,'idle');assert.equal(h.controller.sessionId,null);assert.ok(stops>=2);
});

test('desktop late room attach is detached after cancellation',async t=>{
  const attached=deferred();const calls=[];let captureStarts=0;
  const h=harness({roomCommand:async(type,payload)=>{calls.push({type,...payload});return type==='attach'?attached.promise:{ok:true};},captureStart:async()=>{captureStarts++;return {ok:true};}});
  t.after(()=>h.controller.command('stop'));await h.controller.setRoom({roomId:'123',title:'测试'});
  const opening=h.controller.command('start');await flush();await h.controller.command('stop');
  const detachedBefore=calls.filter(call=>call.type==='detach').length;attached.resolve({ok:true});
  assert.equal((await opening).ok,false);assert.ok(calls.filter(call=>call.type==='detach').length>detachedBefore);assert.equal(captureStarts,0);
});

test('desktop cancellation while a send awaits confirmation cannot mark it sent',async t=>{
  const delivered=deferred();const calls=[];
  const h=await started(t,{roomCommand:async(type,payload)=>{calls.push({type,...payload});return type==='send'?delivered.promise:{ok:true};}});
  await voice(h);const sending=h.controller.command('send-now');await flush();
  await h.controller.command('cancel');delivered.resolve({ok:true});
  assert.equal((await sending).ok,false);assert.equal(h.controller.state.sentCount,0);assert.equal(h.controller.state.pending,null);
  assert.ok(calls.some(call=>call.type==='cancel-send'));
});

test('desktop audio queue retains only the latest waiting segment',async t=>{
  const first=deferred(),texts=[];
  const h=await started(t,{transcribe:async(s,blob)=>{const text=await blob.text();texts.push(text);return texts.length===1?first.promise:'新话题';}});
  const work=h.controller.onSegment(new Blob(['first']),{at:h.time()});await flush();
  h.advance(1000);await h.controller.onSegment(new Blob(['middle']),{at:h.time()});
  h.advance(1000);await h.controller.onSegment(new Blob(['latest']),{at:h.time()});
  first.resolve('第一段');await work;await flush();assert.deepEqual(texts,['first','latest']);
});

test('desktop pending chat request does not block new transcription',async t=>{
  const answer=deferred();let count=0;
  const h=await started(t,{generate:async()=>answer.promise,transcribe:async()=>{count++;return '主播正在接着说话';}});
  await h.controller.onSegment(new Blob(['one']),{at:h.time()});await flush();
  h.advance(1000);await h.controller.onSegment(new Blob(['two']),{at:h.time()});assert.equal(count,2);
  answer.resolve(candidate);await flush();assert.equal(h.controller.state.pending,null);
});

test('desktop pause and resume discard old audio and require fresh voice',async t=>{
  let count=0;const h=await started(t,{transcribe:async()=>{count++;return '新的语音';}});
  const before=h.time();await h.controller.command('pause');h.advance(5000);await h.controller.command('resume');
  await h.controller.onSegment(new Blob(['old']),{at:before});assert.equal(count,0);
  h.controller.onRoomEvents([{id:'chat2',text:'弹幕',user:'观众'}],h.controller.sessionId);await h.controller.tick();assert.equal(h.controller.state.pending,null);
  await voice(h);assert.equal(count,1);
});

test('desktop capture loss requires a new start instead of pretending resume succeeded',async t=>{
  const h=await started(t);h.controller.onCaptureEnded(new Error('音轨断开'),h.controller.sessionId);
  assert.equal(h.controller.state.status,'paused');assert.equal((await h.controller.command('resume')).ok,false);
});

test('desktop ignores events from an old session and a room change stops capture',async t=>{
  const h=await started(t);const old=h.controller.sessionId;
  await h.controller.setRoom({roomId:'456',title:'另一个房间'});
  h.controller.onRoomEvents([{id:'old',text:'旧消息',user:'观众'}],old);
  assert.equal(h.controller.state.status,'idle');assert.equal(h.controller.state.room.roomId,'456');assert.equal(h.controller.state.events.length,0);
  assert.ok(h.calls.some(call=>call.type==='capture-stop'));
});

test('desktop clear-data stops, clears saved settings and removes context and room',async t=>{
  const h=await started(t);await voice(h);assert.ok(h.controller.state.events.length);
  assert.equal((await h.controller.command('clear-data')).ok,true);
  const result=await h.controller.command('get-state');assert.equal(result.state.room,null);assert.deepEqual(result.state.events,[]);assert.deepEqual(result.state.logs,[]);assert.equal(result.settings.chat.apiKey,'');
});

test('desktop does not emit configured secrets even when injected transport errors contain them',async t=>{
  const h=await started(t,{generate:async()=>{throw Error('private-chat-key failed');}});await voice(h);
  assert.equal(h.controller.state.status,'paused');assert.doesNotMatch(JSON.stringify(h.emitted),/private-chat-key|private-audio-key/);
});

test('desktop saving settings while live is rejected and unknown commands fail closed',async t=>{
  const h=await started(t);
  assert.equal((await h.controller.command('save-settings',{settings:normalizeSettings({})})).ok,false);
  assert.equal((await h.controller.command('unknown')).ok,false);
  assert.equal(h.getSaved().chat.apiKey,'private-chat-key');
});

test('desktop concurrent start with an explicit room cannot open two captures',async t=>{
  let captures=0;const h=harness({captureStart:async()=>{captures++;return {ok:true};}});t.after(()=>h.controller.command('stop'));
  const first=h.controller.command('start',{room:{roomId:'123',title:'测试'}});
  const second=h.controller.command('start',{room:{roomId:'123',title:'测试'}});
  const results=await Promise.all([first,second]);
  assert.equal(results.filter(result=>result.ok).length,1);assert.equal(captures,1);
});

test('desktop malformed saved configuration becomes a visible error without rejecting startup readiness',async()=>{
  const h=harness({loadSettings:async()=>({chat:{baseUrl:'http://untrusted.example/v1'}})});
  await assert.doesNotReject(h.controller.ready);
  const result=await h.controller.command('get-state');assert.equal(result.ok,true);assert.match(result.state.error,/API 地址/);assert.equal(result.state.status,'error');assert.equal(result.settings.chat.apiKey,'');
  assert.equal((await h.controller.command('clear-data')).ok,true);
  assert.equal((await h.controller.command('get-state')).state.status,'idle');
});

test('desktop failed audio shutdown is reported without leaking transport details',async t=>{
  const h=await started(t,{captureStop:async()=>{throw Error('private-audio-key audio device failed');}});
  const result=await h.controller.command('stop');assert.equal(result.ok,false);assert.match(result.error,/audio device failed/);assert.doesNotMatch(result.error,/private-audio-key/);
});
