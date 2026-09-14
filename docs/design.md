# 直播搭子：已确认的第一版

用户确认：使用自己的 B 站观众账号，根据主播声音和弹幕自然接话、烘托气氛。采用 Chrome / Edge 侧边栏扩展。默认 OpenAI，保留自由输入 API 地址、密钥和模型的设置。

## 产品与边界
- 插件仅在用户点击开始后捕获指定 B 站直播标签页的音频和新弹幕。
- 主播音频经分段 WAV 转写，与最近弹幕交给聊天模型。模型可以选择沉默；规则层限制过期回复、复读、自己的弹幕、发言密度。
- 自动发送前可取消倒计时；人工暂停、唱歌暂停、停止监听立即作废待发内容和在途请求。
- 使用网页原有输入框和发送按钮，不读取登录 Cookie。拒绝覆盖用户正在输入的文字。发送失败或不确定时不重试，暂停自动发送并提示。
- 设置支持独立的 chat / transcription 配置，均为 OpenAI-compatible Base URL、API Key 和模型。仅 HTTPS 和回环 HTTP 可用；按域名申请可选权限。默认 Key 仅保留在浏览器会话，用户可主动勾选本机保存，明确非加密存储。
- 无服务器，无构建依赖；原生 JS / HTML / CSS / MV3。Chrome 116+。自动模式需用户本次主动选择并点击开始，不跨重启自动恢复。
- 不伪装人类经历、不自称真实观众；提供 AI 助手身份说明。聊天内容是上下文数据，不能修改配置或执行指令。

## 文件与接口
- `extension/core/settings.js`: DEFAULT_SETTINGS; normalizeSettings(input); endpoint(base,path); permissionOrigins(settings); splitSettings(settings) => {publicSettings,secrets}.
- `extension/core/policy.js`: ConversationPolicy(settings), addEvent(event), canGenerate(now), consider(candidate,now), markSent(text,now), cancelPending(now); events {id,kind:'speech'|'chat'|'self',text,user,at}; candidate {action:'reply'|'wait',text,reason,confidence,scene:'chat'|'singing'|'uncertain',respondsToSelf:boolean}.
- `extension/core/provider.js`: generateReply(settings,events,{signal}={}); transcribeAudio(settings,wavBlob,{signal}={}); testProvider(settings,kind,{signal}={}); fetch with timeouts, no retries, no raw key in errors, use chat/completions and audio/transcriptions.
- `extension/audio/capture.js`: startCapture(streamId,{onSegment,onLevel,onEnded,onActivity,onError}) => Promise<{stop()}>; WAV Blob segments; audio continues playing to user; no microphone access.
- `extension/content.js`: self-contained reinjection-safe content script. receives {target:'content',type:'attach'|'detach'|'send',sessionId,text}; attach response {ok,roomId,title}; send response {ok,error,uncertain}; emits {target:'background',type:'room-events',sessionId,events} and {target:'background',type:'room-gone',sessionId}. send dedup id required `messageId`; verify original numeric room URL.
- `extension/background.js`: toolbar selects room, opens sidePanel; checks sender provenance; routes commands, performs tab capture setup and forwards events; chrome.storage session secrets; no keys sent to content scripts.
- `extension/offscreen.js`: owns runtime, audio queue, model requests, generation policy and countdown; handles {target:'offscreen',type:'start'|'stop'|'pause'|'resume'|'cancel'|'singing'|'events'|'snapshot',...}. emits {target:'background',type:'state',state} and {target:'background',type:'send',sessionId,text,messageId}.
- `extension/sidepanel.js`: calls chrome.runtime.sendMessage({target:'background',type,...}). Commands: get-state => {ok,state,settings}; save-settings(settings) => {ok,error}; start({mode:'auto'|'review'}) => {ok,error}; stop/pause/resume/cancel/singing({value})/send-now/test-api({kind:'chat'|'transcription'}) => {ok,error,message}. subscribes {target:'panel',type:'state',state}. State {status:'idle'|'starting'|'listening'|'paused'|'error',room:{tabId,roomId,title},mode,singing,level,events:[],logs:[],pending:null|{text,reason,dueAt},sentCount,error,activity}. Keys may return only to trusted extension panel.

## Verification
Node tests for endpoint validation, provider payload/errors, cooldown, duplicate and self-echo handling, stale context, pause cancellation. DOM fixture test for new-chat collection and refusing duplicate sends/occupied composer. Isolated browser test of actual extension loading, settings persistence, API permission request and UI states. Mock provider transport is identified as test-only; real API and real B站发送 need the user's own key/login and are not claimed as verified.
