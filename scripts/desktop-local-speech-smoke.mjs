// Real offline CPU Whisper verification using synthetic Windows SAPI speech.
// Explicit prepare downloads pinned public model files into a reusable cache.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { createLocalSpeech, LOCAL_SPEECH_MODEL } from '../desktop/local-speech.js';

const requestedDirectory = process.argv.indexOf('--directory');
const directory = resolve(requestedDirectory >= 0 ? process.argv[requestedDirectory + 1] : join(tmpdir(), 'live-companion-speech-model-cache'));
const temporary = await mkdtemp(join(tmpdir(), 'live-companion-local-speech-smoke-'));
const wav = join(temporary, 'public-synthetic-speech.wav');
let speech, timer;
try {
  await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
    Add-Type -AssemblyName System.Speech
    $speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
    try {
      $speaker.SelectVoice('Microsoft Huihui Desktop')
      $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
      $speaker.SetOutputToWaveFile($env:LIVE_COMPANION_SMOKE_WAV, $format)
      $speaker.Speak('大家晚上好，欢迎来到直播间。今天我们聊一聊音乐。')
    } finally { $speaker.Dispose() }
  `], { env: { ...process.env, LIVE_COMPANION_SMOKE_WAV: wav }, windowsHide: true });
  const blob = new Blob([await readFile(wav)], { type: 'audio/wav' });
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
  assert.match(text, /欢迎|歡迎/);
  assert.match(text, /直播|音乐|音樂/);
  assert.ok(ticks - ticksBeforeInference > 3, 'main event loop remains responsive during real CPU inference');
  const controller = new AbortController(), cancelStart = Date.now();
  const pending = speech.transcribe(blob, { signal: controller.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  setTimeout(() => controller.abort(), 30);
  await rejected;
  const cancelMs = Date.now() - cancelStart;
  assert.ok(cancelMs < 500, 'cancellation rejects immediately without waiting for native inference');
  const afterCancel = await speech.transcribe(blob);
  assert.match(afterCancel, /欢迎|歡迎/);
  await speech.close();
  speech = createLocalSpeech({ directory });
  const cachedStart = Date.now();
  const offlineText = await speech.transcribe(blob);
  assert.match(offlineText, /欢迎|歡迎/);
  assert.equal(speech.getState().status, 'ready');
  console.log(JSON.stringify({ ok: true, model: LOCAL_SPEECH_MODEL.id, revision: LOCAL_SPEECH_MODEL.revision,
    readyMs, inferenceMs, cancelMs, cachedLoadAndInferenceMs: Date.now() - cachedStart, text, offlineText,
    checks: ['actual CPU Whisper', 'public synthetic Chinese audio', 'pinned revision and weight SHA-256', 'main event loop responsive', 'immediate cancellation and next request succeeds', 'restart uses offline cache'],
  }, null, 2));
} finally {
  clearInterval(timer);
  await speech?.close();
  assert.equal(dirname(resolve(temporary)), resolve(tmpdir()));
  assert.ok(basename(temporary).startsWith('live-companion-local-speech-smoke-'));
  await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
}
