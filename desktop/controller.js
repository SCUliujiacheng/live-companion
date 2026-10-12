import {DEFAULT_SETTINGS, normalizeSettings} from '../extension/core/settings.js';
import {ConversationPolicy} from '../extension/core/policy.js';
import {CompanionEngine} from '../extension/core/engine.js';
import {generateReply, transcribeAudio, testProvider} from '../extension/core/provider.js';

const initialState=room=>({status:'idle',room,mode:'review',singing:false,level:0,events:[],logs:[],pending:null,sentCount:0,error:'',activity:room?'直播间已就绪，填写 API 后开始':'请先选择 B站直播间'});
const clean=(value,max=500)=>typeof value==='string'?value.trim().slice(0,max):'';
const call=(fn,...args)=>{try{return Promise.resolve(fn(...args));}catch(error){return Promise.reject(error);}};

function normalizeRoom(room){
  if(room===null)return null;
  const roomId=String(room?.roomId||'');
  if(!/^[1-9]\d*$/.test(roomId))throw new Error('请提供有效的数字直播间编号');
  return {roomId,title:clean(room.title,200)||`直播间 ${roomId}`};
}

/**
 * Main-process orchestration. No Electron, disk, credentials, or page globals
 * are accessed here; the application supplies the trusted transport/storage.
 *
 * Dependencies:
 * loadSettings() -> full settings; saveSettings(settings); clearSettings();
 * roomCommand(type, {sessionId, roomId?, text?, messageId?}) -> {ok,error?};
 * captureStart(sessionId: string) -> {ok,error?}; captureStop(); emit(state).
 * Main must reject untrusted IPC senders before invoking these methods.
 *
 * Public API: command(type,payload={}), setRoom(room|null), tick(),
 * onRoomEvents(events,sessionId), onSegment(blob,{at,durationMs,sessionId?}),
 * onLevel(level,sessionId?), onActivity({speaking},sessionId?),
 * onCaptureEnded(error?,sessionId?). Optional callback session ids should be
 * provided by main when possible, so old renderer callbacks are discarded.
 * `onSegment` waits for transcription only, never for the chat request.
 * `state` contains display data only; keys are returned only by get-state.
 */
export class DesktopController {
  constructor({loadSettings,saveSettings,clearSettings,roomCommand,captureStart,captureStop,emit,generate=generateReply,transcribe=transcribeAudio,validateProviders,now=Date.now}){
    for(const [name,fn] of Object.entries({loadSettings,saveSettings,clearSettings,roomCommand,captureStart,captureStop,emit,generate,transcribe,now})){
      if(typeof fn!=='function')throw new TypeError(`DesktopController requires ${name}`);
    }
    Object.assign(this,{loadSettings,saveSettings,clearSettings,roomCommand,captureStart,captureStop,emit,generate,transcribe,now});
    this.validateProviders=validateProviders||((settings)=>{if(!settings.chat.apiKey||!settings.transcription.apiKey)throw new Error('请填写聊天和语音转写 API Key');});
    this.settings=normalizeSettings(DEFAULT_SETTINGS);this.room=null;this.state=initialState(null);
    this.session=null;this.engine=null;this.starting=false;this.stopping=null;this.settingsBusy=false;
    this.lifecycle=0;this.sendEpoch=0;this.roomVersion=0;this.timer=null;this.captureStarting=null;
    this.audioEpoch=0;this.audioAfter=0;this.audioRequest=null;this.queued=null;this.audioErrors=0;this.voiceReady=false;this.captureFailed=false;
    this.ready=call(loadSettings).then(value=>{this.settings=normalizeSettings(value);}).catch(error=>{this.loadError=this.safeError(error,'无法读取 API 设置');});
  }

