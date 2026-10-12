import { startCapture } from '../../extension/audio/capture.js';

const desktop = globalThis.desktopAPI;
const hasDesktop = Boolean(desktop?.command && desktop?.onState && desktop?.onCapture && desktop?.captureEvent);
const $ = id => document.getElementById(id);
const stateListeners = new Set();
const unsubscribers = [];
let toolbarBusy = false;
let roomStatus = { loggedIn: null, loading: false, url: '', title: '', error: '' };
let captureGeneration = 0;
let activeCapture = null;
let unloaded = false;
let aiState = { mode: 'chatgpt-local', chatgptModel: '', chatgpt: { connected: false, sharing: false, models: [], accounts: [] }, speech: { status: 'idle' } };
let aiLoaded = false;
let aiBusy = '';
let sessionActive = false;

function aiFeedback(text = '', kind = '') {
  $('ai-feedback').textContent = text;
  $('ai-feedback').dataset.kind = kind;
  $('ai-feedback').hidden = !text;
}

function setSelectOptions(select, items, current, fallback) {
  const options = items.map(item => ({ value: String(item.id), label: String(item.name || item.label || item.id) }));
  if (!options.length || (current && !options.some(item => item.value === current))) options.unshift({ value: current || '', label: current || fallback });
  const signature = JSON.stringify(options);
  if (select.dataset.options !== signature) {
    select.replaceChildren(...options.map(item => { const option = document.createElement('option'); option.value = item.value; option.textContent = item.label; return option; }));
    select.dataset.options = signature;
  }
  select.value = current || options[0]?.value || '';
}

