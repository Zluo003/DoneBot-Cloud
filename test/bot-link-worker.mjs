import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAgent } from '../src/agent.mjs';
import { createWorker } from '../src/worker.mjs';
import { close, listen } from '../src/common.mjs';
import { DoneBotFixtureRuntime } from '../scripts/donebot-fixture.mjs';
import { browserRequest, fixtureBrowserUA } from './browser-checks.mjs';

const input = []; for await (const chunk of process.stdin) input.push(chunk);
const config = JSON.parse(Buffer.concat(input)), dir = await mkdtemp('/tmp/dbc-botlink-'), nodes = [];
const donebotSource = process.env.DONEBOT_SOURCE_DIR || '/Users/zluo/Dev/DoneBot';
const control = await import(pathToFileURL(join(donebotSource, 'scripts/control-omb.ts')).href);

async function api(token, path, value) {
  const res = await fetch(config.masterOrigin + path, {
    method: value === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, 'user-agent': fixtureBrowserUA, 'content-type': 'application/json', 'idempotency-key': 'bot-link-e2e' },
    body: value === undefined ? undefined : JSON.stringify(value),
    signal: AbortSignal.timeout(10_000),
  });
  return { status: res.status, value: await res.json() };
}

async function until(check, label, attempts = 300) {
  for (let i = 0; i < attempts; i++) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`bot-link e2e timed out: ${label}`);
}

const masterUrl = new URL(config.masterOrigin);
let localFixture = null, localApi = null, dnsShim = null;
const runtimes = [], activeUpstreams = new Set();

