import { Worker } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Pinned public ONNX conversion of OpenAI Whisper base (multilingual, MIT).
// Sources: https://huggingface.co/onnx-community/whisper-base
// Weight SHA-256 values are the repository's LFS object IDs at this revision.
export const LOCAL_SPEECH_MODEL = Object.freeze({
  id: 'onnx-community/whisper-base', revision: '1846881b6b3a3024392c1eea3ad983695bc23925', dtype: 'q8',
  files: [
    ['config.json', 2243], ['generation_config.json', 3832], ['preprocessor_config.json', 339],
    ['tokenizer.json', 2480466], ['tokenizer_config.json', 282682], ['special_tokens_map.json', 2194],
    ['added_tokens.json', 34604], ['normalizer.json', 52666], ['merges.txt', 493869], ['vocab.json', 1036584],
    ['onnx/encoder_model_quantized.onnx', 23201314, '5862993336bf33acd23736071aae2b32261d3b1b2f37780194460d4ef974dd46'],
    ['onnx/decoder_model_merged_quantized.onnx', 53693315, 'fa3ef9902734ce5ae6f9ef2bdb2ba9a6c4b5785b09f4f420ce036573dc9d090b'],
  ],
});
const DOWNLOAD_BYTES = LOCAL_SPEECH_MODEL.files.reduce((sum, file) => sum + file[1], 0);
const MESSAGES = {
  download: '语音模型下载失败，请检查网络后重新点击准备；需要访问 huggingface.co。',
  cache: '本地语音模型缓存不完整，请重新点击“准备本地识别”修复。',
  load: '本地语音识别加载失败，请重新准备模型；仍失败时请重启应用。',
  audio: '直播音频格式无效，请结束后重新开始监听。',
  busy: '本地语音识别正在处理上一段声音，请稍后再试。',
  inference: '本地语音识别失败，请结束后重新开始监听。',
  timeout: '本地语音处理超时，请重新准备模型后再试。',
};
const aborted = () => Object.assign(new Error('本地语音处理已取消'), { name: 'AbortError' });

/** No model downloads occur on construction or first transcription. prepare()
 * is the explicit download action. Cached transcription loads offline lazily.
 * workerFactory is a test seam; production always uses the bundled worker. */
