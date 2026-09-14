import test from 'node:test';
import assert from 'node:assert/strict';
import { CompanionEngine } from '../extension/core/engine.js';

function harness(generate) {
  let time = 100_000; const sent = []; const events = []; let used = false;
  const policy = { events, addEvent(e) { events.push(e); used = false; }, canGenerate() {return events.length > 0 && !used;}, getContext() {return events;}, consider(c) {used=true; return {ok:c.action==='reply',text:c.text,reason:c.reason};}, markSent(t) {events.push({kind:'self',text:t,at:time});}, cancelPending() {used=true;} };
  const engine = new CompanionEngine({settings:{countdownSec:5,maxLength:30}, policy, generate, send: async text=>{sent.push(text);return {ok:true};}, emit:()=>{}, now:()=>time});
  engine.start({mode:'auto',sessionId:'s1',room:{roomId:'123'}});
  return {engine,sent,advance:n=>{time+=n;}};
}
const reply = {action:'reply',text:'家务也开始批量处理啦',reason:'接当前话题',scene:'chat',confidence:0.9};
test('pause invalidates a reply whose model request finishes late',async()=>{
  let resolve; const h=harness(()=>new Promise(r=>{resolve=r;}));
  h.engine.addEvents([{id:'1',kind:'speech',text:'攒两顿碗一起洗',at:100000}]);
  const task=h.engine.tick(); h.engine.pause(); resolve(reply); await task;
  h.advance(10000); await h.engine.tick(); assert.equal(h.engine.state.pending,null); assert.deepEqual(h.sent,[]);
});
test('new speech cancels a pending old-topic message before countdown',async()=>{
  const h=harness(async()=>reply); h.engine.addEvents([{id:'1',kind:'speech',text:'洗碗',at:100000}]);
  await h.engine.tick(); assert.ok(h.engine.state.pending);
  h.advance(1000); h.engine.addEvents([{id:'2',kind:'speech',text:'说回今天的天气',at:101000}]);
  assert.equal(h.engine.state.pending,null); assert.deepEqual(h.sent,[]);
});
test('automatic message waits its countdown and sends once',async()=>{
  const h=harness(async()=>reply); h.engine.addEvents([{id:'1',kind:'speech',text:'洗碗',at:100000}]);
  await h.engine.tick(); h.advance(4999); await h.engine.tick(); assert.equal(h.sent.length,0);
  h.advance(1); await h.engine.tick(); await h.engine.tick(); assert.equal(h.sent.length,1);
});
test('uncertain send pauses and is never automatically retried',async()=>{
  let attempts=0; const h=harness(async()=>reply); h.engine.send=async()=>{attempts++;return {ok:false,uncertain:true,error:'未确认送达'};};
  h.engine.addEvents([{id:'1',kind:'speech',text:'洗碗',at:100000}]); await h.engine.tick(); h.advance(5001);
  await h.engine.tick(); h.advance(60000); await h.engine.tick(); assert.equal(attempts,1);assert.equal(h.engine.state.status,'paused');
});
test('review mode never sends on timer, and stop makes send-now inert',async()=>{
  const h=harness(async()=>reply); h.engine.state.mode='review'; h.engine.addEvents([{id:'1',kind:'speech',text:'洗碗',at:100000}]);await h.engine.tick();
  h.advance(6000);await h.engine.tick();assert.equal(h.sent.length,0);h.engine.stop();await h.engine.sendNow();assert.equal(h.sent.length,0);
});