function renderAI(next) {
  if (next && typeof next === 'object') {
    aiState = { ...aiState, ...next, chatgpt: { ...aiState.chatgpt, ...next.chatgpt }, speech: { ...aiState.speech, ...next.speech } };
  }
  const account = aiState.chatgpt;
  const speech = aiState.speech;
  const api = aiState.mode === 'api';
  const blocked = !hasDesktop || !aiLoaded || sessionActive || Boolean(aiBusy);
  const signingIn = Boolean(account.signingIn || aiBusy === 'chatgpt-sign-in');
  document.body.dataset.aiMode = api ? 'api' : 'chatgpt-local';
  document.body.dataset.aiReady = String(aiLoaded);
  $('ai-mode-picker').disabled = blocked || signingIn;
  document.querySelector(`input[name="ai-mode"][value="${api ? 'api' : 'chatgpt-local'}"]`).checked = true;
  $('chatgpt-connection').hidden = api;
  $('api-route-description').hidden = !api;
  $('ai-route-note').textContent = sessionActive ? '当前正在陪聊，请先结束，再切换 AI 或账号。' : '账号连接和模型选择即时保存；切换前请先结束陪聊。';
  $('chatgpt-status').textContent = !aiLoaded ? '正在读取连接…' : signingIn ? '等待你在浏览器完成登录' : account.connected && account.sharing ? '已连接，可使用模型' : account.connected ? '已登录，待授权用量' : '尚未连接 ChatGPT';
  $('chatgpt-status-dot').dataset.ready = String(Boolean(account.connected && account.sharing));
  const label = typeof account.account === 'string' ? account.account : account.account?.label || account.account?.email || account.account?.name;
  $('chatgpt-account').textContent = account.error || label || (account.connected ? '使用当前 ChatGPT 账号' : '在官方页面登录，无需填写 API Key。');
  $('chatgpt-sign-in').hidden = signingIn || Boolean(account.connected && account.sharing);
  $('chatgpt-sign-in').textContent = account.connected ? '授权 ChatGPT 用量' : 'Continue with ChatGPT';
  $('chatgpt-sign-in').disabled = blocked;
  $('chatgpt-cancel-sign-in').hidden = !signingIn;
  $('chatgpt-cancel-sign-in').disabled = !hasDesktop || aiBusy === 'chatgpt-cancel-sign-in';
  $('chatgpt-sign-in-note').textContent = signingIn ? '请在已打开的官方页面选择账号并授权。完成后此处会自动更新，也可取消。' : '登录与授权在官方页面完成。聊天使用账号可用额度，测试也会消耗用量。';
  $('chatgpt-connected-controls').hidden = !account.connected;
  const accounts = Array.isArray(account.accounts) ? account.accounts : [];
  $('chatgpt-account-field').hidden = accounts.length < 2;
  setSelectOptions($('chatgpt-account-select'), accounts, account.activeAccountId || '', '当前账号');
  setSelectOptions($('chatgpt-model'), Array.isArray(account.models) ? account.models : [], aiState.chatgptModel || '', '使用账号默认模型');
  $('chatgpt-account-select').disabled = blocked || signingIn;
  $('chatgpt-model').disabled = blocked || !account.sharing || signingIn;
  $('chatgpt-test').disabled = blocked || !account.sharing || signingIn;
  $('chatgpt-test').textContent = aiBusy === 'chatgpt-test' ? '测试中…' : '测试聊天';
  $('chatgpt-usage').disabled = !hasDesktop || !aiLoaded || !account.connected;
  $('chatgpt-add-account').disabled = blocked || signingIn;
  $('chatgpt-sign-out').disabled = blocked || signingIn;
  const speechNames = { idle: '待准备', downloading: '下载中', loading: '加载中', ready: '已就绪', error: '需要重试', closed: '待加载' };
  $('local-speech-status').textContent = speechNames[speech.status] || '待准备';
  $('local-speech-message').textContent = speech.message || (speech.status === 'ready' ? '识音模型已就绪。直播声音在本机转写，只将文字交给聊天模型。' : speech.cached ? '识音模型已下载，加载后即可使用。声音在本机处理。' : '首次需下载约 80 MB 识音模型，以后复用。直播声音留在本机，不使用麦克风。');
  const preparing = ['downloading', 'loading'].includes(speech.status) || aiBusy === 'local-speech-prepare';
  $('local-speech-progress').hidden = !preparing;
  if (Number.isFinite(speech.progress)) $('local-speech-progress').value = Math.max(0, Math.min(100, speech.progress));
  else $('local-speech-progress').removeAttribute('value');
  $('local-speech-prepare').hidden = speech.status === 'ready';
  $('local-speech-prepare').disabled = blocked || preparing;
  $('local-speech-prepare').textContent = preparing ? '正在准备，请稍候…' : speech.status === 'error' ? '重试准备识音模型' : speech.cached ? '加载识音模型' : '下载并准备识音模型';
  $('ai-summary-title').textContent = api ? 'API 聊天 + 云端转写' : 'ChatGPT + 本地识音';
  $('ai-summary-detail').textContent = !aiLoaded ? '正在读取 AI 连接…' : api ? '查看聊天与转写配置' : !account.connected ? '连接账号，无需 API Key' : !account.sharing ? '登录完成，继续授权模型用量' : speech.status !== 'ready' ? 'ChatGPT 已连接 · 还需准备识音' : '已准备好 · 点击管理连接';
  $('ai-privacy-note').textContent = api ? '音频片段和最近弹幕将发送给你填写的 AI 服务。' : '声音在本机转成文字；转写和最近弹幕发送给 ChatGPT。';
  window.dispatchEvent(new Event('desktop-ai-state'));
}

async function aiCommand(type, payload = {}) {
  if (!hasDesktop || (aiBusy && !['chatgpt-cancel-sign-in', 'chatgpt-usage'].includes(type))) return;
  const previousBusy = aiBusy;
  aiBusy = type;
  aiFeedback('');
  renderAI();
  try {
    const result = await desktop.command(type, payload);
    if (!result?.ok) throw new Error(result?.error || 'AI 连接操作未完成，请重试。');
    if (result.ai) { aiLoaded = true; renderAI(result.ai); }
    if (result.message) aiFeedback(result.message, 'success');
    else if (type === 'chatgpt-test') aiFeedback('聊天请求成功。实际直播中的回复质量仍需观察。', 'success');
    else if (type === 'chatgpt-sign-out') aiFeedback('已断开当前 ChatGPT 账号。其他已保存账号可单独选择并断开。', 'success');
    else if (type === 'ai-set-mode') aiFeedback('AI 接入方式已切换。', 'success');
    if (!result.ai && type !== 'chatgpt-usage') {
      const snapshot = await desktop.command('ai-get-state');
      if (snapshot?.ok && snapshot.ai) { aiLoaded = true; renderAI(snapshot.ai); }
    }
  } catch (error) {
    aiFeedback(error?.message || '连接失败，请重试。', 'error');
  } finally {
    if (aiBusy === type) aiBusy = type === 'chatgpt-usage' ? previousBusy : '';
    renderAI();
  }
}

