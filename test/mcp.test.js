import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const token = 'local-test-token-at-least-32-characters';
const env = { MCP_AUTH_MODE: 'bearer', MCP_AUTH_TOKEN: token, TFL_API_KEY: 'private-test-key' };
const ctx = { waitUntil(p) { return p; } };
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function request(method = 'tools/list', params = {}, headers = {}) {
  return new Request('http://localhost/mcp', {
    method: 'POST',
    headers: { Host: 'localhost', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-11-25', Authorization: `Bearer ${token}`, ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}
async function rpc(method, params = {}) {
  const response = await worker.fetch(request(method, params), env, ctx);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  const raw = await response.text();
  return JSON.parse(raw.startsWith('event:') || raw.startsWith('data:')
    ? raw.split('\n').find(l => l.startsWith('data:')).slice(5) : raw);
}

test('disabled, incomplete, unauthorized and cross-origin requests never reach TfL', async () => {
  globalThis.fetch = () => { throw new Error('must not fetch'); };
  for (const config of [{}, { MCP_AUTH_MODE: 'disabled' }, { MCP_AUTH_TOKEN: 'short' }]) {
    assert.equal((await worker.fetch(request(), config, ctx)).status, 404);
  }
  for (const auth of ['', 'Bearer wrong', `Basic ${token}`]) {
    assert.equal((await worker.fetch(request('tools/list', {}, { Authorization: auth }), env, ctx)).status, 401);
  }
  assert.equal((await worker.fetch(request('tools/list', {}, { Origin: 'https://evil.example' }), env, ctx)).status, 403);
});

test('legacy-compatible handshake and tool discovery expose exactly two read-only tools', async () => {
  const init = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.result.serverInfo.name, 'tfl-mcp');
  const listed = await rpc('tools/list');
  assert.deepEqual(listed.result.tools.map(t => t.name), ['plan_journey', 'get_line_status']);
  assert.ok(listed.result.tools.every(t => t.annotations.readOnlyHint && !t.annotations.destructiveHint));
});

test('authenticated tool returns matching JSON text and structured data', async () => {
  globalThis.fetch = async () => Response.json([{ id: 'northern', lineStatuses: [{ statusSeverityDescription: 'Good Service' }] }]);
  const { result } = await rpc('tools/call', { name: 'get_line_status', arguments: { lineIds: ['northern'] } });
  assert.notEqual(result.isError, true);
  assert.equal(result.structuredContent.lines[0].statuses[0].description, 'Good Service');
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  assert.doesNotMatch(JSON.stringify(result), /private-test-key/);
});

test('arrival deadline reaches TfL through the MCP transport', async () => {
  globalThis.fetch = async url => {
    const params = new URL(url).searchParams;
    assert.equal(params.get('time'), '0900');
    assert.equal(params.get('timeIs'), 'Arriving');
    return Response.json({ journeys: [] });
  };
  const { result } = await rpc('tools/call', { name: 'plan_journey', arguments: {
    from: 'A', to: 'B', at: '2026-10-12T09:00:00+01:00', timeIs: 'Arriving',
  } });
  assert.equal(result.structuredContent.outcome, 'no_journeys');
});

test('MCP invalid input and tool failures remain distinct from no journeys', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('credential details', { status: 500 }); };
  const invalid = await rpc('tools/call', { name: 'plan_journey', arguments: { from: 'A', to: 'B', timeIs: 'Arriving' } });
  assert.ok(invalid.error || invalid.result?.isError);
  assert.equal(calls, 0);
  const { result } = await rpc('tools/call', { name: 'get_line_status', arguments: { lineIds: ['northern'] } });
  assert.equal(result.isError, true);
  assert.doesNotMatch(result.content[0].text, /credential/);
});
