import { normalizeSettings } from './settings.js';

const CONTEXT_MS = 120_000;
const FRESH_MS = 15_000;
const DUPLICATE_MS = 10 * 60_000;
const clean = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() : '';
const comparable = value => clean(value).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

function similar(a, b) {
  const left = comparable(a);
  const right = comparable(b);
  if (!left || !right) return false;
  if (left === right) return true;
  // Ignore tiny padding edits around an otherwise identical sentence.
  const shorter = left.length < right.length ? left : right;
  const longer = left.length < right.length ? right : left;
  return shorter.length >= 6 && longer.includes(shorter) && shorter.length / longer.length >= 0.8;
}

export class ConversationPolicy {
  constructor(settings = {}) {
    this.settings = normalizeSettings(settings);
    this.events = [];
    this.sent = [];
    this.lastSentAt = -Infinity;
    this._sequence = 0;
    this._consumedSequence = 0;
    this._pending = false;
    this._cancelUntil = -Infinity;
    this._ids = new Set();
  }

  addEvent(event) {
    if (!event || !['speech', 'chat', 'self'].includes(event.kind)) return false;
    const text = clean(event.text).slice(0, 2000);
    const at = Number(event.at);
    if (!text || !Number.isFinite(at)) return false;
    const id = String(event.id || `${event.kind}:${at}:${text}`);
    if (this._ids.has(id)) return false;
    let kind = event.kind;
    const user = clean(event.user).slice(0, 80);
    const ownName = this.settings.nickname && comparable(user) === comparable(this.settings.nickname);
    const echo = this.sent.some(sent => {
      if (at < sent.at || at - sent.at > DUPLICATE_MS) return false;
      const sentKey = comparable(sent.text);
      return similar(sent.text, text) || (kind === 'speech' && sentKey.length >= 6 && comparable(text).includes(sentKey));
    });
    if (ownName || echo) kind = 'self';
    this.events.push({ id, kind, text, user, at });
    this._ids.add(id);
    if (kind !== 'self') this._sequence++;
    while (this.events.length > 100) this._ids.delete(this.events.shift().id);
    return true;
  }

  getContext(now = Date.now()) {
    return this.events.filter(event => now - event.at <= CONTEXT_MS && event.at <= now + 1000).map(event => ({ ...event }));
  }

  canGenerate(now = Date.now()) {
    if (this._pending || now < this._cancelUntil || now - this.lastSentAt < this.settings.minIntervalSec * 1000 || this._sequence <= this._consumedSequence) return false;
    return this.events.some(event => event.kind !== 'self' && event.at <= now + 1000 && now - event.at <= FRESH_MS);
  }

  consider(candidate, now = Date.now()) {
    if (!this.canGenerate(now)) return { ok: false, reason: '等待新的有效话题，或仍在发言间隔内' };
    this._consumedSequence = this._sequence;
    if (!candidate || candidate.action !== 'reply') return { ok: false, reason: '暂时安静，等待合适的接话时机' };
    if (candidate.scene !== 'chat') return { ok: false, reason: '唱歌或场景不确定，暂不插话' };
    if (typeof candidate.confidence !== 'number' || !Number.isFinite(candidate.confidence) || candidate.confidence < 0.65) return { ok: false, reason: '接话把握不足' };
    if (candidate.respondsToSelf !== false) return { ok: false, reason: '避免回应自己的弹幕或主播念弹幕' };
    const text = clean(candidate.text);
    if (!text || [...text].length > this.settings.maxLength) return { ok: false, reason: '回复为空或超过字数上限' };
    if (/https?:\/\/|www\./i.test(text)) return { ok: false, reason: '自动回复不发送链接' };
    if (this.sent.some(sent => now - sent.at <= DUPLICATE_MS && similar(sent.text, text))) return { ok: false, reason: '这句话刚刚说过，避免复读' };
    this._pending = true;
    return { ok: true, text, reason: clean(candidate.reason).slice(0, 160) || '接住当前话题' };
  }

  markSent(text, now = Date.now()) {
    this._pending = false;
    this.lastSentAt = now;
    this.sent = this.sent.filter(sent => now - sent.at <= DUPLICATE_MS);
    this.sent.push({ text: clean(text), at: now });
    if (this.sent.length > 30) this.sent.shift();
    this.addEvent({ id: `sent:${now}:${this.sent.length}`, kind: 'self', text, user: this.settings.nickname, at: now });
  }

  cancelPending(now = Date.now()) {
    this._pending = false;
    this._consumedSequence = this._sequence;
    this._cancelUntil = now + 3000;
  }
}
