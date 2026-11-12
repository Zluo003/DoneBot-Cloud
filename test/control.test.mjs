import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { createAgent } from '../src/agent.mjs';
import { createControl } from '../src/control.mjs';
import { Gateway } from '../src/gateway.mjs';
import { SyntheticRuntime, syntheticGateway } from '../scripts/fixtures.mjs';

async function fixture(t, options = {}) {
  const dir = await mkdtemp('/tmp/dbc-test-'), upstream = await syntheticGateway(options), runtime = new SyntheticRuntime(join(dir, 'tenants')), agentSocket = join(dir, 'agent.sock');
  const agent = await createAgent({ socketPath: agentSocket, runtime, development: true });
  const config = { stateDir: join(dir, 'control'), agentSocket, gateway: new Gateway({ ...upstream, mode: 'development' }), intervalMs: 60000, ...options };
  let app = await createControl(config);
  t.after(async () => { await app.close(); await agent.close(); await upstream.close(); await rm(dir, { recursive: true, force: true }); });
  const api = async (token, path, method = 'GET', value, headers = {}) => {
    const response = await fetch(app.origin + path, { method, headers: { authorization: `Bearer ${token || ''}`, 'content-type': 'application/json', ...headers }, body: value === undefined ? undefined : JSON.stringify(value) });
    return { status: response.status, value: await response.json() };
  };
  const login = async name => (await api(null, '/v1/login', 'POST', { email: name, password: upstream.password })).value.token;
  const operation = async (token, path, key = randomUUID()) => {
    const r = await api(token, path, 'POST', {}, { 'idempotency-key': key }); assert.equal(r.status, 202, JSON.stringify(r.value)); return r.value;
  };
  const settled = async (token, id) => {
    for (let i = 0; i < 300; i++) { const r = await api(token, `/v1/instances/${id}/operations`); const ops = r.value.operations; if (ops.length && ops.every(op => ['succeeded', 'failed'].includes(op.state))) return ops; await new Promise(r => setTimeout(r, 10)); }
    assert.fail('operation did not settle');
  };
  return { dir, upstream, runtime, api, login, operation, settled, get app() { return app; }, async restart() { await app.close(); app = await createControl(config); } };
}

test('two users: durable ownership, once-only purchase, HTTP and WebSocket authorization, restart and retained data', async t => {
  const f = await fixture(t), a = await f.login('a'), b = await f.login('b');
  const requests = await Promise.all(Array.from({ length: 12 }, () => f.operation(a, '/v1/instances', 'same-request')));
  const idA = requests[0].instance.id; assert.equal(new Set(requests.map(r => r.instance.id)).size, 1);
  const idB = (await f.operation(b, '/v1/instances')).instance.id;
  assert.ok((await f.settled(a, idA)).every(o => o.state === 'succeeded')); await f.settled(b, idB);
  assert.equal(f.upstream.events.filter(e => e.id === idA && e.event === 'charge').length, 1);
  assert.equal(f.runtime.started.get(idA), 1);
  const baseA = `/v1/instances/${idA}`, baseB = `/v1/instances/${idB}`;
  for (const [token, other] of [[a, baseB], [b, baseA]]) {
    for (const path of ['', '/operations', '/proxy/api/value']) assert.equal((await f.api(token, other + path)).status, 404);
    for (const action of ['start', 'stop', 'cancel']) assert.equal((await f.api(token, other + '/' + action, 'POST', {}, { 'idempotency-key': randomUUID() })).status, 404);
    const ws = new WebSocket(f.app.origin.replace('http:', 'ws:') + other + '/proxy/api/ws', { headers: { authorization: `Bearer ${token}` } });
    ws.on('error', () => {}); const response = await once(ws, 'unexpected-response'); assert.equal(response[1].statusCode, 404); response[1].resume(); ws.terminate();
  }
  await f.api(a, baseA + '/proxy/api/value', 'POST', { files: ['a.txt'], memory: 'A', config: 'A', chats: ['A'] });
  await f.api(b, baseB + '/proxy/api/value', 'POST', { files: ['b.txt'], memory: 'B', config: 'B', chats: ['B'] });
  const headers = await f.api(a, baseA + '/proxy/api/headers', 'GET', undefined, { 'x-forwarded-for': '127.0.0.1', 'x-user-id': '202', cookie: 'instance=stolen' });
  assert.deepEqual(headers.value, { forwarded: null, impersonation: null, cookie: null, hasBearer: true });
  const ws = new WebSocket(f.app.origin.replace('http:', 'ws:') + baseA + '/proxy/api/ws', { headers: { authorization: `Bearer ${a}` } });
  await once(ws, 'open'); ws.send('a-only'); assert.equal((await once(ws, 'message'))[0].toString(), 'a-only');
  const gone = once(ws, 'close'); await f.operation(a, baseA + '/stop'); await gone; await f.settled(a, idA);
  assert.equal((await f.api(a, baseA + '/proxy/api/value')).status, 409);
  await f.operation(a, baseA + '/start'); await f.settled(a, idA); await f.restart();
  assert.deepEqual((await f.api(a, baseA + '/proxy/api/value')).value, { files: ['a.txt'], memory: 'A', config: 'A', chats: ['A'] });
  assert.equal((await f.api(b, baseB + '/proxy/api/value')).value.memory, 'B');
  assert.equal(f.upstream.events.filter(e => e.id === idA && e.event === 'charge').length, 1);
  const db = await readFile(join(f.dir, 'control/cloud.sqlite')); assert.ok(!db.includes(Buffer.from(a))); assert.ok(!db.includes(Buffer.from(f.upstream.password)));
});

