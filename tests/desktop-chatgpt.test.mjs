import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createChatGPTClient, verifyChatGPTIDToken } from '../desktop/chatgpt-client.js';

const ISSUER = 'https://auth.openai.com';
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const waitFor = async condition => {
  for (let count = 0; count < 200; count++) { if (await condition()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('test condition timed out');
};
function encryption() {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString: text => { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, cipher.update(text, 'utf8'), cipher.final(), cipher.getAuthTag()]); },
    decryptString: data => { const cipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12)); cipher.setAuthTag(data.subarray(-16)); return Buffer.concat([cipher.update(data.subarray(12, -16)), cipher.final()]).toString('utf8'); },
  };
}
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'companion-chatgpt-test-'));
  const opened = [], calls = [], changes = [];
  const crypto = encryption();
  let client, now = Date.now(), tokenCounter = 0;
  const controls = { scopes: SCOPES, subject: 'verified-user', modelResponse: { models: [{ slug: 'visible-model', display_name: '可用模型', visibility: 'list' }, { slug: 'hidden-model', visibility: 'hidden' }] }, responses: null, tokenHandler: null };
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/.well-known/openid-configuration')) return json({ issuer: ISSUER, revocation_endpoint: `${ISSUER}/api/accounts/oauth/revoke` });
    if (String(url).endsWith('/oauth/revoke')) return new Response('', { status: 200 });
    if (String(url).endsWith('/oauth/token')) {
      if (controls.tokenHandler) return controls.tokenHandler(url, init);
      tokenCounter++;
      return json({ access_token: `test-access-${tokenCounter}`, refresh_token: `test-refresh-${tokenCounter}`, id_token: `test-id-${tokenCounter}`, token_type: 'Bearer', expires_in: 3600, scope: controls.scopes });
    }
    if (String(url).endsWith('/models')) return json(controls.modelResponse);
    if (String(url).endsWith('/responses')) return controls.responses ?? new Response('data: {"type":"response.output_text.delta","delta":"你好"}\n\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    throw new Error('Unexpected network endpoint in test');
  };
  const make = overrides => createChatGPTClient({ directory, encryption: crypto, openExternal: async url => { opened.push(new URL(url)); }, onChange: value => changes.push(value), fetchImpl, now: () => now,
    verifyIdToken: async (_token, expected) => ({ issuer: ISSUER, subject: controls.subject, email: 'person@example.com', nonce: expected.nonce }), ...options, ...overrides });
  client = make();
  t.after(async () => { await client.close(); await rm(directory, { recursive: true, force: true }); });
  const callback = async (params = {}) => {
    const authorize = opened.at(-1), url = new URL(authorize.searchParams.get('redirect_uri'));
    url.search = new URLSearchParams({ state: authorize.searchParams.get('state'), code: 'test-code', client_id: authorize.searchParams.get('client_id') === 'dynamic_agent_client' ? 'oaiapp_test_client' : authorize.searchParams.get('client_id'), ...params });
    return fetch(url);
  };
  const signIn = async (options = {}) => { await client.signIn(options); const result = await callback(); assert.equal(result.status, 200); await waitFor(async () => !(await client.getState()).signingIn); assert.equal((await client.getState()).connected, true); };
  return { get client() { return client; }, set client(value) { client = value; }, directory, encryption: crypto, opened, calls, changes, controls, make, callback, signIn, advance: ms => { now += ms; } };
}

