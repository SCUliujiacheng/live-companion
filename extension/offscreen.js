import {ConversationPolicy} from './core/policy.js';
import {generateReply,transcribeAudio} from './core/provider.js';
import {CompanionEngine} from './core/engine.js';
import {startCapture} from './audio/capture.js';

let engine=null,capture=null,sessionId=null,timer=null,settings=null,audioAbort=null,audioBusy=false,queued=null,audioEpoch=0,audioErrors=0,captureFailed=false;
let audioAfter=0,voiceReady=false;
const backgroundUrl=chrome.runtime.getURL('background.js');
function dispatch(message){return chrome.runtime.sendMessage({target:'background',...message});}
function clearAudio(){audioEpoch++;audioAfter=Date.now();audioAbort?.abort();audioAbort=null;queued=null;}
async function stop(){clearAudio();clearInterval(timer);timer=null;engine?.stop();await capture?.stop();capture=null;engine=null;sessionId=null;settings=null;}
async function segment(blob,metadata={}){
  if(!engine||engine.state.status!=='listening'||engine.state.singing)return;
  if(metadata.at&&metadata.at<audioAfter)return;
  // Retain at most the newest segment while a request is in flight.
  if(audioBusy){queued={blob,metadata};return;}
  audioBusy=true;const epoch=audioEpoch;const currentEngine=engine;const controller=new AbortController();audioAbort=controller;
  const capturedAt=metadata.at||Date.now();
  try{
    const result=await transcribeAudio(settings,blob,{signal:controller.signal});
    if(epoch!==audioEpoch||engine!==currentEngine||engine.state.status!=='listening')return;
    audioErrors=0;const text=typeof result==='string'?result:result?.text;
    if(text?.trim()&&Date.now()-capturedAt<20000){
      voiceReady=true;
      engine.addEvents([{id:crypto.randomUUID(),kind:'speech',text:text.trim(),user:'主播',at:capturedAt}]);
      void engine.tick();
    }
  }catch(error){
    if(epoch===audioEpoch&&!controller.signal.aborted&&engine===currentEngine){
      audioErrors++;engine.log(`语音转写失败：${error.message}`,'error');
      if(audioErrors>=3){engine.state.error=error.message;engine.pause('连续转写失败，已暂停接话');clearAudio();}
    }
  }finally{
    audioBusy=false;if(audioAbort===controller)audioAbort=null;
    const next=queued;queued=null;
    if(next&&epoch===audioEpoch)void segment(next.blob,next.metadata);
  }
}
async function start(message){
  await stop();sessionId=message.sessionId;settings=message.settings;captureFailed=false;audioErrors=0;voiceReady=false;
  const id=sessionId;
  engine=new CompanionEngine({settings,policy:new ConversationPolicy(settings),generate:generateReply,
    send:(text,meta)=>dispatch({type:'send',text,...meta}),
    emit:state=>dispatch({type:'state',sessionId:id,state}).catch(()=>{})});
  try{
    capture=await startCapture(message.streamId,{
      onSegment:(blob,meta)=>void segment(blob,meta),
      onLevel:level=>{if(engine){engine.state.level=level;}},
      onActivity:value=>engine?.setActivity(value),
      onEnded:()=>{captureFailed=true;if(engine){engine.state.error='直播声音已断开，请停止后重新开始';engine.pause(engine.state.error);clearAudio();}},
      onError:error=>{captureFailed=true;if(engine){engine.state.error=error.message||String(error);engine.pause('音频处理失败，请停止后重新开始');clearAudio();}}
    });
    engine.start({sessionId,room:message.room,mode:message.mode});
    timer=setInterval(()=>{if(engine){if(voiceReady)void engine.tick();engine.publish();}},1000);
    return {ok:true};
  }catch(error){await stop();throw error;}
}
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  if(message?.target!=='offscreen'||sender.id!==chrome.runtime.id||sender.url!==backgroundUrl)return;
  (async()=>{
    if(message.type==='start')return start(message);
    if(message.type==='stop'){await stop();return {ok:true};}
    if(!engine)return {ok:false,error:'尚未开始监听'};
    switch(message.type){
      case 'events':if(message.sessionId===sessionId)engine.addEvents(message.events);break;
      case 'pause':clearAudio();engine.pause();break;
      case 'resume':if(captureFailed)return {ok:false,error:'音频连接已结束，请先停止，再重新开始监听'};clearAudio();voiceReady=false;audioErrors=0;engine.resume();break;
      case 'cancel':engine.cancel();break;
      case 'singing':clearAudio();voiceReady=false;engine.setSinging(message.value);break;
      case 'send-now':return engine.sendNow();
      case 'snapshot':return {ok:true,state:engine.state};
      default:return {ok:false,error:'未知操作'};
    }
    return {ok:true};
  })().then(respond,error=>respond({ok:false,error:error.message}));return true;
});
