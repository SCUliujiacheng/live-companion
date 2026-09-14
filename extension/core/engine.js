// Lifecycle controller; transport and clock are injectable so cancellation can be tested.
export class CompanionEngine {
  constructor({settings,policy,generate,send,emit,now=Date.now}) {
    Object.assign(this,{settings,policy,generate,send,emit,now});
    this.epoch=0; this.revision=0; this.busy=false; this.sending=false; this.lastAttempt=0;
    this.state={status:'idle',room:null,mode:'review',singing:false,level:0,events:[],logs:[],pending:null,sentCount:0,error:'',activity:'等待开始'};
  }
  publish(){this.emit({...this.state,events:[...this.state.events],logs:[...this.state.logs]});}
  log(text,level='info'){this.state.logs=[...this.state.logs,{id:crypto.randomUUID(),at:this.now(),text,level}].slice(-40);this.publish();}
  start({sessionId,room,mode}) {this.sessionId=sessionId;Object.assign(this.state,{status:'listening',room,mode,error:'',activity:'听主播说话中'});this.publish();}
  invalidate(){this.epoch++;this.controller?.abort();this.controller=null;this.state.pending=null;this.policy.cancelPending(this.now());}
  pause(reason='已暂停接话'){this.invalidate();Object.assign(this.state,{status:'paused',activity:reason,pausedReason:reason});this.publish();}
  resume(){this.invalidate();this.state.status='listening';this.state.error='';this.state.activity='等待新的话题';this.publish();}
  stop(){this.invalidate();this.state.status='idle';this.state.level=0;this.state.activity='已停止监听';this.publish();}
  cancel(reason='已取消本条回复'){this.invalidate();this.log(reason);}
  setSinging(value){this.invalidate();this.state.singing=Boolean(value);this.state.activity=value?'唱歌中，暂不接话':'等待新的话题';this.publish();}
  setActivity(value){this.speaking=Boolean(value.speaking);this.activityAt=this.now();}
  addEvents(events){
    if(this.state.status!=='listening')return;
    for(const event of events){
      if(!event.text?.trim()||!['speech','chat','self'].includes(event.kind))continue;
      if(this.state.events.some(e=>e.id===event.id))continue;
      this.revision++;
      if(event.kind==='speech'&&(this.busy||this.state.pending))this.invalidate();
      this.policy.addEvent(event);
      this.state.events=[...this.state.events,event].slice(-100);
    }
    this.publish();
  }
  async tick(){
    if(this.state.status!=='listening'||this.state.singing||this.sending)return;
    const now=this.now();
    if(this.state.pending){
      if(now-this.state.pending.createdAt>20000){this.cancel('话题已过，跳过这条回复');return;}
      if(this.state.mode==='auto'&&now>=this.state.pending.dueAt)await this.sendNow();
      return;
    }
    if(this.busy||now-this.lastAttempt<3500||!this.policy.canGenerate(now))return;
    // Wait briefly at the onset of speech; sustained music must not block the model forever.
    if(this.speaking&&now-(this.activityAt||0)<1200)return;
    this.busy=true;this.lastAttempt=now;const epoch=this.epoch;
    const controller=new AbortController();this.controller=controller;
    this.state.activity='正在想一句合适的回应';this.publish();
    try{
      const candidate=await this.generate(this.settings,this.policy.getContext(now),{signal:controller.signal});
      if(epoch!==this.epoch||this.state.status!=='listening')return;
      const decision=this.policy.consider(candidate,this.now());
      if(decision.ok){
        this.state.pending={text:decision.text,reason:candidate.reason||'接当前话题',createdAt:this.now(),dueAt:this.now()+this.settings.countdownSec*1000};
        this.state.activity=this.state.mode==='auto'?'准备接话，可随时取消':'回复已准备好，等你发送';
      }else{this.state.activity='继续听，暂不插话';this.log(candidate.reason||decision.reason||'这次选择安静');}
    }catch(error){
      if(epoch===this.epoch&&!controller.signal.aborted){this.state.error=error.message;this.pause('AI 请求失败，已暂停接话');this.log(error.message,'error');}
    }finally{this.busy=false;if(this.controller===controller)this.controller=null;this.publish();}
  }
  async sendNow(){
    const p=this.state.pending;
    if(!p||this.sending||this.state.status!=='listening'||this.state.singing)return {ok:false,error:'没有可发送的回复'};
    if(this.now()-p.createdAt>20000){this.cancel('回复已过期');return {ok:false,error:'回复已过期'};}
    const epoch=this.epoch;this.sending=true;this.state.pending=null;this.publish();
    try{
      const result=await this.send(p.text,{sessionId:this.sessionId,messageId:crypto.randomUUID()});
      if(epoch!==this.epoch)return {ok:false,error:'会话已改变'};
      if(!result?.ok){this.state.error=result?.error||'发送结果不确定';this.pause('发送未确认，已暂停；请查看直播间');this.log(this.state.error,'error');return result;}
      this.policy.markSent(p.text,this.now());this.state.sentCount++;
      this.state.events=[...this.state.events,{id:crypto.randomUUID(),kind:'self',text:p.text,user:this.settings.nickname||'我',at:this.now()}].slice(-100);
      this.state.activity='已发送，继续听';this.log('已发送一条弹幕');return {ok:true};
    }catch(error){this.state.error=error.message;this.pause('发送未确认，已暂停；请查看直播间');return {ok:false,error:error.message};}
    finally{this.sending=false;this.publish();}
  }
}
