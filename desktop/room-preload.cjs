'use strict';

// Build contract: concatenate this file, a newline, and extension/content.js
// into ONE sandbox preload file. Sandboxed require cannot load local modules.
// The lexical `chrome` below is visible to the appended adapter only; nothing
// is exposed through contextBridge, window, or the remote page's main world.
const { ipcRenderer } = require('electron');
const desktopRoomMainFrame = process.isMainFrame === true && window.top === window;
const desktopRoomCommands = new Set(['attach', 'detach', 'cancel-send', 'send', 'status']);
let desktopRoomListener = null;
let desktopRoomAlive = true;

function desktopRoomId() {
  if (!desktopRoomMainFrame || location.protocol !== 'https:' || location.hostname !== 'live.bilibili.com') return null;
  return /^\/([1-9]\d*)\/?$/.exec(location.pathname)?.[1] ?? null;
}

function desktopRoomSend(channel, message) {
  try { ipcRenderer.send(channel, message); } catch { /* Navigation or app shutdown: main owns request timeout. */ }
}

const chrome = {
  runtime: {
    id: 'desktop-room',
    onMessage: {
      addListener(listener) {
        if (desktopRoomMainFrame && typeof listener === 'function' && !desktopRoomListener) desktopRoomListener = listener;
      },
    },
    sendMessage(message) {
      if (!desktopRoomMainFrame || !message || message.target !== 'background' || typeof message.sessionId !== 'string' || message.sessionId.length > 128) {
        return Promise.resolve({ ok: false });
      }
      if (message.type === 'room-gone') {
        // Allow final cleanup notification after navigation has changed the URL.
        desktopRoomSend('room-event', { target: 'background', type: 'room-gone', sessionId: message.sessionId });
      } else if (message.type === 'room-events' && desktopRoomAlive && desktopRoomId() && Array.isArray(message.events)) {
        const events = message.events.slice(0, 100).filter(event => event && typeof event.text === 'string' && typeof event.user === 'string' && typeof event.id === 'string' && Number.isFinite(event.at)).map(event => ({
          id: event.id.slice(0, 128), kind: event.kind === 'self' ? 'self' : 'chat', text: event.text.slice(0, 500), user: event.user.slice(0, 100), at: event.at,
        }));
        if (events.length) desktopRoomSend('room-event', { target: 'background', type: 'room-events', sessionId: message.sessionId, events });
      } else return Promise.resolve({ ok: false });
      return Promise.resolve({ ok: true });
    },
  },
};

if (desktopRoomMainFrame) {
  ipcRenderer.on('room-command', (_event, request) => {
    if (!request || typeof request.requestId !== 'string' || !request.requestId || request.requestId.length > 128) return;
    const { requestId, type } = request;
    const boundRoomId = desktopRoomId();
    let responded = false;
    const respond = result => {
      if (responded || !desktopRoomAlive) return;
      responded = true;
      if (result?.ok && boundRoomId !== desktopRoomId()) result = { ok: false, error: '直播间已改变，请重新开始监听', uncertain: type === 'send' };
      desktopRoomSend('room-result', { requestId, result });
    };
    if (!desktopRoomCommands.has(type)) { respond({ ok: false, error: '不支持的直播间命令' }); return; }
    if (!boundRoomId) { respond({ ok: false, error: '请在应用内打开 HTTPS 的 B站数字直播间' }); return; }
    if (type === 'status') {
      respond({ ok: true, roomId: boundRoomId, title: document.title.slice(0, 200), adapterReady: typeof desktopRoomListener === 'function' });
      return;
    }
    if (!desktopRoomListener) { respond({ ok: false, error: '直播间适配器尚未准备好，请稍后重试' }); return; }
    const payload = request.payload ?? {};
    if (typeof payload !== 'object' || Array.isArray(payload)) { respond({ ok: false, error: '无效的直播间参数' }); return; }
    const message = { target: 'content', type };
    for (const key of ['sessionId', 'messageId', 'text']) {
      if (!Object.prototype.hasOwnProperty.call(payload, key)) continue;
      if (typeof payload[key] !== 'string' || payload[key].length > (key === 'text' ? 320 : 128)) {
        respond({ ok: false, error: '无效的直播间参数' });
        return;
      }
      message[key] = payload[key];
    }
    try {
      const asynchronous = desktopRoomListener(message, { id: 'desktop-room' }, respond);
      if (asynchronous !== true && !responded) respond({ ok: false, error: '直播间适配器未处理此命令' });
    } catch {
      respond({ ok: false, error: '直播间操作未完成，请检查页面', uncertain: type === 'send' });
    }
  });
  addEventListener('pagehide', () => { desktopRoomAlive = false; });
}
