import { createServer } from 'node:http';
import { chmodSync, chownSync, existsSync, lstatSync, unlinkSync } from 'node:fs';
import { connect } from 'node:net';
import { Fault, body, close, fail, instanceID, json, listen } from './common.mjs';
import { httpProxy, proxyHeaders, safePath, wsProxy, wsServer } from './proxy.mjs';
import { MAX_RUN_LEASE_MS, runLeaseDeadline, runLeaseValid } from './run-lease.mjs';

export async function createAgent({ socketPath, runtime, publicOrigin, development = false, socketGroup, credentialCheckMs = 60000, requireLease = !development, backupIntervalMs = 0 }) {
  if (!Number.isSafeInteger(backupIntervalMs) || backupIntervalMs < 0 || backupIntervalMs > 30 * 86400000) throw new Error('invalid backup interval');
  if (requireLease) await runtime.recover?.();
  if (existsSync(socketPath)) {
    const old = lstatSync(socketPath);
    if (!old.isSocket() || old.uid !== process.getuid()) throw new Error('agent socket ownership mismatch');
    const stale = await new Promise(resolve => { const socket = connect(socketPath); socket.once('connect', () => { socket.destroy(); resolve(false); }); socket.once('error', e => resolve(e.code === 'ECONNREFUSED')); socket.setTimeout(1000, () => { socket.destroy(); resolve(false); }); });
    if (!stale || lstatSync(socketPath).ino !== old.ino) throw new Error('agent socket is already in use');
    unlinkSync(socketPath);
  }
  const queues = new Map(), active = new Map(), deadlines = new Map(), fencing = new Set(), streams = new Set(), wss = wsServer();
  let closing = false;
  function serial(id, fn) { const next = (queues.get(id) || Promise.resolve()).catch(() => {}).then(fn); queues.set(id, next); return next; }
  function disconnect(id) { for (const item of streams) if (item.id === id) { streams.delete(item); item.kill(); } }
  function track(id) { return kill => { const item = { id, kill }; streams.add(item); return () => streams.delete(item); }; }
  const authorized = id => !requireLease || runLeaseValid(deadlines.get(id));
  if (runtime.desktops) runtime.desktops.allowed = id => !closing && authorized(id) && active.has(id) && active.get(id).expiresAt > Date.now();
  function renew(id, value) {
    const until = value.authorized_until;
    if (!Number.isSafeInteger(until) || until <= Date.now() || until > Date.now() + MAX_RUN_LEASE_MS) throw new Fault(403, 'invalid_runtime_lease');
    deadlines.set(id, runLeaseDeadline(until));
  }
  function target(req, id) {
    const origin = req.headers['x-cloud-origin'];
    if (origin !== publicOrigin && !(development && /^http:\/\/127\.0\.0\.1:\d+$/.test(origin || ''))) throw new Fault(403, 'origin_forbidden');
    const value = active.get(id); if (!authorized(id) || !value || value.expiresAt <= Date.now()) throw new Fault(409, 'instance_not_ready');
    return { ...value, origin };
  }
  const server = createServer(async (req, res) => {
    try {
      if (req.url === '/healthz' && req.method === 'GET') {
        const health = await runtime.health?.() || { ready: !closing };
        return json(res, health.ready && !closing ? 200 : 503, health);
      }
      const match = /^\/v1\/instances\/([^/]+)\/(start|stop|purge|status|lease|proxy)(.*)$/.exec(req.url);
      if (!match) throw new Fault(404, 'not_found'); const id = instanceID(match[1]), action = match[2];
      if (closing) throw new Fault(503, 'agent_closing');
      if (action === 'status' && req.method === 'GET' && !match[3]) return json(res, 200, await runtime.status(id));
      if (action === 'lease' && req.method === 'POST' && !match[3]) { renew(id, await body(req)); return json(res, 200, { renewed: true, state: active.has(id) ? 'running' : 'stopped' }); }
      if (['start', 'stop', 'purge'].includes(action) && req.method === 'POST' && !match[3]) {
        const input = action === 'start' ? await body(req) : {};
        if (action === 'start' && requireLease) renew(id, input); else req.resume();
        const result = await serial(id, async () => {
          if (action === 'start') {
            if (!authorized(id)) throw new Fault(403, 'runtime_lease_expired');
            if (input.gateway !== undefined) {
              if (!runtime.configureGateway) throw new Fault(503, 'runtime_gateway_unsupported');
              await runtime.configureGateway(id, input.gateway);
            }
            const value = await runtime.start(id);
            if (!authorized(id)) { await runtime.stop(id); throw new Fault(403, 'runtime_lease_expired'); }
            active.set(id, value); return { state: 'running' };
          }
          deadlines.delete(id); active.delete(id); disconnect(id);
          if (action === 'purge') { await runtime.purge(id); return { state: 'deleted', data_retained: false }; }
          await runtime.stop(id); return { state: 'stopped', data_retained: true };
        });
        return json(res, 200, result);
      }
      if (action !== 'proxy') throw new Fault(404, 'not_found');
      const value = target(req, id), path = safePath(match[3] || '/');
      const pathname = path.split('?')[0];
      if (pathname === '/api/cloud/resources' && req.method === 'GET' && runtime.resources) return json(res, 200, { ...await runtime.resources(id), backups: { automatic_interval_hours: backupIntervalMs / 3600000 } });
      const backup = /^\/api\/cloud\/backups(?:\/([^/]+)(\/restore)?)?$/.exec(pathname);
      if (backup) {
        if (!runtime.backups) throw new Fault(503, 'backups_unavailable');
        const snapshot = backup[1] && instanceID(backup[1]);
        if (!snapshot && req.method === 'GET') return json(res, 200, runtime.backups.list(id));
        if (snapshot && !backup[2] && req.method === 'DELETE') {
          return json(res, 200, await serial(id, async () => { target(req, id); runtime.backups.remove(id, snapshot); return { deleted: true }; }));
        }
        if (req.method !== 'POST' || snapshot && !backup[2]) throw new Fault(405, 'method_not_allowed');
        const input = await body(req), key = instanceID(input.request_key);
        if (input.confirm !== true) throw new Fault(400, 'backup_confirmation_required');
        const result = await serial(id, async () => {
          target(req, id); active.delete(id); disconnect(id);
          try {
            await runtime.stop(id);
            if (snapshot) { await runtime.backups.restore(id, snapshot, key); return { restored: true }; }
            const row = await runtime.backups.create(id, key);
            return { id: row.id, state: row.state, created_at: row.created_at, bytes: row.bytes };
          } finally { if (authorized(id) && !closing) active.set(id, await runtime.start(id)); }
        });
        return json(res, 200, result);
      }
      const pinned = runtime.pinSocket?.(id);
      try {
        const outgoing = httpProxy(req, res, { socketPath: pinned?.socketPath || value.socketPath, path }, proxyHeaders(req, value.origin, value.token), track(id));
        outgoing.once('close', () => pinned?.release());
      } catch (e) { pinned?.release(); throw e; }
    } catch (e) { fail(res, e); }
  });
  server.on('upgrade', (req, socket, head) => {
    try {
      const match = /^\/v1\/instances\/([^/]+)\/proxy(\/.*)$/.exec(req.url); if (!match) throw new Fault(404, 'not_found');
      const id = instanceID(match[1]), value = target(req, id);
      const pinned = runtime.pinSocket?.(id);
      try {
        const upstream = wsProxy(wss, req, socket, head, { socketPath: pinned?.socketPath || value.socketPath, path: safePath(match[2]) }, proxyHeaders(req, value.origin, value.token), track(id));
        upstream.once('close', () => pinned?.release());
      } catch (e) { pinned?.release(); throw e; }
    } catch (e) { socket.end(`HTTP/1.1 ${e.status || 503} Rejected\r\nConnection: close\r\n\r\n`); }
  });
  await listen(server, socketPath);
  if (socketGroup !== undefined) { if (!Number.isSafeInteger(socketGroup) || socketGroup < 0) throw new Error('invalid socket group'); chownSync(socketPath, process.getuid(), socketGroup); }
  chmodSync(socketPath, socketGroup === undefined ? 0o600 : 0o660);
  const refreshing = new Set();
  const timer = setInterval(() => {
    for (const [id, value] of active) {
      if (value.expiresAt <= Date.now()) disconnect(id);
      if (value.expiresAt > Date.now() + 60000 || refreshing.has(id)) continue;
      refreshing.add(id);
      serial(id, async () => { if (!closing && authorized(id) && active.get(id) === value) active.set(id, await runtime.start(id)); })
        .catch(() => {}).finally(() => refreshing.delete(id));
    }
  }, credentialCheckMs); timer.unref();
  const watchdog = setInterval(() => {
    if (!requireLease) return;
    for (const [id, lease] of deadlines) if (!runLeaseValid(lease) && !fencing.has(id)) {
      fencing.add(id);
      serial(id, async () => { if (!authorized(id)) { active.delete(id); disconnect(id); await runtime.stop(id); deadlines.delete(id); } })
        .catch(() => {}).finally(() => fencing.delete(id));
    }
  }, 250); watchdog.unref();
  const backingUp = new Set();
  const backupTimer = setInterval(() => {
    if (!backupIntervalMs || !runtime.backups || backingUp.size) return;
    for (const id of active.keys()) if (authorized(id) && !backingUp.has(id) && runtime.backups.due(id, backupIntervalMs)) {
      backingUp.add(id);
      serial(id, async () => {
        if (closing || !authorized(id) || !active.has(id) || !runtime.backups.due(id, backupIntervalMs)) return;
        active.delete(id); disconnect(id);
        try { await runtime.stop(id); await runtime.backups.automatic(id, backupIntervalMs); }
        finally { if (authorized(id) && !closing) active.set(id, await runtime.start(id)); }
      }).catch(() => {}).finally(() => backingUp.delete(id));
      break;
    }
  }, 60000); backupTimer.unref();
  return { server, async close() {
    closing = true; clearInterval(timer); clearInterval(watchdog); clearInterval(backupTimer);
    for (const { kill } of streams) kill();
    await close(server); await Promise.allSettled([...queues.values()]); wss.close();
    const results = await Promise.allSettled([...new Set([...active.keys(), ...deadlines.keys()])].map(id => runtime.stop(id)));
    if (existsSync(socketPath)) unlinkSync(socketPath);
    await runtime.close?.();
    if (results.some(r => r.status === 'rejected')) throw new Error('agent shutdown could not fence every runtime');
  } };
}
