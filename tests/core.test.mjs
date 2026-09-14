import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, normalizeSettings, endpoint, permissionOrigins, splitSettings } from '../extension/core/settings.js';
import { ConversationPolicy } from '../extension/core/policy.js';

const NOW = 1_800_000_000_000;
const reply = (text = '家务也讲究批量处理呀') => ({ action: 'reply', text, confidence: 0.9, scene: 'chat', respondsToSelf: false, reason: '接住当前话题' });
const speech = (text = '我都是攒两顿的碗一起洗', at = NOW, id = String(at)) => ({ id, kind: 'speech', text, at });
const ready = (settings = {}) => { const p = new ConversationPolicy(settings); p.addEvent(speech()); return p; };

test('settings preserve separate compatible providers and bound controls', () => {
  const actual = normalizeSettings({ chat: { baseUrl: 'https://example.com/custom/v1///', apiKey: '  abc  ', model: 'custom-model' }, minIntervalSec: 1, countdownSec: 99, maxLength: 300 });
  assert.equal(actual.chat.baseUrl, 'https://example.com/custom/v1');
  assert.equal(actual.chat.apiKey, 'abc');
  assert.equal(actual.chat.model, 'custom-model');
  assert.equal(actual.transcription.model, 'gpt-4o-mini-transcribe');
  assert.equal(actual.minIntervalSec, 15);
  assert.equal(actual.countdownSec, 15);
  assert.equal(actual.maxLength, 60);
  assert.equal(DEFAULT_SETTINGS.chat.apiKey, '');
});

test('settings reject unsafe API addresses before any credential can be sent', () => {
  for (const baseUrl of ['http://example.com/v1', 'file:///tmp/key', 'https://user:secret@example.com/v1', 'https://example.com/v1?key=secret', 'https://example.com/#key', 'http://localhost.evil.test/v1']) {
    assert.throws(() => normalizeSettings({ chat: { baseUrl } }), /API 地址/);
  }
  assert.equal(endpoint('http://127.0.0.1:1234/v1', 'chat/completions'), 'http://127.0.0.1:1234/v1/chat/completions');
  assert.equal(endpoint('http://[::1]:8080/v1/', '/models'), 'http://[::1]:8080/v1/models');
  assert.throws(() => endpoint('https://example.com/v1', '../secrets'), /API 路径/);
});

test('settings trim secrets without exporting them in public storage', () => {
  const settings = normalizeSettings({ chat: { apiKey: 'chat-secret' }, transcription: { baseUrl: 'http://localhost:8000/v1', apiKey: 'audio-secret' }, rememberKeys: false });
  const { publicSettings, secrets } = splitSettings(settings);
  assert.equal(publicSettings.chat.apiKey, '');
  assert.equal(publicSettings.transcription.apiKey, '');
  assert.deepEqual(secrets, { chatApiKey: 'chat-secret', transcriptionApiKey: 'audio-secret' });
  assert.deepEqual(permissionOrigins(settings), ['https://api.openai.com/*', 'http://localhost/*']);
});

test('missing or nonfinite controls restore usable defaults', () => {
  const s = normalizeSettings({ minIntervalSec: '', countdownSec: NaN, maxLength: Infinity, rememberKeys: 'false' });
  assert.equal(s.minIntervalSec, 45);
  assert.equal(s.countdownSec, 5);
  assert.equal(s.maxLength, 30);
  assert.equal(s.rememberKeys, false);
});

test('only fresh external context can trigger a response', () => {
  const p = new ConversationPolicy({});
  assert.equal(p.canGenerate(NOW), false);
  p.addEvent(speech('过去的话题', NOW - 16_000));
  assert.equal(p.canGenerate(NOW), false);
  p.addEvent(speech('现在的话题', NOW));
  assert.equal(p.canGenerate(NOW), true);
  assert.equal(p.canGenerate(NOW + 16_000), false);
});

test('singing, low confidence, and replies to self remain silent', () => {
  for (const overrides of [{ scene: 'singing' }, { scene: 'uncertain' }, { confidence: 0.4 }, { respondsToSelf: true }, { action: 'wait' }]) {
    const p = ready();
    assert.equal(p.consider({ ...reply(), ...overrides }, NOW).ok, false);
    assert.equal(p.canGenerate(NOW + 100), false);
  }
});

test('approved replies reserve a pending slot until cancelled', () => {
  const p = ready();
  const result = p.consider(reply(), NOW);
  assert.equal(result.ok, true);
  assert.equal(result.text, '家务也讲究批量处理呀');
  p.addEvent(speech('新话题', NOW + 1_000));
  assert.equal(p.canGenerate(NOW + 1_000), false);
  p.cancelPending(NOW + 1_000);
  assert.equal(p.canGenerate(NOW + 1_001), false);
  p.addEvent(speech('取消后新的话题', NOW + 5_000));
  assert.equal(p.canGenerate(NOW + 5_000), true);
});

test('send cooldown survives new chat events', () => {
  const p = ready();
  p.markSent('家务也讲究批量处理呀', NOW);
  p.addEvent(speech('下个话题', NOW + 10_000));
  assert.equal(p.canGenerate(NOW + 10_000), false);
  p.addEvent(speech('再下个话题', NOW + 46_000));
  assert.equal(p.canGenerate(NOW + 46_000), true);
});

test('punctuation and full-width changes do not evade duplicate detection', () => {
  const p = ready();
  p.markSent('家务也讲究批量处理呀！😂', NOW);
  p.addEvent(speech('继续这个话题', NOW + 46_000));
  assert.equal(p.consider(reply('家 务也讲究批量处理呀...'), NOW + 46_000).ok, false);
});

test('own nickname and broadcaster reading our sentence cannot restart a loop', () => {
  const p = new ConversationPolicy({ nickname: '我的昵称' });
  p.markSent('家务也讲究批量处理呀', NOW);
  p.addEvent({ id: 'mine', kind: 'chat', user: '我的昵称', text: '新的话题', at: NOW + 50_000 });
  p.addEvent(speech('我的昵称说家务也讲究批量处理呀', NOW + 51_000));
  assert.equal(p.canGenerate(NOW + 51_000), false);
  assert.equal(p.getContext(NOW + 51_000).filter(e => e.kind === 'self').length, 3);
});

test('overlong replies are rejected whole without cutting emoji or meaning', () => {
  const p = ready({ maxLength: 12 });
  assert.equal(p.consider(reply('这是一个超过十二个字的很长很长的回复'), NOW).ok, false);
  assert.equal(ready({ maxLength: 12 }).consider(reply('好耶🥳'), NOW).ok, true);
});

test('event ids deduplicate and the retained context is bounded', () => {
  const p = ready();
  assert.equal(p.addEvent(speech()), false);
  for (let i = 1; i <= 130; i++) p.addEvent(speech(`消息${i}`, NOW + i, `event-${i}`));
  assert.ok(p.events.length <= 100);
  assert.ok(p.getContext(NOW + 130).length <= 100);
  assert.deepEqual(p.getContext(NOW + 200_000), []);
});

test('a delayed old transcription cannot hide a fresh chat message', () => {
  const p = ready();
  p.addEvent(speech('较旧的语音片段现在才转写完', NOW - 30_000));
  assert.equal(p.canGenerate(NOW), true);
});

test('full-width latin reply variants are still duplicates', () => {
  const p = ready();
  p.markSent('That is a good idea!', NOW);
  p.addEvent(speech('新的话题', NOW + 46_000));
  assert.equal(p.consider(reply('ＴＨＡＴ ｉｓ ａ ｇｏｏｄ ｉｄｅａ'), NOW + 46_000).ok, false);
});