function toolbarFeedback(text, status = '') {
  $('room-toolbar-status').dataset.status = status;
  $('room-toolbar-status').querySelector('span').textContent = text;
  $('room-toolbar-status').title = text;
}

function updateToolbarControls() {
  $('open-room-button').disabled = !hasDesktop || toolbarBusy;
  $('reload-room-button').disabled = !hasDesktop || toolbarBusy;
  $('logout-room-button').disabled = !hasDesktop || toolbarBusy;
  $('room-url').disabled = !hasDesktop || toolbarBusy;
  $('open-room-button').textContent = toolbarBusy ? '正在打开…' : '打开直播间 ↗';
}

function updateRoomStatus(update = {}) {
  if (!update || typeof update !== 'object') return;
  roomStatus = { ...roomStatus, ...update };
  if (update.url && document.activeElement !== $('room-url')) $('room-url').value = update.url;
  const notice = $('desktop-login-notice');
  notice.hidden = roomStatus.loggedIn === true && !roomStatus.error;
  notice.dataset.error = String(Boolean(roomStatus.error));
  notice.querySelector('p').textContent = roomStatus.error || (roomStatus.loggedIn === false
    ? '尚未登录 B 站。请先在左侧页面完成登录，再开始陪聊。'
    : '登录状态以左侧 B 站页面为准。已登录后，连接 AI、打开直播间即可开始。');
  if (roomStatus.error) toolbarFeedback('页面需要处理', 'error');
  else if (roomStatus.loading) toolbarFeedback('直播页面加载中', 'loading');
  else if (roomStatus.loggedIn === true) toolbarFeedback('已登录 B 站', 'ready');
  else toolbarFeedback(roomStatus.loggedIn === false ? '尚未登录 B 站' : '登录待确认');
}

function normalizeRoomUrl(value) {
  const text = String(value || '').trim();
  if (/^[1-9]\d*$/.test(text)) return `https://live.bilibili.com/${text}`;
  let url;
  try { url = new URL(text); } catch { throw new Error('请填写 B 站直播间链接，或直接输入房间号。'); }
  if (url.protocol !== 'https:' || url.hostname !== 'live.bilibili.com' || !/^\/[1-9]\d*\/?$/.test(url.pathname) || url.username || url.password || url.port) {
    throw new Error('请使用 https://live.bilibili.com/房间号 格式的直播间链接。');
  }
  return `https://live.bilibili.com${url.pathname.replace(/\/$/, '')}`;
}

async function roomCommand(type, payload = {}) {
  if (!hasDesktop || toolbarBusy) return;
  toolbarBusy = true;
  updateToolbarControls();
  toolbarFeedback(type === 'logout-room' ? '正在退出 B 站登录' : type === 'reload-room' ? '正在刷新直播页面' : '正在打开直播间', 'loading');
  try {
    const result = await desktop.command(type, payload);
    if (!result?.ok) throw new Error(result?.error || '直播页面操作未完成，请重试。');
    if (result.roomStatus) updateRoomStatus(result.roomStatus);
    else updateRoomStatus({ error: '', ...(payload.url ? { url: payload.url } : {}), ...(type === 'logout-room' ? { loggedIn: false } : {}) });
  } catch (error) {
    updateRoomStatus({ error: error?.message || '无法打开直播页面，请检查网络后重试。', loading: false });
  } finally { toolbarBusy = false; updateToolbarControls(); }
}

function postCapture(type, payload) {
  if (!hasDesktop || unloaded) return Promise.resolve();
  try { return Promise.resolve(desktop.captureEvent(type, payload)); }
  catch (error) { return Promise.reject(error); }
}

