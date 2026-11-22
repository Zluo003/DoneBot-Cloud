import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, sign } from 'node:crypto';
import WebSocket from 'ws';
import { body, close, fail, hash, json, listen } from '../src/common.mjs';
import { wsServer } from '../src/proxy.mjs';
import { createAgent } from '../src/agent.mjs';
import { createWorker } from '../src/worker.mjs';
import { TEAM_PROTOCOL, teamRequest } from '../src/team-runtime.mjs';
import { teamFixture } from './team-fixtures.mjs';

async function nodeFixture(t, { enabled = true, protocol = TEAM_PROTOCOL, coordinatorPatch = {} } = {}) {
  const f = teamFixture(), dir = await mkdtemp('/tmp/dbc-team-node-'), nodeId = randomUUID(), logs = [], claims = [], seen = [];
  let active = false, starts = 0, configurations = 0, advertise = protocol, authorized = true, configuration = { team: f.team, coordinator: { ...f.coordinator, ...coordinatorPatch } };
  const runtimeSocket = join(dir, 'runtime.sock'), agentSocket = join(dir, 'agent.sock');
  const server = createServer((req, res) => {
    try {
      const member = teamRequest(f.team, req, req.url);
      seen.push({ ...member, bearer: req.headers.authorization, cookie: req.headers.cookie, computerSecret: req.headers['x-omb-computer-secret'] });
      json(res, 200, { user_id: member.userId, role: member.role });
    } catch (e) { fail(res, e); }
  });
  const wss = wsServer();
  server.on('upgrade', (req, socket, head) => {
    try { teamRequest(f.team, req, req.url); wss.handleUpgrade(req, socket, head, ws => ws.on('message', (data, binary) => ws.send(data, { binary }))); }
    catch { socket.end('HTTP/1.1 401 Rejected\r\nConnection: close\r\n\r\n'); }
  });
  await listen(server, runtimeSocket);
  const runtime = {
    health: async () => ({ ready: true, team_protocol: advertise }),
    configureTeam: async (id, value) => { assert.equal(id, f.id); assert.deepEqual(value, f.team); configurations++; },
    configureTeamCoordinator: async (id, value) => { assert.equal(id, f.id); assert.deepEqual(value, f.coordinator); },
    start: async () => { active = true; starts++; return { socketPath: runtimeSocket, team: f.team, expiresAt: Number.MAX_SAFE_INTEGER }; },
    status: async () => ({ state: active ? 'running' : 'stopped' }), stop: async () => { active = false; },
    resources: async () => ({ cpu_cores: 2 }), backups: { list: () => [], remove: () => {}, create: async () => ({ id: randomUUID() }) },
  };
  const agent = await createAgent({ socketPath: agentSocket, runtime, development: true, requireLease: true });
  let command = { id: randomUUID(), instance_id: f.id, generation: 1, action: 'start', lease_token: 'synthetic-operation' };
  const master = createServer(async (req, res) => {
    const value = await body(req), verb = req.url.split('/').at(-1);
    if (verb === 'runtime-configuration') return json(res, 200, { code: 0, data: configuration });
    if (verb === 'runtime-credential') return json(res, 403, { reason: 'TEAM_RUNTIME_INACTIVE' });
    if (verb === 'report') return json(res, 200, { code: 0, data: {} });
    assert.equal(verb, 'claim'); claims.push(value);
    const next = command; command = null;
    json(res, 200, { code: 0, data: { server_time: new Date().toISOString(), leases: authorized ? [{ instance_id: f.id, generation: 1, authorized_until: new Date(Date.now() + 20000).toISOString() }] : [], command: next } });
  });
  const address = await listen(master, { host: '127.0.0.1', port: 0 }), origin = `http://127.0.0.1:${address.port}`;
  const worker = await createWorker({ masterOrigin: origin, nodeId, nodeToken: 'synthetic-node-credential'.repeat(3), publicKey: f.publicKey,
    stateDir: join(dir, 'worker'), agentSocket, port: 0, development: true, runtimeCredentials: true, teamsEnabled: enabled, pollMs: 100000, log: row => logs.push(row) });
  t.after(async () => {
    await worker.close(); await agent.close(); for (const client of wss.clients) client.terminate(); wss.close(); await close(server); await close(master);
    await rm(dir, { recursive: true, force: true });
  });
  const until = async predicate => { for (let n = 0; n < 200; n++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail('team node fixture did not settle'); };
  const headers = (route, role = 'member', method = 'GET', patch = {}) => {
    const path = `/v1/instances/${f.id}/proxy${route}`, payload = Buffer.from(JSON.stringify({ node_id: nodeId, instance_id: f.id,
      request_hash: hash(`${method}\n${path}`), expires: Math.floor(Date.now() / 1000) + 20 }));
    return { 'x-cloud-grant': payload.toString('base64url') + '.' + sign(null, payload, f.privateKey).toString('base64url'),
      'x-cloud-origin': origin, 'x-donebot-team-grant': f.grant(route, role, patch, method), cookie: 'owner=must-not-forward', authorization: 'Bearer forged-owner', 'content-type': 'application/json' };
  };
  const proxy = (route, role = 'member', method = 'GET', patch = {}) => fetch(`${worker.origin}/v1/instances/${f.id}/proxy${route}`, { method, headers: headers(route, role, method, patch) });
  return { ...f, worker, logs, claims, seen, until, headers, proxy, origin,
    get starts() { return starts; }, get configurations() { return configurations; },
    set protocol(value) { advertise = value; }, set authorized(value) { authorized = value; }, set configuration(value) { configuration = value; },
    retry() { command = { id: randomUUID(), instance_id: f.id, generation: 2, action: 'start', lease_token: 'synthetic-operation' }; },
  };
}

test('worker and agent preserve actual member identity across HTTP and WebSocket without owner credentials', async t => {
  const f = await nodeFixture(t);
  await f.until(() => f.logs.some(row => row.event === 'operation_completed'));
  assert.equal(f.claims[0].team_protocol, TEAM_PROTOCOL); assert.equal(f.configurations, 1);
  const response = await f.proxy('/api/bots?limit=1'); assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { user_id: '303', role: 'member' });
  assert.equal(f.seen[0].bearer, undefined); assert.equal(f.seen[0].cookie, undefined);
  const sharedSecret = 'a'.repeat(64);
  const shared = await fetch(`${f.worker.origin}/v1/instances/${f.id}/proxy/api/shared-computers/connect`, {
    method: 'POST',
    headers: { ...f.headers('/api/shared-computers/connect', 'member', 'POST'), 'x-omb-computer-secret': sharedSecret },
    body: '{}',
  });
  assert.equal(shared.status, 200);
  assert.equal(f.seen.at(-1).computerSecret, sharedSecret);
  assert.equal(f.seen.at(-1).bearer, undefined); assert.equal(f.seen.at(-1).cookie, undefined);
  assert.ok(!JSON.stringify(f.logs).includes(f.coordinator.credential));
  assert.ok(!JSON.stringify(f.seen).includes(f.coordinator.credential));
  assert.equal((await f.proxy('/api/bots', 'member', 'GET', { team_id: randomUUID() })).status, 401);
  const route = '/api/events?cursor=socket', socket = new WebSocket(f.worker.origin.replace('http:', 'ws:') + `/v1/instances/${f.id}/proxy${route}`, { headers: f.headers(route) });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  const echoed = new Promise((resolve, reject) => { socket.once('message', data => resolve(data.toString())); socket.once('error', reject); });
  socket.send('member-stream'); assert.equal(await echoed, 'member-stream');
  const closed = new Promise(resolve => socket.once('close', resolve));
  f.authorized = false; await f.worker.poll(); await closed;
  assert.equal((await f.proxy('/api/bots')).status, 403);
});

