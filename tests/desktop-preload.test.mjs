import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function preload({ url = 'https://live.bilibili.com/12345', mainFrame = true } = {}) {
  const sent = [];
  const handlers = new Map();
  const location = new URL(url);
  const window = {};
  window.top = window;
  const sandbox = {
    URL, Promise, Set, Map, Object, Date,
    process: { isMainFrame: mainFrame }, location, window,
    document: { title: '测试直播间' },
    addEventListener() {},
    require(name) {
      assert.equal(name, 'electron');
      return { ipcRenderer: { on(channel, handler) { handlers.set(channel, handler); }, send(channel, message) { sent.push({ channel, message: structuredClone(message) }); } } };
    },
  };
  const context = vm.createContext(sandbox);
  const source = await readFile(new URL('../desktop/room-preload.cjs', import.meta.url), 'utf8');
  vm.runInContext(source + `\nchrome.runtime.onMessage.addListener((message, sender, respond) => {
    globalThis.observedCommand = {message, sender};
    if (message.type === 'send') { Promise.resolve().then(() => respond({ok:true})); return true; }
    respond({ok:true, roomId:'12345', title:'测试直播间'}); return false;
  });`, context);
  return { sent, handlers, context, command(request) { handlers.get('room-command')?.({}, request); } };
}

test('desktop preload bridges allowed commands and async responses without exposing a page API', async () => {
  const fixture = await preload();
  fixture.command({ requestId: 'request-one', type: 'send', payload: { sessionId: 'session-one', messageId: 'message-one', text: '自然接话', target: 'dangerous', apiKey: 'not-forwarded' } });
  await Promise.resolve();
  const observed = structuredClone(fixture.context.observedCommand);
  assert.deepEqual(observed, { message: { target: 'content', type: 'send', sessionId: 'session-one', messageId: 'message-one', text: '自然接话' }, sender: { id: 'desktop-room' } });
  assert.deepEqual(fixture.sent, [{ channel: 'room-result', message: { requestId: 'request-one', result: { ok: true } } }]);
  assert.equal(vm.runInContext('globalThis.chrome', fixture.context), undefined);
  assert.equal(vm.runInContext('window.electronAPI', fixture.context), undefined);
});

test('desktop preload declines arbitrary commands and non-room or iframe callers', async () => {
  const fixture = await preload();
  fixture.command({ requestId: 'arbitrary', type: 'executeJavaScript', payload: { code: 'dangerous' } });
  assert.equal(fixture.sent[0].message.result.ok, false);
  assert.equal(fixture.context.observedCommand, undefined);
  for (const options of [{ url: 'https://example.com/12345' }, { url: 'https://live.bilibili.com/' }, { mainFrame: false }]) {
    const denied = await preload(options);
    denied.command({ requestId: 'denied', type: 'send', payload: { sessionId: 'one', messageId: 'one', text: '不应发送' } });
    assert.equal(denied.context.observedCommand, undefined);
    assert.ok(denied.sent.every(item => item.message.result?.ok !== true));
  }
});

test('desktop preload forwards only room event types and provides read-only status', async () => {
  const fixture = await preload();
  fixture.command({ requestId: 'status-one', type: 'status' });
  assert.equal(fixture.context.observedCommand, undefined);
  assert.deepEqual(fixture.sent[0].message.result, { ok: true, roomId: '12345', title: '测试直播间', adapterReady: true });
  vm.runInContext(`chrome.runtime.sendMessage({target:'background',type:'room-gone',sessionId:'one'}); chrome.runtime.sendMessage({target:'background',type:'get-settings'});`, fixture.context);
  assert.equal(fixture.sent.filter(item => item.channel === 'room-event').length, 1);
  assert.equal(fixture.sent.at(-1).message.type, 'room-gone');
});
