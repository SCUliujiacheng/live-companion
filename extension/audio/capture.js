import { encodeWav, VoiceSegmenter } from './wav.js';

export async function startCapture(streamId, callbacks = {}, options = { monitorPlayback: true }) {
  if (typeof streamId !== 'string' || !streamId) throw new Error('缺少直播标签页音频授权，请重新点击开始');
  let stream;
  let context;
  let source;
  let worklet;
  let segmenter;
  let stopped = false;
  let started = false;
  let speaking = false;
  let lastLevelAt = 0;
  let draining = false;
  let queuedBytes = 0;
  const queue = [];
  const trackListeners = [];
  let cancelStartup;
  const startupCancelled = new Promise((_, reject) => { cancelStartup = reject; });
  startupCancelled.catch(() => {});
  const notify = (name, ...values) => { if (!stopped) callbacks[name]?.(...values); };

  function stop() {
    if (stopped) return;
    stopped = true;
    cancelStartup(new Error('标签页音频已停止'));
    queue.length = 0;
    queuedBytes = 0;
    segmenter?.reset();
    for (const [track, listener] of trackListeners) track.removeEventListener('ended', listener);
    if (worklet) {
      worklet.port.onmessage = null;
      worklet.port.postMessage({ type: 'stop' });
      worklet.port.close();
      worklet.disconnect();
    }
    source?.disconnect();
    for (const track of stream?.getTracks() ?? []) track.stop();
    if (context && context.state !== 'closed') void context.close().catch(() => {});
  }

  async function drain() {
    if (draining || stopped) return;
    draining = true;
    try {
      while (queue.length && !stopped) {
        const item = queue.shift();
        queuedBytes -= item.blob.size;
        await callbacks.onSegment?.(item.blob, item.metadata);
      }
    } catch {
      notify('onError', new Error('音频片段处理失败，请暂停后重试'));
      stop();
    } finally { draining = false; }
  }

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
      video: false,
    });
    if (!stream.getAudioTracks().length) throw new Error('直播标签页没有可捕获的音轨');
    for (const track of stream.getAudioTracks()) {
      const ended = () => {
        if (stopped) return;
        try { notify('onEnded'); } finally { stop(); }
      };
      track.addEventListener('ended', ended);
      trackListeners.push([track, ended]);
    }
    context = new AudioContext();
    await Promise.race([context.audioWorklet.addModule(new URL('./pcm-worklet.js', import.meta.url)), startupCancelled]);
    if (stopped) throw new Error('标签页音频已停止');
    segmenter = new VoiceSegmenter(context.sampleRate);
    source = context.createMediaStreamSource(stream);
    worklet = new AudioWorkletNode(context, 'companion-pcm', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    // Chrome extension tab capture needs this playback restoration. Electron's
    // getMediaSourceId path appears to preserve local echo in Chromium, so its
    // caller can disable monitoring to avoid playing the same audio twice.
    if (options.monitorPlayback !== false) source.connect(context.destination);
    source.connect(worklet);
    worklet.connect(context.destination);
    const clockOffset = Date.now() - context.currentTime * 1_000;
    let previousChunkEnd = null;
    worklet.port.onmessage = ({ data }) => {
      if (stopped || data?.type !== 'pcm') return;
      worklet.port.postMessage({ type: 'ack' });
      if (!started || !(data.samples instanceof Float32Array)) return;
      try {
        // Discontinuities occur after suspended processing. Never glue old
        // speech to a later, unrelated conversation after a dropped backlog.
        if (previousChunkEnd !== null && Math.abs(data.at - previousChunkEnd) > 0.1) {
          segmenter.reset();
          if (speaking) { speaking = false; notify('onActivity', { speaking: false, at: Date.now() }); }
        }
        previousChunkEnd = data.at + data.samples.length / context.sampleRate;
        const result = segmenter.push(data.samples, clockOffset + data.at * 1_000);
        const now = Date.now();
        if (now - lastLevelAt >= 120) { lastLevelAt = now; notify('onLevel', Math.min(1, result.level * 5)); }
        if (result.speaking !== speaking) {
          speaking = result.speaking;
          notify('onActivity', { speaking, at: now });
        }
        for (const segment of result.segments) {
          const blob = encodeWav(segment.pcm, segment.sampleRate);
          if (queue.length >= 2 || queuedBytes + blob.size > 2 * 1024 * 1024) throw new Error('音频处理队列已满');
          queue.push({ blob, metadata: { at: segment.at, durationMs: segment.durationMs } });
          queuedBytes += blob.size;
        }
        void drain();
      } catch {
        notify('onError', new Error('音频处理跟不上直播，请暂停后重新开始'));
        stop();
      }
    };
    await Promise.race([context.resume(), startupCancelled]);
    if (stopped || stream.getAudioTracks().some(track => track.readyState === 'ended')) throw new Error('标签页音频已停止');
    started = true;
    return { stop };
  } catch (error) {
    stop();
    throw error;
  }
}
