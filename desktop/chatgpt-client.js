// Independent implementation of the public Sign in with ChatGPT OSS protocol.
// https://developers.openai.com/siwc/token-sharing-open-source/sign-in
// https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
// This module belongs in the Electron main process. No credential or authorize
// URL is ever returned to a renderer, state listener, or application log.
import { createServer } from 'node:http';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const ISSUER = 'https://auth.openai.com';
const AUTHORIZE = `${ISSUER}/api/accounts/authorize`;
const TOKEN = `${ISSUER}/api/accounts/oauth/token`;
const DISCOVERY = `${ISSUER}/.well-known/openid-configuration`;
const RESOURCE = 'https://api.openai.com/v1';
const SHARING = 'chatgpt.tokens.use.direct';
const SCOPES = `openid profile email offline_access resource.invoke ${SHARING}`;
const DYNAMIC_CLIENT = 'dynamic_agent_client';
const APP_NAME = '直播搭子';
const JWKS = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`), { timeoutDuration: 10_000 });
const TERMINAL_REFRESH = new Set(['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused']);
const ABORT = () => new DOMException('ChatGPT 请求已取消', 'AbortError');
const equal = (left, right) => typeof left === 'string' && typeof right === 'string' && Buffer.byteLength(left) === Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right));
const validString = (value, max = 32_768) => typeof value === 'string' && value.length > 0 && value.length <= max;

function failure(message, { code = '', status, requestId = '' } = {}) {
  const error = new Error(message);
  error.name = 'ChatGPTError'; error.code = code;
  if (status !== undefined) error.status = status;
  if (requestId) error.requestId = requestId;
  return error;
}
function safe(error, fallback = 'ChatGPT 操作未完成，请稍后重试') {
  return error?.name === 'ChatGPTError' || error?.name === 'AbortError' ? error : failure(fallback);
}
function serviceFailure(response, body) {
  const raw = typeof body?.error === 'string' ? body.error : body?.error?.code;
  // Never display arbitrary provider messages: they can contain credentials,
  // callback URLs, copied prompts or other sensitive diagnostic data.
  const code = typeof raw === 'string' && /^[a-z][a-z0-9_]{0,95}$/.test(raw) ? raw : '';
  const known = {
    subscription_sharing_usage_limit_exceeded: '此应用可用的 ChatGPT 套餐额度已达上限，请查看 ChatGPT 设置中的用量',
    subscription_sharing_usage_unavailable: '暂时无法确认 ChatGPT 套餐额度，请稍后再试',
    subscription_sharing_user_not_eligible: '当前账号或工作区暂不能共享 ChatGPT 套餐',
    subscription_sharing_unsupported_capability: '当前 ChatGPT 套餐通道不支持此请求能力',
    subscription_sharing_route_not_supported: '当前 ChatGPT 套餐通道不支持此请求路径',
    subscription_sharing_invalid_user: 'ChatGPT 登录身份无法确认，请重新登录',
    subscription_sharing_user_unavailable: 'ChatGPT 账号信息暂时不可用，请稍后再试',
    chatpass_v2_scope_not_authorized: '当前授权未允许使用 ChatGPT 套餐，请重新授权',
    chatpass_v2_invalid_authorization_context: 'ChatGPT 套餐授权上下文无效，请重新授权',
    invalid_client: 'ChatGPT 客户端注册无效，请重新授权或联系维护者',
  };
  const message = TERMINAL_REFRESH.has(code) ? 'ChatGPT 登录已失效，请重新登录' : known[code] || ({ 401: 'ChatGPT 授权未被接受，请检查登录和套餐权限', 403: '当前地区、账号或工作区策略不允许此 ChatGPT 请求', 429: 'ChatGPT 请求受限，请稍后再试', 503: 'ChatGPT 套餐通道暂时不可用，请稍后再试' })[response.status] || `ChatGPT 请求失败（HTTP ${response.status}）`;
  const requestId = response.headers?.get('x-request-id') || '';
  return failure(message, { code, status: response.status, requestId: /^[\w-]{1,128}$/.test(requestId) ? requestId : '' });
}

/** Validate a signed ID token against the fixed official issuer/JWKS. */
export async function verifyChatGPTIDToken(token, { clientId, nonce, subject }, keySet = JWKS) {
  try {
    const { payload } = await jwtVerify(token, keySet, { issuer: ISSUER, audience: clientId, algorithms: ['RS256'], requiredClaims: ['iss', 'aud', 'exp', 'iat', 'sub'], clockTolerance: 5 });
    if (!validString(payload.sub, 512) || (nonce !== undefined && !equal(payload.nonce, nonce)) || (subject && !equal(payload.sub, subject))) throw new Error();
    if ((payload.azp !== undefined && payload.azp !== clientId) || (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId)) throw new Error();
    return { issuer: ISSUER, subject: payload.sub, email: typeof payload.email === 'string' ? payload.email.slice(0, 254) : '', name: typeof payload.name === 'string' ? payload.name.slice(0, 100) : '' };
  } catch { throw failure('ChatGPT 身份校验未通过，请重新登录'); }
}

/**
 * createChatGPTClient({directory, encryption: Electron.safeStorage,
 *   openExternal: shell.openExternal, onChange})
 *
 * All public methods are async. signIn returns once the external browser opens;
 * its completion is reported through onChange/getState. Credentials never leave
 * this closure. Optional fetchImpl/verifyIdToken/now/timeouts are dependency
 * injection for isolated tests, never configurable provider URLs.
 */
export function createChatGPTClient({ directory, encryption, openExternal, onChange = () => {}, fetchImpl = globalThis.fetch, verifyIdToken = verifyChatGPTIDToken, now = Date.now, requestTimeoutMs = 45_000, signInTimeoutMs = 180_000 }) {
  if (!directory || typeof openExternal !== 'function' || typeof fetchImpl !== 'function') throw new TypeError('ChatGPT client requires local storage and browser transport');
  const path = join(directory, 'chatgpt-auth.json');
  let hostId = `urn:uuid:${randomUUID()}`, accounts = [], activeId = null, models = [], errorMessage = '';
  let attempt = null, generation = 0, closed = false, signingOut = false, selectingAccount = false, signInStarting = false, refreshOperation = null, retryRegistration = null;
  let writeChain = Promise.resolve(), loadError = '';
  const requests = new Set();
  const selected = () => accounts.find(account => account.id === activeId) || null;
  const canEncrypt = () => { try { return encryption?.isEncryptionAvailable() === true && encryption.getSelectedStorageBackend?.() !== 'basic_text'; } catch { return false; } };
  const requireEncryption = () => { if (!canEncrypt()) throw failure('系统凭据加密不可用，无法安全保存 ChatGPT 登录'); };
  const connected = account => Boolean(account?.accessToken && !closed && !signingOut);
  const label = account => `${account.email || account.name || 'ChatGPT 账号'} · ${account.id.slice(0, 6)}`;
  const snapshot = () => {
    const account = selected();
    return { connected: connected(account), sharing: connected(account) && account.scopes.includes(SHARING), account: account ? label(account) : '', models: models.map(model => ({ ...model })), signingIn: Boolean(attempt || signInStarting), error: errorMessage || loadError,
      activeAccountId: activeId, accounts: accounts.map(item => ({ id: item.id, label: label(item), connected: connected(item) })) };
  };
  const notify = () => { try { Promise.resolve(onChange(snapshot())).catch(() => {}); } catch { /* A closed UI cannot affect authentication. */ } };
  const abortRequests = () => { for (const controller of requests) controller.abort(); };
  const ensureOpen = () => { if (closed) throw failure('ChatGPT 连接已关闭'); };
  function persist(nextAccounts = accounts, nextActiveId = activeId, isCurrent = () => true, nextRegistration = retryRegistration) {
    requireEncryption();
    const serialize = (values, id, registration) => JSON.stringify({ version: 1, hostId, activeId: id, encryptedAccounts: encryption.encryptString(JSON.stringify(values)).toString('base64'), encryptedRegistration: encryption.encryptString(JSON.stringify(registration)).toString('base64') });
    const content = serialize(nextAccounts, nextActiveId, nextRegistration);
    writeChain = writeChain.catch(() => {}).then(async () => {
      try {
        if (!isCurrent()) throw ABORT();
        await mkdir(directory, { recursive: true });
        await writeFile(path + '.tmp', content, { encoding: 'utf8', mode: 0o600 });
        if (!isCurrent()) { await rm(path + '.tmp', { force: true }); throw ABORT(); }
        await rename(path + '.tmp', path);
        if (!isCurrent()) {
          // A cancellation can land during the atomic rename itself. Restore
          // the current in-memory registration before this serialized write
          // settles, so close()/signOut() cannot leave a cancelled login behind.
          await writeFile(path + '.tmp', serialize(accounts, activeId, retryRegistration), { encoding: 'utf8', mode: 0o600 });
          await rename(path + '.tmp', path);
          throw ABORT();
        }
      } catch (error) { throw safe(error, '无法安全保存 ChatGPT 登录，请检查本机存储空间与权限'); }
    });
    return writeChain;
  }
  const ready = (async () => {
    try {
      const raw = await readFile(path, 'utf8');
      if (raw.length > 2 * 1024 * 1024) throw new Error();
      const saved = JSON.parse(raw);
      if (saved.version !== 1 || !/^urn:uuid:[\da-f-]{36}$/i.test(saved.hostId)) throw new Error();
      hostId = saved.hostId;
      requireEncryption();
      const values = JSON.parse(encryption.decryptString(Buffer.from(saved.encryptedAccounts, 'base64')));
      if (!Array.isArray(values) || values.length > 50 || values.some(item => !validString(item.id, 128) || !validString(item.clientId, 256) || item.clientId === DYNAMIC_CLIENT || item.issuer !== ISSUER || !validString(item.subject, 512) || !Array.isArray(item.scopes))) throw new Error();
      const registration = saved.encryptedRegistration ? JSON.parse(encryption.decryptString(Buffer.from(saved.encryptedRegistration, 'base64'))) : null;
      if (registration !== null && (!validString(registration.id, 128) || !validString(registration.clientId, 256) || registration.clientId === DYNAMIC_CLIENT || Object.keys(registration).some(key => !['id', 'clientId'].includes(key)))) throw new Error();
      retryRegistration = registration;
      accounts = values; activeId = accounts.some(item => item.id === saved.activeId) ? saved.activeId : accounts[0]?.id || null;
    } catch (error) {
      if (error.code !== 'ENOENT') loadError = '保存的 ChatGPT 登录无法读取或解密，请退出此登录后重新授权';
    }
  })();

  async function runRequest(url, init, signal, consume, timeout = requestTimeoutMs) {
    if (signal?.aborted) throw ABORT();
    ensureOpen();
    const controller = new AbortController(); requests.add(controller);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout); timer.unref?.();
    const cancel = () => controller.abort(); signal?.addEventListener('abort', cancel, { once: true });
    try {
      const response = await fetchImpl(url, { ...init, redirect: 'error', credentials: 'omit', cache: 'no-store', signal: controller.signal });
      if (controller.signal.aborted) throw ABORT();
      return await consume(response, controller.signal);
    } catch (error) {
      if (timedOut) throw failure('ChatGPT 请求超时，已取消本次操作');
      if (controller.signal.aborted) throw ABORT();
      throw safe(error, '无法连接 ChatGPT 官方服务，请检查网络后重试');
    } finally { clearTimeout(timer); requests.delete(controller); signal?.removeEventListener('abort', cancel); }
  }
  async function jsonRequest(url, init, signal, timeout) {
    return runRequest(url, init, signal, async response => {
      let data; try { const text = await response.text(); if (text.length > 2 * 1024 * 1024) throw new Error(); data = text ? JSON.parse(text) : {}; }
      catch { if (!response.ok) throw serviceFailure(response, null); throw failure('ChatGPT 服务返回格式无效'); }
      if (!response.ok) throw serviceFailure(response, data);
      return data;
    }, timeout);
  }
  const formRequest = (url, data, signal) => jsonRequest(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data).toString() }, signal, 20_000);
  function tokenFields(data, previous) {
    if (!validString(data.access_token) || !/^Bearer$/i.test(data.token_type || '') || !Number.isFinite(data.expires_in) || data.expires_in <= 0 || data.expires_in > 86_400) throw failure('ChatGPT 登录凭据格式无效，请重新登录');
    if (data.scope !== undefined && (typeof data.scope !== 'string' || data.scope.length > 8192)) throw failure('ChatGPT 授权权限凭据格式无效，请重新登录');
    if (data.refresh_token !== undefined && !validString(data.refresh_token)) throw failure('ChatGPT 续期凭据格式无效，请重新登录');
    const earliest = typeof data.earliest_refresh_at === 'number' ? data.earliest_refresh_at * (data.earliest_refresh_at < 1e12 ? 1000 : 1) : Date.parse(data.earliest_refresh_at || '');
    return { accessToken: data.access_token, refreshToken: data.refresh_token || previous?.refreshToken || '', idToken: data.id_token || previous?.idToken || '', expiresAt: now() + data.expires_in * 1000,
      earliestRefreshAt: Number.isFinite(earliest) ? earliest : 0, scopes: typeof data.scope === 'string' ? [...new Set(data.scope.split(/\s+/).filter(Boolean))] : previous?.scopes || [] };
  }
  const withoutTokens = account => ({ id: account.id, clientId: account.clientId, issuer: account.issuer, subject: account.subject, email: account.email || '', name: account.name || '', scopes: [] });
  function stopAttempt(target = attempt, closeConnections = false) {
    if (!target) return;
    clearTimeout(target.timer); target.controller.abort();
    target.server?.close(); if (closeConnections) target.server?.closeAllConnections();
    if (attempt === target) attempt = null;
  }
  function callbackResponse(res, status, text) {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'", 'Referrer-Policy': 'no-referrer', Connection: 'close' }); res.end(text);
  }
  async function callback(target, req, res) {
    try {
      if (target !== attempt || target.processing || req.method !== 'GET' || req.headers.host !== new URL(target.redirectUri).host) { callbackResponse(res, 400, '无效的登录回调'); return; }
      const url = new URL(req.url, target.redirectUri);
      if (url.pathname !== '/auth/callback') { callbackResponse(res, 404, '页面不存在'); return; }
      for (const key of ['state', 'code', 'error', 'client_id']) if (url.searchParams.getAll(key).length > 1) { callbackResponse(res, 400, '无效的登录回调'); return; }
      if (!equal(url.searchParams.get('state'), target.state)) { callbackResponse(res, 400, '登录状态不匹配，请回到原登录页面'); return; }
      target.processing = true;
      if (url.searchParams.has('error')) throw failure(url.searchParams.get('error') === 'access_denied' ? '你取消了 ChatGPT 授权，可随时重新登录' : 'ChatGPT 授权未完成，请重新登录');
      const issuedId = url.searchParams.get('client_id');
      const clientId = target.registration?.clientId || issuedId;
      if (!validString(clientId, 256) || clientId === DYNAMIC_CLIENT || (issuedId && issuedId !== clientId)) throw failure('ChatGPT 客户端注册不匹配，请重新登录');
      const code = url.searchParams.get('code'); if (!validString(code, 4096)) throw failure('ChatGPT 登录回调缺少有效授权码');
      const current = () => attempt === target && !target.controller.signal.aborted && !closed;
      const isCurrent = () => { if (!current()) throw ABORT(); };
      if (!target.registration) {
        // Keep the issued client ID before consuming the one-time code. It is
        // untrusted registration metadata, never an authenticated account.
        target.registration = { id: randomUUID(), clientId };
        retryRegistration = target.registration;
        await persist(accounts, activeId, current);
        isCurrent();
      }
      const data = await formRequest(TOKEN, { grant_type: 'authorization_code', client_id: clientId, code, code_verifier: target.verifier, redirect_uri: target.redirectUri, resource: RESOURCE }, target.controller.signal);
      isCurrent();
      if (!validString(data.id_token)) throw failure('ChatGPT 登录未返回有效身份凭据');
      const identity = await verifyIdToken(data.id_token, { clientId, nonce: target.nonce, subject: target.registration?.subject });
      isCurrent();
      if (identity.issuer !== ISSUER || !validString(identity.subject, 512) || (target.registration?.subject && identity.subject !== target.registration.subject)) throw failure('ChatGPT 身份校验未通过，请重新登录');
      const account = { id: target.registration?.id || randomUUID(), clientId, issuer: ISSUER, subject: identity.subject, email: identity.email || '', name: identity.name || '', ...tokenFields(data) };
      const nextAccounts = [...accounts.filter(item => item.id !== account.id), account];
      await persist(nextAccounts, account.id, current, null);
      isCurrent(); accounts = nextAccounts; activeId = account.id; models = [];
      retryRegistration = null; errorMessage = ''; loadError = ''; generation++; abortRequests(); target.succeeded = true;
      callbackResponse(res, 200, 'ChatGPT 登录完成。可以关闭此页面，回到直播搭子。');
      stopAttempt(target); notify();
    } catch (error) {
      if (attempt !== target) { if (!res.destroyed) callbackResponse(res, 400, '登录已取消'); return; }
      errorMessage = safe(error, 'ChatGPT 登录未完成，请重新登录').message;
      if (!res.destroyed) callbackResponse(res, 400, 'ChatGPT 登录未完成，请回到直播搭子查看提示。');
      stopAttempt(target); notify();
    }
  }

  async function signIn({ accountId, addAccount = false, enableSharing = false } = {}) {
    if (signInStarting || signingOut || selectingAccount) throw failure('请等待当前登录操作结束');
    signInStarting = true;
    const version = ++generation;
    try {
      await ready; ensureOpen(); requireEncryption(); if (loadError) throw failure(loadError);
      if (version !== generation) throw ABORT();
      stopAttempt(attempt, true);
      let registration = addAccount ? retryRegistration : accountId ? accounts.find(item => item.id === accountId) : selected() || retryRegistration;
      if (accountId && !registration) throw failure('所选 ChatGPT 账号不存在');
      await persist();
      if (version !== generation || closed) throw ABORT();
      const target = { registration, state: randomBytes(32).toString('base64url'), nonce: randomBytes(32).toString('base64url'), verifier: randomBytes(48).toString('base64url'), controller: new AbortController(), processing: false };
      attempt = target; errorMessage = '';
      target.server = createServer((req, res) => { void callback(target, req, res); });
      target.server.requestTimeout = 15_000; target.server.headersTimeout = 10_000;
      await new Promise((resolveListen, reject) => { target.server.once('error', reject); target.server.listen(0, '127.0.0.1', resolveListen); });
      if (attempt !== target || closed) { target.server.close(); throw ABORT(); }
      target.server.unref(); target.redirectUri = `http://127.0.0.1:${target.server.address().port}/auth/callback`;
      target.timer = setTimeout(() => { if (attempt === target) { stopAttempt(target, true); errorMessage = 'ChatGPT 登录已超时，请重新点击登录'; notify(); } }, signInTimeoutMs); target.timer.unref();
      const url = new URL(AUTHORIZE);
      url.search = new URLSearchParams({ client_id: registration?.clientId || DYNAMIC_CLIENT, ext_agent_host_id: hostId, response_type: 'code', redirect_uri: target.redirectUri, scope: SCOPES, resource: RESOURCE, state: target.state, nonce: target.nonce, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(target.verifier).digest('base64url') });
      if (!registration) url.searchParams.set('agent_name_hint', APP_NAME);
      if (registration?.idToken) url.searchParams.set('id_token_hint', registration.idToken);
      if (registration?.email) url.searchParams.set('login_hint', registration.email);
      if (enableSharing) url.searchParams.set('prompt', 'consent');
      // The full URL may contain id_token_hint. Pass directly to the trusted OS
      // browser opener and never return it to UI state, telemetry or errors.
      await openExternal(url.href);
      if (attempt !== target && !target.succeeded) throw ABORT();
      return { ok: true, signingIn: Boolean(attempt) };
    } catch (error) { stopAttempt(attempt, true); errorMessage = safe(error, '无法打开 ChatGPT 登录页面，请检查默认浏览器').message; throw safe(error, errorMessage); }
    finally { signInStarting = false; notify(); }
  }

  async function access() {
    await ready; ensureOpen();
    if (selectingAccount) throw failure('请等待账号切换完成');
    const account = selected(), version = generation;
    if (!connected(account)) throw failure('请先登录 ChatGPT');
    if (!account.scopes.includes(SHARING)) throw failure('尚未允许使用 ChatGPT 套餐，请在登录设置中重新授权');
    if (account.expiresAt > now() + 60_000 || (now() < account.earliestRefreshAt && account.expiresAt > now())) return { token: account.accessToken, accountId: account.id, generation: version };
    if (!account.refreshToken) throw failure('ChatGPT 登录已过期，请重新登录');
    if (!refreshOperation || refreshOperation.id !== account.id) {
      const operation = { id: account.id, promise: null };
      operation.promise = (async () => {
        try {
          const data = await formRequest(TOKEN, { grant_type: 'refresh_token', client_id: account.clientId, refresh_token: account.refreshToken, resource: RESOURCE });
          if (generation !== version || selected()?.id !== account.id || signingOut || closed) throw ABORT();
          if (data.id_token) await verifyIdToken(data.id_token, { clientId: account.clientId, subject: account.subject });
          if (generation !== version || selected()?.id !== account.id || signingOut || closed) throw ABORT();
          const replacement = { ...account, ...tokenFields(data, account) };
          const nextAccounts = accounts.map(item => item.id === account.id ? replacement : item);
          const current = () => generation === version && selected()?.id === account.id && !signingOut && !closed;
          await persist(nextAccounts, activeId, current);
          if (!current()) throw ABORT();
          accounts = nextAccounts; notify();
        } catch (error) {
          if (TERMINAL_REFRESH.has(error?.code) && generation === version) {
            accounts = accounts.map(item => item.id === account.id ? withoutTokens(item) : item); models = []; errorMessage = 'ChatGPT 登录已失效，请重新登录'; await persist(); notify();
          }
          throw safe(error, 'ChatGPT 登录续期未完成，请稍后重试');
        } finally { if (refreshOperation === operation) refreshOperation = null; }
      })();
      refreshOperation = operation;
    }
    await refreshOperation.promise;
    if (generation !== version || selected()?.id !== account.id || signingOut || closed) throw ABORT();
    const refreshed = selected();
    if (!refreshed.scopes.includes(SHARING)) throw failure('ChatGPT 套餐使用权限已改变，请重新授权');
    return { token: refreshed.accessToken, accountId: refreshed.id, generation: version };
  }
  function stillActive(auth) { if (closed || signingOut || generation !== auth.generation || selected()?.id !== auth.accountId) throw ABORT(); }
  async function listModels() {
    const auth = await access();
    const data = await jsonRequest(`${RESOURCE}/models`, { method: 'GET', headers: { Authorization: `Bearer ${auth.token}` } });
    stillActive(auth);
    if (!Array.isArray(data.models)) throw failure('ChatGPT 未返回有效模型列表');
    models = data.models.filter(item => item?.visibility === 'list' && validString(item.slug, 200)).map(item => ({ id: item.slug, name: typeof item.display_name === 'string' ? item.display_name.slice(0, 200) : item.slug }));
    errorMessage = ''; notify(); return models.map(model => ({ ...model }));
  }
  async function respond({ model, instructions = '', input, signal } = {}) {
    if (signal?.aborted) throw ABORT();
    const auth = await access();
    if (!models.length) await listModels(); stillActive(auth);
    if (!models.some(item => item.id === model)) throw failure('所选模型不在当前 ChatGPT 账号的可用列表中');
    if (typeof instructions !== 'string' || instructions.length > 128_000 || !Array.isArray(input) || input.length > 100 || input.some(item => !['user', 'assistant', 'developer'].includes(item?.role) || typeof item.content !== 'string' || item.content.length > 128_000)) throw failure('ChatGPT 请求输入格式无效');
    return runRequest(`${RESOURCE}/responses`, { method: 'POST', headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: JSON.stringify({ model, instructions, input: input.map(({ role, content }) => ({ role, content })), store: false, stream: true }) }, signal, async (response, requestSignal) => {
      if (!response.ok) { let body; try { body = await response.json(); } catch { /* Shape is not guaranteed on direct admission errors. */ } throw serviceFailure(response, body); }
      if (!response.body) throw failure('ChatGPT 未返回流式回复');
      const reader = response.body.getReader(), decoder = new TextDecoder();
      const cancelRead = () => { void reader.cancel().catch(() => {}); }; requestSignal.addEventListener('abort', cancelRead, { once: true });
      let buffer = '', text = '', completed = false;
      try {
        while (!completed) {
          const { value, done } = await reader.read();
          if (requestSignal.aborted) throw ABORT(); stillActive(auth);
          buffer += decoder.decode(value, { stream: !done });
          if (buffer.length > 2 * 1024 * 1024) throw failure('ChatGPT 流式回复过大，已取消');
          let match;
          while ((match = /\r?\n\r?\n/.exec(buffer))) {
            const event = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
            const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
            if (!data || data === '[DONE]') continue;
            let item; try { item = JSON.parse(data); } catch { throw failure('ChatGPT 流式回复格式无效'); }
            if (item.type === 'response.output_text.delta' && typeof item.delta === 'string') text += item.delta;
            if (text.length > 128_000) throw failure('ChatGPT 回复过长，已取消');
            if (item.type === 'response.failed' || item.type === 'error') throw serviceFailure(response, { error: item.response?.error || item.error || item });
            if (item.type === 'response.incomplete') throw failure('ChatGPT 回复未完成，本次不会发送');
            if (item.type === 'response.completed') {
              if (item.response?.status && item.response.status !== 'completed') throw failure('ChatGPT 回复未完成，本次不会发送');
              const finalText = item.response?.output?.filter(part => part.type === 'message').flatMap(part => part.content || []).filter(part => part.type === 'output_text' && typeof part.text === 'string').map(part => part.text).join('');
              if (finalText) text = finalText;
              completed = true; break;
            }
          }
          if (done) break;
        }
        if (!completed) throw failure('ChatGPT 回复流已中断，未收到完成确认，本次不会发送');
        if (!text.trim() || text.length > 128_000) throw failure('ChatGPT 没有返回有效回复');
        return text;
      } finally { requestSignal.removeEventListener('abort', cancelRead); await reader.cancel().catch(() => {}); }
    });
  }

  async function cancelSignIn() { generation++; stopAttempt(attempt, true); errorMessage = ''; notify(); return { ok: true }; }
  async function selectAccount(id) {
    await ready; ensureOpen();
    if (signingOut || signInStarting || selectingAccount) throw failure('请等待当前登录操作结束');
    if (!accounts.some(account => account.id === id)) throw failure('所选 ChatGPT 账号不存在');
    selectingAccount = true;
    const version = ++generation;
    stopAttempt(attempt, true); abortRequests(); models = []; errorMessage = '';
    const current = () => generation === version && !closed && !signingOut;
    try {
      await persist(accounts, id, current);
      if (!current()) throw ABORT();
      activeId = id; return snapshot();
    } finally { selectingAccount = false; notify(); }
  }
  async function signOut() {
    await ready; ensureOpen(); if (signingOut) throw failure('正在退出 ChatGPT 登录，请稍候');
    signingOut = true; generation++; stopAttempt(attempt, true); abortRequests(); models = []; notify();
    const account = selected(); let revoked = !account?.refreshToken;
    try {
      if (account?.refreshToken) {
        try {
          const discovery = await jsonRequest(DISCOVERY, { method: 'GET' }, undefined, 10_000);
          const endpoint = new URL(discovery.revocation_endpoint);
          if (discovery.issuer !== ISSUER || endpoint.origin !== ISSUER || endpoint.username || endpoint.password || endpoint.hash || endpoint.search) throw new Error();
          for (let attempt = 0; attempt < 2; attempt++) {
            try { await formRequest(endpoint.href, { token: account.refreshToken, token_type_hint: 'refresh_token', client_id: account.clientId }); revoked = true; break; }
            catch (error) { if (error.status && error.status < 500) break; if (attempt === 0) await new Promise(resolveDelay => setTimeout(resolveDelay, 150)); }
          }
        } catch { /* Clear local tokens even if remote revocation is unavailable. */ }
      }
    } finally {
      accounts = accounts.map(item => !account || item.id === account.id ? withoutTokens(item) : item);
      errorMessage = revoked ? '' : '已退出本机登录，但远程撤销未确认。可在 ChatGPT 设置中断开此应用';
      try { await persist(); loadError = ''; } finally { signingOut = false; notify(); }
    }
    return { ok: true, revoked, state: snapshot() };
  }
  async function close() { closed = true; generation++; stopAttempt(attempt, true); abortRequests(); await writeChain.catch(() => {}); }
  return { getState: async () => { await ready; return snapshot(); }, signIn, cancelSignIn, signOut, selectAccount, listModels, respond, close };
}