test('first sign-in uses real app identity, loopback, fresh state/nonce and S256 PKCE; credentials remain encrypted', async t => {
  const f = await fixture(t);
  assert.equal((await f.client.getState()).connected, false);
  await f.client.signIn();
  const url = f.opened[0], query = url.searchParams, redirect = new URL(query.get('redirect_uri'));
  assert.equal(url.origin, ISSUER); assert.equal(url.pathname, '/api/accounts/authorize');
  assert.equal(query.get('client_id'), 'dynamic_agent_client'); assert.equal(query.get('agent_name_hint'), '直播搭子');
  assert.match(query.get('ext_agent_host_id'), /^urn:uuid:[\da-f-]{36}$/);
  assert.equal(redirect.hostname, '127.0.0.1'); assert.equal(redirect.pathname, '/auth/callback');
  assert.equal(query.get('code_challenge_method'), 'S256'); assert.notEqual(query.get('state'), query.get('nonce'));
  assert.equal(query.get('prompt'), null);
  assert.equal((await f.callback()).status, 200);
  const tokenCall = f.calls.find(call => call.url.endsWith('/oauth/token'));
  const body = new URLSearchParams(tokenCall.init.body);
  assert.equal(body.get('client_id'), 'oaiapp_test_client'); assert.equal(body.get('redirect_uri'), redirect.href);
  assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'), query.get('code_challenge'));
  assert.equal(body.has('client_secret'), false);
  const safe = await f.client.getState();
  assert.equal(safe.connected, true); assert.equal(safe.sharing, true);
  assert.deepEqual(await f.client.listModels(), [{ id: 'visible-model', name: '可用模型' }]);
  const stored = await readFile(join(f.directory, 'chatgpt-auth.json'), 'utf8');
  for (const secret of ['test-access-', 'test-refresh-', 'test-id-', 'person@example.com']) assert.equal(stored.includes(secret), false);
  for (const secret of ['test-access-', 'test-refresh-', 'test-id-']) assert.equal(JSON.stringify([safe, f.changes]).includes(secret), false);
});

test('wrong callback state cannot exchange a code or terminate the valid attempt', async t => {
  const f = await fixture(t); await f.client.signIn();
  assert.equal((await f.callback({ state: 'forged-state' })).status, 400);
  assert.equal(f.calls.some(call => call.url.endsWith('/oauth/token')), false);
  assert.equal((await f.client.getState()).signingIn, true);
  assert.equal((await f.callback()).status, 200);
});

test('callback denial and cancellation never activate or retain a token', async t => {
  const f = await fixture(t); await f.client.signIn();
  assert.equal((await f.callback({ error: 'access_denied' })).status, 400);
  assert.equal((await f.client.getState()).connected, false);
  assert.equal(f.calls.some(call => call.url.endsWith('/oauth/token')), false);
  await f.client.signIn(); await f.client.cancelSignIn();
  assert.equal((await f.client.getState()).signingIn, false);
  await assert.rejects(f.callback());
});

test('identity-only grant remains signed in but cannot list models or perform inference', async t => {
  const f = await fixture(t); f.controls.scopes = 'openid profile email'; await f.signIn();
  assert.equal((await f.client.getState()).sharing, false);
  await assert.rejects(f.client.listModels(), /套餐/);
  await assert.rejects(f.client.respond({ model: 'x', input: [], instructions: '' }), /套餐/);
  assert.equal(f.calls.some(call => call.url.includes('api.openai.com')), false);
});

test('returning sign-in preserves client and host; changed callback client or validated subject cannot replace credentials', async t => {
  const f = await fixture(t); await f.signIn(); const first = f.opened[0];
  await f.client.signIn(); const second = f.opened[1];
  assert.equal(second.searchParams.get('client_id'), 'oaiapp_test_client');
  assert.equal(second.searchParams.get('ext_agent_host_id'), first.searchParams.get('ext_agent_host_id'));
  assert.equal(second.searchParams.has('agent_name_hint'), false); assert.equal(second.searchParams.get('id_token_hint'), 'test-id-1');
  assert.notEqual(second.searchParams.get('state'), first.searchParams.get('state'));
  assert.equal((await f.callback({ client_id: 'oaiapp_different' })).status, 400);
  assert.equal((await f.client.getState()).connected, true);
  await f.client.signIn(); f.controls.subject = 'different-user';
  assert.equal((await f.callback()).status, 400);
  assert.equal((await f.client.getState()).connected, true);
});

test('sign-out revokes renewable session, removes tokens and retains registration for reauthorization', async t => {
  const f = await fixture(t); await f.signIn(); await f.client.signOut();
  assert.equal((await f.client.getState()).connected, false);
  const revoke = f.calls.find(call => call.url.endsWith('/oauth/revoke'));
  assert.equal(new URLSearchParams(revoke.init.body).get('token_type_hint'), 'refresh_token');
  await f.client.signIn();
  assert.equal(f.opened.at(-1).searchParams.get('client_id'), 'oaiapp_test_client');
  assert.equal(f.opened.at(-1).searchParams.has('id_token_hint'), false);
  await f.client.cancelSignIn();
});

