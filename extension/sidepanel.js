import { DEFAULT_SETTINGS, normalizeSettings, permissionOrigins } from './core/settings.js';

const $ = (id) => document.getElementById(id);
const hasRuntime = Boolean(globalThis.chrome?.runtime?.id && globalThis.chrome?.runtime?.sendMessage);
const isDesktop = Boolean(globalThis.desktopAPI);
const defaults = DEFAULT_SETTINGS;
let state = { status: 'idle', room: null, mode: 'review', singing: false, level: 0, events: [], logs: [], pending: null, sentCount: 0, activity: '' };
let savedSettings = { ...defaults, chat: { ...defaults.chat }, transcription: { ...defaults.transcription } };
let actionBusy = false;
let settingsBusy = false;
let settingsLoaded = !hasRuntime;
let eventSignature = '';
let logSignature = '';
let lastStateError = '';
const formBaseUrls = {};
const usesAccountAI = () => isDesktop && document.body.dataset.aiMode === 'chatgpt-local';

function announce(message, kind = 'success') {
  $('feedback').textContent = message;
  $('feedback').dataset.kind = kind;
  $('feedback').hidden = !message;
}

async function command(type, payload = {}) {
  if (!hasRuntime) throw new Error('当前是界面预览。请在 Chrome 或 Edge 中加载扩展后使用。');
  let result;
  try {
    result = await chrome.runtime.sendMessage({ target: 'background', type, ...payload });
  } catch {
    throw new Error(isDesktop ? '无法连接应用后台。请重新打开应用后重试。' : '无法连接扩展后台。请重新打开侧边栏，或在扩展页面重新加载。');
  }
  if (!result?.ok) throw new Error(result?.error || '操作未完成，请查看运行记录后重试。');
  return result;
}

