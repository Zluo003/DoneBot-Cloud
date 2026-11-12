import { createServer } from 'node:http';
import { createPublicKey, verify } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Fault, close, hash, instanceID, json, listen, privateDir, socketJSON } from './common.mjs';
import { httpProxy, proxyHeaders, safePath, wsProxy, wsServer } from './proxy.mjs';

export async function createWorker({ masterOrigin, nodeId, nodeToken, publicKey, stateDir, agentSocket, host = '127.0.0.1', port = 18991, development = false, pollMs = 3000, runtimeCredentials = !development }) {
  instanceID(nodeId); const url = new URL(masterOrigin);
  if (url.origin !== masterOrigin || url.protocol !== 'https:' && !(development && url.protocol === 'http:' && url.hostname === '127.0.0.1')) throw new Error('worker requires an HTTPS master origin');
  const rawKey = Buffer.from(publicKey, 'base64'); if (rawKey.length !== 32 || typeof nodeToken !== 'string' || nodeToken.length < 32) throw new Error('invalid worker enrollment');
  const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), rawKey]), type: 'spki', format: 'der' });
  privateDir(stateDir); const manifest = join(stateDir, 'owned.json');
  const owned = new Set(existsSync(manifest) ? JSON.parse(readFileSync(manifest)) : []); for (const id of owned) instanceID(id);
  const leases = new Map(), started = new Set(), tasks = new Map(), streams = new Set(), wss = wsServer();
  let current = null, polling = false, stopped = false, lastMasterContact = 0;
  const persist = () => { writeFileSync(manifest + '.tmp', JSON.stringify([...owned]), { mode: 0o600 }); renameSync(manifest + '.tmp', manifest); };
  const allowed = id => !stopped && (leases.get(id)?.until || 0) > Date.now();
  function serial(id, task) { const next = (tasks.get(id) || Promise.resolve()).catch(() => {}).then(task); tasks.set(id, next); next.finally(() => { if (tasks.get(id) === next) tasks.delete(id); }).catch(() => {}); return next; }
  const execute = async (id, action) => {
    const value = action === 'start' || action === 'lease' ? { authorized_until: leases.get(id)?.until } : {};
    if (action === 'start' && runtimeCredentials) value.gateway = await call('runtime-credential', { instance_id: instanceID(id) });
    return socketJSON(agentSocket, `/v1/instances/${instanceID(id)}/${action}`, 'POST', value);
  };
  async function call(verb, value) {
    let res;
    try { res = await fetch(`${masterOrigin}/api/v1/donebot/cloud/nodes/${nodeId}/${verb}`, { method: 'POST', headers: { authorization: `Bearer ${nodeToken}`, 'content-type': 'application/json' }, body: JSON.stringify(value), redirect: 'error', signal: AbortSignal.timeout(10000) }); } catch { throw new Fault(503, 'master_unavailable'); }
    const text = await res.text(); if (text.length > 1024 * 1024) throw new Fault(502, 'invalid_master_response');
    let result; try { result = JSON.parse(text); } catch { throw new Fault(502, 'invalid_master_response'); }
    if (!res.ok || result.code !== 0) throw new Fault(res.status, 'master_request_failed'); return result.data;
  }
  // A restarted worker starts with no authority to keep any recorded runtime running.
  for (const id of owned) await execute(id, 'stop');
  function grant(req) {
    const match = /^\/v1\/instances\/([^/]+)\/proxy(\/.*)$/.exec(req.url); if (!match) throw new Fault(404, 'not_found');
    const id = instanceID(match[1]); safePath(match[2]);
    const encoded = req.headers['x-cloud-grant']; if (typeof encoded !== 'string' || encoded.length > 4096) throw new Fault(401, 'grant_required');
    const parts = encoded.split('.'); if (parts.length !== 2) throw new Fault(401, 'invalid_grant');
    const payload = Buffer.from(parts[0], 'base64url');
    if (!verify(null, payload, key, Buffer.from(parts[1], 'base64url'))) throw new Fault(401, 'invalid_grant');
    let value; try { value = JSON.parse(payload); } catch { throw new Fault(401, 'invalid_grant'); }
    if (value.node_id !== nodeId || value.instance_id !== id || value.request_hash !== hash(req.method + '\n' + req.url) || !Number.isSafeInteger(value.expires) || value.expires * 1000 <= Date.now() || value.expires * 1000 > Date.now() + 30000 || !allowed(id) || !started.has(id)) throw new Fault(403, 'instance_not_authorized');
    const origin = req.headers['x-cloud-origin']; if (origin !== masterOrigin) throw new Fault(403, 'origin_forbidden');
    return { id, origin };
  }
  function track(id) { return kill => { const item = { id, kill }; streams.add(item); return () => streams.delete(item); }; }
  const server = createServer(async (req, res) => {
    if (req.url === '/healthz' && req.method === 'GET') {
      let agent = false;
      try { agent = (await socketJSON(agentSocket, '/healthz', 'GET', undefined, 3000)).ready === true; } catch { /* Only bounded readiness is exposed. */ }
      const master = Date.now() - lastMasterContact < 30000, ready = !stopped && agent && master;
      return json(res, ready ? 200 : 503, { ready, master, agent });
    }
    try { const { id, origin } = grant(req), headers = proxyHeaders(req, origin); headers['x-cloud-origin'] = origin; httpProxy(req, res, { socketPath: agentSocket, path: req.url }, headers, track(id)); }
    catch (e) { res.writeHead(e.status || 503, { 'cache-control': 'no-store' }); res.end(); }
  });
  server.on('upgrade', (req, socket, head) => {
    try { const { id, origin } = grant(req), headers = proxyHeaders(req, origin); headers['x-cloud-origin'] = origin; wsProxy(wss, req, socket, head, { socketPath: agentSocket, path: req.url }, headers, track(id)); }
    catch (e) { socket.end(`HTTP/1.1 ${e.status || 503} Rejected\r\nConnection: close\r\n\r\n`); }
  });
  const address = await listen(server, { host, port });
  async function command(op) {
    instanceID(op.instance_id); instanceID(op.id);
    if (!['start', 'stop', 'cancel', 'purge'].includes(op.action)) throw new Fault(400, 'invalid_command');
    current = { op, result: null }; const task = current;
    try {
      if (op.action === 'start') {
        if (!allowed(op.instance_id) || leases.get(op.instance_id).generation !== op.generation) throw new Fault(403, 'runtime_lease_expired');
        owned.add(op.instance_id); persist(); await serial(op.instance_id, () => execute(op.instance_id, 'start'));
        if (!allowed(op.instance_id)) { await serial(op.instance_id, () => execute(op.instance_id, 'stop')); throw new Fault(403, 'runtime_lease_expired'); }
        started.add(op.instance_id);
      } else {
        started.delete(op.instance_id); leases.delete(op.instance_id);
        if (op.action === 'purge') await call('confirm-purge', { operation_id: op.id, lease_token: op.lease_token });
        await serial(op.instance_id, () => execute(op.instance_id, op.action === 'purge' ? 'purge' : 'stop'));
        if (op.action === 'purge') { owned.delete(op.instance_id); persist(); }
      }
      task.result = '';
    } catch (e) { if (owned.has(op.instance_id)) started.add(op.instance_id); task.result = /^[a-z_]{1,100}$/.test(e.code || '') ? e.code : 'runtime_operation_failed'; }
  }
  async function poll() {
    if (polling || stopped) return; polling = true;
    try {
      if (current?.result !== null && current) {
        try { await call('report', { operation_id: current.op.id, lease_token: current.op.lease_token, error: current.result }); current = null; }
        catch (e) { if (e.status === 409) current = null; else throw e; }
      }
      const claimStarted = Date.now();
      const response = await call('claim', { running: current ? [{ operation_id: current.op.id, lease_token: current.op.lease_token }] : [] });
      if (stopped) return;
      const serverTime = Date.parse(response.server_time); if (!Number.isFinite(serverTime) || !Array.isArray(response.leases)) throw new Fault(502, 'invalid_master_lease');
      lastMasterContact = Date.now();
      leases.clear();
      for (const lease of response.leases) {
        const until = Math.min(20000, Date.parse(lease.authorized_until) - serverTime) + claimStarted;
        if (Number.isFinite(until) && until > Date.now()) leases.set(instanceID(lease.instance_id), { until, generation: lease.generation });
      }
      await Promise.all([...owned].filter(allowed).map(async id => { const observed = await execute(id, 'lease'); if (observed.state !== 'running') started.delete(id); }));
      for (const id of owned) if (allowed(id) && !started.has(id) && !tasks.has(id) && current?.op.instance_id !== id) {
        serial(id, async () => { await execute(id, 'start'); if (allowed(id)) started.add(id); else await execute(id, 'stop'); }).catch(() => started.add(id));
      }
      if (!current && response.command) void command(response.command).catch(() => {});
    } finally { polling = false; }
  }
  const fence = setInterval(() => {
    for (const item of streams) if (!allowed(item.id)) { streams.delete(item); item.kill(); }
    for (const id of started) if (!allowed(id) && !tasks.has(id)) { started.delete(id); serial(id, () => execute(id, 'stop')).catch(() => started.add(id)); }
  }, 250); fence.unref();
  await poll().catch(() => {});
  const timer = setInterval(() => poll().catch(() => {}), pollMs); timer.unref();
  return { origin: `http://${host}:${address.port}`, server, poll, allowed, async close() {
    stopped = true; clearInterval(timer); clearInterval(fence); leases.clear(); for (const item of streams) item.kill();
    await close(server); for (const id of owned) await serial(id, () => execute(id, 'stop')).catch(() => {}); await Promise.allSettled([...tasks.values()]); wss.close();
  } };
}