test('models and Responses use only fixed official endpoints and the streaming preview schema', async t => {
  const f = await fixture(t); await f.signIn(); await f.client.listModels();
  assert.equal(await f.client.respond({ model: 'visible-model', instructions: 'short answer', input: [{ role: 'user', content: 'hello' }] }), '你好');
  const request = f.calls.find(call => call.url.endsWith('/responses'));
  assert.equal(request.url, 'https://api.openai.com/v1/responses');
  assert.deepEqual(JSON.parse(request.init.body), { model: 'visible-model', instructions: 'short answer', input: [{ role: 'user', content: 'hello' }], store: false, stream: true });
  assert.equal(request.init.redirect, 'error');
  await assert.rejects(f.client.respond({ model: 'hidden-model', instructions: '', input: [] }), /模型/);
  await assert.rejects(f.client.respond({ model: 'visible-model', instructions: '', input: [{ role: 'system', content: 'x' }] }), /输入/);
});

test('SSE requires response.completed and rejects a failure after text deltas', async t => {
  const f = await fixture(t); await f.signIn(); await f.client.listModels();
  const request = () => f.client.respond({ model: 'visible-model', instructions: '', input: [] });
  for (const end of ['', 'data: [DONE]\n\n', 'data: {"type":"response.incomplete"}\n\n']) {
    f.controls.responses = new Response('data: {"type":"response.output_text.delta","delta":"partial"}\n\n' + end);
    await assert.rejects(request(), /完成|中断/);
  }
  f.controls.responses = new Response('data: {"type":"response.output_text.delta","delta":"partial"}\n\ndata: {"type":"response.failed","response":{"error":{"code":"subscription_sharing_usage_limit_exceeded"}}}\n\n');
  await assert.rejects(request(), error => error.code === 'subscription_sharing_usage_limit_exceeded' && /额度/.test(error.message));
});

test('SSE UTF-8 and CRLF boundaries survive arbitrary network chunks', async t => {
  const f = await fixture(t); await f.signIn(); await f.client.listModels();
  const bytes = new TextEncoder().encode(': keepalive\r\n\r\nevent: response.output_text.delta\r\ndata: {"type":"response.output_text.delta","delta":"你好世界"}\r\n\r\ndata: {"type":"response.completed","response":{"status":"completed"}}\r\n\r\n');
  f.controls.responses = new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 2) controller.enqueue(bytes.slice(i, i + 2)); controller.close(); } }));
  assert.equal(await f.client.respond({ model: 'visible-model', instructions: '', input: [] }), '你好世界');
});

test('concurrent expiry refreshes are serialized and a rotating token is stored before requests resume', async t => {
  const f = await fixture(t); await f.signIn(); f.advance(3_590_000);
  await Promise.all([f.client.listModels(), f.client.listModels()]);
  const tokenCalls = f.calls.filter(call => call.url.endsWith('/oauth/token'));
  assert.equal(tokenCalls.length, 2);
  const refresh = new URLSearchParams(tokenCalls[1].init.body);
  assert.equal(refresh.get('grant_type'), 'refresh_token'); assert.equal(refresh.get('refresh_token'), 'test-refresh-1');
  assert.equal(refresh.has('scope'), false); assert.equal(refresh.get('resource'), 'https://api.openai.com/v1');
  const modelCalls = f.calls.filter(call => call.url.endsWith('/models'));
  assert.ok(modelCalls.every(call => call.init.headers.Authorization === 'Bearer test-access-2'));
});

test('terminal refresh error clears unusable tokens but preserves account/client mapping', async t => {
  const f = await fixture(t); await f.signIn(); f.advance(3_590_000);
  f.controls.tokenHandler = () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
  await assert.rejects(f.client.listModels(), /登录/);
  assert.equal((await f.client.getState()).connected, false);
  await f.client.signIn(); assert.equal(f.opened.at(-1).searchParams.get('client_id'), 'oaiapp_test_client');
});

test('cancelling while OAuth exchange is in flight cannot reactivate credentials', async t => {
  const f = await fixture(t); let release;
  f.controls.tokenHandler = () => new Promise(resolve => { release = () => resolve(json({ access_token: 'late-access', refresh_token: 'late-refresh', id_token: 'late-id', token_type: 'Bearer', expires_in: 3600, scope: SCOPES })); });
  await f.client.signIn(); const response = f.callback().catch(() => null);
  await waitFor(() => Boolean(release)); await f.client.cancelSignIn(); release(); await response;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal((await f.client.getState()).connected, false);
  assert.equal((await readFile(join(f.directory, 'chatgpt-auth.json'), 'utf8')).includes('late-access'), false);
});

