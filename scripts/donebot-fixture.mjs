import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { openSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { Fault, close, listen } from '../src/common.mjs';
import { httpProxy, wsProxy, wsServer } from '../src/proxy.mjs';

export class DoneBotFixtureRuntime {
  constructor(dir, source = '/Users/zluo/Dev/DoneBot', { staticDir, gatewayOrigin, onGateway } = {}) { this.dir = dir; this.source = resolve(source); this.staticDir = staticDir; this.gatewayOrigin = gatewayOrigin; this.onGateway = onGateway; this.gateways = new Map(); this.instances = new Map(); }
  configureGateway(id, value) { if (value.installationId !== id) throw new Fault(400, 'fixture_gateway_scope'); this.gateways.set(id, value); this.onGateway?.(value); }
  async start(id) {
    let entry = this.instances.get(id);
    if (entry?.running) return entry.target;
    const control = await import(pathToFileURL(join(this.source, 'scripts/control-omb.ts')).href);
    if (!entry) {
      const fixture = await control.launchVerificationServer({ DONEBOT_DEV_TRUST_LOCAL_BROWSER: '0' }, undefined, undefined, undefined, undefined, undefined, [], undefined, this.staticDir, this.gatewayOrigin, this.gateways.get(id));
      entry = { fixture, child: fixture.child, port: Number(new URL(fixture.info.url).port) }; this.instances.set(id, entry);
    } else {
      const log = openSync(entry.fixture.info.logPath, 'a', 0o600);
      const env = control.verificationServerEnvironment({ DONEBOT_DEV_TRUST_LOCAL_BROWSER: '0' }, entry.fixture.info.dataDir, entry.port);
      if (this.staticDir) env.DONEBOT_STATIC_DIR = this.staticDir;
      if (this.gatewayOrigin) Object.assign(env, { DONEBOT_UPSTREAM_FIXTURE: '0', DONEBOT_FIXTURE_ORIGIN: this.gatewayOrigin });
      if (this.gateways.has(id)) env.DONEBOT_CLOUD_CREDENTIAL_FILE = join(entry.fixture.info.dataDir, 'fixture-cloud-gateway.json');
      entry.child = spawn(process.execPath, control.verificationServerArgs(env), { cwd: this.source, env, stdio: ['ignore', log, log] }); closeSync(log);
    }
    const deadline = Date.now() + 30000;
    while (true) {
      try { const r = await fetch(entry.fixture.info.url + '/api/health', { signal: AbortSignal.timeout(1000) }); if (r.ok && (await r.json()).app === 'donebot') break; } catch {}
      if (Date.now() > deadline || entry.child.exitCode !== null) throw new Fault(504, 'fixture_start_failed');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const call = async (path, value) => { const r = await fetch(entry.fixture.info.url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value), signal: AbortSignal.timeout(5000) }); if (!r.ok) throw new Fault(502, 'fixture_pairing_failed'); return r.json(); };
    const p = await call('/api/auth/pairing', { scopes: ['admin', 'client'], tokenTtlMs: 86400000, label: 'Cloud fixture' });
    const s = await call('/api/auth/pair', { code: p.code, label: 'Cloud fixture' });
    const socketPath = join(this.dir, id + '.sock');
    const headers = req => ({ ...req.headers, host: 'cloud-fixture.internal', ...(req.headers.origin ? { origin: 'http://cloud-fixture.internal' } : {}), 'x-forwarded-for': '192.0.2.1' });
    entry.wss = wsServer();
    entry.shim = createServer((req, res) => httpProxy(req, res, { hostname: '127.0.0.1', port: entry.port, path: req.url }, headers(req)));
    entry.shim.on('upgrade', (req, socket, head) => wsProxy(entry.wss, req, socket, head, { hostname: '127.0.0.1', port: entry.port, path: req.url }, headers(req)));
    await listen(entry.shim, socketPath); entry.running = true;
    entry.target = { socketPath, token: s.token, expiresAt: s.session.expiresAt }; return entry.target;
  }
  async stop(id) {
    const e = this.instances.get(id); if (!e?.running) return;
    await close(e.shim);
    e.wss.close();
    if (e.child.exitCode === null) {
      const exited = once(e.child, 'exit'); e.child.kill('SIGTERM');
      const timer = setTimeout(() => e.child.kill('SIGKILL'), 15000); timer.unref(); await exited; clearTimeout(timer);
    }
    e.running = false;
  }
  async status(id) { return { state: this.instances.get(id)?.running ? 'running' : 'stopped' }; }
  async close() { for (const [id, entry] of this.instances) { await this.stop(id); await entry.fixture.close(); } }
}
