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
    : '请先在左侧 B 站页面登录你的观众账号，再开始陪聊。');
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
        return desktop.command(type, payload);
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
    for (const listener of stateListeners) listener({ target: 'panel', type: 'state', state }, { id: 'desktop' });
    if (typeof state?.loggedIn === 'boolean') updateRoomStatus({ loggedIn: state.loggedIn });
  });
  const uncapture = desktop.onCapture(message => { void handleCapture(message).catch(() => {}); });
  if (typeof unstate === 'function') unsubscribers.push(unstate);
  if (typeof uncapture === 'function') unsubscribers.push(uncapture);
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
if (!hasDesktop) toolbarFeedback('桌面界面预览');
await import('../../extension/sidepanel.js');
