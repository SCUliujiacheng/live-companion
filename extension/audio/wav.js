// Dependency-free PCM helpers. Segmentation detects sound, not whether it is speech
// or singing; the conversation policy makes the final scene decision.
export function encodeWav(pcm, sampleRate) {
  if (!(pcm instanceof Float32Array) || !Number.isInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 192_000) {
    throw new TypeError('无效的音频采样数据');
  }
  const bytes = new ArrayBuffer(44 + pcm.length * 2);
  const view = new DataView(bytes);
  const label = (offset, value) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  label(0, 'RIFF');
  view.setUint32(4, bytes.byteLength - 8, true);
  label(8, 'WAVE');
  label(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  label(36, 'data');
  view.setUint32(40, pcm.length * 2, true);
  for (let index = 0; index < pcm.length; index += 1) {
    const sample = Number.isFinite(pcm[index]) ? Math.max(-1, Math.min(1, pcm[index])) : 0;
    view.setInt16(44 + index * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  }
  return new Blob([bytes], { type: 'audio/wav' });
}

export class VoiceSegmenter {
  constructor(sampleRate, { threshold = 0.012, minVoiceMs = 700, silenceMs = 900, maxMs = 8_000, preRollMs = 200 } = {}) {
    if (!Number.isInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 192_000) throw new TypeError('无效的采样率');
    this.sampleRate = sampleRate;
    this.threshold = threshold;
    this.minVoiceSamples = Math.round(sampleRate * minVoiceMs / 1_000);
    this.silenceSamples = Math.round(sampleRate * silenceMs / 1_000);
    this.maxSamples = Math.max(1, Math.round(sampleRate * maxMs / 1_000));
    this.preRollSamples = Math.min(Math.round(sampleRate * preRollMs / 1_000), this.maxSamples);
    this.frameSamples = Math.max(1, Math.round(sampleRate / 50));
    this.reset();
  }

  reset() {
    this.frames = [];
    this.preRoll = [];
    this.preRollCount = 0;
    this.bufferedSamples = 0;
    this.voicedSamples = 0;
    this.quietSamples = 0;
    this.speaking = false;
    this.startedAt = 0;
  }

  push(pcm, at = Date.now()) {
    const segments = [];
    let level = 0;
    for (let offset = 0; offset < pcm.length;) {
      const available = this.bufferedSamples ? this.maxSamples - this.bufferedSamples : this.frameSamples;
      const length = Math.min(this.frameSamples, available, pcm.length - offset);
      const frame = pcm.slice(offset, offset + length);
      const frameAt = at + offset / this.sampleRate * 1_000;
      offset += length;
      let energy = 0;
      for (const value of frame) energy += Number.isFinite(value) ? value * value : 0;
      const rms = Math.sqrt(energy / frame.length);
      level = Math.max(level, rms);
      const voiced = rms >= this.threshold;
      if (!this.bufferedSamples && !voiced && !this.speaking) {
        this.preRoll.push({ pcm: frame, at: frameAt });
        this.preRollCount += frame.length;
        while (this.preRollCount > this.preRollSamples && this.preRoll.length) {
          const excess = this.preRollCount - this.preRollSamples;
          const oldest = this.preRoll[0];
          if (oldest.pcm.length <= excess) {
            this.preRoll.shift();
            this.preRollCount -= oldest.pcm.length;
          } else {
            oldest.pcm = oldest.pcm.slice(excess);
            oldest.at += excess / this.sampleRate * 1_000;
            this.preRollCount -= excess;
          }
        }
        continue;
      }
      if (!this.bufferedSamples) {
        this.frames = this.preRoll.map(item => item.pcm);
        this.bufferedSamples = this.preRollCount;
        this.startedAt = this.preRoll[0]?.at ?? frameAt;
        this.preRoll = [];
        this.preRollCount = 0;
      }
      this.frames.push(frame);
      this.bufferedSamples += frame.length;
      if (voiced) {
        this.voicedSamples += frame.length;
        this.quietSamples = 0;
        this.speaking = true;
      } else {
        this.quietSamples += frame.length;
      }
      if (this.quietSamples >= this.silenceSamples || this.bufferedSamples >= this.maxSamples) {
        const keepSpeaking = voiced && this.bufferedSamples >= this.maxSamples;
        if (this.voicedSamples >= this.minVoiceSamples) {
          const samples = new Float32Array(this.bufferedSamples);
          let position = 0;
          for (const chunk of this.frames) { samples.set(chunk, position); position += chunk.length; }
          segments.push({ pcm: samples, sampleRate: this.sampleRate, at: this.startedAt, durationMs: samples.length / this.sampleRate * 1_000 });
        }
        this.reset();
        this.speaking = keepSpeaking;
      }
    }
    return { segments, level, speaking: this.speaking };
  }
}