async function stopRecord(record) {
  if (!record) return;
  record.cancelled = true;
  try {
    if (record.handle) await record.handle.stop();
    else if (record.promise) { const handle = await record.promise; await handle?.stop(); }
  } catch { /* A failed or cancelled startup has no capture left to retain. */ }
}

async function handleCapture(message) {
  if (!message || !['start', 'stop'].includes(message.type)) return;
  const generation = ++captureGeneration;
  const previous = activeCapture;
  activeCapture = null;
  if (message.type === 'stop') {
    await stopRecord(previous);
    await postCapture('result', { requestId: message.requestId, ok: true });
    return;
  }
  const record = { generation, sessionId: message.sessionId, cancelled: false, promise: null, handle: null };
  activeCapture = record;
  const current = () => !unloaded && !record.cancelled && activeCapture === record && captureGeneration === generation;
  try {
    await stopRecord(previous);
    if (!current()) throw new Error('音频连接已取消');
    if (typeof message.streamId !== 'string' || !message.streamId || typeof message.sessionId !== 'string' || !message.sessionId) throw new Error('直播声音授权无效，请重新开始。');
    record.promise = startCapture(message.streamId, {
      onSegment: async (blob, metadata) => {
        if (!current()) return;
        const bytes = new Uint8Array(await blob.arrayBuffer());
        if (!current()) return;
        await postCapture('segment', { sessionId: record.sessionId, bytes, metadata });
      },
      onLevel: level => { if (current()) void postCapture('level', { sessionId: record.sessionId, level }).catch(() => {}); },
      onActivity: activity => { if (current()) void postCapture('activity', { sessionId: record.sessionId, ...activity }).catch(() => {}); },
      onEnded: () => { if (current()) void postCapture('ended', { sessionId: record.sessionId }).catch(() => {}); },
      onError: error => { if (current()) void postCapture('error', { sessionId: record.sessionId, error: error?.message || '直播声音处理失败' }).catch(() => {}); },
    }, { monitorPlayback: false });
    record.handle = await record.promise;
    if (!current()) { await record.handle.stop(); throw new Error('音频连接已取消'); }
    await postCapture('result', { requestId: message.requestId, ok: true });
  } catch (error) {
    await stopRecord(record);
    if (activeCapture === record) activeCapture = null;
    await postCapture('result', { requestId: message.requestId, ok: false, error: error?.message || '无法连接直播声音' });
  }
}

if (hasDesktop) {
  globalThis.chrome = {
    runtime: {
      id: 'desktop',
      sendMessage(message) {
        const { target, type, ...payload } = message || {};
        if (target !== 'background' || typeof type !== 'string') return Promise.resolve({ ok: false, error: '无效的桌面操作' });
        return Promise.resolve(desktop.command(type, payload)).then(result => {
          if (result?.state) { sessionActive = ['starting', 'listening', 'paused'].includes(result.state.status); renderAI(); }
          return result;
        });
      },
      onMessage: {
        addListener(listener) { stateListeners.add(listener); },
        removeListener(listener) { stateListeners.delete(listener); },
      },
    },
    // The desktop main process owns endpoint validation and all API requests.
    permissions: { request: async () => true },
  };
  const unstate = desktop.onState(state => {
    sessionActive = ['starting', 'listening', 'paused'].includes(state?.status);
    renderAI();
    for (const listener of stateListeners) listener({ target: 'panel', type: 'state', state }, { id: 'desktop' });
    if (typeof state?.loggedIn === 'boolean') updateRoomStatus({ loggedIn: state.loggedIn });
  });
  const uncapture = desktop.onCapture(message => { void handleCapture(message).catch(() => {}); });
  if (typeof unstate === 'function') unsubscribers.push(unstate);
  if (typeof uncapture === 'function') unsubscribers.push(uncapture);
  if (typeof desktop.onAIState === 'function') {
    const unai = desktop.onAIState(next => { aiLoaded = true; renderAI(next); });
    if (typeof unai === 'function') unsubscribers.push(unai);
  }
  void aiCommand('ai-get-state');
  if (typeof desktop.onRoomStatus === 'function') {
    const unroom = desktop.onRoomStatus(updateRoomStatus);
    if (typeof unroom === 'function') unsubscribers.push(unroom);
  }
  if (typeof desktop.getVersion === 'function') {
    Promise.resolve(desktop.getVersion()).then(version => {
      const value = typeof version === 'string' ? version : version?.version;
      if (value) $('desktop-version').textContent = `桌面版 · ${String(value).slice(0, 30)}`;
    }).catch(() => {});
  }
}