export function createLocalSpeech({ directory, onChange = () => {}, workerFactory } = {}) {
  if (typeof directory !== 'string' || !isAbsolute(directory)) throw new TypeError('本地语音缓存目录必须是绝对路径');
  let worker = null, serial = 0, closed = false, preparing = null;
  const pending = new Map();
  let state = { status: 'idle', cached: false, progress: 0, busy: false, model: 'Whisper base · 本地中文识别', downloadBytes: DOWNLOAD_BYTES,
    message: '首次使用请点击“准备本地识别”，下载约 81 MB 模型；之后可离线识别。', error: '' };
  const getState = () => ({ ...state });
  function publish(patch) {
    if (closed) return;
    state = { ...state, ...patch };
    try { onChange(getState()); } catch { /* A closing window cannot break worker cleanup. */ }
  }
  const initialized = readFile(join(directory, 'ready.json'), 'utf8').then(text => {
    const cached = JSON.parse(text);
    if (cached.id === LOCAL_SPEECH_MODEL.id && cached.revision === LOCAL_SPEECH_MODEL.revision && cached.dtype === LOCAL_SPEECH_MODEL.dtype) {
      publish({ cached: true, progress: 100, message: '本地语音模型已缓存，开始时会自动加载。' });
    }
  }).catch(() => {});
  function settle(id, error, value) {
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id);clearTimeout(request.timer);request.cleanup?.();
    if (request.kind === 'transcribe') publish({ busy: [...pending.values()].some(item => item.kind === 'transcribe') });
    if (error) request.reject(error); else request.resolve(value);
  }
  function failed(code = 'load') {
    const error = new Error(MESSAGES[code] || MESSAGES.load);
    for (const id of [...pending.keys()]) settle(id, error);
    const old = worker;worker = null;
    old?.terminate().catch(() => {});
    publish({ status: 'error', busy: false, error: error.message, message: error.message });
  }
  function ensureWorker() {
    if (worker) return worker;
    const path = fileURLToPath(new URL('./local-speech-worker.js', import.meta.url)).replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
    const created = workerFactory ? workerFactory({ directory, model: LOCAL_SPEECH_MODEL }) : new Worker(path, { workerData: { directory, model: LOCAL_SPEECH_MODEL } });
    worker = created;
    created.on('message', message => {
      if (closed || worker !== created || !message) return;
      if (message.type === 'progress' && preparing) {
        const status = message.status === 'downloading' ? 'downloading' : 'loading';
        publish({ status, progress: Math.max(0, Math.min(100, Number(message.progress) || 0)), message: status === 'downloading' ? '正在下载本地语音模型，请稍候。' : '正在加载本地语音模型，请稍候。' });
      }
      if (message.type === 'result') {
        const request = pending.get(message.id);
        if (!request) return;
        if (!message.ok) {
          const error = new Error(MESSAGES[message.code] || MESSAGES.inference);
          error.code = message.code;
          settle(message.id, error);
        } else settle(message.id, null, request.kind === 'transcribe' ? String(message.text || '').trim().slice(0, 4000) : true);
      }
    });
    created.on('error', () => { if (!closed && worker === created) failed(); });
    created.on('exit', () => { if (!closed && worker === created) failed(); });
    return created;
  }
  function request(kind, payload, { signal, transfer = [] } = {}) {
    if (closed || signal?.aborted) return Promise.reject(aborted());
    let target;
    try { target = ensureWorker(); } catch { return Promise.reject(new Error(MESSAGES.load)); }
    const id = ++serial;
    return new Promise((resolve, reject) => {
      const cancel = () => {
        try { target.postMessage({ type: 'cancel', id }); } catch { /* Worker already exited. */ }
        settle(id, aborted());
      };
      const timer = setTimeout(() => failed('timeout'), kind === 'prepare' ? 15 * 60_000 : 60_000);
      timer.unref?.();
      pending.set(id, { kind, resolve, reject, timer, cleanup: () => signal?.removeEventListener('abort', cancel) });
      signal?.addEventListener('abort', cancel, { once: true });
      if (kind === 'transcribe') publish({ busy: true });
      try { target.postMessage({ type: kind, id, ...payload }, transfer); }
      catch { settle(id, new Error(MESSAGES.load)); }
    });
  }
  async function prepareModel(allowDownload) {
    if (closed) throw aborted();
    if (state.status === 'ready') return getState();
    if (preparing) return preparing;
    const operation = (async () => {
      await initialized;
      if (closed) throw aborted();
      publish({ status: state.cached ? 'loading' : 'downloading', error: '', progress: state.cached ? 100 : 0,
        message: state.cached ? '正在加载本地语音模型，请稍候。' : '正在下载约 81 MB 本地语音模型，请稍候。' });
      try {
        await request('prepare', { allowDownload });
        if (closed) throw aborted();
        publish({ status: 'ready', cached: true, progress: 100, error: '', message: '本地语音识别已就绪，声音不会上传。' });
        return getState();
      } catch (error) {
        if (!closed) publish({ status: 'error', cached: error.code === 'cache' ? false : state.cached, error: error.message, message: error.message });
        throw error;
      }
    })();
    preparing = operation;
    try { return await operation; } finally { if (preparing === operation) preparing = null; }
  }
  function waitFor(signal, operation) {
    if (!signal) return operation;
    if (signal.aborted) return Promise.reject(aborted());
    return new Promise((resolve, reject) => {
      const cancel = () => { cleanup(); reject(aborted()); };
      const cleanup = () => signal.removeEventListener('abort', cancel);
      signal.addEventListener('abort', cancel, { once: true });
      operation.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    });
  }
  return {
    getState,
    prepare: () => prepareModel(true),
    async transcribe(blob, { signal } = {}) {
      if (closed || signal?.aborted) throw aborted();
      if (!(blob instanceof Blob) || blob.size < 44 || blob.size > 4 * 1024 * 1024) throw new Error(MESSAGES.audio);
      await waitFor(signal, initialized);
      if (closed || signal?.aborted) throw aborted();
      if (state.status !== 'ready') {
        if (preparing) await waitFor(signal, preparing);
        else if (state.cached) await waitFor(signal, prepareModel(false));
        else throw new Error('请先点击“准备本地识别”，下载语音模型。');
      }
      if (closed || signal?.aborted) throw aborted();
      if ([...pending.values()].some(item => item.kind === 'transcribe')) throw new Error(MESSAGES.busy);
      const bytes = await blob.arrayBuffer();
      if (closed || signal?.aborted) throw aborted();
      return request('transcribe', { bytes }, { signal, transfer: [bytes] });
    },
    async close() {
      if (closed) return;
      publish({ status: 'closed', busy: false, message: '本地语音识别已关闭。', error: '' });
      closed = true;
      for (const id of [...pending.keys()]) settle(id, aborted());
      const old = worker;worker = null;
      await old?.terminate().catch(() => {});
    },
  };
}
