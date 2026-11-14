import { createServer } from 'node:http';
import { createPublicKey, verify } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Fault, body, close, hash, instanceID, json, listen, privateDir, socketJSON } from './common.mjs';
import { httpProxy, proxyHeaders, safePath, wsProxy, wsServer } from './proxy.mjs';
import { errorFields, masterFailure } from './worker-errors.mjs';
import { readRunLeases, runLeaseValid, runLeaseUntil } from './run-lease.mjs';

export async function createWorker({ masterOrigin, nodeId, nodeToken, publicKey, stateDir, agentSocket, host = '127.0.0.1', port = 18991, development = false, pollMs = 3000, runtimeCredentials = !development, log = entry => console.log(JSON.stringify(entry)) }) {
  instanceID(nodeId); const url = new URL(masterOrigin);
  if (url.origin !== masterOrigin || url.protocol !== 'https:' && !(development && url.protocol === 'http:' && url.hostname === '127.0.0.1')) throw new Error('worker requires an HTTPS master origin');
  const rawKey = Buffer.from(publicKey, 'base64'); if (rawKey.length !== 32 || typeof nodeToken !== 'string' || nodeToken.length < 32) throw new Error('invalid worker enrollment');
  const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), rawKey]), type: 'spki', format: 'der' });
  privateDir(stateDir); const manifest = join(stateDir, 'owned.json');
  const owned = new Set(existsSync(manifest) ? JSON.parse(readFileSync(manifest)) : []); for (const id of owned) instanceID(id);
  const leases = new Map(), started = new Set(), needsStop = new Set(), retries = new Map(), tasks = new Map(), streams = new Set(), wss = wsServer();
  let current = null, polling = false, stopped = false, lastMasterContact = 0;
  const persist = () => { writeFileSync(manifest + '.tmp', JSON.stringify([...owned]), { mode: 0o600 }); renameSync(manifest + '.tmp', manifest); };
  const allowed = id => !stopped && runLeaseValid(leases.get(id));
  const record = (event, fields = {}) => { try { log({ app: 'donebot-cloud-worker', event, node_id: nodeId, ...fields }); } catch { /* Diagnostics cannot interrupt lease fencing. */ } };
  function serial(id, task) { const next = (tasks.get(id) || Promise.resolve()).catch(() => {}).then(task); tasks.set(id, next); next.finally(() => { if (tasks.get(id) === next) tasks.delete(id); }).catch(() => {}); return next; }
  const execute = async (id, action) => {
    const lease = leases.get(id);
    const value = action === 'start' || action === 'lease' ? { authorized_until: lease && runLeaseUntil(lease) } : {};
    if (action === 'start' && runtimeCredentials) value.gateway = await call('runtime-credential', { instance_id: instanceID(id) });
    if (action === 'start') needsStop.add(id);
    const result = await socketJSON(agentSocket, `/v1/instances/${instanceID(id)}/${action}`, 'POST', value);
    if (action === 'stop' || action === 'purge') { needsStop.delete(id); started.delete(id); }
    return result;
  };
  async function call(verb, value) {
    let res;
    try { res = await fetch(`${masterOrigin}/api/v1/donebot/cloud/nodes/${nodeId}/${verb}`, { method: 'POST', headers: { authorization: `Bearer ${nodeToken}`, 'content-type': 'application/json' }, body: JSON.stringify(value), redirect: 'error', signal: AbortSignal.timeout(10000) }); } catch { throw new Fault(503, 'master_unavailable'); }
    let result;
    try { result = await body(res.body, 1024 * 1024); } catch {
      if (!res.ok) throw masterFailure(res);
      throw new Fault(502, 'invalid_master_response');
    }
    if (!res.ok || result?.code !== 0) throw masterFailure(res, result);
    return result.data;
  }
  async function start(id) {
    const generation = leases.get(id)?.generation, prior = retries.get(id);
    if (prior?.generation === generation && prior.until > Date.now()) throw prior.error;
    try {
      await execute(id, 'start');
      if (!allowed(id) || leases.get(id)?.generation !== generation) { await execute(id, 'stop'); throw new Fault(403, 'runtime_lease_expired'); }
      started.add(id); retries.delete(id);
      record('instance_started', { instance_id: id });
    } catch (error) {
      started.delete(id);
      const attempts = prior?.generation === generation ? prior.attempts + 1 : 1;
      const delay = Math.min(300000, 15000 * 2 ** Math.min(attempts - 1, 5));
      retries.set(id, { generation, attempts, until: Date.now() + delay, error });
      record('instance_start_failed', { instance_id: id, ...errorFields(error), attempt: attempts, retry_in_ms: delay });
      throw error;
    }
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
        owned.add(op.instance_id); persist(); await serial(op.instance_id, () => start(op.instance_id));
      } else {
        started.delete(op.instance_id); leases.delete(op.instance_id); retries.delete(op.instance_id);
        if (op.action === 'purge') await call('confirm-purge', { operation_id: op.id, lease_token: op.lease_token });
        await serial(op.instance_id, () => execute(op.instance_id, op.action === 'purge' ? 'purge' : 'stop'));
        if (op.action === 'purge') { owned.delete(op.instance_id); persist(); }
      }
      task.result = '';
      record('operation_completed', { operation_id: op.id, instance_id: op.instance_id, action: op.action });
    } catch (e) {
      task.result = /^[a-z_]{1,100}$/.test(e.code || '') ? e.code : 'runtime_operation_failed';
      record('operation_failed', { operation_id: op.id, instance_id: op.instance_id, action: op.action, ...errorFields(e) });
    }
  }
  async function poll() {
    if (polling || stopped) return; polling = true;
    try {
      if (current?.result !== null && current) {
        try {
          await call('report', { operation_id: current.op.id, lease_token: current.op.lease_token, error: current.result });
          record('operation_reported', { operation_id: current.op.id, instance_id: current.op.instance_id, outcome: current.result ? 'failed' : 'succeeded', code: current.result ? errorFields({ code: current.result }).code : undefined });
          current = null;
        } catch (e) {
          record('operation_report_failed', { operation_id: current.op.id, instance_id: current.op.instance_id, ...errorFields(e) });
          if (e.status === 409) current = null; else throw e;
        }
      }
      const claimStarted = Date.now(), monotonicStarted = performance.now();
      const response = await call('claim', { running: current ? [{ operation_id: current.op.id, lease_token: current.op.lease_token }] : [] });
      if (stopped) return;
      const renewed = readRunLeases(response, claimStarted, monotonicStarted);
      lastMasterContact = Date.now();
      leases.clear();
      for (const [id, lease] of renewed) if (runLeaseValid(lease)) leases.set(id, lease);
      await Promise.all([...owned].filter(allowed).map(async id => { const observed = await execute(id, 'lease'); if (observed.state !== 'running') started.delete(id); }));
      for (const id of owned) if (allowed(id) && !started.has(id) && !tasks.has(id) && current?.op.instance_id !== id && response.command?.instance_id !== id && !(retries.get(id)?.generation === leases.get(id)?.generation && retries.get(id).until > Date.now())) {
        serial(id, () => start(id)).catch(() => {});
      }
      if (!current && response.command) void command(response.command).catch(() => {});
    } catch (error) {
      if (error.status === 401 || error.status === 403) { leases.clear(); lastMasterContact = 0; }
      throw error;
    } finally { polling = false; }
  }
  const fence = setInterval(() => {
    for (const item of streams) if (!allowed(item.id)) { streams.delete(item); item.kill(); }
    for (const id of needsStop) if (!allowed(id) && !tasks.has(id)) { started.delete(id); serial(id, () => execute(id, 'stop')).catch(error => record('instance_fence_failed', { instance_id: id, ...errorFields(error) })); }
  }, 250); fence.unref();
  const pollSafely = () => poll().catch(error => record('master_poll_failed', errorFields(error)));
  await pollSafely();
  const timer = setInterval(pollSafely, pollMs); timer.unref();
  return { origin: `http://${host}:${address.port}`, server, poll, allowed, async close() {
    stopped = true; clearInterval(timer); clearInterval(fence); leases.clear(); for (const item of streams) item.kill();
    await close(server); for (const id of owned) await serial(id, () => execute(id, 'stop')).catch(() => {}); await Promise.allSettled([...tasks.values()]); wss.close();
  } };
}
