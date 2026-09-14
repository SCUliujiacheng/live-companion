import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); } catch { /* Optional local browser integration. */ }

test('DOM adapter reads only new chat and refuses occupied, duplicate, off-room, and uncertain sends', { skip: !playwright }, async () => {
  const browser = await playwright.chromium.launch({ headless: true, ...(process.env.LIVE_COMPANION_BROWSER ? { executablePath: process.env.LIVE_COMPANION_BROWSER } : {}) });
  try {
    const page = await browser.newPage();
    const fixture = await readFile(new URL('./fixtures/room.html', import.meta.url), 'utf8');
    await page.route('https://live.bilibili.com/**', route => route.fulfill({ contentType: 'text/html', body: fixture }));
    await page.goto('https://live.bilibili.com/12345');
    await page.evaluate(() => {
      window.emitted = [];
      window.chrome = { runtime: { id: 'test-extension', onMessage: { addListener(listener) { window.receive = listener; } }, sendMessage(message) { window.emitted.push(message); return Promise.resolve(); } } };
      window.command = message => new Promise(resolve => {
        const asynchronous = window.receive({ target: 'content', ...message }, { id: 'test-extension' }, resolve);
        if (asynchronous !== true) resolve({ ok: false, error: 'Unhandled command' });
      });
    });
    await page.addScriptTag({ content: await readFile(new URL('../extension/content.js', import.meta.url), 'utf8') });
    const command = message => page.evaluate(message => window.command(message), message);
    assert.equal((await command({ type: 'attach', sessionId: 'one' })).roomId, '12345');
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => window.emitted.length), 0);
    await page.evaluate(() => { window.addChat('观众A', '聊到哪里啦', 'new-one'); window.addChat('观众A', '聊到哪里啦', 'new-one'); });
    await page.waitForTimeout(100);
    const events = await page.evaluate(() => window.emitted.flatMap(message => message.events ?? []));
    assert.equal(events.length, 1);
    assert.equal(events[0].text, '聊到哪里啦');
    assert.equal(events[0].user, '观众A');

    await page.locator('textarea').fill('用户还没写完');
    assert.equal((await command({ type: 'send', sessionId: 'one', messageId: 'busy', text: '不能覆盖' })).ok, false);
    assert.equal(await page.locator('textarea').inputValue(), '用户还没写完');
    assert.equal(await page.evaluate(() => window.clickCount), 0);
    await page.locator('textarea').fill('');
    await page.locator('textarea').evaluate(element => element.blur());
    const cancelled = command({ type: 'send', sessionId: 'one', messageId: 'cancel-before-click', text: '这条应被取消' });
    await page.waitForTimeout(20);
    const cancelResult = await command({ type: 'cancel-send', sessionId: 'one' });
    const cancelOutcome = await cancelled;
    assert.equal(cancelResult.ok, true);
    assert.equal(cancelOutcome.ok, false);
    assert.equal(await page.evaluate(() => window.clickCount), 0);
    assert.equal(await page.locator('textarea').inputValue(), '');
    const editedThenCancelled = command({ type: 'send', sessionId: 'one', messageId: 'cancel-after-user-edit', text: '助手的草稿' });
    await page.waitForTimeout(20);
    await page.evaluate(() => { document.querySelector('textarea').value = '用户的新输入'; return window.command({ type: 'cancel-send', sessionId: 'one' }); });
    assert.equal((await editedThenCancelled).ok, false);
    assert.equal(await page.locator('textarea').inputValue(), '用户的新输入');
    assert.equal(await page.evaluate(() => window.clickCount), 0);
    await page.locator('textarea').fill('');
    await page.locator('textarea').evaluate(element => element.blur());
    assert.equal((await command({ type: 'send', sessionId: 'one', messageId: 'send-one', text: '接个话' })).ok, true);
    assert.equal((await command({ type: 'send', sessionId: 'one', messageId: 'send-one', text: '接个话' })).ok, false);
    assert.equal(await page.evaluate(() => window.clickCount), 1);

    await page.evaluate(() => { window.suppressEcho = true; });
    const uncertain = await command({ type: 'send', sessionId: 'one', messageId: 'no-echo', text: '没有回声的测试' });
    assert.equal(uncertain.ok, false);
    assert.equal(uncertain.uncertain, true);
    assert.equal(await page.evaluate(() => window.clickCount), 2);
    await page.evaluate(() => history.pushState({}, '', '/54321'));
    assert.equal((await command({ type: 'send', sessionId: 'one', messageId: 'wrong-room', text: '不应发出' })).ok, false);
    assert.equal(await page.evaluate(() => window.clickCount), 2);
    await command({ type: 'detach', sessionId: 'one' });
  } finally { await browser.close(); }
});