try {
  for (const [i, enrolled] of config.nodes.entries()) {
    const runtime = new DoneBotFixtureRuntime(dir, donebotSource, { scripted: true });
    runtimes.push(runtime);
    const socket = join(dir, `agent-${i}.sock`);
    const agent = await createAgent({ socketPath: socket, runtime, publicOrigin: config.masterOrigin, development: true, requireLease: true });
    const worker = await createWorker({ masterOrigin: config.masterOrigin, nodeId: enrolled.id, nodeToken: enrolled.token, publicKey: config.publicKey, stateDir: join(dir, `worker-${i}`), agentSocket: socket, port: 0, development: true, pollMs: 100, runtimeCredentials: false });
    nodes.push({ agent, worker, runtime });
    assert.equal((await api(config.adminToken, '/fixture/admin/endpoint', { operation_id: enrolled.id, endpoint: worker.origin })).status, 200);
  }

  // Provision user A's personal Cloud instance through real PostgreSQL + Go gateway + Node worker/agent.
  const token = config.users.a;
  const created = await api(token, '/fixture/instances', {});
  assert.equal(created.status, 200);
  const instanceId = created.value.data.instance.id;
  await until(async () => (await api(token, `/fixture/instances/${instanceId}`)).value.data.actual === 'running', 'cloud instance running');

  const launch = await api(token, `/fixture/browser/launch/${instanceId}`, {});
  assert.equal(launch.status, 200);
  const cloudUrl = new URL(launch.value.data.url);
  const code = new URLSearchParams(cloudUrl.hash.slice(1)).get('code');
  const exchange = await browserRequest(config.masterOrigin, cloudUrl, '/__cloud/exchange', { origin: cloudUrl.origin, value: { code } });
  assert.equal(exchange.status, 200);
  const cookie = exchange.headers['set-cookie'][0].split(';')[0];
  const cloudCall = (path, options = {}) => browserRequest(config.masterOrigin, cloudUrl, path, { cookie, origin: cloudUrl.origin, ...options });

  // Create a Cloud Bot "Atlas" on the real Cloud DoneBot service through the gateway browser proxy.
  const createdAtlas = await cloudCall('/api/bots', { method: 'POST', value: { name: 'Atlas' } });
  assert.equal(createdAtlas.status, 201, JSON.stringify(createdAtlas.value));
  const atlas = createdAtlas.value.bot ?? createdAtlas.value;
  const cloudInfo = runtimes.map(r => r.instanceInfo(instanceId)).find(Boolean);
  assert.ok(cloudInfo, 'could not locate Cloud DoneBot fixture info');

  // Launch a real disposable local DoneBot server with scripted turns.
  localFixture = await control.launchVerificationServer({}, undefined, undefined, undefined, undefined, { scripted: true });
  const localUrl = localFixture.info.url;
  localApi = async (method, path, body) => {
    const r = await fetch(`${localUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', origin: localUrl },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
    return { status: r.status, value: await r.json() };
  };
  const writer = (await control.runControlOmb(['new-bot', '--name', 'Writer', '--url', localUrl])).bot;
  const localEnv = (await localApi('GET', '/.well-known/donebot/environment')).value;

  // Pair through real Go ServeBrowser (cookie-authenticated): gateway wraps inner token into dbl_ grant.
  const paired = await cloudCall('/api/bot-link/pair', {
    method: 'POST',
    value: { computer: { id: localEnv.environmentId, name: 'Fixture Mac' }, name: 'DoneBot Cloud' },
  });
  assert.equal(paired.status, 200, JSON.stringify(paired.value));
  assert.match(paired.value.token, /^dbl_[A-Za-z0-9_-]{43}$/);

  // Simulates DNS resolution of <instance>.cloud.localhost -> master loopback listener without modifying /etc/hosts.
  dnsShim = createServer((req, res) => {
    const outHeaders = { ...req.headers, host: cloudUrl.host };
    if (outHeaders.origin) outHeaders.origin = cloudUrl.origin;
    const upstream = httpRequest({ hostname: masterUrl.hostname, port: masterUrl.port, method: req.method, path: req.url, headers: outHeaders, agent: false }, incoming => {
      res.writeHead(incoming.statusCode, incoming.headers);
      incoming.pipe(res);
    });
    activeUpstreams.add(upstream);
    upstream.once('close', () => activeUpstreams.delete(upstream));
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
    req.pipe(upstream);
  });
  const shimAddr = await listen(dnsShim, { host: '127.0.0.1', port: 0 });
  const shimOrigin = `http://127.0.0.1:${shimAddr.port}`;

  // Turn on local DoneBot dialer using the gateway-issued dbl_ token (NO browser cookie!).
  const enabled = await localApi('PUT', '/api/bot-link', {
    on: true,
    origin: shimOrigin,
    token: paired.value.token,
    name: 'Fixture Mac',
    cloud: paired.value.place,
  });
  assert.equal(enabled.status, 200, JSON.stringify(enabled.value));

  // Verify local DoneBot connects through Go gateway -> worker -> agent -> Cloud DoneBot and discovers Atlas!
  await until(async () => {
    const st = (await localApi('GET', '/api/bot-link')).value;
    return st.on === true && st.online === true && st.bots > 0;
  }, 'bot-link online and synced');

  const linkedBots = (await localApi('GET', '/api/bot-link/bots')).value.bots;
  assert.ok(linkedBots.some(b => b.name === 'Atlas' && b.botId === atlas.id), 'Atlas not found in linked bots: ' + JSON.stringify(linkedBots));

  // Script a real local->Cloud handoff WITH file transfer through /api/bot-link/file!
  const localPlans = {}, cloudPlans = {};
  const writePlan = (dataDir, plans, botId, ...turns) => {
    (plans[botId] ??= { turns: [] }).turns.push(...turns);
    writeFileSync(join(dataDir, 'room-plan.json'), JSON.stringify(plans));
  };
  const desk = join(localFixture.info.dataDir, 'task-workspaces', writer.id, writer.activeTaskId);
  mkdirSync(desk, { recursive: true });
  writeFileSync(join(desk, 'orders.csv'), 'id,total\n1,20\n2,22\n');

  writePlan(cloudInfo.dataDir, cloudPlans, atlas.id, { reply: 'Atlas counted 42 orders via Cloud proxy.' });
  writePlan(
    localFixture.info.dataDir,
    localPlans,
    writer.id,
    { steps: [{ tool: 'list_bots', arguments: {} }, { tool: 'coordinate_bots', arguments: { bot_ids: ['Atlas'], request_key: 'cloud-count', message: 'Count orders from CSV.', files: [join(desk, 'orders.csv')] } }], reply: 'Asked Atlas on Cloud.' },
    { reply: 'Atlas confirmed 42 orders.' },
  );

  await control.runControlOmb(['send', '--bot', writer.id, '--task', writer.activeTaskId, '--text', 'Ask Cloud Atlas to count orders.', '--url', localUrl]);
  const settled = await control.runControlOmb(['wait', '--bot', writer.id, '--task', writer.activeTaskId, '--timeout', '45', '--url', localUrl]);
  assert.equal(settled.status, 'settled');

  const messages = await until(async () => {
    const list = (await localApi('GET', `/api/threads/${writer.activeTaskId}/messages?limit=100`)).value.messages;
    return list.some(m => m.roomRequest?.phase === 'result' && /42 orders via Cloud proxy/.test(m.tool?.output ?? '')) ? list : null;
  }, 'cloud result received on local');
  assert.ok(messages.filter(m => m.kind === 'text').some(m => m.text === 'Atlas confirmed 42 orders.'));

  // Verify the uploaded CSV physically arrived in Cloud DoneBot's task workspace inbox!
  const cloudInboxFiles = existsSync(join(cloudInfo.dataDir, 'task-workspaces', atlas.id))
    ? readdirSync(join(cloudInfo.dataDir, 'task-workspaces', atlas.id), { recursive: true }).map(String).filter(p => p.endsWith('orders.csv') && /(^|[\\/])inbox[\\/]/.test(p))
    : [];
  assert.equal(cloudInboxFiles.length, 1);
  assert.equal(readFileSync(join(cloudInfo.dataDir, 'task-workspaces', atlas.id, cloudInboxFiles[0]), 'utf8'), 'id,total\n1,20\n2,22\n');

  // Revoke via DELETE /api/bot-link/pair and verify the gateway immediately blocks further sync with 401.
  const del = await cloudCall(`/api/bot-link/pair?computer=${encodeURIComponent(localEnv.environmentId)}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  const blocked = await browserRequest(config.masterOrigin, cloudUrl, '/api/bot-link/sync', {
    origin: cloudUrl.origin,
    extra: { authorization: `Bearer ${paired.value.token}`, 'x-donebot-bot-link': '2' },
    value: { ack: 0, frames: [], wait: 0 },
  });
  assert.equal(blocked.status, 401);

  console.log(JSON.stringify({
    result: 'bot_link_cloud_e2e_passed',
    gatewayWrappedOuterToken: true,
    syncWithoutCookieThroughProxy: true,
    listBotsFoundCloudAtlas: true,
    bidirectionalHandoffAndFileTransfer: true,
    revocationBlocksSync401: true,
  }));
} finally {
  if (localApi) await localApi('PUT', '/api/bot-link', { on: false }).catch(() => {});
  for (const upstream of activeUpstreams) upstream.destroy();
  if (dnsShim) await close(dnsShim);
  if (localFixture) await localFixture.close();
  for (const n of nodes) { await n.worker.close(); await n.agent.close(); }
  await rm(dir, { recursive: true, force: true });
}