test('startup restores encrypted registrations and blocks sign-in when OS encryption is unavailable', async t => {
  const f = await fixture(t); await f.signIn(); await f.client.close(); f.client = f.make();
  assert.equal((await f.client.getState()).connected, true);
  await f.client.close(); f.client = f.make({ encryption: { isEncryptionAvailable: () => false } });
  assert.equal((await f.client.getState()).connected, false);
  await assert.rejects(f.client.signIn(), /加密/);
});

test('cancellation at encrypted persistence cannot activate a newly authorized account after restart', async t => {
  const f = await fixture(t); await f.client.close();
  let cancelOnce = true;
  f.client = f.make({ encryption: { ...f.encryption, encryptString(value) {
    if (cancelOnce && value.includes('test-access-')) { cancelOnce = false; void f.client.cancelSignIn(); }
    return f.encryption.encryptString(value);
  } } });
  await f.client.signIn(); await f.callback().catch(() => null);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal((await f.client.getState()).connected, false);
  await f.client.close(); f.client = f.make();
  assert.equal((await f.client.getState()).connected, false);
});

test('abort interrupts a pending SSE read, discards partial text and releases the stream', async t => {
  const f = await fixture(t); await f.signIn(); await f.client.listModels();
  let cancelled = false;
  f.controls.responses = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"partial"}\n\n')); }, cancel() { cancelled = true; } }));
  const controller = new AbortController();
  const result = f.client.respond({ model: 'visible-model', input: [], signal: controller.signal });
  await waitFor(() => f.calls.some(call => call.url.endsWith('/responses')));
  controller.abort();
  await assert.rejects(result, error => error.name === 'AbortError');
  assert.equal(cancelled, true);
});

test('real jose validation checks signature, issuer, audience, expiry, nonce and returning subject', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const publicJwk = await exportJWK(publicKey); publicJwk.kid = 'test-key';
  const keySet = createLocalJWKSet({ keys: [publicJwk] });
  const make = async claims => new SignJWT({ sub: 'subject', nonce: 'nonce', email: 'person@example.com', ...claims }).setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).setIssuer(claims?.iss || ISSUER).setAudience(claims?.aud || 'oaiapp_client').setIssuedAt().setExpirationTime(claims?.exp || '5m').sign(privateKey);
  const expected = { clientId: 'oaiapp_client', nonce: 'nonce', subject: 'subject' };
  assert.equal((await verifyChatGPTIDToken(await make(), expected, keySet)).subject, 'subject');
  for (const claims of [{ iss: 'https://wrong.invalid' }, { aud: 'wrong-client' }, { nonce: 'wrong' }, { sub: 'wrong' }, { exp: 1 }]) {
    await assert.rejects(verifyChatGPTIDToken(await make(claims), expected, keySet));
  }
  const token = await make(); await assert.rejects(verifyChatGPTIDToken(token.slice(0, -8) + 'abcdefgh', expected, keySet));
});

test('issued registration is durably retained before code exchange and reused after restart', async t => {
  const f = await fixture(t); let persistedClient;
  f.controls.tokenHandler = async () => {
    const saved = JSON.parse(await readFile(join(f.directory, 'chatgpt-auth.json'), 'utf8'));
    persistedClient = saved.encryptedRegistration && JSON.parse(f.encryption.decryptString(Buffer.from(saved.encryptedRegistration, 'base64')))?.clientId;
    return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
  };
  await f.client.signIn(); assert.equal((await f.callback()).status, 400);
  assert.equal(persistedClient, 'oaiapp_test_client');
  assert.equal((await f.client.getState()).accounts.length, 0);
  await f.client.close(); f.client = f.make(); await f.client.signIn();
  assert.equal(f.opened.at(-1).searchParams.get('client_id'), 'oaiapp_test_client');
  assert.equal(f.opened.at(-1).searchParams.has('id_token_hint'), false);
});

