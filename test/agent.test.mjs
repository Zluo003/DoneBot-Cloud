import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createAgent } from '../src/agent.mjs';
import { socketJSON } from '../src/common.mjs';
import { SyntheticRuntime } from '../scripts/fixtures.mjs';
import { request } from 'node:http';

test('agent refreshes an expiring native session and keeps a stopped instance stopped', async t => {
  const dir = await mkdtemp('/tmp/dbc-agent-'), runtime = new SyntheticRuntime(join(dir, 'runtime'));
  const start = runtime.start.bind(runtime); let calls = 0;
  runtime.start = async id => { const result = await start(id); calls++; return { ...result, expiresAt: Date.now() + (calls === 1 ? 1000 : 3600000) }; };
  const socket = join(dir, 'agent.sock'), agent = await createAgent({ socketPath: socket, runtime, development: true, credentialCheckMs: 10 });
  t.after(async () => { await agent.close(); await rm(dir, { recursive: true, force: true }); });
  const id = randomUUID(); await socketJSON(socket, `/v1/instances/${id}/start`, 'POST', {});
  for (let i = 0; i < 100 && calls < 2; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(calls, 2);
  await socketJSON(socket, `/v1/instances/${id}/stop`, 'POST', {});
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal((await runtime.status(id)).state, 'stopped'); assert.equal(calls, 2);
});

test('trusted agent stops the runtime when a worker stops renewing its lease', async t => {
  const dir = await mkdtemp('/tmp/dbc-watchdog-'), runtime = new SyntheticRuntime(join(dir, 'runtime'));
  const socket = join(dir, 'agent.sock'), agent = await createAgent({ socketPath: socket, runtime, development: true, requireLease: true });
  t.after(async () => { await agent.close(); await rm(dir, { recursive: true, force: true }); });
  const id = randomUUID();
  await assert.rejects(socketJSON(socket, `/v1/instances/${id}/start`, 'POST', {}));
  await socketJSON(socket, `/v1/instances/${id}/start`, 'POST', { authorized_until: Date.now() + 100 });
  for (let i = 0; i < 100; i++) {
    if ((await runtime.status(id)).state === 'stopped') return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('agent left an unleased runtime running');
});

test('backup requests confirm intent, bind snapshots to the target, and restart only while authorized', async t => {
  const dir = await mkdtemp('/tmp/dbc-backup-api-'), runtime = new SyntheticRuntime(join(dir, 'runtime'));
  const id = randomUUID(), other = randomUUID(), snapshot = randomUUID(), key = randomUUID();
  const socket = join(dir, 'agent.sock'), origin = 'https://donebot.cn';
  let restores = 0;
  runtime.backups = {
    list: owner => owner === id ? [{ id: snapshot, state: 'ready' }] : [],
    create: async (owner, requestKey) => { assert.equal(owner, id); assert.equal(requestKey, key); assert.equal((await runtime.status(id)).state, 'stopped'); return { id: snapshot, state: 'ready' }; },
    restore: async owner => { assert.equal(owner, id); restores++; await new Promise(resolve => setTimeout(resolve, 120)); },
  };
  const agent = await createAgent({ socketPath: socket, runtime, publicOrigin: origin, development: true, requireLease: true });
  t.after(async () => { await agent.close(); await rm(dir, { recursive: true, force: true }); });
  const api = (owner, path, value) => new Promise((resolve, reject) => {
    const req = request({ socketPath: socket, path: `/v1/instances/${owner}/proxy/api/cloud/backups${path}`, method: value ? 'POST' : 'GET', agent: false, headers: { 'x-cloud-origin': origin, 'content-type': 'application/json' } }, res => { let text = ''; res.on('data', b => text += b); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) })); }); req.on('error', reject); req.end(value && JSON.stringify(value));
  });
  await socketJSON(socket, `/v1/instances/${id}/start`, 'POST', { authorized_until: Date.now() + 10000 });
  assert.equal((await api(id, '?timezone=UTC')).body[0].id, snapshot);
  assert.equal((await api(other, '')).status, 409);
  assert.equal((await api(id, '', { request_key: key })).status, 400);
  assert.equal((await api(id, '', { request_key: key, confirm: true })).status, 200);
  assert.equal((await runtime.status(id)).state, 'running');
  await socketJSON(socket, `/v1/instances/${id}/lease`, 'POST', { authorized_until: Date.now() + 50 });
  assert.equal((await api(id, `/${snapshot}/restore`, { request_key: randomUUID(), confirm: true })).status, 200);
  assert.equal(restores, 1);
  assert.equal((await runtime.status(id)).state, 'stopped');
});

test('agent shutdown stops its running instances', async () => {
  const dir = await mkdtemp('/tmp/dbc-shutdown-'), runtime = new SyntheticRuntime(join(dir, 'runtime'));
  const socket = join(dir, 'agent.sock'), agent = await createAgent({ socketPath: socket, runtime, development: true });
  const id = randomUUID(); await socketJSON(socket, `/v1/instances/${id}/start`, 'POST', {});
  let stopped = false; const stop = runtime.stop.bind(runtime);
  runtime.stop = async value => { if (value === id) stopped = true; return stop(value); };
  try { await agent.close(); assert.equal(stopped, true); } finally { await rm(dir, { recursive: true, force: true }); }
});
