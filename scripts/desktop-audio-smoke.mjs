// Isolated real Electron capture verification. No microphones, API requests,
// actual websites or existing login profiles are used. All windows stay hidden.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { _electron } = require('playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const profile = await mkdtemp(join(tmpdir(), 'live-companion-audio-smoke-'));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
let application;
try {
  application = await _electron.launch({
    // Let Playwright resolve the installed Electron package so it injects its
    // startup loader; passing a bare electron.exe skips that synchronization.
    args: [join(root, 'tests/fixtures/desktop-audio/main.cjs'), '--smoke-root', root, '--smoke-profile', profile],
    env,
    timeout: 30_000,
  });
  await application.evaluate(async () => { await globalThis.audioSmoke.ready; });
  const receiver = application.windows().find(page => page.url().startsWith('companion://app/'));
  assert.ok(receiver, 'trusted capture renderer is available');
  await receiver.waitForFunction(() => typeof window.audioSmokeReceiver?.start === 'function');
  const versions = await application.evaluate(() => ({ electron: process.versions.electron, chromium: process.versions.chrome }));
  const denied = await application.evaluate(async () => {
    const { source, other, receiver, capturePermission } = globalThis.audioSmoke;
    const request = async sourceContents => {
      const id = sourceContents.getMediaSourceId(receiver.webContents);
      return receiver.webContents.executeJavaScript(`navigator.mediaDevices.getUserMedia({audio:{mandatory:{chromeMediaSource:'tab',chromeMediaSourceId:${JSON.stringify(id)}}},video:false}).then(stream=>{stream.getTracks().forEach(track=>track.stop());return {ok:true};},error=>({ok:false,name:error.name}))`);
    };
    capturePermission.grant(source.webContents, receiver.webContents);
    const otherPage = await request(other.webContents);
    capturePermission.revoke();
    const cancelled = await request(source.webContents);
    return { otherPage, cancelled };
  });
  assert.deepEqual(denied, { otherPage: { ok: false, name: 'NotAllowedError' }, cancelled: { ok: false, name: 'NotAllowedError' } });
  const streamId = await application.evaluate(() => {
    const { source, receiver, capturePermission } = globalThis.audioSmoke;
    if (source.webContents.session === receiver.webContents.session) throw new Error('Fixture must use separate source and receiver partitions');
    capturePermission.grant(source.webContents, receiver.webContents);
    return source.webContents.getMediaSourceId(receiver.webContents);
  });
  const tracks = await receiver.evaluate(id => window.audioSmokeReceiver.start(id), streamId);
  assert.deepEqual(tracks, { audioTracks: 1, videoTracks: 0 });
  await receiver.waitForFunction(() => window.audioSmokeReceiver.segments.length >= 1 || window.audioSmokeReceiver.errors.length > 0, undefined, { timeout: 15_000 });
  const beforeMute = await receiver.evaluate(() => window.audioSmokeReceiver.snapshot());
  assert.deepEqual(beforeMute.errors, []);
  assert.ok(beforeMute.levels.some(sample => sample.level > 0.03), 'designated source produces a nonzero captured level');
  assert.ok(beforeMute.segments[0].tone440 > 0.01, '440Hz target tone is present in WAV');
  assert.ok(beforeMute.segments[0].tone880 < beforeMute.segments[0].tone440 / 30, '880Hz unrelated page is excluded from captured audio');
  assert.equal(beforeMute.constraints.video, false);
  assert.equal(beforeMute.constraints.audio.mandatory.chromeMediaSource, 'tab');
  const sourcePlayback = await application.evaluate(() => {
    const wc = globalThis.audioSmoke.source.webContents;
    return { audible: wc.isCurrentlyAudible(), muted: wc.isAudioMuted() };
  });
  assert.deepEqual(sourcePlayback, { audible: true, muted: false }, 'capturing the page preserves its original audible output');
  const reusedPermission = await application.evaluate(async () => {
    const { source, receiver } = globalThis.audioSmoke;
    const id = source.webContents.getMediaSourceId(receiver.webContents);
    return receiver.webContents.executeJavaScript(`navigator.mediaDevices.getUserMedia({audio:{mandatory:{chromeMediaSource:'tab',chromeMediaSourceId:${JSON.stringify(id)}}},video:false}).then(stream=>{stream.getTracks().forEach(track=>track.stop());return {ok:true};},error=>({ok:false,name:error.name}))`);
  });
  assert.deepEqual(reusedPermission, { ok: false, name: 'NotAllowedError' }, 'a successful capture does not cache a reusable permission');
  const mutedAt = await application.evaluate(async () => {
    await globalThis.audioSmoke.source.webContents.executeJavaScript('tone.gain.gain.value = 0; true');
    return Date.now();
  });
  await receiver.waitForFunction(at => window.audioSmokeReceiver.levels.filter(sample => sample.at > at + 700).length >= 5, mutedAt, { timeout: 5_000 });
  const muted = await receiver.evaluate(() => window.audioSmokeReceiver.snapshot());
  const quietLevels = muted.levels.filter(sample => sample.at > mutedAt + 700);
  assert.ok(quietLevels.every(sample => sample.level < 0.002), 'unrelated 880Hz page is still excluded when the target page is silent');
  const unrelated = await application.evaluate(() => globalThis.audioSmoke.other.webContents.executeJavaScript('toneState()'));
  assert.ok(unrelated.rms > 0.01, 'unrelated source was actually playing throughout the silence check');
  await receiver.evaluate(() => window.audioSmokeReceiver.stop());
  await receiver.waitForFunction(() => window.audioSmokeReceiver.snapshot().contextStates.every(state => state === 'closed'));
  const stopped = await receiver.evaluate(() => window.audioSmokeReceiver.snapshot());
  assert.ok(stopped.trackStates.length > 0 && stopped.trackStates.every(state => state === 'ended'), 'capture tracks stop');
  assert.ok(stopped.contextStates.length > 0 && stopped.contextStates.every(state => state === 'closed'), 'capture AudioContext closes');
  const sourceState = await application.evaluate(async () => {
    await globalThis.audioSmoke.source.webContents.executeJavaScript('tone.gain.gain.value = 0.035; true');
    return globalThis.audioSmoke.source.webContents.executeJavaScript('toneState()');
  });
  assert.equal(sourceState.state, 'running', 'stopping capture leaves the source audio graph running');
  await application.evaluate(async () => { await globalThis.audioSmoke.source.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 150))'); });
  const resumedSource = await application.evaluate(() => globalThis.audioSmoke.source.webContents.executeJavaScript('toneState()'));
  assert.ok(resumedSource.rms > 0.01, 'source continues generating audio after capture stops');
  const noLateCallbacks = await receiver.evaluate(() => window.audioSmokeReceiver.snapshot());
  assert.equal(noLateCallbacks.levels.length, stopped.levels.length, 'no level callbacks after stop');
  assert.deepEqual(noLateCallbacks.errors, []);
  const grantedRequests = await application.evaluate(() => globalThis.audioSmoke.permissionLog.filter(entry => entry.allowed));
  assert.equal(grantedRequests.length, 1);
  assert.equal(grantedRequests[0].source, true);
  assert.equal(grantedRequests[0].details.securityOrigin, 'companion://app/');
  assert.deepEqual(grantedRequests[0].details.mediaTypes, []);
  console.log(JSON.stringify({
    ok: true, versions, tracks, separatePartitions: true, wav: beforeMute.segments[0],
    maximumQuietLevel: Math.max(...quietLevels.map(sample => sample.level)),
    stop: { contexts: stopped.contextStates, tracks: stopped.trackStates, sourceState: resumedSource.state },
    sourcePlayback,
    permissions: { cancelledCapture: denied.cancelled.name, unapprovedSource: denied.otherPage.name, reusedPermission: reusedPermission.name, grantedRequests: grantedRequests.length },
    checks: ['real getMediaSourceId', 'production single-use permission gate', 'actual audio-only getUserMedia tab capture', 'actual production WAV segment', '440Hz target present', '880Hz unrelated page excluded', 'source silence excludes unrelated audio', 'resources released', 'source remains playing', 'no callbacks after stop'],
  }, null, 2));
} catch (error) {
  if (application) {
    const diagnostic = await application.evaluate(() => ({ permissionLog: globalThis.audioSmoke?.permissionLog })).catch(() => null);
    console.error(JSON.stringify({ audioSmokeDiagnostic: diagnostic }));
  }
  throw error;
} finally {
  await application?.close();
  const target = resolve(profile);
  assert.equal(dirname(target), resolve(tmpdir()));
  assert.ok(basename(target).startsWith('live-companion-audio-smoke-'));
  await rm(target, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 });
}
