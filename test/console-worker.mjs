import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request } from 'node:https';
import { createAgent } from '../src/agent.mjs';
import { createWorker } from '../src/worker.mjs';
import { DoneBotFixtureRuntime } from '../scripts/donebot-fixture.mjs';

const input = []; for await (const chunk of process.stdin) input.push(chunk);
const config = JSON.parse(Buffer.concat(input));
assert.equal(new URL(config.masterOrigin).hostname, '127.0.0.1');
assert.ok(config.staticDir.startsWith('/tmp/dbc-'));
const dir = await mkdtemp('/tmp/dbc-console-worker-'), nodes = [];
const purged = new Set();
class ConsoleRuntime extends DoneBotFixtureRuntime {
  constructor(...args) { super(...args); this.backups = { list: () => [] }; }
  async resources() { return { cpu_cores: 1, memory_bytes: 2147483648, pids: 256, storage: { enforced: false, limit_bytes: null }, backups: { automatic_interval_hours: 0 } }; }
  async purge(id) {
    const entry = this.instances.get(id); await this.stop(id);
    if (entry) await entry.fixture.close();
    this.instances.delete(id); this.gateways.delete(id); purged.add(id);
  }
}
async function call(path, { token, value, method = value === undefined ? 'GET' : 'POST', control = false } = {}) {
  const response = await fetch(config.masterOrigin + path, { method,
    headers: { 'content-type': 'application/json', 'user-agent': 'cloud-console-fixture', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(control ? { 'x-fixture-control': config.supervisor } : {}), 'idempotency-key': randomUUID() },
    body: value === undefined ? undefined : JSON.stringify(value), signal: AbortSignal.timeout(15000) });
  const result = await response.json(); return { status: response.status, data: result.data, message: result.message };
}
const control = async (action, value = {}) => { const r = await call('/__fixture/' + action, { control: true, value }); assert.equal(r.status, 200, r.message); return r.data; };
function browserRequest(path, headers, value) {
  return new Promise((resolve, reject) => {
    const req = request(config.masterOrigin + path, { servername: 'example.com', method: value ? 'POST' : 'GET', headers: { ...headers, 'content-type': 'application/json' }, signal: AbortSignal.timeout(15000) }, res => {
      let text = ''; res.on('data', chunk => text += chunk); res.on('end', () => resolve({ status: res.statusCode, text, cookies: res.headers['set-cookie'] || [] }));
    });
    req.on('error', reject); req.end(value ? JSON.stringify(value) : undefined);
  });
}
async function until(check, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('console fixture condition timed out');
}
try {
  for (const [index, enrolled] of config.nodes.entries()) {
    const runtime = new ConsoleRuntime(dir, process.env.DONEBOT_SOURCE_DIR, { staticDir: config.staticDir });
    const socket = join(dir, `agent-${index}.sock`);
    const agent = await createAgent({ socketPath: socket, runtime, publicOrigin: config.masterOrigin, development: true, requireLease: true });
    const worker = await createWorker({ masterOrigin: config.masterOrigin, nodeId: enrolled.id, nodeToken: enrolled.token, publicKey: config.publicKey,
      stateDir: join(dir, `worker-${index}`), agentSocket: socket, port: 0, development: true, pollMs: 100 });
    nodes.push({ agent, worker, runtime });
    await control('endpoint', { node: enrolled.id, endpoint: worker.origin });
  }
  if (config.hold) {
    console.log(JSON.stringify({ consoleFixtureReady: config.masterOrigin + '/cloud', temporaryPassword: config.password, temporaryControl: config.supervisor, users: ['a@cloud.example.test', 'b@cloud.example.test', 'poor@cloud.example.test'] }));
    await until(async () => (await control('state', { owner: 101 })).finished, 24 * 60 * 1000);
  } else {
    const login = async name => { const r = await call('/api/v1/auth/login', { value: { email: `${name}@cloud.example.test`, password: config.password } }); assert.equal(r.status, 200, r.message); return r.data.access_token; };
    const a = await login('a'), b = await login('b'), poor = await login('poor');
    assert.equal((await call('/api/v1/donebot/cloud/instances')).status, 401);
    const refused = await call('/api/v1/donebot/cloud/instances', { token: poor, value: {} });
    assert.equal(refused.status, 202); assert.equal(refused.data.operation.state, 'failed');
    assert.equal(refused.data.operation.error, 'billing_insufficient_balance');
    assert.equal((await control('state', { owner: 202 })).charges, 0);
    const create = async token => { const r = await call('/api/v1/donebot/cloud/instances', { token, value: {} }); assert.equal(r.status, 202, r.message); return r.data.instance.id; };
    const idA = await create(a), idB = await create(b);
    await until(async () => (await control('state', { owner: 101 })).instances[0]?.actual === 'running');
    await until(async () => (await control('state', { owner: 303 })).instances[0]?.actual === 'running');
    const launched = await call(`/api/v1/donebot/cloud/instances/${idA}/browser-launch`, { token: a, value: {} });
    assert.equal(launched.status, 200);
    const browser = new URL(launched.data.url);
    const headers = { host: browser.host, origin: browser.origin, 'user-agent': 'cloud-console-fixture' };
    const landing = await browserRequest('/__cloud/launch', headers);
    assert.equal(landing.status, 200); assert.match(landing.text, /正在打开云实例/);
    const exchange = await browserRequest('/__cloud/exchange', headers, { code: new URLSearchParams(browser.hash.slice(1)).get('code') });
    assert.equal(exchange.status, 200); assert.ok(exchange.cookies.some(value => value.includes('HttpOnly')));
    assert.equal((await call(`/api/v1/donebot/cloud/instances/${idA}/browser-launch`, { token: b, value: {} })).status, 404);
    await control('expire', { owner: 101, days: 0 });
    await until(async () => (await control('state', { owner: 101 })).instances[0]?.actual === 'stopped');
    assert.equal((await control('state', { owner: 101 })).instances[0].id, idA);
    await control('topup', { owner: 101 });
    await until(async () => (await control('state', { owner: 101 })).instances[0]?.actual === 'running');
    assert.equal((await control('state', { owner: 101 })).instances[0].id, idA);
    assert.equal((await control('state', { owner: 101 })).charges, 2);
    await control('expire', { owner: 101, days: 8 });
    await until(async () => (await control('state', { owner: 101 })).instances.length === 0);
    assert.ok(purged.has(idA));
    assert.equal((await control('state', { owner: 303 })).instances[0].id, idB);
    assert.equal((await control('state', { owner: 303 })).instances[0].actual, 'running');
  }
  const a = await control('state', { owner: 101 }), b = await control('state', { owner: 303 }), poor = await control('state', { owner: 202 });
  assert.equal(poor.charges, 0);
  assert.equal(a.charges, 2); assert.equal(a.refunds, 0); assert.equal(a.instances.length, 0);
  assert.equal(b.charges, 1); assert.equal(b.instances[0].actual, 'running');
  assert.ok(purged.size === 1);
  console.log(JSON.stringify({ result: 'cloud_console_fixture_passed', realLoginHandler: true, realJWTMiddleware: true, realCloudHandlers: true,
    privatePostgres: true, twoActualDoneBotProcesses: true, poorBalanceRejected: true, expiredRetainedThenRenewed: true, chargesForA: a.charges,
    purgedFixtureHomes: purged.size, otherUserRunning: true, realBrowserJourney: !!config.hold, actualLinuxContainers: false, packagedElectronGUI: false }));
} finally {
  for (const node of nodes) { await node.worker.close(); await node.agent.close(); }
  await rm(dir, { recursive: true, force: true });
}
