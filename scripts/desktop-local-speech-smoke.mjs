// Real offline CPU Whisper verification using a checked-in synthetic Mandarin fixture.
// Explicit prepare downloads pinned public model files into a reusable cache.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { createLocalSpeech, LOCAL_SPEECH_MODEL } from '../desktop/local-speech.js';

const requestedDirectory = process.argv.indexOf('--directory');
const directory = resolve(requestedDirectory >= 0 ? process.argv[requestedDirectory + 1] : join(tmpdir(), 'live-companion-speech-model-cache'));
const wav = new URL('../tests/fixtures/chinese-speech.wav', import.meta.url);
let speech, timer;
try {
  const fixture = await readFile(wav);
  assert.equal(createHash('sha256').update(fixture).digest('hex'), '378fb398ce22ee7afc69cb8a2e1773ad05d1cf4f8077671072216c9b2c7b0890');
  const blob = new Blob([fixture], { type: 'audio/wav' });
  let ticks = 0, lastStatus = '', lastPercent = -1;
  timer = setInterval(() => ticks++, 20);
  const states = [];
  speech = createLocalSpeech({ directory, onChange: state => {
    states.push(state.status);
    const percent = Math.floor(state.progress / 10) * 10;
    if (state.status !== lastStatus || percent !== lastPercent) {
      console.log(JSON.stringify({ status: state.status, progress: percent }));
      lastStatus = state.status;lastPercent = percent;
    }
  } });
  const started = Date.now();
  await speech.prepare();
  const readyMs = Date.now() - started;
  const inferenceStart = Date.now(), ticksBeforeInference = ticks;
  const text = await speech.transcribe(blob);
  const inferenceMs = Date.now() - inferenceStart;
  assert.match(text, /功能/);
  assert.match(text, /模型/);
  assert.match(text, /强大|強大/);
  assert.ok(ticks - ticksBeforeInference > 3, 'main event loop remains responsive during real CPU inference');
  const controller = new AbortController(), cancelStart = Date.now();
  const pending = speech.transcribe(blob, { signal: controller.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  setTimeout(() => controller.abort(), 30);
  await rejected;
  const cancelMs = Date.now() - cancelStart;
  assert.ok(cancelMs < 500, 'cancellation rejects immediately without waiting for native inference');
  const afterCancel = await speech.transcribe(blob);
  assert.match(afterCancel, /功能/);
  await speech.close();
  // A fresh worker with fetch disabled proves cached startup cannot silently
  // succeed by redownloading from the network. No application code is replaced.
  const denyNetwork = 'globalThis.fetch = () => { throw new Error("Offline smoke forbids network"); };';
  speech = createLocalSpeech({ directory, workerFactory: workerData => new Worker(
    new URL('../desktop/local-speech-worker.js', import.meta.url),
    { workerData, execArgv: ['--import', `data:text/javascript,${encodeURIComponent(denyNetwork)}`] },
  ) });
  const cachedStart = Date.now();
  const offlineText = await speech.transcribe(blob);
  assert.match(offlineText, /功能/);
  assert.equal(speech.getState().status, 'ready');
  console.log(JSON.stringify({ ok: true, model: LOCAL_SPEECH_MODEL.id, revision: LOCAL_SPEECH_MODEL.revision,
    readyMs, inferenceMs, cancelMs, cachedLoadAndInferenceMs: Date.now() - cachedStart, text, offlineText,
    checks: ['actual CPU Whisper', 'public synthetic Chinese audio', 'pinned revision and weight SHA-256', 'main event loop responsive', 'immediate cancellation and next request succeeds', 'restart uses offline cache with fetch disabled'],
  }, null, 2));
} finally {
  clearInterval(timer);
  await speech?.close();
}
