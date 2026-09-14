import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeWav, VoiceSegmenter } from '../extension/audio/wav.js';
import { startCapture } from '../extension/audio/capture.js';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

function feed(segmenter, level, ms, start = 1_000) {
  const output = [];
  for (let elapsed = 0; elapsed < ms; elapsed += 20) {
    output.push(...segmenter.push(new Float32Array(320).fill(level), start + elapsed).segments);
  }
  return output;
}

test('WAV stores signed mono PCM with a valid header and clips extreme samples', async () => {
  const blob = encodeWav(new Float32Array([-2, -1, 0, 1, 2]), 16_000);
  const view = new DataView(await blob.arrayBuffer());
  assert.equal(blob.type, 'audio/wav');
  assert.equal(view.byteLength, 54);
  assert.equal(view.getUint32(24, true), 16_000);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(40, true), 10);
  assert.deepEqual(Array.from({ length: 5 }, (_, i) => view.getInt16(44 + i * 2, true)), [-32768, -32768, 0, 32767, 32767]);
});

test('silence and brief noise do not become transcription requests', () => {
  const segmenter = new VoiceSegmenter(16_000);
  assert.equal(feed(segmenter, 0, 10_000).length, 0);
  assert.equal(feed(segmenter, 0.1, 300).length, 0);
  assert.equal(feed(segmenter, 0, 1_000).length, 0);
  assert.equal(segmenter.speaking, false);
});

test('speech emits only after sustained silence and preserves its start time', () => {
  const segmenter = new VoiceSegmenter(16_000);
  feed(segmenter, 0, 200, 1_000);
  assert.equal(feed(segmenter, 0.2, 800, 1_200).length, 0);
  assert.equal(segmenter.speaking, true);
  assert.equal(feed(segmenter, 0, 880, 2_000).length, 0);
  const segments = feed(segmenter, 0, 20, 2_880);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].at, 1_000);
  assert.equal(segments[0].durationMs, 1_900);
  assert.equal(segments[0].pcm.length, 30_400);
  assert.equal(segmenter.speaking, false);
});

test('continuous audio is split and memory stays bounded', () => {
  const segmenter = new VoiceSegmenter(16_000);
  const segments = feed(segmenter, 0.2, 60_000);
  assert.equal(segments.length, 7);
  assert.ok(segments.every(segment => segment.durationMs <= 8_000));
  assert.ok(segmenter.bufferedSamples <= 128_000);
});

test('reset discards pending audio so stopping cannot flush an old utterance', () => {
  const segmenter = new VoiceSegmenter(16_000);
  feed(segmenter, 0.2, 800);
  segmenter.reset();
  assert.equal(feed(segmenter, 0, 1_000).length, 0);
  assert.equal(segmenter.speaking, false);
});

test('speech ending at a maximum-length boundary still transitions to silence', () => {
  const segmenter = new VoiceSegmenter(16_000);
  assert.equal(feed(segmenter, 0.2, 8_000).length, 1);
  assert.equal(segmenter.speaking, true);
  feed(segmenter, 0, 1_000);
  assert.equal(segmenter.speaking, false);
});

test('the worklet mixes channels and caps its unacknowledged message backlog', async () => {
  let Processor;
  const messages = [];
  const sandbox = {
    Float32Array, currentTime: 0, sampleRate: 16_000,
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage(message) { messages.push(message); } }; } },
    registerProcessor(_name, implementation) { Processor = implementation; },
  };
  vm.runInNewContext(await readFile(new URL('../extension/audio/pcm-worklet.js', import.meta.url), 'utf8'), sandbox);
  const processor = new Processor();
  const inputs = [[new Float32Array(128).fill(0.4), new Float32Array(128).fill(0.2)]];
  for (let index = 0; index < 160; index += 1) processor.process(inputs);
  assert.equal(messages.length, 4);
  assert.ok(Math.abs(messages[0].samples[0] - 0.3) < 0.000001);
  processor.port.onmessage({ data: { type: 'ack' } });
  for (let index = 0; index < 16; index += 1) processor.process(inputs);
  assert.equal(messages.length, 5);
  processor.port.onmessage({ data: { type: 'stop' } });
  assert.equal(processor.process(inputs), false);
});

function fakeAudio(t, { pendingResume = false } = {}) {
  const originals = new Map(['navigator', 'AudioContext', 'AudioWorkletNode'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  t.after(() => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  const track = new EventTarget();
  track.readyState = 'live';
  let stoppedTracks = 0;
  track.stop = () => { stoppedTracks += 1; track.readyState = 'ended'; };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const state = { connections: [], closeCount: 0, track, get stoppedTracks() { return stoppedTracks; } };
  let resumeEntered;
  state.resumeEntered = new Promise(resolve => { resumeEntered = resolve; });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { async getUserMedia(constraints) { state.constraints = constraints; return stream; } } } });
  globalThis.AudioContext = class {
    constructor() { this.sampleRate = 16_000; this.currentTime = 0; this.state = 'suspended'; this.destination = {}; this.audioWorklet = { addModule: async () => {} }; }
    createMediaStreamSource() { return { connect: target => state.connections.push(target), disconnect() {} }; }
    resume() { resumeEntered(); if (pendingResume) return new Promise(() => {}); this.state = 'running'; return Promise.resolve(); }
    close() { state.closeCount += 1; this.state = 'closed'; return Promise.resolve(); }
  };
  globalThis.AudioWorkletNode = class {
    constructor() { state.port = this.port = { postMessage() {}, close() {} }; }
    connect() {}
    disconnect() {}
  };
  return state;
}

test('stopping capture releases resources, keeps original tab playback connected, and prevents new callbacks', async t => {
  const state = fakeAudio(t);
  let callbackCount = 0;
  const capture = await startCapture('authorized-tab', { onActivity() { callbackCount += 1; }, onLevel() { callbackCount += 1; } });
  assert.deepEqual(state.constraints, { audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: 'authorized-tab' } }, video: false });
  assert.equal(state.connections.length, 2);
  const handler = state.port.onmessage;
  handler({ data: { type: 'pcm', samples: new Float32Array(2048).fill(0.2), at: 0 } });
  assert.ok(callbackCount > 0);
  capture.stop();
  const countAtStop = callbackCount;
  handler({ data: { type: 'pcm', samples: new Float32Array(2048).fill(0.2), at: 0.128 } });
  assert.equal(callbackCount, countAtStop);
  assert.equal(state.stoppedTracks, 1);
  assert.equal(state.closeCount, 1);
  capture.stop();
  assert.equal(state.closeCount, 1);
});

test('a track ending while AudioContext.resume is pending cannot leak a capture startup', async t => {
  const state = fakeAudio(t, { pendingResume: true });
  let ended = 0;
  const startup = startCapture('authorized-tab', { onEnded() { ended += 1; } });
  await state.resumeEntered;
  state.track.dispatchEvent(new Event('ended'));
  await assert.rejects(startup, /音频已停止/);
  assert.equal(ended, 1);
  assert.equal(state.closeCount, 1);
  assert.equal(state.stoppedTracks, 1);
});
