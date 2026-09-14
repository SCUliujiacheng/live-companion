import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { DEFAULT_SETTINGS } from '../extension/core/settings.js';

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); } catch { /* Optional browser regression tests. */ }

async function openPanel({ preview = false } = {}) {
  const browser = await playwright.chromium.launch({ headless: true, ...(process.env.LIVE_COMPANION_BROWSER ? { executablePath: process.env.LIVE_COMPANION_BROWSER } : {}) });
  try {
    const page = await browser.newPage();
    const resources = new Map(await Promise.all([
      ['sidepanel.html', 'text/html'], ['sidepanel.js', 'text/javascript'],
      ['sidepanel.css', 'text/css'], ['core/settings.js', 'text/javascript'],
    ].map(async ([path, contentType]) => [`/${path}`, { contentType, body: await readFile(new URL(`../extension/${path}`, import.meta.url), 'utf8') }])));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      const resource = url.origin === 'https://panel.test' && resources.get(url.pathname);
      return resource ? route.fulfill(resource) : route.abort('blockedbyclient');
    });
    await page.addInitScript(({ preview }) => {
      window.__panelTest = { requests: [], permissionRequests: [], bootstrapRequested: false };
      if (preview) return;
      window.chrome = {
        runtime: {
          id: 'isolated-panel-test',
          onMessage: { addListener() {} },
          sendMessage(message) {
            window.__panelTest.requests.push(message);
            if (message.type === 'get-state') {
              window.__panelTest.bootstrapRequested = true;
              return new Promise(resolve => { window.__panelTest.releaseBootstrap = resolve; });
            }
            return Promise.resolve({ ok: true });
          },
        },
        permissions: { request(options) { window.__panelTest.permissionRequests.push(options); return Promise.resolve(true); } },
      };
    }, { preview });
    await page.goto('https://panel.test/sidepanel.html');
    if (!preview) await page.waitForFunction(() => window.__panelTest.bootstrapRequested);
    await page.locator('#open-settings').click();
    return { browser, page };
  } catch (error) { await browser.close(); throw error; }
}

test('panel waits for late settings before allowing edits and preserves edits after readiness', { skip: !playwright }, async () => {
  const { browser, page } = await openPanel();
  try {
    assert.equal(await page.locator('#chat-base-url').isDisabled(), true, 'an unresolved get-state must block edits that it could later overwrite');
    assert.equal(await page.locator('#transcription-api-key').isDisabled(), true);
    assert.equal(await page.locator('#save-settings').isDisabled(), true);
    assert.equal(await page.locator('#start-button').isDisabled(), true);
    assert.notEqual(await page.locator('body').getAttribute('data-ready'), 'true');
    await assert.rejects(page.locator('#chat-base-url').fill('https://early-edit.test/v1', { timeout: 200 }), /Timeout/);

    const settings = {
      ...DEFAULT_SETTINGS,
      chat: { baseUrl: 'https://saved-chat.test/v1', model: 'saved-chat-model', apiKey: 'test-only-chat-key' },
      transcription: { baseUrl: 'https://saved-audio.test/v1', model: 'saved-audio-model', apiKey: 'test-only-audio-key' },
    };
    await page.evaluate(settings => window.__panelTest.releaseBootstrap({ ok: true, settings, state: { status: 'idle', events: [], logs: [], pending: null, error: '' } }), settings);
    await page.waitForFunction(() => document.body.dataset.ready === 'true');
    assert.equal(await page.locator('#chat-base-url').isDisabled(), false);
    assert.equal(await page.locator('#chat-base-url').inputValue(), settings.chat.baseUrl);
    assert.equal(await page.locator('#chat-model').inputValue(), settings.chat.model);
    await page.locator('#chat-base-url').fill('https://new-chat.test/v1');
    await page.locator('#chat-api-key').fill('test-only-new-chat-key');
    await page.locator('#chat-model').fill('new-chat-model');
    await page.locator('#save-settings').click();
    await page.waitForFunction(() => document.querySelector('#feedback').textContent.includes('设置已保存'));
    const result = await page.evaluate(() => ({
      save: window.__panelTest.requests.find(message => message.type === 'save-settings'),
      permissions: window.__panelTest.permissionRequests,
    }));
    assert.equal(result.save.settings.chat.baseUrl, 'https://new-chat.test/v1');
    assert.equal(result.save.settings.chat.model, 'new-chat-model');
    assert.equal(result.save.settings.transcription.baseUrl, settings.transcription.baseUrl);
    assert.deepEqual(result.permissions, [{ origins: ['https://new-chat.test/*', 'https://saved-audio.test/*'] }]);
  } finally { await browser.close(); }
});

test('panel keeps settings and live actions blocked if initial settings cannot load', { skip: !playwright }, async () => {
  const { browser, page } = await openPanel();
  try {
    await page.evaluate(() => window.__panelTest.releaseBootstrap({ ok: false, error: '模拟的设置读取失败' }));
    await page.waitForFunction(() => document.querySelector('#feedback').textContent.includes('模拟的设置读取失败'));
    assert.notEqual(await page.locator('body').getAttribute('data-ready'), 'true');
    assert.equal(await page.locator('#chat-api-key').isDisabled(), true);
    assert.equal(await page.locator('#save-settings').isDisabled(), true);
    assert.equal(await page.locator('#test-chat').isDisabled(), true);
    assert.equal(await page.locator('#clear-data').isDisabled(), true);
    assert.equal(await page.locator('#start-button').isDisabled(), true);
    assert.equal(await page.evaluate(() => window.__panelTest.permissionRequests.length), 0);
  } finally { await browser.close(); }
});

test('standalone preview remains editable without enabling API or live actions', { skip: !playwright }, async () => {
  const { browser, page } = await openPanel({ preview: true });
  try {
    assert.equal(await page.locator('#preview-banner').isVisible(), true);
    assert.equal(await page.locator('#chat-base-url').isDisabled(), false);
    assert.equal(await page.locator('#save-settings').isDisabled(), true);
    assert.equal(await page.locator('#start-button').isDisabled(), true);
    assert.notEqual(await page.locator('body').getAttribute('data-ready'), 'true');
  } finally { await browser.close(); }
});