function cleanBase(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function fillSettings(settings) {
  savedSettings = {
    ...defaults, ...settings,
    chat: { ...defaults.chat, ...settings?.chat },
    transcription: { ...defaults.transcription, ...settings?.transcription },
  };
  for (const kind of ['chat', 'transcription']) {
    $(`${kind}-base-url`).value = savedSettings[kind].baseUrl;
    formBaseUrls[kind] = cleanBase(savedSettings[kind].baseUrl);
    $(`${kind}-api-key`).value = savedSettings[kind].apiKey || '';
    $(`${kind}-model`).value = savedSettings[kind].model;
  }
  $('nickname').value = savedSettings.nickname;
  const style = savedSettings.style || defaults.style;
  if (![...$('style').options].some((option) => option.value === style)) {
    const option = document.createElement('option');
    option.value = style;
    option.textContent = style;
    $('style').append(option);
  }
  $('style').value = style;
  $('room-notes').value = savedSettings.roomNotes;
  $('min-interval').value = savedSettings.minIntervalSec;
  $('countdown').value = savedSettings.countdownSec;
  $('max-length').value = savedSettings.maxLength;
  $('remember-keys').checked = Boolean(savedSettings.rememberKeys);
}

function collectSettings() {
  const settings = {
    nickname: $('nickname').value.trim(), style: $('style').value,
    roomNotes: $('room-notes').value.trim(), minIntervalSec: Number($('min-interval').value),
    countdownSec: Number($('countdown').value), maxLength: Number($('max-length').value),
    rememberKeys: $('remember-keys').checked,
  };
  for (const kind of ['chat', 'transcription']) {
    settings[kind] = usesAccountAI() ? { ...savedSettings[kind] } : {
      baseUrl: cleanBase($(`${kind}-base-url`).value),
      apiKey: $(`${kind}-api-key`).value.trim(), model: $(`${kind}-model`).value.trim(),
    };
  }
  if (usesAccountAI()) settings.rememberKeys = savedSettings.rememberKeys;
  return normalizeSettings(settings);
}

// Called from a direct click / submit gesture. Request permissions before the
// first await so Chrome can attribute its prompt to that user gesture.
async function saveFromGesture(testKind = null) {
  if (settingsBusy || (hasRuntime && !settingsLoaded)) return;
  if (!$('settings-form').reportValidity()) return;
  if (!hasRuntime) {
    announce('界面预览不会保存密钥或调用 API。加载扩展后再填写和保存。', 'error');
    return;
  }
  let settings;
  let permissionPromise;
  try {
    settings = collectSettings();
    const origins = permissionOrigins(settings);
    permissionPromise = chrome.permissions.request({ origins });
  } catch (error) {
    announce(error?.message || '请检查 API 地址格式。', 'error');
    return;
  }
  settingsBusy = true;
  renderControls();
  const output = testKind ? $(`${testKind}-test-result`) : null;
  if (output) {
    output.hidden = false;
    output.dataset.kind = '';
    output.textContent = '等待访问权限并保存配置…';
  }
  try {
    if (!(await permissionPromise)) throw new Error('未获得 API 站点访问权限，设置未保存。');
    await command('save-settings', { settings });
    savedSettings = { ...settings, chat: { ...settings.chat }, transcription: { ...settings.transcription } };
    announce(usesAccountAI() ? '设置已保存。昵称和聊天偏好将用于下一次接话。' : settings.rememberKeys ? (isDesktop ? '设置已保存。密钥已使用系统加密保存在这台电脑。' : '设置已保存。密钥将保留在这台电脑。') : isDesktop ? '设置已保存。密钥仅在本次应用会话中保留。' : '设置已保存。密钥仅在本次浏览器会话中保留。');
    if (testKind) {
      output.textContent = testKind === 'chat' ? '正在测试聊天模型…' : '正在检查转写服务连接…';
      const result = await command('test-api', { kind: testKind });
      output.textContent = result.message || (testKind === 'chat' ? '聊天测试成功。' : '连接检查完成。实际音频转写仍需开始监听后验证。');
    }
  } catch (error) {
    announce(error.message, 'error');
    if (output) {
      output.dataset.kind = 'error';
      output.textContent = error.message;
    }
  } finally {
    settingsBusy = false;
    renderControls();
  }
}

function showSettings(open) {
  $('settings-view').hidden = !open;
  $('companion-view').hidden = open;
  $('open-settings').hidden = open;
  for (const button of document.querySelectorAll('.reveal-key')) {
    $(button.dataset.input).type = 'password';
    button.textContent = '显示';
  }
  if (open) $('close-settings').focus();
  else $('open-settings').focus();
  window.scrollTo({ top: 0, behavior: 'instant' });
}

async function clearLocalData() {
  if (!hasRuntime || !settingsLoaded || settingsBusy || actionBusy) return;
  if (!window.confirm(isDesktop ? '清除聊天设置、API 与上下文？\n\n这会停止陪聊，删除昵称、聊天偏好、API 密钥、本次转写、弹幕上下文和运行记录。保留 B 站登录、ChatGPT 连接与本地识音模型。已发送的数据不会被删除。' : '清除本机设置与密钥？\n\n这会停止监听，删除本机保存的设置、API Key、本次转写、弹幕上下文和运行记录。已发送到直播间或 AI 服务的数据不会被删除。')) return;
  settingsBusy = true;
  renderControls();
  try {
    const result = await command('clear-data');
    fillSettings(result.settings || defaults);
    lastStateError = '';
    for (const kind of ['chat', 'transcription']) {
      $(`${kind}-api-key`).type = 'password';
      $(`${kind}-test-result`).textContent = '';
      $(`${kind}-test-result`).hidden = true;
    }
    for (const button of document.querySelectorAll('.reveal-key')) button.textContent = '显示';
    document.querySelector('input[name="mode"][value="review"]').checked = true;
    updateModeDescription();
    renderState(result.state || { status: 'idle', room: null, mode: 'review', singing: false, level: 0, events: [], logs: [], pending: null, sentCount: 0, error: '', activity: '已清除本机数据', pausedReason: '' });
    announce(isDesktop ? '陪聊已停止，聊天设置、API 密钥与本次上下文已清除。账号连接和识音模型已保留。' : '监听已停止，本机设置、密钥和本次上下文已清除。');
  } catch (error) {
    announce(error.message, 'error');
  } finally {
    settingsBusy = false;
    renderControls();
  }
}

function selectedMode() {
  return document.querySelector('input[name="mode"]:checked')?.value === 'auto' ? 'auto' : 'review';
}

function updateModeDescription() {
  $('mode-description').textContent = selectedMode() === 'auto'
    ? '合适时自动接话；发送前有倒计时，可随时取消。'
    : '搭子准备好回复，由你决定何时发送。';
}

function renderControls() {
  const active = ['starting', 'listening', 'paused'].includes(state.status);
  const disabled = !hasRuntime || !settingsLoaded || actionBusy;
  const accountAI = usesAccountAI();
  for (const section of document.querySelectorAll('[data-api-only]')) section.hidden = accountAI;
  for (const input of document.querySelectorAll('#settings-form input, #settings-form select, #settings-form textarea, #settings-form .reveal-key')) {
    input.disabled = !settingsLoaded || settingsBusy || (accountAI && Boolean(input.closest('[data-api-only]')));
  }
  $('start-button').hidden = active;
  $('pause-button').hidden = !active;
  $('stop-button').hidden = !active;
  $('start-button').disabled = disabled || settingsBusy || (isDesktop && document.body.dataset.aiReady !== 'true');
  $('pause-button').disabled = disabled || state.status === 'starting';
  $('stop-button').disabled = disabled;
  $('pause-button').textContent = state.status === 'starting' ? '正在连接…' : state.status === 'paused' ? '继续陪聊' : '暂停陪聊';
  $('mode-picker').disabled = active || !settingsLoaded;
  $('singing-toggle').disabled = disabled || !active || state.status === 'starting';
  $('cancel-button').disabled = disabled || !state.pending;
  $('send-now-button').disabled = disabled || !state.pending || state.status !== 'listening' || state.singing;
  $('save-settings').disabled = !hasRuntime || !settingsLoaded || settingsBusy;
  $('test-chat').disabled = !hasRuntime || !settingsLoaded || settingsBusy || accountAI;
  $('test-transcription').disabled = !hasRuntime || !settingsLoaded || settingsBusy || accountAI;
  $('clear-data').disabled = !hasRuntime || !settingsLoaded || settingsBusy || actionBusy;
  if ($('copy-chat-service')) $('copy-chat-service').disabled = !settingsLoaded || settingsBusy || accountAI;
  $('save-settings').textContent = !settingsLoaded ? '正在读取设置…' : settingsBusy ? '正在保存 / 检查…' : '保存设置';
}

function timestamp(at) {
  const value = new Date(at || Date.now());
  return Number.isNaN(value.getTime()) ? '' : value.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function renderEvents(events = []) {
  const recent = Array.isArray(events) ? events.slice(-60) : [];
  const signature = JSON.stringify(recent);
  if (signature === eventSignature) return;
  eventSignature = signature;
  $('context-count').textContent = `${recent.length} 条上下文`;
  const stream = $('context-stream');
  const atBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 50;
  const empty = $('context-empty');
  stream.replaceChildren(empty);
  empty.hidden = recent.length > 0;
  for (const event of recent) {
    const article = document.createElement('article');
    article.className = 'context-event';
    article.dataset.kind = event.kind;
    const meta = document.createElement('div');
    meta.className = 'event-meta';
    const kind = document.createElement('span');
    kind.className = 'event-kind';
    kind.textContent = event.kind === 'speech' ? '主播' : event.kind === 'self' ? '我' : '弹幕';
    const user = document.createElement('span');
    user.className = 'event-user';
    user.textContent = event.kind === 'speech' ? '直播语音' : event.kind === 'self' ? 'AI 助手' : event.user || '直播间观众';
    const time = document.createElement('time');
    time.className = 'event-time';
    time.textContent = timestamp(event.at);
    const text = document.createElement('p');
    text.textContent = String(event.text || '').slice(0, 2000);
    meta.append(kind, user, time);
    article.append(meta, text);
    stream.append(article);
  }
  if (atBottom) stream.scrollTop = stream.scrollHeight;
}

function renderLogs(logs = []) {
  const recent = Array.isArray(logs) ? logs.slice(-30).reverse() : [];
  const signature = JSON.stringify(recent);
  if (signature === logSignature) return;
  logSignature = signature;
  $('log-list').replaceChildren();
  if (!recent.length) {
    const item = document.createElement('li');
    item.className = 'muted';
    item.textContent = '本次会话还没有运行记录。';
    $('log-list').append(item);
  }
  for (const log of recent) {
    const item = document.createElement('li');
    item.dataset.level = log.level || 'info';
    const time = document.createElement('time');
    time.textContent = timestamp(log.at);
    const text = document.createElement('span');
    text.textContent = String(log.text || log.message || '').slice(0, 1200);
    item.append(time, text);
    $('log-list').append(item);
  }
}

function renderPending() {
  const pending = state.pending;
  $('candidate-empty').hidden = Boolean(pending);
  $('candidate-content').hidden = !pending;
  if (!pending) {
    $('candidate-state').textContent = state.singing ? '专心听歌' : state.status === 'paused' ? '已暂停' : '等待话题';
    return;
  }
  $('candidate-text').textContent = pending.text || '';
  $('candidate-reason').textContent = pending.reason || '根据最近的主播语音和弹幕生成。';
  const dueAt = typeof pending.dueAt === 'number' ? pending.dueAt : Date.parse(pending.dueAt);
  if (state.mode === 'auto' && Number.isFinite(dueAt)) {
    const seconds = Math.max(0, Math.ceil((dueAt - Date.now()) / 1000));
    $('candidate-state').textContent = seconds > 0 ? `${seconds} 秒后发送` : '正在处理发送';
  } else {
    $('candidate-state').textContent = '等你确认';
  }
}

function renderState(next) {
  if (!next || typeof next !== 'object') return;
  state = { ...state, ...next };
  const names = { idle: '未开始', starting: '连接中', listening: '陪聊中', paused: '已暂停', error: '需要处理' };
  $('status-badge').dataset.status = state.status;
  $('status-label').textContent = names[state.status] || '未开始';
  const roomTitle = state.room?.title;
  $('room-title').textContent = roomTitle || (state.room?.roomId ? `直播间 ${state.room.roomId}` : '准备好，陪主播聊会儿');
  $('room-detail').textContent = state.room?.roomId
    ? `房间 ${state.room.roomId} · ${['starting', 'listening', 'paused'].includes(state.status) ? (state.mode === 'auto' ? '自动接话' : '发送前由你确认') : '已选中直播间'}`
    : isDesktop ? '在顶部粘贴直播间链接，先在左侧登录 B 站账号。' : '打开 B 站直播间，点击浏览器工具栏的搭子图标。';
  $('activity-text').textContent = state.singing ? '听歌中 · 暂停生成和发送' : state.activity || state.pausedReason || ({ idle: '等待开始监听', starting: '正在连接直播声音…', listening: '正在听主播说话', paused: '已暂停，继续后再接话', error: '请检查运行记录' }[state.status] || '等待开始监听');
  $('audio-meter').dataset.active = String(state.status === 'listening' && state.level > 0.01);
  const level = Math.max(0, Math.min(1, Number(state.level) || 0));
  for (const [index, bar] of [...$('audio-meter').children].entries()) {
    const weight = [0.3, 0.55, 0.8, 1, 0.65, 0.9, 1, 0.65, 0.8, 0.45, 0.6, 0.3][index];
    bar.style.height = `${3 + Math.round(level * weight * 15)}px`;
  }
  $('singing-toggle').checked = Boolean(state.singing);
  $('sent-count').textContent = `已发送 ${Math.max(0, Number(state.sentCount) || 0)} 条`;
  if (['starting', 'listening', 'paused'].includes(state.status)) {
    const radio = document.querySelector(`input[name="mode"][value="${state.mode === 'auto' ? 'auto' : 'review'}"]`);
    radio.checked = true;
    updateModeDescription();
  }
  if (state.error && state.error !== lastStateError) {
    announce(state.error, 'error');
    lastStateError = state.error;
  } else if (!state.error) lastStateError = '';
  renderControls();
  renderPending();
  renderEvents(state.events);
  renderLogs(state.logs);
}

async function runAction(type, payload = {}) {
  if (actionBusy || !settingsLoaded) return;
  actionBusy = true;
  renderControls();
  try {
    const result = await command(type, payload);
    if (result.state) renderState(result.state);
    if (result.message) announce(result.message);
    const snapshot = await command('get-state');
    renderState(snapshot.state);
  } catch (error) {
    announce(error.message, 'error');
  } finally {
    actionBusy = false;
    renderControls();
  }
}

$('open-settings').addEventListener('click', () => showSettings(true));
$('close-settings').addEventListener('click', () => showSettings(false));
$('settings-form').addEventListener('submit', (event) => { event.preventDefault(); void saveFromGesture(); });
$('test-chat').addEventListener('click', () => { void saveFromGesture('chat'); });
$('test-transcription').addEventListener('click', () => { void saveFromGesture('transcription'); });
$('clear-data').addEventListener('click', () => { void clearLocalData(); });
$('start-button').addEventListener('click', () => {
  if (!usesAccountAI() && (!savedSettings.chat.apiKey || !savedSettings.transcription.apiKey)) {
    showSettings(true);
    announce('先填写聊天和转写服务的 API Key 并保存，就可以开始陪聊。', 'error');
    return;
  }
  announce('');
  void runAction('start', { mode: selectedMode() });
});
if (isDesktop) window.addEventListener('desktop-ai-state', renderControls);
$('pause-button').addEventListener('click', () => { void runAction(state.status === 'paused' ? 'resume' : 'pause'); });
$('stop-button').addEventListener('click', () => { void runAction('stop'); });
$('cancel-button').addEventListener('click', () => { void runAction('cancel'); });
$('send-now-button').addEventListener('click', () => { void runAction('send-now'); });
$('singing-toggle').addEventListener('change', (event) => { void runAction('singing', { value: event.target.checked }); });
for (const radio of document.querySelectorAll('input[name="mode"]')) radio.addEventListener('change', updateModeDescription);
for (const kind of ['chat', 'transcription']) {
  $(`${kind}-base-url`).addEventListener('input', () => {
    const nextBase = cleanBase($(`${kind}-base-url`).value);
    if (nextBase !== formBaseUrls[kind] && $(`${kind}-api-key`).value) {
      $(`${kind}-api-key`).value = '';
      announce('API 地址已更改，对应密钥已清空。请填写这个服务的密钥后保存。');
    }
    formBaseUrls[kind] = nextBase;
    $(`${kind}-test-result`).hidden = true;
  });
}
for (const button of document.querySelectorAll('.reveal-key')) {
  button.addEventListener('click', () => {
    const input = $(button.dataset.input);
    const reveal = input.type === 'password';
    input.type = reveal ? 'text' : 'password';
    button.textContent = reveal ? '隐藏' : '显示';
    button.setAttribute('aria-label', `${reveal ? '隐藏' : '显示'}${button.dataset.input.startsWith('chat') ? '聊天' : '转写'}密钥`);
  });
}

fillSettings(defaults);
renderState(state);
setInterval(() => { if (state.pending) renderPending(); }, 250);
if (hasRuntime) {
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (sender?.id !== chrome.runtime.id || sender.tab) return;
    if (message?.target === 'panel' && message.type === 'state') renderState(message.state);
  });
  announce('正在读取已保存的设置…');
  command('get-state').then((result) => {
    fillSettings(result.settings || defaults);
    settingsLoaded = true;
    announce('');
    renderState(result.state);
    renderControls();
    document.body.dataset.ready = 'true';
  }).catch((error) => announce(error.message, 'error'));
} else {
  $('preview-banner').hidden = false;
}
