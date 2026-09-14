import { startCapture } from './extension/audio/capture.js';

const contexts = [];
const streams = [];
const NativeAudioContext = globalThis.AudioContext;
globalThis.AudioContext = class extends NativeAudioContext {
  constructor(...args) { super(...args); contexts.push(this); }
};
const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
navigator.mediaDevices.getUserMedia = async constraints => {
  window.audioSmokeReceiver.constraints = constraints;
  const stream = await getUserMedia(constraints);
  streams.push(stream);
  return stream;
};

function amplitude(samples, sampleRate, frequency) {
  const count = Math.min(samples.length, sampleRate);
  const start = Math.min(sampleRate, Math.max(0, samples.length - count));
  let real = 0;
  let imaginary = 0;
  for (let index = 0; index < count; index += 1) {
    const angle = 2 * Math.PI * frequency * index / sampleRate;
    real += samples[start + index] * Math.cos(angle);
    imaginary -= samples[start + index] * Math.sin(angle);
  }
  return 2 * Math.sqrt(real * real + imaginary * imaginary) / count;
}

window.audioSmokeReceiver = {
  levels: [], segments: [], errors: [], constraints: null, ended: 0, capture: null,
  async start(streamId) {
    this.capture = await startCapture(streamId, {
      onLevel: level => this.levels.push({ at: Date.now(), level }),
      onSegment: async (blob, metadata) => {
        const bytes = await blob.arrayBuffer();
        const view = new DataView(bytes);
        const sampleRate = view.getUint32(24, true);
        const samples = new Float32Array((bytes.byteLength - 44) / 2);
        for (let index = 0; index < samples.length; index += 1) samples[index] = view.getInt16(44 + index * 2, true) / 32768;
        this.segments.push({ bytes: bytes.byteLength, sampleRate, durationMs: metadata.durationMs, tone440: amplitude(samples, sampleRate, 440), tone880: amplitude(samples, sampleRate, 880) });
      },
      onEnded: () => { this.ended += 1; },
      onError: error => this.errors.push(error.message),
    }, { monitorPlayback: false });
    return { audioTracks: streams[0].getAudioTracks().length, videoTracks: streams[0].getVideoTracks().length };
  },
  stop() { this.capture?.stop(); },
  snapshot() {
    return { levels: this.levels, segments: this.segments, errors: this.errors, constraints: this.constraints, ended: this.ended, contextStates: contexts.map(context => context.state), trackStates: streams.flatMap(stream => stream.getTracks().map(track => track.readyState)) };
  },
};
