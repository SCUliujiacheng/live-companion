import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { createLocalSpeech, LOCAL_SPEECH_MODEL } from '../desktop/local-speech.js';
import { decodePcmWav } from '../desktop/local-speech-worker.js';
import { encodeWav } from '../extension/audio/wav.js';

class FakeWorker extends EventEmitter {
  messages = [];
  postMessage(message) { this.messages.push(message); this.emit('posted', message); }
  reply(message) { this.emit('message', message); }
  async terminate() { this.terminated = true; return 0; }
}
async function fixture(t, cached = false) {
  const directory = await mkdtemp(join(tmpdir(), 'live-companion-speech-test-'));
  if (cached) await writeFile(join(directory, 'ready.json'), JSON.stringify(LOCAL_SPEECH_MODEL));
  const workers = [], changes = [];
  const speech = createLocalSpeech({ directory, onChange: state => changes.push(state), workerFactory: () => { const worker = new FakeWorker(); workers.push(worker); return worker; } });
  t.after(async () => {
    await speech.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('live-companion-speech-test-'));
    await rm(directory, { recursive: true, force: true });
  });
  return { speech, workers, changes };
}
async function preparing(f) {
  const promise = f.speech.prepare();
  while (!f.workers[0]?.messages.length) await new Promise(resolve => setImmediate(resolve));
  return { promise, worker: f.workers[0], message: f.workers[0].messages[0] };
}
async function ready(f) {
  const { promise, worker, message } = await preparing(f);
  worker.reply({ type: 'result', id: message.id, ok: true });
  await promise;
  return worker;
}
const audio = () => encodeWav(new Float32Array(16_000).fill(0.1), 16_000);

test('first transcription cannot silently download a model; prepare is explicit and shared', async t => {
  const f = await fixture(t);
  await assert.rejects(f.speech.transcribe(audio()), /准备本地识别/);
  assert.equal(f.workers.length, 0);
  const { promise, worker, message } = await preparing(f);
  const again = f.speech.prepare();
  assert.equal(message.allowDownload, true);
  worker.reply({ type: 'progress', status: 'downloading', progress: 42 });
  assert.equal(f.speech.getState().progress, 42);
  worker.reply({ type: 'result', id: message.id, ok: true });
  await Promise.all([promise, again]);
  assert.equal(worker.messages.length, 1);
  assert.equal(f.speech.getState().status, 'ready');
  assert.equal(f.speech.getState().cached, true);
  assert.equal(JSON.stringify(f.speech.getState()).includes(tmpdir()), false);
});

test('a cached model loads offline when transcribing after restart', async t => {
  const f = await fixture(t, true);
  const promise = f.speech.transcribe(audio());
  while (!f.workers[0]?.messages.length) await new Promise(resolve => setImmediate(resolve));
  const worker = f.workers[0], prepare = worker.messages[0];
  assert.equal(prepare.allowDownload, false);
  const posted = once(worker, 'posted');
  worker.reply({ type: 'result', id: prepare.id, ok: true });
  const [request] = await posted;
  assert.equal(request.type, 'transcribe');
  worker.reply({ type: 'result', id: request.id, ok: true, text: '欢迎来到直播间。' });
  assert.equal(await promise, '欢迎来到直播间。');
});

test('abort rejects promptly, sends cancellation and ignores late inference results', async t => {
  const f = await fixture(t), worker = await ready(f);
  const controller = new AbortController(), posted = once(worker, 'posted');
  const pending = f.speech.transcribe(audio(), { signal: controller.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  const [request] = await posted;
  controller.abort();
  await rejected;
  assert.ok(worker.messages.some(message => message.type === 'cancel' && message.id === request.id));
  worker.reply({ type: 'result', id: request.id, ok: true, text: '过期结果' });
  const nextPosted = once(worker, 'posted');
  const next = f.speech.transcribe(audio());
  const [nextRequest] = await nextPosted;
  worker.reply({ type: 'result', id: nextRequest.id, ok: true, text: '当前结果' });
  assert.equal(await next, '当前结果');
  assert.equal(JSON.stringify(f.changes).includes('过期结果'), false);
});

test('close settles in-flight preparation and never publishes late callbacks', async t => {
  const f = await fixture(t);
  const { promise, worker, message } = await preparing(f);
  const rejection = assert.rejects(promise, { name: 'AbortError' });
  await f.speech.close();
  await rejection;
  const count = f.changes.length;
  worker.reply({ type: 'progress', status: 'downloading', progress: 70 });
  worker.reply({ type: 'result', id: message.id, ok: true });
  assert.equal(f.changes.length, count);
  assert.equal(f.speech.getState().status, 'closed');
  assert.equal(worker.terminated, true);
  await assert.rejects(f.speech.prepare(), { name: 'AbortError' });
});

test('worker errors expose fixed actionable messages instead of paths or raw exceptions', async t => {
  const f = await fixture(t);
  const { promise, worker } = await preparing(f);
  const rejected = assert.rejects(promise, /本地语音/);
  worker.emit('error', new Error('C:/private/location secret-token raw native error'));
  await rejected;
  assert.equal(f.speech.getState().status, 'error');
  assert.doesNotMatch(JSON.stringify(f.changes), /secret-token|private\/location/);
});

test('PCM WAV decoding produces normalized 16kHz mono and rejects malformed or oversized audio', async () => {
  const pcm = Float32Array.from({ length: 48_000 }, (_, i) => 0.2 * Math.sin(2 * Math.PI * 440 * i / 48_000));
  const result = decodePcmWav(await encodeWav(pcm, 48_000).arrayBuffer());
  assert.equal(result.length, 16_000);
  const rms = Math.sqrt(result.reduce((sum, n) => sum + n * n, 0) / result.length);
  assert.ok(rms > 0.13 && rms < 0.15);
  assert.throws(() => decodePcmWav(new ArrayBuffer(20)), /音频/);
  const bad = await audio().arrayBuffer();
  new DataView(bad).setUint32(40, bad.byteLength + 100, true);
  assert.throws(() => decodePcmWav(bad), /音频/);
  assert.throws(() => decodePcmWav(new ArrayBuffer(4 * 1024 * 1024 + 1)), /音频/);
});