test('insufficient prepaid balance blocks creation and expiry stops existing connections without a renewal', async t => {
  let clock = Date.now(); const f = await fixture(t, { clock: () => clock, now: () => clock, monthMs: 1000 });
  const poor = await f.login('poor'), request = await f.operation(poor, '/v1/instances'), idPoor = request.instance.id;
  assert.equal((await f.settled(poor, idPoor))[0].error, 'insufficient_balance'); assert.equal(f.runtime.started.has(idPoor), false);
  const a = await f.login('a'), id = (await f.operation(a, '/v1/instances')).instance.id; await f.settled(a, id);
  const ws = new WebSocket(f.app.origin.replace('http:', 'ws:') + `/v1/instances/${id}/proxy/api/ws`, { headers: { authorization: `Bearer ${a}` } }); await once(ws, 'open');
  f.upstream.users.get('a').balance = 0n; clock += 2000; const gone = once(ws, 'close'); await f.app.tick(); await gone;
  assert.equal(f.upstream.events.filter(e => e.id === id).length, 1); assert.equal((await f.runtime.status(id)).state, 'stopped');
  assert.equal((await f.api(a, `/v1/instances/${id}/proxy/api/value`)).status, 402);
  f.upstream.users.get('a').balance = 20_000_000n; await f.operation(a, `/v1/instances/${id}/start`); await f.settled(a, id);
  assert.equal(f.upstream.events.filter(e => e.id === id).length, 2);
});

test('start failure preserves a pending charge; cancel refunds once; revoked sessions close streams', async t => {
  const f = await fixture(t), a = await f.login('a');
  const original = f.runtime.start.bind(f.runtime); let fail = true;
  f.runtime.start = async id => { if (fail) { fail = false; f.runtime.failures.add(id); } return original(id); };
  const id = (await f.operation(a, '/v1/instances')).instance.id; await f.settled(a, id);
  assert.equal(f.upstream.subscriptions.get(id).state, 'pending');
  await f.operation(a, `/v1/instances/${id}/cancel`, 'cancel'); await f.settled(a, id); await f.operation(a, `/v1/instances/${id}/cancel`, 'cancel');
  assert.equal(f.upstream.events.filter(e => e.event === 'refund').length, 1);
  await f.operation(a, `/v1/instances/${id}/start`); await f.settled(a, id);
  const ws = new WebSocket(f.app.origin.replace('http:', 'ws:') + `/v1/instances/${id}/proxy/api/ws`, { headers: { authorization: `Bearer ${a}` } }); await once(ws, 'open');
  const gone = once(ws, 'close'); f.upstream.revoke('a'); await f.app.tick(); await gone;
  assert.equal((await f.api(a, '/v1/instances')).status, 401);
});

test('rejects impersonation, browser cross-origin mutations, invalid paths, and production fixture identity', async t => {
  const f = await fixture(t), a = await f.login('a');
  assert.equal((await f.api(a, '/v1/instances', 'POST', { owner: '202' }, { 'idempotency-key': 'fake-owner' })).status, 400);
  assert.equal((await f.api(a, '/v1/instances', 'POST', {}, { origin: 'https://evil.invalid', 'idempotency-key': 'evil' })).status, 403);
  assert.equal((await f.api(null, '/v1/instances', 'GET', undefined, { 'x-user-id': '101', 'x-forwarded-user': '101' })).status, 401);
  assert.throws(() => new Gateway({ origin: f.upstream.origin, mode: 'production' }));
  assert.throws(() => new Gateway({ origin: 'http://localhost:1234', mode: 'development' }));
});
