class CompanionPCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Float32Array(2048);
    this.position = 0;
    this.inFlight = 0;
    this.stopped = false;
    this.chunkStart = 0;
    this.port.onmessage = ({ data }) => {
      if (data?.type === 'ack') this.inFlight = Math.max(0, this.inFlight - 1);
      if (data?.type === 'stop') this.stopped = true;
    };
  }

  process(inputs) {
    if (this.stopped) return false;
    const channels = inputs[0];
    if (!channels?.length || !channels[0]?.length) return true;
    for (let frame = 0; frame < channels[0].length; frame += 1) {
      if (this.position === 0) this.chunkStart = currentTime + frame / sampleRate;
      let sample = 0;
      for (const channel of channels) sample += channel[frame] ?? 0;
      this.samples[this.position++] = sample / channels.length;
      if (this.position === this.samples.length) {
        // The transferable backlog is capped at 32 KiB. A suspended consumer
        // drops audio rather than accumulating an unbounded stream of messages.
        if (this.inFlight < 4) {
          this.port.postMessage({ type: 'pcm', samples: this.samples, at: this.chunkStart }, [this.samples.buffer]);
          this.inFlight += 1;
          this.samples = new Float32Array(2048);
        }
        this.position = 0;
      }
    }
    // This output remains silent. The source is separately connected to the
    // destination so the captured tab keeps playing exactly once.
    return true;
  }
}

registerProcessor('companion-pcm', CompanionPCMProcessor);
