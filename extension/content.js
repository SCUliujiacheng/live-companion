(() => {
  // Script execution stays in the extension's isolated world. No page globals,
  // cookies, account tokens, or private network APIs are read.
  if (globalThis.__liveCompanionContentV1) return;
  globalThis.__liveCompanionContentV1 = true;
  const ITEM = '.chat-item.danmaku-item';
  const sentIds = new Set();
  let session = null;
  let observer;
  let routeTimer;
  let flushTimer;
  let batch = [];
  let knownNodes = new WeakMap();
  let recent = new Map();
  let recentSelf = new Map();
  let inFlight = null;
  let cancelGeneration = 0;

  function roomId() {
    if (location.protocol !== 'https:' || location.hostname !== 'live.bilibili.com') return null;
    return /^\/([1-9]\d*)\/?$/.exec(location.pathname)?.[1] ?? null;
  }
  const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 128;
  function emit(message) {
    try { Promise.resolve(chrome.runtime.sendMessage({ target: 'background', ...message })).catch(() => {}); } catch { /* Extension may be reloaded. */ }
  }
  function detach() {
    cancelGeneration += 1;
    observer?.disconnect();
    clearInterval(routeTimer);
    clearTimeout(flushTimer);
    routeTimer = flushTimer = null;
    batch = [];
    knownNodes = new WeakMap();
    recent = new Map();
    recentSelf = new Map();
    session = null;
    if (inFlight) inFlight.cancel();
  }
  function stillInRoom() {
    if (!session) return false;
    if (roomId() === session.roomId) return true;
    emit({ type: 'room-gone', sessionId: session.id });
    detach();
    return false;
  }
  function parse(node) {
    if (!(node instanceof Element) || !node.matches(ITEM)) return null;
    const text = (node.dataset.danmaku || node.querySelector('.danmaku-content, .text')?.textContent || '').trim().slice(0, 500);
    const user = (node.dataset.uname || node.querySelector('.user-name')?.textContent || '').trim().replace(/[:：]\s*$/, '').slice(0, 100);
    if (!text || !user) return null;
    return { text, user, domId: node.dataset.danmakuId || node.dataset.id || '' };
  }
  function signature(parsed) { return `${parsed.domId}\u0000${parsed.user}\u0000${parsed.text}`; }
  function collect(node) {
    if (!stillInRoom()) return;
    const parsed = parse(node);
    if (!parsed) return;
    const key = signature(parsed);
    if (knownNodes.get(node) === key) return;
    knownNodes.set(node, key);
    const now = Date.now();
    for (const [id, at] of recent) if (now - at > 30_000) recent.delete(id);
    const dedupKey = parsed.domId ? `id:${parsed.domId}` : `text:${parsed.user}\u0000${parsed.text}`;
    const prior = recent.get(dedupKey);
    if (prior !== undefined && (parsed.domId || now - prior < 1_500)) return;
    recent.set(dedupKey, now);
    if (recent.size > 500) recent.delete(recent.keys().next().value);
    for (const [text, at] of recentSelf) if (now - at > 30_000) recentSelf.delete(text);
    const isSelf = recentSelf.has(parsed.text);
    if (inFlight?.clicked && inFlight.text === parsed.text) inFlight.echo();
    batch.push({ id: `dom-${crypto.randomUUID()}`, kind: isSelf ? 'self' : 'chat', text: parsed.text, user: parsed.user, at: now });
    if (batch.length > 100) batch.shift();
    if (!flushTimer) flushTimer = setTimeout(() => {
      flushTimer = null;
      if (!stillInRoom()) return;
      const events = batch;
      batch = [];
      if (events.length) emit({ type: 'room-events', sessionId: session.id, events });
    }, 60);
  }
  function inspect(node) {
    const element = node instanceof Element ? node : node.parentElement;
    if (!element) return;
    const parent = element.closest(ITEM);
    if (parent) collect(parent);
    for (const child of element.querySelectorAll(ITEM)) collect(child);
  }
  function attach(message) {
    const id = roomId();
    if (!id || !validId(message.sessionId)) return { ok: false, error: '请打开有效的 B 站数字房间链接' };
    if (session?.id === message.sessionId && session.roomId === id) return { ok: true, roomId: id, title: document.title.slice(0, 200) };
    detach();
    session = { id: message.sessionId, roomId: id };
    knownNodes = new WeakMap();
    recent = new Map();
    recentSelf = new Map();
    // Seed existing items; attaching never replays the historical chat list.
    for (const node of document.querySelectorAll(ITEM)) {
      const parsed = parse(node);
      if (parsed) {
        knownNodes.set(node, signature(parsed));
        if (parsed.domId) recent.set(`id:${parsed.domId}`, Date.now());
      }
    }
    observer = new MutationObserver(records => {
      if (!stillInRoom()) return;
      for (const record of records) {
        if (record.type === 'characterData' || record.type === 'attributes') inspect(record.target);
        else for (const node of record.addedNodes) inspect(node);
      }
    });
    observer.observe(document.body || document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['data-uname', 'data-danmaku', 'data-id', 'data-danmaku-id'] });
    routeTimer = setInterval(stillInRoom, 500);
    return { ok: true, roomId: id, title: document.title.slice(0, 200) };
  }
  const visible = element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
  const disabled = element => element.disabled || element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true' || /(^|\s)(disabled|is-disabled)(\s|$)/.test(element.className);
  const readInput = element => element.isContentEditable ? element.textContent : element.value;
  function writeInput(element, text) {
    if (element.isContentEditable) element.textContent = text;
    else {
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, text);
    }
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: text ? 'insertText' : 'deleteContentBackward', data: text || null }));
  }
  function findComposer() {
    const pairs = new Map();
    for (const container of document.querySelectorAll('#chat-control-panel-vm, .chat-input-ctnr, .chat-control-panel')) {
      for (const input of container.querySelectorAll('textarea, input.chat-input, input.danmaku-input, [contenteditable="true"]')) {
        if (!visible(input)) continue;
        const scope = input.closest('.chat-input-ctnr, .chat-control-panel, #chat-control-panel-vm');
        const buttons = [...scope.querySelectorAll('button, [role="button"], .send-button, .chat-send-button')].filter(button => visible(button) && button.textContent.trim() === '发送');
        if (buttons.length === 1) pairs.set(input, { input, button: buttons[0] });
      }
    }
    return pairs.size === 1 ? [...pairs.values()][0] : null;
  }

  async function send(message) {
    const sendGeneration = cancelGeneration;
    if (!stillInRoom() || message.sessionId !== session?.id) return { ok: false, error: '直播间或监听会话已改变' };
    if (!validId(message.messageId)) return { ok: false, error: '缺少有效的发送编号' };
    const dedupId = `${message.sessionId}\u0000${message.messageId}`;
    if (sentIds.has(dedupId)) return { ok: false, error: '此消息已经尝试发送，不能自动重试' };
    if (sentIds.size >= 2_000) return { ok: false, error: '本页发送记录已达上限，请重新加载直播间' };
    sentIds.add(dedupId);
    if (inFlight) return { ok: false, error: '上一条消息仍在确认中' };
    const text = typeof message.text === 'string' ? message.text.trim() : '';
    if (!text || [...text].length > 80 || /[\r\n\u0000-\u001f]/.test(text)) return { ok: false, error: '弹幕须为 1–80 字的单行文字' };
    const composer = findComposer();
    if (!composer) return { ok: false, error: '无法唯一识别弹幕输入框和发送按钮，请检查登录状态或页面布局' };
    const { input, button } = composer;
    if (readInput(input).trim() || document.activeElement === input) return { ok: false, error: '你正在输入弹幕，助手不会覆盖或插入文字' };
    if (disabled(input) || input.readOnly || disabled(button)) return { ok: false, error: '网页暂不允许发送，请检查登录、禁言或冷却状态' };
    if (input.maxLength > 0 && text.length > input.maxLength) return { ok: false, error: '文字超过网页弹幕长度限制' };

    let timer;
    let resolveResult;
    let finished = false;
    const sessionId = session.id;
    const clearDraft = () => {
      if (!operation.clicked && input.isConnected && readInput(input) === text && document.activeElement !== input) writeInput(input, '');
    };
    const result = new Promise(resolve => { resolveResult = resolve; });
    const complete = value => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolveResult(value);
    };
    const operation = {
      text, clicked: false,
      echo: () => {
        if (!readInput(input).trim() && session?.id === sessionId && roomId() === session.roomId) complete({ ok: true, confirmedBy: 'new-room-echo' });
      },
      cancel: () => {
        clearDraft();
        complete({ ok: false, error: operation.clicked ? '已取消后续操作，发送结果请以直播间为准' : '已取消发送', uncertain: operation.clicked });
      },
    };
    inFlight = operation;
    try {
      writeInput(input, text);
      await new Promise(resolve => setTimeout(resolve, 80));
      if (finished) return await result;
      if (sendGeneration !== cancelGeneration || !stillInRoom() || session?.id !== sessionId || !input.isConnected || !button.isConnected || readInput(input) !== text || document.activeElement === input || disabled(button)) {
        complete({ ok: false, error: '页面或输入状态已改变，已取消发送' });
      } else {
        // Once clicked, no retry is attempted even if the page response is lost.
        operation.clicked = true;
        recentSelf.set(text, Date.now());
        button.click();
        if (!finished) timer = setTimeout(() => complete({ ok: false, error: '网页未确认发送结果，请检查直播间；助手不会重试', uncertain: true }), 2_500);
      }
      return await result;
    } catch {
      return { ok: false, error: '网页发送发生异常，请检查直播间', uncertain: operation.clicked };
    } finally {
      clearTimeout(timer);
      clearDraft();
      if (inFlight === operation) inFlight = null;
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || message?.target !== 'content') return false;
    if (message.type === 'attach') { respond(attach(message)); return false; }
    if (message.type === 'cancel-send') {
      if (message.sessionId && session && message.sessionId !== session.id) { respond({ ok: false, error: '会话编号不匹配' }); return false; }
      cancelGeneration += 1;
      inFlight?.cancel();
      respond({ ok: true });
      return false;
    }
    if (message.type === 'detach') {
      if (!session || message.sessionId === session.id) { detach(); respond({ ok: true }); }
      else respond({ ok: false, error: '会话编号不匹配' });
      return false;
    }
    if (message.type === 'send') {
      send(message).then(respond, () => respond({ ok: false, error: '发送状态未知，请检查直播间', uncertain: true }));
      return true;
    }
    return false;
  });
  addEventListener('pagehide', () => {
    if (session) emit({ type: 'room-gone', sessionId: session.id });
    detach();
  });
})();