  get sessionId(){return this.session?.id||null;}
  safeError(error,fallback='操作失败'){
    let message=typeof error?.message==='string'?error.message:typeof error==='string'?error:fallback;
    for(const key of [this.settings.chat.apiKey,this.settings.transcription.apiKey])if(key)message=message.split(key).join('[密钥已隐藏]');
    return message.replace(/\bsk-(?:(?:proj|svcacct)-)?[A-Za-z0-9_-]{20,}\b/g,'[密钥已隐藏]').slice(0,500);
  }
  publish(state=this.state){
    // Sanitize nested display strings, including injected transport error text.
    const scrub=value=>typeof value==='string'?this.safeError(value):Array.isArray(value)?value.map(scrub):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,item])=>[key,scrub(item)])):value;
    this.state=scrub(state);
    try{Promise.resolve(this.emit(structuredClone(this.state))).catch(()=>{});}catch{/* A closed renderer cannot revive or break a session. */}
  }
  validSession(id){return !!this.session&&(!id||id===this.session.id);}
  clearAudio(){
    this.audioEpoch++;this.audioAfter=this.now();this.audioRequest?.controller.abort();this.queued=null;
  }
  cancelPage(){
    this.sendEpoch++;
    return this.session?call(this.roomCommand,'cancel-send',{sessionId:this.session.id}).catch(()=>({ok:false})):Promise.resolve({ok:true});
  }

  async setRoom(room){
    const normalized=normalizeRoom(room);const version=++this.roomVersion;
    if(this.room?.roomId===normalized?.roomId){this.room=normalized;this.publish({...this.state,room:normalized});return {ok:true,state:this.state};}
    if(this.session||this.starting||this.stopping)await this.stop();
    if(version!==this.roomVersion)return {ok:false,error:'直播间选择已改变'};
    this.room=normalized;this.publish(initialState(normalized));return {ok:true,state:this.state};
  }

  async start(payload={}){
    if(this.starting||this.stopping||this.session||this.settingsBusy)throw new Error('请等待当前操作结束，或先停止监听');
    if(payload.room){this.room=normalizeRoom(payload.room);this.roomVersion++;this.publish(initialState(this.room));}
    if(!this.room)throw new Error('请先选择 B站直播间');
    this.starting=true;const version=++this.lifecycle;
    const room={...this.room},session={id:crypto.randomUUID(),roomId:room.roomId};
    const ensureCurrent=()=>{if(version!==this.lifecycle||this.room?.roomId!==room.roomId)throw new Error('开始操作已取消');};
    try{
      await this.ready;ensureCurrent();if(this.loadError)throw new Error(this.loadError);
      await this.validateProviders(this.settings);ensureCurrent();
      this.session=session;this.captureFailed=false;this.voiceReady=false;this.audioErrors=0;this.clearAudio();
      this.publish({...initialState(room),status:'starting',activity:'正在连接直播声音'});
      const attached=await this.roomCommand('attach',{sessionId:session.id,roomId:room.roomId});
      ensureCurrent();
      if(!attached?.ok)throw new Error(this.safeError(attached?.error,'无法连接直播间弹幕'));
      const engine=new CompanionEngine({settings:this.settings,policy:new ConversationPolicy(this.settings),now:this.now,
        generate:async(...args)=>{try{return await this.generate(...args);}catch(error){throw new Error(this.safeError(error,'AI 请求失败'));}},
        send:(text,meta)=>this.send(text,meta),
        emit:state=>{if(this.session?.id===session.id&&this.engine===engine)this.publish(state);},
      });
      this.engine=engine;
      const opening=call(this.captureStart,session.id);this.captureStarting=opening;
      let captureResult;
      try{captureResult=await opening;}finally{if(this.captureStarting===opening)this.captureStarting=null;}
      ensureCurrent();
      if(this.captureFailed)throw new Error('直播声音已断开，请重新开始');
      if(!captureResult?.ok)throw new Error(this.safeError(captureResult?.error,'无法开始声音捕获'));
      engine.start({sessionId:session.id,room,mode:payload.mode==='auto'?'auto':'review'});
      this.timer=setInterval(()=>{void this.tick();},1000);this.timer.unref?.();
      return {ok:true};
    }catch(error){
      const message=this.safeError(error,'无法开始监听');
      if(version===this.lifecycle){await this.stop();this.publish({...this.state,status:'error',error:message,activity:message});}
      else await call(this.roomCommand,'detach',{sessionId:session.id}).catch(()=>{});
      return {ok:false,error:message};
    }finally{this.starting=false;}
  }

  stop(){
    if(this.stopping)return this.stopping;
    this.lifecycle++;this.sendEpoch++;
    const session=this.session,engine=this.engine,pendingCapture=this.captureStarting;
    // Dispatch page cancellation before the first await. It cancels the page's
    // pre-click wait even if audio shutdown or an earlier start is still pending.
    const cancel=session?call(this.roomCommand,'cancel-send',{sessionId:session.id}):Promise.resolve();
    const detach=session?call(this.roomCommand,'detach',{sessionId:session.id}):Promise.resolve();
    this.session=null;this.engine=null;clearInterval(this.timer);this.timer=null;
    this.clearAudio();this.voiceReady=false;engine?.stop();
    this.publish({...this.state,status:'idle',singing:false,pending:null,level:0,activity:'已停止监听'});
    const firstCaptureStop=call(this.captureStop);
    const operation=(async()=>{
      const results=await Promise.allSettled([cancel,detach,firstCaptureStop]);
      let captureError=results[2].status==='rejected'?results[2].reason:results[2].value?.ok===false?results[2].value.error||'无法关闭声音捕获':null;
      // Capture may finish opening after an early stop. Close it again before
      // allowing another session to begin; never stop a newer session's capture.
      if(pendingCapture){
        await pendingCapture.catch(()=>{});
        try{const result=await this.captureStop();captureError=result?.ok===false?result.error||'无法关闭声音捕获':null;}
        catch(error){captureError=error;}
      }
      if(captureError){const error=this.safeError(captureError,'无法关闭声音捕获');this.captureFailed=true;this.publish({...this.state,status:'error',error,activity:'音频关闭未确认，请检查播放页面或关闭应用'});return {ok:false,error};}
      return {ok:true};
    })();
    this.stopping=operation;
    operation.finally(()=>{if(this.stopping===operation)this.stopping=null;}).catch(()=>{});
    return operation;
  }

  async send(text,meta){
    const session=this.session,engine=this.engine,version=this.sendEpoch;
    const allowed=()=>session&&this.session?.id===session.id&&meta.sessionId===session.id&&this.room?.roomId===session.roomId&&this.engine===engine&&engine.state.status==='listening'&&!engine.state.singing&&version===this.sendEpoch;
    if(!allowed())return {ok:false,error:'发送已取消或直播间已改变'};
    let result;
    try{result=await this.roomCommand('send',{...meta,roomId:session.roomId,text});}
    catch(error){result={ok:false,uncertain:true,error:this.safeError(error,'发送未确认，请查看直播间')};}
    if(!allowed())return {ok:false,uncertain:!!result?.ok||!!result?.uncertain,error:'会话已改变，请以直播间发送结果为准'};
    return result?.ok?{ok:true}:{ok:false,uncertain:!!result?.uncertain,error:this.safeError(result?.error,'发送未确认，请查看直播间')};
  }

  async tick(){
    const engine=this.engine;
    if(!engine||!this.voiceReady)return;
    await engine.tick();
    if(this.engine===engine)engine.publish();
  }

  onRoomEvents(events,sessionId){
    if(!this.validSession(sessionId)||sessionId!==this.session.id||!Array.isArray(events)||!this.engine)return false;
    const now=this.now();
    const context=events.slice(-30).filter(event=>event&&typeof event.text==='string').map(event=>({
      id:clean(event.id,128)||crypto.randomUUID(),kind:event.kind==='self'?'self':'chat',text:clean(event.text,500),user:clean(event.user,80),at:now,
    }));
    this.engine.addEvents(context);if(this.voiceReady)void this.tick();return true;
  }

  async onSegment(blob,metadata={}){
    const engine=this.engine,session=this.session;
    if(!engine||!session||!this.validSession(metadata.sessionId)||engine.state.status!=='listening'||engine.state.singing)return false;
    const at=Number.isFinite(metadata.at)?metadata.at:this.now();
    if(at<this.audioAfter||at>this.now()+1000||this.now()-at>=20_000||!(blob instanceof Blob)||blob.size===0||blob.size>24*1024*1024)return false;
    if(this.audioRequest){this.queued={blob,metadata:{...metadata,at,sessionId:session.id}};return false;}
    const operation={controller:new AbortController(),epoch:this.audioEpoch,sessionId:session.id};this.audioRequest=operation;
    try{
      const text=await this.transcribe(this.settings,blob,{signal:operation.controller.signal});
      if(this.audioEpoch!==operation.epoch||this.engine!==engine||this.session?.id!==session.id||engine.state.status!=='listening'||engine.state.singing)return false;
      this.audioErrors=0;
      if(typeof text==='string'&&text.trim()&&this.now()-at<20_000){
        this.voiceReady=true;engine.addEvents([{id:crypto.randomUUID(),kind:'speech',text:clean(text,4000),user:'主播',at}]);
        void this.tick();return true;
      }
      return false;
    }catch(error){
      if(this.audioEpoch===operation.epoch&&this.engine===engine&&!operation.controller.signal.aborted){
        this.audioErrors++;const message=this.safeError(error,'语音转写失败');engine.log(`语音转写失败：${message}`,'error');
        if(this.audioErrors>=3){this.clearAudio();engine.state.error=message;engine.pause('连续转写失败，已暂停接话');void this.cancelPage();}
      }
      return false;
    }finally{
      if(this.audioRequest===operation){this.audioRequest=null;const next=this.queued;this.queued=null;if(next)void this.onSegment(next.blob,next.metadata);}
    }
  }

  onLevel(level,sessionId){if(this.validSession(sessionId)&&this.engine){this.engine.state.level=Math.max(0,Math.min(1,Number(level)||0));this.engine.publish();}}
  onActivity(value,sessionId){if(this.validSession(sessionId)&&this.engine)this.engine.setActivity({speaking:!!value?.speaking});}
  onCaptureEnded(error,sessionId){
    if(!this.validSession(sessionId))return;
    this.captureFailed=true;this.clearAudio();void this.cancelPage();
    if(this.engine){this.engine.state.error=this.safeError(error,'直播声音已断开，请结束后重新开始');this.engine.pause('音频连接已结束，请结束后重新开始');}
  }

  async command(type,payload={}){
    try{
      switch(type){
        case 'get-state':{
          await this.ready;
          // A corrupt or undecryptable file must not disable the settings UI's
          // reset/save controls. Return safe defaults with a visible error;
          // start() still refuses to operate until settings are recovered.
          if(this.loadError)this.publish({...this.state,status:'error',error:this.loadError,activity:'设置无法读取，请清除本机设置或重新填写后保存'});
          return {ok:true,state:structuredClone(this.state),settings:structuredClone(this.settings)};
        }
        case 'start':return await this.start(payload);
        case 'stop':return await this.stop();
        case 'save-settings':{
          if(this.session||this.starting||this.stopping||this.settingsBusy)throw new Error('请先停止监听，再修改 API 设置');
          this.settingsBusy=true;
          try{await this.ready;const settings=normalizeSettings(payload.settings??payload);await this.saveSettings(settings);this.settings=settings;this.loadError=null;return {ok:true};}
          finally{this.settingsBusy=false;}
        }
        case 'clear-data':{
          if(this.settingsBusy)throw new Error('请等待设置操作完成');this.settingsBusy=true;
          try{await this.ready;await this.stop();await this.clearSettings();this.settings=normalizeSettings(DEFAULT_SETTINGS);this.loadError=null;this.room=null;this.roomVersion++;this.publish(initialState(null));return {ok:true,state:structuredClone(this.state),settings:structuredClone(this.settings)};}
          finally{this.settingsBusy=false;}
        }
        case 'test-api':{
          if(this.session||this.starting||this.stopping||this.settingsBusy)throw new Error('请先停止监听，再测试 API');this.settingsBusy=true;
          try{await this.ready;if(this.loadError)throw new Error(this.loadError);return await testProvider(this.settings,payload.kind==='transcription'?'transcription':'chat');}
          finally{this.settingsBusy=false;}
        }
        case 'pause':case 'cancel':case 'singing':{
          if(!this.engine||!this.session)throw new Error('尚未开始监听');
          const cancellation=this.cancelPage();
          if(type==='pause'){this.clearAudio();this.engine.pause();}
          if(type==='cancel')this.engine.cancel();
          if(type==='singing'){this.clearAudio();this.voiceReady=false;this.engine.setSinging(!!payload.value);}
          await cancellation;return {ok:true};
        }
        case 'resume':{
          if(!this.engine||!this.session)throw new Error('尚未开始监听');if(this.captureFailed)throw new Error('音频连接已结束，请先结束，再重新开始监听');
          this.clearAudio();this.voiceReady=false;this.audioErrors=0;this.engine.resume();return {ok:true};
        }
        case 'send-now':if(!this.engine)throw new Error('尚未开始监听');return await this.engine.sendNow();
        default:throw new Error('未知操作');
      }
    }catch(error){return {ok:false,error:this.safeError(error)};}
  }
}