$('room-form').addEventListener('submit', event => {
  event.preventDefault();
  try { void roomCommand('open-room', { url: normalizeRoomUrl($('room-url').value) }); }
  catch (error) { updateRoomStatus({ error: error.message, loading: false }); $('room-url').focus(); }
});
$('reload-room-button').addEventListener('click', () => { void roomCommand('reload-room'); });
$('logout-room-button').addEventListener('click', () => {
  if (!hasDesktop || toolbarBusy) return;
  if (window.confirm('退出 B 站登录？\n\n这会停止陪聊并清除应用内的 B 站登录状态。API 设置和密钥不会被删除。')) void roomCommand('logout-room');
});
$('return-to-chat').addEventListener('click', () => { $('close-settings').click(); });
$('ai-summary').addEventListener('click', () => { $('open-settings').click(); });
for (const radio of document.querySelectorAll('input[name="ai-mode"]')) radio.addEventListener('change', () => { if (radio.checked) void aiCommand('ai-set-mode', { mode: radio.value }); });
$('chatgpt-sign-in').addEventListener('click', () => { void aiCommand('chatgpt-sign-in', aiState.chatgpt.connected ? { enableSharing: true } : {}); });
$('chatgpt-add-account').addEventListener('click', () => { void aiCommand('chatgpt-sign-in', { addAccount: true }); });
$('chatgpt-cancel-sign-in').addEventListener('click', () => { void aiCommand('chatgpt-cancel-sign-in'); });
$('chatgpt-sign-out').addEventListener('click', () => {
  if (window.confirm('断开当前 ChatGPT 账号？\n\n这会清除本机保存的当前账号凭据，并尝试撤销授权。其他已保存账号、B 站登录和本地识音模型不会删除。')) void aiCommand('chatgpt-sign-out');
});
$('chatgpt-account-select').addEventListener('change', event => { void aiCommand('chatgpt-select-account', { accountId: event.target.value }); });
$('chatgpt-model').addEventListener('change', event => { void aiCommand('chatgpt-select-model', { model: event.target.value }); });
$('chatgpt-test').addEventListener('click', () => { void aiCommand('chatgpt-test'); });
$('chatgpt-usage').addEventListener('click', () => { void aiCommand('chatgpt-usage'); });
$('local-speech-prepare').addEventListener('click', () => { void aiCommand('local-speech-prepare'); });
$('copy-chat-service').addEventListener('click', () => {
  const baseUrl = $('chat-base-url').value.trim();
  const apiKey = $('chat-api-key').value.trim();
  const feedback = $('feedback');
  feedback.hidden = false;
  if (!baseUrl || !apiKey) {
    feedback.dataset.kind = 'error';
    feedback.textContent = '请先填写聊天服务的 API 地址和 Key，再复制到声音转文字。';
    (baseUrl ? $('chat-api-key') : $('chat-base-url')).focus();
    return;
  }
  $('transcription-base-url').value = baseUrl;
  $('transcription-base-url').dispatchEvent(new Event('input', { bubbles: true }));
  $('transcription-api-key').value = apiKey;
  $('transcription-test-result').hidden = true;
  feedback.dataset.kind = 'success';
  feedback.textContent = '地址和 Key 已复制，尚未保存。请单独确认转写模型，再保存设置。';
});
for (const id of ['open-settings', 'close-settings']) {
  $(id).addEventListener('click', () => { $('desktop-sidebar').scrollTop = 0; });
}
window.addEventListener('pagehide', () => {
  unloaded = true;
  captureGeneration++;
  const record = activeCapture;
  activeCapture = null;
  void stopRecord(record);
  for (const unsubscribe of unsubscribers) unsubscribe();
  stateListeners.clear();
}, { once: true });

updateToolbarControls();
renderAI();
if (!hasDesktop) toolbarFeedback('桌面界面预览');
await import('../../extension/sidepanel.js');