test('host-intercepted resources and full-instance backups enforce member grants and roles', async t => {
  const f = await nodeFixture(t);
  await f.until(() => f.starts === 1);
  assert.equal((await f.proxy('/api/cloud/resources')).status, 200);
  assert.equal((await f.proxy('/api/cloud/resources', 'member', 'GET', { expires: 1 })).status, 401);
  assert.equal((await f.proxy('/api/cloud/backups')).status, 403);
  assert.equal((await f.proxy('/api/cloud/backups/' + randomUUID(), 'member', 'DELETE')).status, 403);
  for (const role of ['admin', 'owner']) assert.equal((await f.proxy('/api/cloud/backups', role)).status, 200);
});

test('default-off workers refuse team provisioning and do not advertise the protocol', async t => {
  const f = await nodeFixture(t, { enabled: false });
  await f.until(() => f.logs.some(row => row.event === 'operation_failed'));
  assert.equal(f.claims[0].team_protocol, undefined); assert.equal(f.starts, 0);
});

test('workers reject mismatched coordinator identity and old runtime generation before starting a team', async t => {
  for (const patch of [{ generation: 0 }, { instance_id: randomUUID() }, { team_id: randomUUID() }, { credential: undefined }]) {
    await t.test(JSON.stringify(patch), async child => {
      const f = await nodeFixture(child, { coordinatorPatch: patch });
      await f.until(() => f.logs.some(row => row.event === 'operation_failed'));
      assert.equal(f.starts, 0);
      assert.ok(!JSON.stringify(f.logs).includes('dbtc_'));
    });
  }
});

test('capability claims downgrade with the agent and ambiguous configurations never start', async t => {
  const f = await nodeFixture(t, { protocol: 'future' });
  await f.until(() => f.logs.some(row => row.event === 'operation_failed'));
  assert.equal(f.claims[0].team_protocol, '');
  assert.equal(f.starts, 0);
  f.protocol = TEAM_PROTOCOL; f.configuration = { team: f.team, gateway: { credential: 'forbidden' } };
  f.retry(); await f.worker.poll();
  await f.until(() => f.logs.filter(row => row.event === 'operation_failed').length === 2);
  assert.equal(f.claims.at(-1).team_protocol, TEAM_PROTOCOL);
  assert.equal(f.starts, 0);
});
