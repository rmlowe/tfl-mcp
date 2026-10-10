import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import worker from '../src/index.js';

const { privateKey, publicKey } = await generateKeyPair('RS256');
const forgedKey = (await generateKeyPair('RS256')).privateKey;
const jwk = { ...await exportJWK(publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' };
const originalFetch = globalThis.fetch;
const originalCaches = globalThis.caches;
afterEach(() => { globalThis.fetch = originalFetch; globalThis.caches = originalCaches; });
let counter = 0;
function fixture() {
  const env = { MCP_AUTH_MODE: 'access', MCP_ACCESS_TEAM_DOMAIN: `https://test-${++counter}.cloudflareaccess.com`, MCP_ACCESS_AUD: 'expected-app-audience' };
  let keyRequests = 0;
  globalThis.fetch = async (url) => {
    assert.equal(String(url), `${env.MCP_ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
    keyRequests++;
    return Response.json({ keys: [jwk] });
  };
  return { env, keyRequests: () => keyRequests };
}
async function token(env, changes = {}, key = privateKey, header = {}) {
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: env.MCP_ACCESS_TEAM_DOMAIN, aud: [env.MCP_ACCESS_AUD], sub: 'test-user', iat: now - 10, exp: now + 300, ...changes };
  for (const name of Object.keys(claims)) if (claims[name] === undefined) delete claims[name];
  return new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'test-key', ...header }).sign(key);
}
function call(env, assertion, extraHeaders = {}, method = 'tools/list') {
  return worker.fetch(new Request('http://localhost/mcp', {
    method: 'POST', headers: { Host: 'localhost', 'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25',
      ...(assertion ? { 'Cf-Access-Jwt-Assertion': assertion } : {}), ...extraHeaders },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method,
      params: method === 'tools/call' ? { name: 'get_line_status', arguments: { lineIds: ['northern'] } } : {} }),
  }), env, { waitUntil(p) { return p; } });
}

test('Access mode accepts signed assertions, discovers the tool and caches public keys', async () => {
  const f = fixture();
  const jwt = await token(f.env);
  for (let i = 0; i < 2; i++) {
    const r = await call(f.env, jwt, { Authorization: 'Bearer oauth:opaque-access-token' });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('Cache-Control'), 'private, no-store');
    const body = await r.text();
    assert.match(body, /get_line_status/);
    assert.doesNotMatch(body, /test-user|opaque-access-token/);
  }
  assert.equal(f.keyRequests(), 1);
});

test('wrong issuer/audience, expired/future/missing claims, forged signatures and unknown keys are rejected', async (t) => {
  const f = fixture();
  const now = Math.floor(Date.now() / 1000);
  const cases = [
    ['issuer', { iss: 'https://other.cloudflareaccess.com' }],
    ['audience', { aud: 'another-app' }], ['expired', { exp: now - 10 }],
    ['not yet valid', { nbf: now + 300 }], ['future issue', { iat: now + 300 }],
    ['missing expiry', { exp: undefined }], ['missing issued-at', { iat: undefined }],
    ['missing subject', { sub: undefined }], ['empty subject', { sub: '' }],
    ['forged', {}, forgedKey], ['unknown key', {}, privateKey, { kid: 'unknown' }],
  ];
  for (const [name, changes, key, header] of cases) await t.test(name, async () => {
    const r = await call(f.env, await token(f.env, changes, key, header), {}, 'tools/call');
    assert.equal(r.status, 401);
    assert.equal(await r.text(), 'Unauthorized');
  });
});

test('opaque, unsigned and malformed tokens cannot substitute for a verified assertion', async () => {
  const f = fixture();
  for (const value of ['oauth:opaque', 'not-a-jwt', 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJ1c2VyIn0.', 'x'.repeat(16385)]) {
    assert.equal((await call(f.env, value)).status, 401);
  }
  const bearer = 'legacy-token-at-least-32-characters';
  assert.equal((await call({ ...f.env, MCP_AUTH_TOKEN: bearer }, null, { Authorization: `Bearer ${bearer}` })).status, 401);
  assert.equal((await call(f.env, null, { 'Cf-Access-Authenticated-User-Email': 'user@example.com' })).status, 401);
  assert.equal(f.keyRequests(), 0);
});

test('incomplete or invalid config stays disabled, even with a legacy token', async () => {
  const f = fixture();
  for (const change of [
    { MCP_AUTH_MODE: 'disabled' }, { MCP_AUTH_MODE: 'typo' },
    { MCP_ACCESS_AUD: '' }, { MCP_ACCESS_AUD: undefined },
    { MCP_ACCESS_TEAM_DOMAIN: undefined }, { MCP_ACCESS_TEAM_DOMAIN: 'http://test.cloudflareaccess.com' },
    { MCP_ACCESS_TEAM_DOMAIN: 'https://evil.example' },
    { MCP_ACCESS_TEAM_DOMAIN: 'https://team.cloudflareaccess.com.evil.example' },
    { MCP_ACCESS_TEAM_DOMAIN: 'https://team.cloudflareaccess.com/path' },
  ]) {
    assert.equal((await call({ ...f.env, MCP_AUTH_TOKEN: 'legacy-token-at-least-32-characters', ...change }, null)).status, 404);
  }
  assert.equal(f.keyRequests(), 0);
});

test('key endpoint failure fails closed without leaking errors', async () => {
  const f = fixture();
  globalThis.fetch = async () => { throw new Error('sensitive upstream details'); };
  const r = await call(f.env, await token(f.env));
  assert.equal(r.status, 401);
  assert.equal(await r.text(), 'Unauthorized');
});

test('cross-origin requests remain denied with a valid Access assertion', async () => {
  const f = fixture();
  assert.equal((await call(f.env, await token(f.env), { Origin: 'https://evil.example' })).status, 403);
  assert.equal(f.keyRequests(), 0);
});
