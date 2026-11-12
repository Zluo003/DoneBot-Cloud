import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { body, close, fail, Fault, json, listen, secret } from '../src/common.mjs';

export async function syntheticGateway({ clock = Date.now, monthMs = 31 * 86400000 } = {}) {
  const password = secret(), serviceToken = secret(), access = new Map(), refresh = new Map(), subscriptions = new Map();
  const users = new Map([['a', { id: 101, balance: 30_000_000n }], ['b', { id: 202, balance: 30_000_000n }], ['poor', { id: 303, balance: 0n }]]);
  const events = [], price = 10_000_000n;
  function credentials(user) { const a = secret(), r = secret(); access.set(a, user); refresh.set(r, user); return { access_token: a, refresh_token: r, expires_in: 3600 }; }
  const server = createServer(async (req, res) => {
    try {
      const path = req.url.replace('/api/v1/', ''), token = (req.headers.authorization || '').replace('Bearer ', ''), user = access.get(token);
      let result;
      if (path === 'auth/login') { const b = await body(req); const u = users.get(b.email); if (!u || b.password !== password) throw new Fault(401, 'invalid_login'); result = credentials(u); }
      else if (path === 'auth/me') { if (!user) throw new Fault(401, 'revoked'); result = { id: user.id, status: 'active' }; }
      else if (path === 'auth/refresh') { const b = await body(req); const u = refresh.get(b.refresh_token); if (!u) throw new Fault(401, 'revoked'); refresh.delete(b.refresh_token); result = credentials(u); }
      else if (path === 'auth/logout') { const b = await body(req); refresh.delete(b.refresh_token); result = { ok: true }; }
      else {
        if (req.headers['x-donebot-cloud-service'] !== serviceToken) throw new Fault(401, 'service_required');
        const m = /^donebot\/cloud\/billing\/instances\/([^/]+)\/(status|purchase|renew|activate|cancel)$/.exec(path); if (!m) throw new Fault(404, 'not_found');
        const [, id, action] = m;
        let s = subscriptions.get(id);
        if (action === 'status') result = s || { state: 'unpaid' };
        else {
          if (action === 'purchase' && (!user || s && s.user_id !== user.id)) throw new Fault(401, 'user_required');
          if (!s && action !== 'purchase') throw new Fault(404, 'not_found');
          if (action === 'purchase' || action === 'renew') {
            if (!s || s.state === 'cancelled' || Date.parse(s.paid_until) <= clock()) {
              const u = s ? [...users.values()].find(u => u.id === s.user_id) : user;
              if (action === 'renew' && ['cancelled', 'pending'].includes(s.state)) result = s;
              else if (u.balance < price) { if (action === 'purchase') throw new Fault(402, 'insufficient_balance'); s.state = 'past_due'; }
              else { u.balance -= price; s = { instance_id: id, user_id: u.id, state: action === 'purchase' ? 'pending' : 'active', paid_until: new Date(clock() + monthMs).toISOString(), cycle: (s?.cycle || 0) + 1 }; subscriptions.set(id, s); events.push({ id, cycle: s.cycle, event: 'charge' }); }
            }
          } else if (action === 'activate' && s.state === 'pending') s.state = 'active';
          else if (action === 'cancel' && s.state !== 'cancelled') { if (s.state === 'pending') { [...users.values()].find(u => u.id === s.user_id).balance += price; events.push({ id, cycle: s.cycle, event: 'refund' }); } s.state = 'cancelled'; }
          result = s;
        }
      }
      json(res, 200, { code: 0, data: result });
    } catch (e) { json(res, e.status || 500, { code: e.status || 500 }); }
  });
  const address = await listen(server, { host: '127.0.0.1', port: 0 });
  return { origin: `http://127.0.0.1:${address.port}`, serviceToken, password, users, events, subscriptions,
    revoke(name) { const u = users.get(name); for (const [t, v] of access) if (v === u) access.delete(t); for (const [t, v] of refresh) if (v === u) refresh.delete(t); },
    close: () => close(server) };
}

export class SyntheticRuntime {
  constructor(dir) { this.dir = dir; this.instances = new Map(); this.started = new Map(); this.failures = new Set(); this.failStops = new Set(); }
  async start(id) {
    if (this.failures.delete(id)) throw new Fault(503, 'injected_start_failure');
    const existing = this.instances.get(id); if (existing) return existing.target;
    mkdirSync(this.dir, { recursive: true }); const socketPath = join(this.dir, id + '.sock'), data = join(this.dir, id + '.json'), token = secret();
    if (existsSync(socketPath)) unlinkSync(socketPath);
    const server = createServer(async (req, res) => {
      try {
        if (req.headers.authorization !== `Bearer ${token}`) throw new Fault(401, 'instance_auth_required');
        if (req.url === '/api/value') {
          if (req.method === 'POST') writeFileSync(data, JSON.stringify(await body(req)));
          return json(res, 200, existsSync(data) ? JSON.parse(readFileSync(data)) : {});
        }
        if (req.url === '/api/headers') return json(res, 200, { forwarded: req.headers['x-forwarded-for'] || null, impersonation: req.headers['x-user-id'] || null, cookie: req.headers.cookie || null, hasBearer: !!req.headers.authorization });
        if (req.url === '/api/stream') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: connected\n\n'); return; }
        throw new Fault(404, 'not_found');
      } catch (e) { fail(res, e); }
    });
    const wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => { if (req.headers.authorization !== `Bearer ${token}`) return socket.destroy(); wss.handleUpgrade(req, socket, head, ws => ws.on('message', (v, binary) => ws.send(v, { binary }))); });
    await listen(server, socketPath);
    const target = { socketPath, token, expiresAt: Date.now() + 86400000 };
    this.instances.set(id, { server, wss, target }); this.started.set(id, (this.started.get(id) || 0) + 1); return target;
  }
  async stop(id) { if (this.failStops.delete(id)) throw new Fault(503, 'injected_stop_failure'); const s = this.instances.get(id); if (!s) return; for (const c of s.wss.clients) c.terminate(); s.wss.close(); await close(s.server); this.instances.delete(id); }
  async status(id) { return { state: this.instances.has(id) ? 'running' : 'stopped' }; }
  async purge(id) { await this.stop(id); const path = join(this.dir, id + '.json'); if (existsSync(path)) unlinkSync(path); }
  async close() { for (const id of this.instances.keys()) await this.stop(id); }
}
