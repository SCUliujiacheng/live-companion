const OPENAI = 'https://api.openai.com/v1';

export const DEFAULT_SETTINGS = Object.freeze({
  chat: Object.freeze({ baseUrl: OPENAI, apiKey: '', model: 'gpt-4.1-mini' }),
  transcription: Object.freeze({ baseUrl: OPENAI, apiKey: '', model: 'gpt-4o-mini-transcribe' }),
  nickname: '',
  style: '轻松自然，短句接梗',
  roomNotes: '',
  minIntervalSec: 45,
  countdownSec: 5,
  maxLength: 30,
  rememberKeys: false,
});

const string = (value, fallback = '', limit = 2000) => typeof value === 'string' ? value.trim().slice(0, limit) : fallback;

function baseAddress(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('API 地址无效，请填写完整的 Base URL。'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && local)) || url.username || url.password || url.search || url.hash) {
    throw new Error('API 地址仅支持 HTTPS 或本机回环 HTTP，不能包含账号、密码、查询参数或片段。');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.href.replace(/\/+$/, '');
}

function bounded(value, fallback, min, max) {
  if (value === '' || value === null || value === undefined) return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.round(number))) : fallback;
}

function providerSettings(input, defaults) {
  return {
    baseUrl: baseAddress(string(input?.baseUrl, defaults.baseUrl) || defaults.baseUrl),
    apiKey: string(input?.apiKey, '', 8192),
    model: string(input?.model, defaults.model, 200) || defaults.model,
  };
}

export function normalizeSettings(input = {}) {
  input = input && typeof input === 'object' ? input : {};
  return {
    chat: providerSettings(input.chat, DEFAULT_SETTINGS.chat),
    transcription: providerSettings(input.transcription, DEFAULT_SETTINGS.transcription),
    nickname: string(input.nickname, '', 80),
    style: string(input.style, DEFAULT_SETTINGS.style, 500) || DEFAULT_SETTINGS.style,
    roomNotes: string(input.roomNotes, '', 4000),
    minIntervalSec: bounded(input.minIntervalSec, 45, 15, 600),
    countdownSec: bounded(input.countdownSec, 5, 3, 15),
    maxLength: bounded(input.maxLength, 30, 8, 60),
    rememberKeys: input.rememberKeys === true,
  };
}

export function endpoint(base, path) {
  const suffix = String(path).replace(/^\/+/, '');
  if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(suffix)) throw new Error('API 路径无效。');
  return `${baseAddress(base)}/${suffix}`;
}

export function permissionOrigins(settings) {
  const normalized = normalizeSettings(settings);
  return [...new Set([normalized.chat, normalized.transcription].map(config => {
    const url = new URL(config.baseUrl);
    // Chromium host match patterns apply to all ports and do not contain :port.
    return `${url.protocol}//${url.hostname}/*`;
  }))];
}

export function splitSettings(settings) {
  const normalized = normalizeSettings(settings);
  const secrets = { chatApiKey: normalized.chat.apiKey, transcriptionApiKey: normalized.transcription.apiKey };
  return {
    publicSettings: { ...normalized, chat: { ...normalized.chat, apiKey: '' }, transcription: { ...normalized.transcription, apiKey: '' } },
    secrets,
  };
}
