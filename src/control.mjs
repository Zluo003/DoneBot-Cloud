import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Fault, body, close, fail, hash, instanceID, json, listen, secret, socketJSON } from './common.mjs';
import { Store } from './store.mjs';
import { httpProxy, proxyHeaders, safePath, wsProxy, wsServer } from './proxy.mjs';

export async function createControl({ stateDir, agentSocket, gateway, host = '127.0.0.1', port = 0, publicOrigin, intervalMs = 5000, now = Date.now }) {
  const store = new Store(stateDir), holder = randomUUID(), connections = new Set(), queues = new Map(), verification = new Map();
  store.acquire(holder);
  let stopped = false, origin = publicOrigin, ticking = false;
  const wss = wsServer();
  const agent = (id, action) => socketJSON(agentSocket, `/v1/instances/${instanceID(id)}/${action}`, action === 'status' ? 'GET' : 'POST', action === 'status' ? undefined : {});
  function disconnect(predicate) { for (const item of connections) if (predicate(item)) { connections.delete(item); item.kill(); } }
  function track(session, id) { return kill => { const item = { session, id, kill }; connections.add(item); return () => connections.delete(item); }; }
  function source(req) {
    if (req.headers.origin && req.headers.origin !== origin) throw new Fault(403, 'origin_forbidden');
    const bearer = /^Bearer ([A-Za-z0-9_-]+)$/.exec(req.headers.authorization || '')?.[1];
    const cookie = /(?:^|;\s*)cloud_session=([A-Za-z0-9_-]+)(?:;|$)/.exec(req.headers.cookie || '')?.[1];
    if (!bearer && cookie && (req.headers.upgrade || !['GET', 'HEAD'].includes(req.method)) && req.headers.origin !== origin) throw new Fault(403, 'origin_required');
    return bearer || cookie;
  }
  async function verify(session) {
    if (!verification.has(session.hash)) verification.set(session.hash, (async () => {
      try {
        const credentials = await gateway.verify(session);
        const live = store.get('SELECT * FROM sessions WHERE hash=? AND expires_at>?', session.hash, now());
        if (!live) throw new Fault(401, 'login_required');
        store.run('UPDATE sessions SET credentials=? WHERE hash=?', store.vault.seal(credentials), session.hash);
        return { ...session, credentials };
      } catch (e) {
        if (e.status === 401 || e.status === 403) store.run('DELETE FROM sessions WHERE hash=?', session.hash);
        disconnect(c => c.session === session.hash); throw e;
      } finally { verification.delete(session.hash); }
    })());
    return verification.get(session.hash);
  }
  async function auth(req) { return verify(store.session(source(req))); }
  function entitlement(row) {
    if (row.paid_until <= now() || row.subscription_state !== 'active') throw new Fault(402, 'subscription_inactive');
    if (row.desired !== 'running' || row.actual !== 'running') throw new Fault(409, 'instance_not_running');
  }
  function updateSubscription(id, sub) {
    const until = Date.parse(sub?.paid_until);
    if (!['unpaid', 'pending', 'active', 'past_due', 'cancelled'].includes(sub?.state) || (sub.state !== 'unpaid' && !Number.isFinite(until))) throw new Fault(502, 'invalid_subscription');
    store.run('UPDATE instances SET paid_until=?,subscription_state=? WHERE id=?', Number.isFinite(until) ? until : 0, sub.state, id);
    return sub;
  }
  function enqueue(id, task) {
    const pending = (queues.get(id) || Promise.resolve()).catch(() => {}).then(task);
    queues.set(id, pending); pending.finally(() => { if (queues.get(id) === pending) queues.delete(id); }).catch(() => {});
    return pending;
  }
  async function apply(op) {
    if (stopped) return;
    if (store.get('SELECT state FROM operations WHERE id=?', op.id)?.state === 'succeeded') return;
    store.run("UPDATE operations SET state='running',error=NULL WHERE id=?", op.id);
    try {
      if (op.action === 'start') {
        let sub = updateSubscription(op.instance_id, await gateway.subscription(op.instance_id));
        if (sub.state === 'unpaid' || sub.state === 'cancelled') {
          const row = store.get('SELECT * FROM sessions WHERE hash=? AND expires_at>?', op.session_hash, now());
          if (!row) throw new Fault(401, 'login_required_for_purchase');
          const session = await verify({ ...row, credentials: store.vault.open(row.credentials) });
          sub = updateSubscription(op.instance_id, await gateway.subscription(op.instance_id, 'purchase', session.credentials.accessToken));
        } else if (Date.parse(sub.paid_until) <= now()) sub = updateSubscription(op.instance_id, await gateway.subscription(op.instance_id, 'renew'));
        if (!['active', 'pending'].includes(sub.state) || Date.parse(sub.paid_until) <= now()) throw new Fault(402, 'insufficient_balance');
        store.run("UPDATE instances SET actual='starting',error=NULL WHERE id=?", op.instance_id);
        await agent(op.instance_id, 'start');
        updateSubscription(op.instance_id, await gateway.subscription(op.instance_id, 'activate'));
        store.run("UPDATE instances SET actual='running',error=NULL WHERE id=?", op.instance_id);
      } else {
        disconnect(c => c.id === op.instance_id);
        await agent(op.instance_id, 'stop');
        if (op.action === 'cancel') updateSubscription(op.instance_id, await gateway.subscription(op.instance_id, 'cancel'));
        store.run("UPDATE instances SET actual='stopped',error=NULL WHERE id=?", op.instance_id);
      }
      store.run("UPDATE operations SET state='succeeded',error=NULL WHERE id=?", op.id);
    } catch (e) {
      store.run("UPDATE operations SET state='failed',error=? WHERE id=?", e.code || 'operation_failed', op.id);
      store.run("UPDATE instances SET actual='error',error=? WHERE id=?", e.code || 'operation_failed', op.instance_id);
      disconnect(c => c.id === op.instance_id);
    }
  }
  function operation(row, action, key, session) {
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(key)) throw new Fault(400, 'idempotency_key_required');
    const op = store.transaction(() => {
      const old = store.get('SELECT * FROM operations WHERE instance_id=? AND request_key=?', row.id, key);
      if (old) { if (old.action !== action) throw new Fault(409, 'idempotency_conflict'); return old; }
      const id = randomUUID();
      store.run("INSERT INTO operations VALUES(?,?,?,?, 'pending',NULL,?,?)", id, row.id, key, action, now(), session.hash);
      store.run("UPDATE instances SET desired=?,actual='reconciling',error=NULL WHERE id=?", action === 'start' ? 'running' : 'stopped', row.id);
      return store.get('SELECT * FROM operations WHERE id=?', id);
    });
    if (op.state === 'pending') enqueue(row.id, () => apply(op));
    if (action !== 'start') disconnect(c => c.id === row.id);
    const { session_hash, ...out } = op; return out;
  }
  const server = createServer(async (req, res) => {
    try {
      const path = req.url.split('?')[0];
      if (path === '/healthz' && req.method === 'GET') return json(res, 200, { app: 'donebot-cloud', ready: !stopped });
      if (['/v1/login', '/v1/login/2fa'].includes(path) && req.method === 'POST') {
        source(req); const credentials = await gateway.login(await body(req), path.endsWith('/2fa'));
        if (credentials.requires_2fa) return json(res, 200, credentials);
        const owner = await gateway.identity(credentials.accessToken), token = secret();
        store.run('INSERT INTO sessions VALUES(?,?,?,?)', hash(token), owner, store.vault.seal(credentials), now() + 86400000);
        res.setHeader('set-cookie', `cloud_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400${origin.startsWith('https:') ? '; Secure' : ''}`);
        return json(res, 200, { token, user_id: owner });
      }
      const session = await auth(req);
      if (['/v1/logout', '/api/auth/logout'].includes(path) && req.method === 'POST') {
        store.run('DELETE FROM sessions WHERE hash=?', session.hash); disconnect(c => c.session === session.hash);
        await gateway.call('auth/logout', 'POST', { refresh_token: session.credentials.refreshToken }).catch(() => {});
        res.setHeader('set-cookie', 'cloud_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0'); return json(res, 200, { ok: true });
      }
      if (path === '/v1/me' && req.method === 'GET') return json(res, 200, { user_id: session.owner });
      if (path === '/v1/instances' && req.method === 'GET') return json(res, 200, { instances: store.all('SELECT * FROM instances WHERE owner=?', session.owner) });
      if (path === '/v1/instances' && req.method === 'POST') {
        if (Object.keys(await body(req)).length) throw new Fault(400, 'unexpected_parameters');
        // The only owner accepted is the identity returned by the gateway.
        const row = store.transaction(() => { store.run("INSERT OR IGNORE INTO instances VALUES(?,?,'stopped','stopped',NULL,0,'unpaid',?)", randomUUID(), session.owner, now()); return store.get('SELECT * FROM instances WHERE owner=?', session.owner); });
        return json(res, 202, { instance: row, operation: operation(row, 'start', req.headers['idempotency-key'], session) });
      }
      const match = /^\/v1\/instances\/([^/]+)(?:\/(start|stop|cancel|operations|proxy)(\/.*)?)?$/.exec(path);
      if (!match) {
        if (path.startsWith('/v1/')) throw new Fault(404, 'not_found');
        const row = store.get('SELECT * FROM instances WHERE owner=?', session.owner);
        if (!row) throw new Fault(404, 'instance_not_found'); entitlement(row);
        const headers = proxyHeaders(req, origin); headers['x-cloud-origin'] = origin;
        return httpProxy(req, res, { socketPath: agentSocket, path: `/v1/instances/${row.id}/proxy${safePath(req.url)}` }, headers, track(session.hash, row.id));
      }
      const id = instanceID(match[1]), row = store.owned(id, session.owner), action = match[2];
      if (!action && req.method === 'GET') return json(res, 200, row);
      if (action === 'operations' && req.method === 'GET') return json(res, 200, { operations: store.all('SELECT id,instance_id,request_key,action,state,error,created_at FROM operations WHERE instance_id=? ORDER BY created_at', id) });
      if (['start', 'stop', 'cancel'].includes(action) && req.method === 'POST') {
        if (Object.keys(await body(req)).length) throw new Fault(400, 'unexpected_parameters');
        return json(res, 202, { operation: operation(row, action, req.headers['idempotency-key'], session) });
      }
      if (action === 'proxy') {
        entitlement(row); const tail = safePath(req.url.slice(req.url.indexOf('/proxy') + 6) || '/');
        const headers = proxyHeaders(req, origin); headers['x-cloud-origin'] = origin;
        return httpProxy(req, res, { socketPath: agentSocket, path: `/v1/instances/${id}/proxy${tail}` }, headers, track(session.hash, id));
      }
      throw new Fault(404, 'not_found');
    } catch (e) { fail(res, e); }
  });
  server.on('upgrade', async (req, socket, head) => {
    try {
      const session = await auth(req), match = /^\/v1\/instances\/([^/]+)\/proxy(\/.*)$/.exec(req.url);
      const own = match ? store.owned(instanceID(match[1]), session.owner) : !req.url.startsWith('/v1/') ? store.get('SELECT * FROM instances WHERE owner=?', session.owner) : null;
      if (!own) throw new Fault(404, 'not_found'); const id = own.id; entitlement(own);
      const headers = proxyHeaders(req, origin); headers['x-cloud-origin'] = origin;
      wsProxy(wss, req, socket, head, { socketPath: agentSocket, path: `/v1/instances/${id}/proxy${safePath(match ? match[2] : req.url)}` }, headers, track(session.hash, id));
    } catch (e) { socket.end(`HTTP/1.1 ${e.status || 503} Rejected\r\nConnection: close\r\n\r\n`); }
  });
  const address = await listen(server, { host, port }); origin ||= `http://${host}:${address.port}`;
  async function tick() {
    if (stopped || ticking) return; ticking = true;
    try {
      store.acquire(holder);
      for (const c of [...connections]) {
        const row = store.get('SELECT * FROM instances WHERE id=?', c.id);
        try { entitlement(row); const s = store.get('SELECT * FROM sessions WHERE hash=? AND expires_at>?', c.session, now()); if (!s) throw new Fault(401, 'login_required'); await verify({ ...s, credentials: store.vault.open(s.credentials) }); }
        catch { disconnect(item => item === c); }
      }
      for (const row of store.all('SELECT * FROM instances')) {
        if (queues.has(row.id)) continue;
        await enqueue(row.id, async () => {
          try {
            let sub = updateSubscription(row.id, await gateway.subscription(row.id));
            if (['active', 'past_due'].includes(sub.state) && Date.parse(sub.paid_until) <= now()) sub = updateSubscription(row.id, await gateway.subscription(row.id, 'renew'));
            if (Date.parse(sub.paid_until) <= now() || !['active', 'pending'].includes(sub.state)) {
              disconnect(c => c.id === row.id); await agent(row.id, 'stop');
              store.run("UPDATE instances SET actual='stopped' WHERE id=?", row.id); return;
            }
            if (row.desired === 'running') {
              await agent(row.id, 'start');
              updateSubscription(row.id, await gateway.subscription(row.id, 'activate'));
              store.run("UPDATE instances SET actual='running',error=NULL WHERE id=?", row.id);
            } else { await agent(row.id, 'stop'); store.run("UPDATE instances SET actual='stopped',error=NULL WHERE id=?", row.id); }
          } catch (e) {
            disconnect(c => c.id === row.id);
            store.run("UPDATE instances SET actual='error',error=? WHERE id=?", e.code || 'reconciliation_failed', row.id);
            // Expiry is enforced locally even while the billing service is down.
            if (store.get('SELECT paid_until FROM instances WHERE id=?', row.id).paid_until <= now()) await agent(row.id, 'stop').catch(() => {});
          }
        });
      }
    } finally { ticking = false; }
  }
  store.run("UPDATE instances SET actual='reconciling'");
  for (const op of store.all("SELECT * FROM operations WHERE state IN ('pending','running') ORDER BY created_at,rowid")) enqueue(op.instance_id, () => apply(op));
  await tick();
  const timer = setInterval(() => tick().catch(() => { stopped = true; disconnect(() => true); server.close(); }), intervalMs); timer.unref();
  const leaseTimer = setInterval(() => { try { store.acquire(holder); } catch { stopped = true; disconnect(() => true); server.close(); } }, 5000); leaseTimer.unref();
  return { server, store, origin, tick, async close() { stopped = true; clearInterval(timer); clearInterval(leaseTimer); disconnect(() => true); await close(server); await Promise.allSettled([...queues.values()]); store.run('DELETE FROM lease WHERE holder=?', holder); store.close(); wss.close(); } };
}
