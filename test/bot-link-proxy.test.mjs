import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPairSync, sign, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAgent } from '../src/agent.mjs';
import { createWorker } from '../src/worker.mjs';
import { close, hash, listen } from '../src/common.mjs';

function makeGrant(privateKey, claims) {
  const payload = Buffer.from(JSON.stringify(claims));
  return payload.toString('base64url') + '.' + sign(null, payload, privateKey).toString('base64url');
}

test('worker and agent forward signed bot-link token only on sync/file and preserve protocol headers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dbc-bot-link-'));
  const nodeId = randomUUID(), instanceId = randomUUID(), nodeToken = 'n'.repeat(48);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyB64 = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
  const adminToken = 'omb_admin_fixed_token_value_123456';
  const botLinkToken = 'omb_bot_link_dedicated_token_987654';
  const observed = [];

  const runtimeSocket = join(dir, 'runtime.sock');
  const runtimeServer = createServer((req, res) => {
    observed.push({ method: req.method, url: req.url, auth: req.headers.authorization, level: req.headers['x-donebot-bot-link'], bg: req.headers['x-omb-background'] });
    res.setHeader('content-type', 'application/json');
    res.setHeader('x-donebot-bot-link', '2');
    res.end(JSON.stringify({ ok: true }));
  });
  await listen(runtimeServer, runtimeSocket);

  const runtime = {
    started: false,
    async status() { return { state: this.started ? 'running' : 'stopped' }; },
    async start() { this.started = true; return { socketPath: runtimeSocket, token: adminToken, expiresAt: Date.now() + 300_000 }; },
    async stop() { this.started = false; },
    async purge() { this.started = false; },
    async health() { return { ready: true }; },
  };
  let reported = false;
  const master = createServer((req, res) => {
    req.resume();
    res.setHeader('content-type', 'application/json');
    if (req.url.endsWith('/report')) {
      reported = true;
      res.end(JSON.stringify({ code: 0, data: { ok: true } }));
      return;
    }
    if (req.url.endsWith('/claim')) {
      res.end(JSON.stringify({
        code: 0,
        data: {
          server_time: new Date().toISOString(),
          command: !runtime.started ? { id: randomUUID(), instance_id: instanceId, action: 'start', generation: 1, lease_token: 'lease-1' } : null,
          leases: [{ instance_id: instanceId, generation: 1, authorized_until: new Date(Date.now() + 300_000).toISOString() }],
        },
      }));
      return;
    }
    res.end(JSON.stringify({ code: 0, data: {} }));
  });
  const masterAddr = await listen(master, { host: '127.0.0.1', port: 0 });
  const masterOrigin = `http://127.0.0.1:${masterAddr.port}`;
  const agentSocket = join(dir, 'agent.sock');
  const agent = await createAgent({ socketPath: agentSocket, runtime, publicOrigin: masterOrigin, development: true, requireLease: false });
  const worker = await createWorker({ masterOrigin, nodeId, nodeToken, publicKey: publicKeyB64, stateDir: join(dir, 'worker'), agentSocket, port: 0, development: true, runtimeCredentials: false, pollMs: 60_000, log: () => {} });

  try {
    for (let i = 0; i < 40 && !runtime.started; i++) await new Promise(r => setTimeout(r, 25));
    assert.equal(runtime.started, true);
    await worker.poll();
    assert.equal(reported, true);

    const call = (method, subPath, extraHeaders = {}, grantExtra = {}) => {
      const uri = `/v1/instances/${instanceId}/proxy${subPath}`;
      const grant = makeGrant(privateKey, { node_id: nodeId, instance_id: instanceId, expires: Math.floor(Date.now() / 1000) + 10, request_hash: hash(`${method}\n${uri}`), ...grantExtra });
      return fetch(worker.origin + uri, { method, headers: { 'x-cloud-grant': grant, 'x-cloud-origin': masterOrigin, origin: masterOrigin, ...extraHeaders }, ...(method === 'POST' || method === 'PUT' ? { body: '{}' } : {}) });
    };

    // 1. Signed bot-link sync forwards bot-link token + protocol headers.
    const r1 = await call('POST', '/api/bot-link/sync', { 'content-type': 'application/json', 'x-donebot-bot-link-token': botLinkToken, 'x-donebot-bot-link': '2', 'x-omb-background': '1' }, { bot_link_token_hash: hash(botLinkToken) });
    assert.equal(r1.status, 200);
    assert.equal(r1.headers.get('x-donebot-bot-link'), '2');
    assert.deepEqual(observed.at(-1), { method: 'POST', url: '/api/bot-link/sync', auth: `Bearer ${botLinkToken}`, level: '2', bg: '1' });

    // 2. Signed bot-link file forwards bot-link token.
    const r2 = await call('GET', '/api/bot-link/file?id=1&way=sent&index=0&name=a.txt&probe=1&bytes=1', { 'x-donebot-bot-link-token': botLinkToken }, { bot_link_token_hash: hash(botLinkToken) });
    assert.equal(r2.status, 200);
    assert.equal(observed.at(-1).auth, `Bearer ${botLinkToken}`);

    // 3. Mismatched hash is rejected by worker.
    const r3 = await call('POST', '/api/bot-link/sync', { 'x-donebot-bot-link-token': botLinkToken }, { bot_link_token_hash: hash('wrong-token-value-123456') });
    assert.equal(r3.status, 403);

    // 4. Bot-link grant on non-sync/file path is rejected by worker.
    const r4 = await call('GET', '/api/bots', { 'x-donebot-bot-link-token': botLinkToken }, { bot_link_token_hash: hash(botLinkToken) });
    assert.equal(r4.status, 403);

    // 5. Normal request without bot_link_token_hash ignores any spoofed header and uses admin token.
    const r5 = await call('POST', '/api/bot-link/pair', { 'content-type': 'application/json', 'x-donebot-bot-link-token': botLinkToken });
    assert.equal(r5.status, 200);
    assert.equal(observed.at(-1).auth, `Bearer ${adminToken}`);
  } finally {
    await worker.close();
    await agent.close();
    await close(master);
    await close(runtimeServer);
    rmSync(dir, { recursive: true, force: true });
  }
});
