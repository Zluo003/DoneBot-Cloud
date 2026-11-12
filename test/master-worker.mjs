import assert from 'node:assert/strict';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createAgent } from '../src/agent.mjs';
import { createWorker } from '../src/worker.mjs';
import { SyntheticRuntime } from '../scripts/fixtures.mjs';
import { Fault } from '../src/common.mjs';
import { browserSessionChecks, browserRequest, fixtureBrowserUA } from './browser-checks.mjs';

const input = []; for await (const chunk of process.stdin) input.push(chunk);
const config = JSON.parse(Buffer.concat(input)), dir = await mkdtemp('/tmp/dbc-multi-'), nodes = [];
async function api(token, path, value, method = value === undefined ? 'GET' : 'POST', key = 'request') {
  const r = await fetch(config.masterOrigin + path, { method, headers: { authorization: `Bearer ${token}`, 'user-agent': fixtureBrowserUA, 'content-type': 'application/json', 'idempotency-key': key }, body: value === undefined ? undefined : JSON.stringify(value), signal: AbortSignal.timeout(10000) });
  const text = await r.text(); return { status: r.status, value: text ? JSON.parse(text) : null };
}
async function until(check, label) { for (let i = 0; i < 300; i++) { const result = await check(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 50)); } assert.fail('Timed out: ' + label); }
try {
  for (let i = 0; i < config.nodes.length; i++) {
    const enrolled = config.nodes[i], root = join(dir, String(i)), runtime = new SyntheticRuntime(root), agentSocket = join(dir, `agent${i}.sock`);
    const agent = await createAgent({ socketPath: agentSocket, runtime, publicOrigin: config.masterOrigin, development: true, requireLease: true });
    const workerConfig = { masterOrigin: config.masterOrigin, nodeId: enrolled.id, nodeToken: enrolled.token, publicKey: config.publicKey, stateDir: join(dir, `worker${i}`), agentSocket, port: 0, development: true, pollMs: 100 };
    const worker = await createWorker(workerConfig); nodes.push({ ...enrolled, root, runtime, agent, worker, workerConfig });
    assert.equal((await api(config.adminToken, '/fixture/admin/endpoint', { operation_id: enrolled.id, endpoint: worker.origin })).status, 200);
  }
  const created = await Promise.all(Array.from({ length: 8 }, () => api(config.users.a, '/fixture/instances', {}, 'POST', 'one-purchase')));
  assert.ok(created.every(r => r.status === 200)); const a = created[0].value.data.instance;
  assert.equal(new Set(created.map(r => r.value.data.instance.id)).size, 1);
  const b = (await api(config.users.b, '/fixture/instances', {}, 'POST', 'second-purchase')).value.data.instance;
  async function running(token, id) { return until(async () => { const r = await api(token, `/fixture/instances/${id}`); return r.value?.data?.actual === 'running' && r.value.data; }, 'instance running'); }
  const liveA = await running(config.users.a, a.id), liveB = await running(config.users.b, b.id); assert.notEqual(liveA.node_id, liveB.node_id);
  const pathA = `/fixture/instances/${a.id}/proxy/api/value`, pathB = `/fixture/instances/${b.id}/proxy/api/value`;
  assert.equal((await api(config.users.a, pathA, { value: 'A-private' })).status, 200);
  assert.equal((await api(config.users.b, pathB, { value: 'B-private' })).status, 200);
  assert.equal((await api(config.users.a, pathB)).status, 404); assert.equal((await api(config.users.b, pathA)).status, 404);
  const browser = await browserSessionChecks({ config, api, a, b });
  const correct = new WebSocket(config.masterOrigin.replace('http:', 'ws:') + `/fixture/instances/${a.id}/proxy/api/ws`, { headers: { authorization: `Bearer ${config.users.a}` } }); await once(correct, 'open'); correct.send('private'); assert.equal((await once(correct, 'message'))[0].toString(), 'private');
  const other = new WebSocket(config.masterOrigin.replace('http:', 'ws:') + `/fixture/instances/${b.id}/proxy/api/ws`, { headers: { authorization: `Bearer ${config.users.a}` } }); other.on('error', () => {}); const denied = await once(other, 'unexpected-response'); assert.equal(denied[1].statusCode, 404); denied[1].resume(); other.terminate();
  const nodeA = nodes.find(n => n.id === liveA.node_id);
  assert.equal((await fetch(nodeA.worker.origin + `/v1/instances/${a.id}/proxy/api/value`)).status, 401);
  assert.equal((await fetch(nodeA.worker.origin + `/v1/instances/${a.id}/start`, { method: 'POST' })).status, 404);
  await api(config.adminToken, '/fixture/admin/restart', {});
  assert.equal((await api(config.users.a, pathA)).value.value, 'A-private');
  correct.terminate(); await nodeA.worker.close(); nodeA.worker = await createWorker(nodeA.workerConfig);
  await api(config.adminToken, '/fixture/admin/endpoint', { operation_id: nodeA.id, endpoint: nodeA.worker.origin });
  await until(async () => (await api(config.users.a, pathA)).status === 200, 'worker recovery');
  assert.equal((await api(config.users.a, pathA)).value.value, 'A-private');
  const stream = new WebSocket(config.masterOrigin.replace('http:', 'ws:') + `/fixture/instances/${a.id}/proxy/api/ws`, { headers: { authorization: `Bearer ${config.users.a}` } }); await once(stream, 'open'); const closed = once(stream, 'close');
  const browserStream = new WebSocket(browser.wsURL, browser.wsOptions); await once(browserStream, 'open'); const browserClosed = once(browserStream, 'close');
  await api(config.adminToken, '/fixture/admin/expire', { instance_id: a.id, days: 0 }); await Promise.all([closed, browserClosed]);
  assert.equal((await browserRequest(config.masterOrigin, browser.url, '/api/value', { cookie: browser.cookie })).status, 403);
  await until(async () => (await nodeA.runtime.status(a.id)).state === 'stopped', 'expiry stop'); await access(join(nodeA.root, a.id + '.json'));
  assert.equal((await api(config.users.a, pathA)).status, 403);
  const originalPurge = nodeA.runtime.purge.bind(nodeA.runtime); let fail = true;
  nodeA.runtime.purge = async id => { if (fail) { fail = false; throw new Fault(503, 'injected_delete_failure'); } return originalPurge(id); };
  await api(config.adminToken, '/fixture/admin/expire', { instance_id: a.id, days: 8 });
  await until(async () => (await api(config.users.a, `/fixture/instances/${a.id}`)).value?.data?.error === 'injected_delete_failure', 'deletion failure visible');
  await access(join(nodeA.root, a.id + '.json')); await api(config.adminToken, '/fixture/admin/retry', { instance_id: a.id });
  await until(async () => (await api(config.users.a, `/fixture/instances/${a.id}`)).status === 404, 'deletion complete');
  await assert.rejects(access(join(nodeA.root, a.id + '.json')));
  assert.equal((await api(config.users.b, pathB)).value.value, 'B-private');
  console.log(JSON.stringify({ result: 'two_workers_passed', postgresAuthority: true, capacity: true, crossUserHttpAndWebSocket: true, browserSingleUseLaunch: true, browserCookieHttpAndWebSocket: true, browserCrossTenantAndOriginDenied: true, browserRevocationDisconnect: true, browserExpiryDisconnect: true, workerRestart: true, expiryDisconnect: true, retainedBeforeDeadline: true, purgeFailureRetry: true, unrelatedUserDataRetained: true, actualLinuxContainers: false }));
} finally {
  for (const n of nodes) { await n.worker.close(); await n.agent.close(); }
  await rm(dir, { recursive: true, force: true });
}
