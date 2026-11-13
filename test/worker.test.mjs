import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createWorker } from '../src/worker.mjs';
import { createAgent } from '../src/agent.mjs';
import { SyntheticRuntime } from '../scripts/fixtures.mjs';
import { listen, close, body, json, hash, Fault } from '../src/common.mjs';
import { sign } from 'node:crypto';

async function credentialFixture(t) {
  const dir = await mkdtemp('/tmp/dbc-worker-'), runtime = new SyntheticRuntime(join(dir, 'runtime'));
  const node = randomUUID(), id = randomUUID(), op = randomUUID(), logs = [], reports = [];
  let command = { id: op, instance_id: id, generation: 1, action: 'start', lease_token: 'synthetic-operation-secret' };
  let failure = { code: '404', reason: 'API_KEY_NOT_FOUND', message: 'synthetic-secret-do-not-log', metadata: { step: 'validate_installation' } };
  let credentials = 0, reportFailure = false, authorized = true, generation = 1;
  const gateway = { installationId: id, credential: 'synthetic-runtime-secret-do-not-log', user: { id: '101' } };
  runtime.configureGateway = async (owner, value) => { assert.equal(owner, id); assert.deepEqual(value, gateway); };
  const agentSocket = join(dir, 'agent.sock'), agent = await createAgent({ socketPath: agentSocket, runtime, development: true, requireLease: true });
  const master = createServer(async (req, res) => {
    const value = await body(req), verb = req.url.split('/').at(-1);
    res.setHeader('x-request-id', 'fixture-request-id');
    if (verb === 'runtime-credential') {
      credentials++; assert.equal(value.instance_id, id);
      if (failure === 'html') { res.writeHead(404); return res.end('<html>synthetic-secret-do-not-log</html>'); }
      return json(res, failure ? 404 : 200, failure || { code: 0, data: gateway });
    }
    if (verb === 'report') {
      if (reportFailure) return json(res, 503, { code: 503, message: 'synthetic-secret-do-not-log' });
      reports.push(value); return json(res, 200, { code: 0, data: {} });
    }
    assert.equal(verb, 'claim');
    const next = command; command = null;
    json(res, 200, { code: 0, data: { server_time: new Date().toISOString(), leases: authorized ? [{ instance_id: id, generation, authorized_until: new Date(Date.now() + 19000).toISOString() }] : [], command: next } });
  });
  const address = await listen(master, { host: '127.0.0.1', port: 0 }), keys = generateKeyPairSync('ed25519');
  const origin = `http://127.0.0.1:${address.port}`;
  const worker = await createWorker({ masterOrigin: origin, nodeId: node, nodeToken: 'synthetic-node-secret-'.repeat(3), publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64'), stateDir: join(dir, 'worker'), agentSocket, port: 0, development: true, runtimeCredentials: true, pollMs: 100000, log: entry => logs.push(entry) });
  t.after(async () => { t.mock.timers.reset(); await worker.close(); await agent.close(); await close(master); await rm(dir, { recursive: true, force: true }); });
  const until = async predicate => { for (let n = 0; n < 100; n++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail('fixture did not settle'); };
  const proxy = async () => {
    const path = `/v1/instances/${id}/proxy/api/value`;
    const payload = Buffer.from(JSON.stringify({ node_id: node, instance_id: id, request_hash: hash('GET\n' + path), expires: Math.floor(Date.now() / 1000) + 20 }));
    const grant = payload.toString('base64url') + '.' + sign(null, payload, keys.privateKey).toString('base64url');
    return fetch(worker.origin + path, { headers: { 'x-cloud-grant': grant, 'x-cloud-origin': origin } });
  };
  return { worker, runtime, id, logs, reports, until, proxy, get credentials() { return credentials; },
    set failure(value) { failure = value; }, set reportFailure(value) { reportFailure = value; }, set authorized(value) { authorized = value; },
    retry(nextGeneration = 1) { generation = nextGeneration; command = { id: op, instance_id: id, generation, action: 'start', lease_token: 'synthetic-operation-secret' }; },
    stop() { authorized = false; command = { id: randomUUID(), instance_id: id, generation: 2, action: 'stop', lease_token: 'synthetic-operation-secret' }; },
  };
}

test('business 404 preserves safe diagnostics, prevents agent start and backs off before recovery', async t => {
  const f = await credentialFixture(t);
  await f.until(() => f.logs.some(e => e.event === 'operation_failed'));
  assert.equal(f.credentials, 1); assert.equal(f.runtime.started.size, 0);
  const error = f.logs.find(e => e.event === 'instance_start_failed');
  assert.equal(error.code, 'master_api_key_not_found'); assert.equal(error.reason, 'API_KEY_NOT_FOUND');
  assert.equal(error.request_id, 'fixture-request-id'); assert.equal(error.step, 'validate_installation');
  assert.equal(error.retry_in_ms, 15000);
  assert.equal((await f.proxy()).status, 403);
  assert.equal((await fetch(f.worker.origin + '/healthz')).status, 200, 'node readiness does not claim instance success');
  f.reportFailure = true;
  await assert.rejects(f.worker.poll());
  assert.ok(f.logs.some(e => e.event === 'operation_report_failed'));
  f.reportFailure = false;
  await f.worker.poll();
  assert.equal(f.reports[0].error, 'master_api_key_not_found');
  assert.equal(f.logs.find(e => e.event === 'operation_reported').outcome, 'failed');
  for (let n = 0; n < 5; n++) await f.worker.poll();
  f.retry(); await f.worker.poll();
  await f.until(() => f.logs.filter(e => e.event === 'operation_failed').length === 2);
  assert.equal(f.credentials, 1, 'reclaimed command respects the same backoff');
  await f.worker.poll();
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() }); t.mock.timers.tick(15001);
  f.failure = null;
  await f.worker.poll(); await f.until(() => f.runtime.started.has(f.id));
  assert.equal(f.credentials, 2); assert.equal((await f.proxy()).status, 200);
  assert.ok(!JSON.stringify(f.logs).includes('synthetic-'), 'logs contain no credentials, error messages or operation tokens');
  f.stop(); await f.worker.poll();
  await f.until(() => f.logs.some(e => e.event === 'operation_completed' && e.action === 'stop'));
  assert.equal((await f.runtime.status(f.id)).state, 'stopped'); assert.equal((await f.proxy()).status, 403);
});

test('unstructured route 404 differs from business errors and a new generation can retry immediately', async t => {
  const f = await credentialFixture(t);
  await f.until(() => f.logs.some(e => e.event === 'operation_failed'));
  await f.worker.poll(); f.failure = 'html'; f.retry(2); await f.worker.poll();
  await f.until(() => f.logs.filter(e => e.event === 'instance_start_failed').length === 2);
  const error = f.logs.filter(e => e.event === 'instance_start_failed')[1];
  assert.equal(error.code, 'master_http_not_found'); assert.equal(error.reason, undefined); assert.equal(error.step, undefined);
  assert.equal(error.request_id, 'fixture-request-id'); assert.equal(f.credentials, 2);
  assert.equal(f.runtime.started.size, 0);
  assert.ok(!JSON.stringify(f.logs).includes('synthetic-'));
});

test('unknown master fields are discarded and uncertain starts are fenced after lease revocation', async t => {
  const f = await credentialFixture(t);
  await f.until(() => f.logs.some(e => e.event === 'operation_failed'));
  await f.worker.poll();
  f.failure = { code: 404, reason: 'synthetic-secret-do-not-log', message: 'synthetic-secret-do-not-log', metadata: { step: 'synthetic-secret-do-not-log', credential: 'synthetic-secret-do-not-log' } };
  f.retry(2); await f.worker.poll();
  await f.until(() => f.logs.filter(e => e.event === 'instance_start_failed').length === 2);
  const error = f.logs.filter(e => e.event === 'instance_start_failed')[1];
  assert.equal(error.code, 'master_http_not_found'); assert.equal(error.reason, undefined); assert.equal(error.step, undefined);
  await f.worker.poll();
  f.failure = null;
  const original = f.runtime.start.bind(f.runtime);
  f.runtime.start = async id => { await original(id); throw new Fault(503, 'docker_failed'); };
  f.retry(3); await f.worker.poll();
  await f.until(() => f.logs.filter(e => e.event === 'instance_start_failed').length === 3);
  assert.equal((await f.runtime.status(f.id)).state, 'running', 'simulated partial creation');
  assert.equal((await f.proxy()).status, 403, 'failed start never authorizes access');
  f.authorized = false; await f.worker.poll();
  await f.until(() => !f.runtime.instances.has(f.id));
  assert.ok(!JSON.stringify(f.logs).includes('synthetic-'));
});

test('worker readiness requires a healthy agent and recent successful master contact', async t => {
  const dir = await mkdtemp('/tmp/dbc-health-'), runtime = new SyntheticRuntime(join(dir, 'runtime'));
  let agentReady = true;
  runtime.health = async () => ({ ready: agentReady });
  const agentSocket = join(dir, 'agent.sock'), agent = await createAgent({ socketPath: agentSocket, runtime, development: true });
  const master = createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ code: 0, data: { server_time: new Date().toISOString(), leases: [], command: null } })); });
  const address = await listen(master, { host: '127.0.0.1', port: 0 });
  const { publicKey } = generateKeyPairSync('ed25519');
  const worker = await createWorker({ masterOrigin: `http://127.0.0.1:${address.port}`, nodeId: randomUUID(), nodeToken: 'synthetic-node-token-'.repeat(3), publicKey: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64'), stateDir: join(dir, 'worker'), agentSocket, port: 0, development: true, pollMs: 100000 });
  t.after(async () => { t.mock.timers.reset(); await worker.close(); await agent.close(); await close(master); await rm(dir, { recursive: true, force: true }); });
  const health = async () => { const r = await fetch(worker.origin + '/healthz'); return { status: r.status, body: await r.json() }; };
  await worker.poll();
  assert.deepEqual(await health(), { status: 200, body: { ready: true, master: true, agent: true } });
  agentReady = false;
  assert.deepEqual(await health(), { status: 503, body: { ready: false, master: true, agent: false } });
  agentReady = true;
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() }); t.mock.timers.tick(31000);
  assert.deepEqual(await health(), { status: 503, body: { ready: false, master: false, agent: true } });
});
