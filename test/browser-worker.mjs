import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { request } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createAgent } from '../src/agent.mjs';
import { createWorker } from '../src/worker.mjs';
import { DoneBotFixtureRuntime } from '../scripts/donebot-fixture.mjs';
import { browserRequest, fixtureBrowserUA } from './browser-checks.mjs';

const input = []; for await (const chunk of process.stdin) input.push(chunk);
const config = JSON.parse(Buffer.concat(input)), dir = await mkdtemp('/tmp/dbc-browser-'), nodes = [];
if (!config.staticDir?.startsWith('/tmp/dbc-')) throw new Error('CLOUD_DONEBOT_STATIC_DIR must name this task’s temporary frontend build');
async function api(token, path, value) {
  const res = await fetch(config.masterOrigin + path, { method: value === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'user-agent': fixtureBrowserUA, 'content-type': 'application/json', 'idempotency-key': 'browser-fixture' }, body: value === undefined ? undefined : JSON.stringify(value), signal: AbortSignal.timeout(10000) });
  return { status: res.status, value: await res.json() };
}
async function until(check, attempts = 400) { for (let i = 0; i < attempts; i++) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error('browser fixture timed out'); }
const users = [];
const installationKeys = new Map();
const { probeServer } = await import(pathToFileURL(join(process.env.DONEBOT_SOURCE_DIR || '/Users/zluo/Dev/DoneBot', 'electron/server-probe.mjs')));
const { pairingPageUrl } = await import(pathToFileURL(join(process.env.DONEBOT_SOURCE_DIR || '/Users/zluo/Dev/DoneBot', 'electron/server-address.mjs')));
const gateway = config.models ? await (await import(pathToFileURL(join(process.env.DONEBOT_SOURCE_DIR || '/Users/zluo/Dev/DoneBot', 'server/testing/fake-donebot-gateway.ts')))).startFakeDoneBotGateway(undefined, installationKeys) : null;
try {
  for (const [i, enrolled] of config.nodes.entries()) {
    const runtime = new DoneBotFixtureRuntime(dir, process.env.DONEBOT_SOURCE_DIR, { staticDir: config.staticDir, gatewayOrigin: gateway?.origin, onGateway: value => installationKeys.set(value.credential, value.installationId) }), socket = join(dir, `agent-${i}.sock`);
    const agent = await createAgent({ socketPath: socket, runtime, publicOrigin: config.masterOrigin, development: true, requireLease: true });
    const worker = await createWorker({ masterOrigin: config.masterOrigin, nodeId: enrolled.id, nodeToken: enrolled.token, publicKey: config.publicKey, stateDir: join(dir, `worker-${i}`), agentSocket: socket, port: 0, development: true, pollMs: 100, runtimeCredentials: !!config.models });
    nodes.push({ agent, worker });
    assert.equal((await api(config.adminToken, '/fixture/admin/endpoint', { operation_id: enrolled.id, endpoint: worker.origin })).status, 200);
  }
  for (const [index, name] of ['a', 'b'].entries()) {
    const token = config.users[name], created = await api(token, '/fixture/instances', {});
    assert.equal(created.status, 200); const id = created.value.data.instance.id;
    await until(async () => (await api(token, `/fixture/instances/${id}`)).value.data.actual === 'running');
    const launch = await api(token, `/fixture/browser/launch/${id}`, {}); assert.equal(launch.status, 200);
    const url = new URL(launch.value.data.url), code = new URLSearchParams(url.hash.slice(1)).get('code');
    const exchange = await browserRequest(config.masterOrigin, url, '/__cloud/exchange', { origin: url.origin, value: { code } });
    assert.equal(exchange.status, 200); const cookie = exchange.headers['set-cookie'][0].split(';')[0];
    const call = (path, options = {}) => browserRequest(config.masterOrigin, url, path, { cookie, origin: url.origin, ...options });
    assert.equal((await call('/api/auth/session')).value.kind, 'session');
    const desktop = await api(token, `/fixture/desktop/launch/${id}`, {}); assert.equal(desktop.status, 200);
    const found = await probeServer({ address: desktop.value.data.url, fetch: async address => {
      const target = new URL(address), response = await browserRequest(config.masterOrigin, target, target.pathname);
      return new Response(JSON.stringify(response.value), { status: response.status, headers: response.headers });
    } });
    assert.equal(found.outcome, 'found'); assert.equal(found.origin, url.origin);
    const pairing = new URL(pairingPageUrl(found.origin, found.credential));
    assert.equal((await browserRequest(config.masterOrigin, pairing, pairing.pathname)).status, 200);
    const nativeOptions = { origin: url.origin, userAgent: 'isolated-native-client', value: { code: new URLSearchParams(pairing.hash.slice(1)).get('code'), cookie: true, label: 'Native Cloud fixture' } };
    const native = await browserRequest(config.masterOrigin, url, '/api/auth/pair', nativeOptions); assert.equal(native.status, 200);
    assert.equal((await browserRequest(config.masterOrigin, url, '/api/auth/pair', nativeOptions)).status, 401);
    const nativeCookie = native.headers['set-cookie'][0].split(';')[0];
    assert.equal((await browserRequest(config.masterOrigin, url, '/api/auth/session', { origin: url.origin, userAgent: 'isolated-native-client', cookie: nativeCookie })).value.kind, 'session');
    assert.equal((await browserRequest(config.masterOrigin, url, '/api/auth/session', { origin: url.origin, cookie: nativeCookie })).status, 401);
    let modelCatalog;
    if (gateway) {
      const state = await call('/api/donebot/state');
      assert.equal(state.value.authenticated, true);
      assert.equal(state.value.user.id, index === 0 ? '101' : '303');
      assert.doesNotMatch(JSON.stringify(state.value), /sk-donebot-|accessToken|refreshToken/);
      modelCatalog = await call('/api/donebot/catalog'); assert.equal(modelCatalog.status, 200);
      assert.equal((await call('/api/donebot/account')).status, 200);
      assert.equal((await call('/api/donebot/logout', { value: {} })).status, 403);
    }
    const html = await call('/'); assert.equal(html.status, 200); assert.match(html.value, /<script[^>]*src="\/assets\//);
    assert.match(html.headers['content-security-policy'], /frame-ancestors 'none'/); assert.equal(html.headers['origin-agent-cluster'], '?1');
    const bots = (await call('/api/bots?messages=0')).value.bots, bot = bots[0];
    const label = index === 0 ? 'Cloud 用户甲' : 'Cloud 用户乙';
    assert.equal((await call(`/api/bots/${bot.id}`, { method: 'PATCH', value: { name: label } })).status, 200);
    assert.equal((await call(`/api/bots/${bot.id}/memory`, { method: 'PUT', value: { text: 'private-' + name } })).status, 200);
    if (gateway) {
      const selection = await call(`/api/bots/${bot.id}`, { method: 'PATCH', value: { modelSelection: { instanceId: 'donebot', model: modelCatalog.value.defaults.text }, requireAvailableModel: true } });
      assert.equal(selection.status, 200, 'Fixture model selection failed: ' + String(selection.value?.error || selection.status));
      const send = await call(`/api/bots/${bot.id}/messages`, { method: 'POST', value: { text: 'Synthetic Cloud model request ' + name, threadId: bot.threadId } });
      assert.ok([200, 202].includes(send.status), 'Cloud model message was rejected: ' + String(send.value?.error || send.status));
      await until(async () => {
        const messages = await call(`/api/threads/${bot.threadId}/messages?limit=20`);
        return messages.value.messages?.some(m => m.role === 'bot' && m.text?.includes('Synthetic DoneBot fixture complete.'));
      });
      assert.ok(gateway.requests.some(r => r.authenticated && r.installation === id && ['/v1/responses', '/v1/messages', '/v1/chat/completions'].includes(r.path)), 'No model request used this tenant installation');
    }
    users.push({ id, url, cookie, call, bot, name, label });
  }
  for (const [own, other] of [[users[0], users[1]], [users[1], users[0]]]) {
    assert.equal((await own.call(`/api/bots/${own.bot.id}/memory`)).value.text, 'private-' + own.name);
    assert.equal((await browserRequest(config.masterOrigin, other.url, '/api/bots', { cookie: own.cookie, origin: other.url.origin })).status, 401);
    assert.equal((await browserRequest(config.masterOrigin, own.url, '/api/bots', { cookie: own.cookie, origin: other.url.origin })).status, 403);
  }
  const master = new URL(config.masterOrigin), own = users[0];
  let stream;
  await new Promise((resolve, reject) => {
    stream = request({ hostname: master.hostname, port: master.port, path: '/api/events?screens=off', headers: { host: own.url.host, cookie: own.cookie, origin: own.url.origin, 'user-agent': fixtureBrowserUA } }, res => {
      try { assert.equal(res.statusCode, 200); assert.match(res.headers['content-type'], /text\/event-stream/); } catch (e) { reject(e); return; }
      res.once('data', () => resolve());
    }); stream.on('error', reject); stream.setTimeout(5000, () => stream.destroy(new Error('SSE fixture timeout'))); stream.end();
  });
  stream.destroy();
  const result = { result: 'donebot_browser_passed', actualDoneBotProcesses: 2, frontendStaticAssets: true, nativeSession: true, nativeSSE: true, crossInstanceCookieDenied: true, crossOriginDenied: true, privateMemorySeparated: true, actualLinuxContainers: false, existingNativeClientProtocol: true, nativeSingleUseHandoff: true, packagedDesktopGUI: false };
  if (gateway) {
    assert.equal(installationKeys.size, 2);
    assert.ok(!gateway.requests.some(r => r.path.startsWith('/api/v1/auth/')));
    result.automaticModelCredentials = true; result.independentModelInstallations = true; result.noSecondLoginOrUserJWT = true; result.syntheticModelReplies = true;
  }
  console.log(JSON.stringify(result));
  if (config.hold) {
    console.log(JSON.stringify({ browserFixtureReady: config.masterOrigin + '/fixture/browser-console' }));
    await until(async () => { const response = await api(config.adminToken, '/fixture/admin/browser-finished', {}); return response.value.data.finished; }, 6000);
  }
} finally {
  for (const node of nodes) { await node.worker.close(); await node.agent.close(); }
  await gateway?.close();
  await rm(dir, { recursive: true, force: true });
}
