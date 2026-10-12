import test from 'node:test';
import assert from 'node:assert/strict';
import { createCapturePermissionGate } from '../desktop/capture-permission.js';

const trustedURL = 'companion://app/desktop/ui/index.html';
function contents(url) {
  return { url, destroyed: false, mainFrame: {}, getURL() { return this.url; }, isDestroyed() { return this.destroyed; } };
}
function fixture() {
  let time = 100;
  const gate = createCapturePermissionGate({ trustedURL, now: () => time });
  const source = contents('https://live.bilibili.com/12345');
  const receiver = contents(trustedURL);
  const details = { isMainFrame: true, mediaTypes: [], requestingUrl: source.url, securityOrigin: 'companion://app/' };
  return { gate, source, receiver, details, advance: ms => { time += ms; } };
}

test('tab capture permission is restricted to one issued source-to-receiver request', () => {
  const f = fixture();
  assert.equal(f.gate.request(f.source, 'media', f.details), false);
  f.gate.grant(f.source, f.receiver);
  assert.equal(f.gate.request(f.source, 'media', f.details), true);
  assert.equal(f.gate.request(f.source, 'media', f.details), false, 'grant is consumed');
});

test('microphone, camera, foreign origins, other contents and frames remain denied', () => {
  const cases = [
    f => [f.source, 'media', { ...f.details, mediaTypes: ['audio'] }],
    f => [f.source, 'media', { ...f.details, mediaTypes: ['video'] }],
    f => [f.source, 'media', { ...f.details, mediaTypes: undefined }],
    f => [f.source, 'geolocation', f.details],
    f => [f.source, 'media', { ...f.details, securityOrigin: 'https://live.bilibili.com/' }],
    f => [f.source, 'media', { ...f.details, securityOrigin: 'companion://app.evil/' }],
    f => [f.source, 'media', { ...f.details, securityOrigin: 'companion://user@app/' }],
    f => [f.source, 'media', { ...f.details, securityOrigin: 'companion://app/other' }],
    f => [f.source, 'media', { ...f.details, requestingUrl: 'https://live.bilibili.com/67890' }],
    f => [f.source, 'media', { ...f.details, isMainFrame: false }],
    f => [f.receiver, 'media', f.details],
    f => [contents(f.source.url), 'media', f.details],
    f => [null, 'media', f.details],
  ];
  for (const args of cases) {
    const f = fixture();
    f.gate.grant(f.source, f.receiver);
    assert.equal(f.gate.request(...args(f)), false);
    assert.equal(f.gate.request(f.source, 'media', f.details), true, 'denied requests do not consume another request grant');
  }
});

test('cancel, expiry and stale completion cannot authorize a later capture', () => {
  const f = fixture();
  const first = f.gate.grant(f.source, f.receiver);
  f.advance(10_000);
  assert.equal(f.gate.request(f.source, 'media', f.details), false);
  const second = f.gate.grant(f.source, f.receiver);
  f.gate.revoke(first);
  assert.equal(f.gate.request(f.source, 'media', f.details), true);
  f.gate.grant(f.source, f.receiver);
  f.gate.revoke();
  assert.equal(f.gate.request(f.source, 'media', f.details), false);
  f.gate.revoke(second);
});

test('navigation, frame replacement or destruction invalidates an outstanding grant', () => {
  for (const mutate of [
    f => { f.source.url += '?changed'; },
    f => { f.receiver.url += '?changed'; },
    f => { f.source.mainFrame = {}; },
    f => { f.receiver.mainFrame = {}; },
    f => { f.source.destroyed = true; },
    f => { f.receiver.destroyed = true; },
  ]) {
    const f = fixture();
    f.gate.grant(f.source, f.receiver);
    mutate(f);
    assert.equal(f.gate.request(f.source, 'media', f.details), false);
  }
  const f = fixture();
  f.receiver.url = 'https://live.bilibili.com/';
  assert.throws(() => f.gate.grant(f.source, f.receiver));
});