test('registration storage failure prevents exchanging a one-time authorization code', async t => {
  const f = await fixture(t); await f.client.signIn();
  // Occupy the atomic-write temporary pathname to simulate a real disk failure.
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(f.directory, 'chatgpt-auth.json.tmp'));
  assert.equal((await f.callback()).status, 400);
  assert.equal(f.calls.some(call => call.url.endsWith('/oauth/token')), false);
  assert.equal((await f.client.getState()).connected, false);
});

test('failed account selection keeps the previous account active in memory and on disk', async t => {
  const f = await fixture(t); await f.signIn(); const first = (await f.client.getState()).activeAccountId;
  f.controls.subject = 'second-user'; await f.signIn({ addAccount: true });
  const second = (await f.client.getState()).activeAccountId;
  const { mkdir } = await import('node:fs/promises'); await mkdir(join(f.directory, 'chatgpt-auth.json.tmp'));
  await assert.rejects(f.client.selectAccount(first), /保存/);
  assert.equal((await f.client.getState()).activeAccountId, second);
  await f.client.close(); f.client = f.make();
  assert.equal((await f.client.getState()).activeAccountId, second);
});

test('malformed refresh scopes cannot silently inherit plan permission', async t => {
  const f = await fixture(t); await f.signIn(); f.advance(3_590_000);
  f.controls.tokenHandler = () => json({ access_token: 'rotated', token_type: 'Bearer', expires_in: 3600, scope: null });
  await assert.rejects(f.client.listModels(), /权限|凭据/);
  assert.equal(f.calls.some(call => call.url.endsWith('/models')), false);
});

test('account selection blocks inference until its durable selection completes', async t => {
  const f = await fixture(t); await f.signIn(); const first = (await f.client.getState()).activeAccountId;
  f.controls.subject = 'second-user'; await f.signIn({ addAccount: true }); await f.client.close();
  let duringWrite, armed = false;
  f.client = f.make({ encryption: { ...f.encryption, encryptString(value) {
    if (armed) { armed = false; duringWrite = f.client.listModels().then(() => 'allowed', () => 'blocked'); }
    return f.encryption.encryptString(value);
  } } });
  await f.client.getState(); armed = true;
  await f.client.selectAccount(first);
  assert.equal(await duringWrite, 'blocked');
  assert.equal(f.calls.some(call => call.url.endsWith('/models')), false);
});

test('refresh without a scope field retains permission but an explicit reduced grant persists and blocks inference', async t => {
  const f = await fixture(t); await f.signIn(); f.advance(3_590_000);
  f.controls.tokenHandler = () => json({ access_token: 'rotated', token_type: 'Bearer', expires_in: 3600 });
  await f.client.listModels(); assert.equal((await f.client.getState()).sharing, true);
  const count = f.calls.filter(call => call.url.endsWith('/models')).length;
  f.advance(3_590_000);
  f.controls.tokenHandler = () => json({ access_token: 'identity-only', token_type: 'Bearer', expires_in: 3600, scope: 'openid profile email' });
  await assert.rejects(f.client.listModels(), /权限/);
  assert.equal(f.calls.filter(call => call.url.endsWith('/models')).length, count);
  await f.client.close(); f.client = f.make();
  assert.equal((await f.client.getState()).sharing, false);
});

test('switching accounts during refresh cannot restore or use a late token from the previous selection', async t => {
  const f = await fixture(t); await f.signIn(); const first = (await f.client.getState()).activeAccountId;
  f.controls.subject = 'second-user'; await f.signIn({ addAccount: true }); f.advance(3_590_000);
  let release;
  f.controls.tokenHandler = () => new Promise(resolve => { release = () => resolve(json({ access_token: 'late-rotated', token_type: 'Bearer', expires_in: 3600, scope: SCOPES })); });
  const pending = f.client.listModels(); const rejected = assert.rejects(pending, error => error.name === 'AbortError');
  await waitFor(() => Boolean(release)); await f.client.selectAccount(first); release(); await rejected;
  await f.client.close(); f.client = f.make(); assert.equal((await f.client.getState()).activeAccountId, first);
  const saved = JSON.parse(await readFile(join(f.directory, 'chatgpt-auth.json'), 'utf8'));
  assert.equal(f.encryption.decryptString(Buffer.from(saved.encryptedAccounts, 'base64')).includes('late-rotated'), false);
});
