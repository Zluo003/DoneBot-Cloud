import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, request } from 'node:http';
import { chmodSync, chownSync, closeSync, fstatSync, mkdirSync, openSync, rmSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { BoundedDisks } from './storage.mjs';
import { Backups } from './backups.mjs';
import { Egress } from './egress.mjs';
import { Store } from './store.mjs';
import { Fault, body, close, fail, instanceID, json, listen, privateDir } from './common.mjs';

const execute = promisify(execFile), CUA = '/usr/local/libexec/donebot/cua-driver', CUA_SOCKET = '/run/user/1000/donebot-cua.sock';
const readFile = `import os,sys,stat,struct
root='/home/cua/workspace'
path=os.path.normpath(sys.argv[1])
if not path.startswith(root+'/'): sys.exit(2)
fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
s=os.fstat(fd)
if not stat.S_ISREG(s.st_mode) or s.st_size>100*1024*1024 or not os.path.realpath('/proc/self/fd/'+str(fd)).startswith(root+'/'): sys.exit(2)
sys.stdout.buffer.write(struct.pack('>Q',s.st_size));sys.stdout.buffer.flush()
with os.fdopen(fd,'rb') as f:
 while True:
  data=f.read(65536)
  if not data: break
  sys.stdout.buffer.write(data)`;
const BASE = 'sha256:274eb636f5cf3fc58f705916ee72b7a701270b3877369d08533a385c5325be9b';
const init = `set -eu
mkdir -p /run/user/1000 /var/log/supervisor
chown 1000:1000 /run/user/1000
chmod 700 /run/user/1000
exec /usr/bin/supervisord -c /etc/supervisor/supervisord.conf`;
const viewerBridge = `import socket,select,threading,os
path='/run/donebot-desktop/viewer.sock'
try: os.unlink(path)
except FileNotFoundError: pass
listener=socket.socket(socket.AF_UNIX);listener.bind(path);os.chmod(path,0o600);listener.listen(8)
def relay(client):
 peer=socket.socket()
 try:
  peer.connect(('127.0.0.1',6901))
  while True:
   ready,_,_=select.select([client,peer],[],[],60)
   if not ready: continue
   for source in ready:
    data=source.recv(65536)
    if not data: return
    (peer if source is client else client).sendall(data)
 except OSError: pass
 finally: client.close();peer.close()
while True:
 client,_=listener.accept();threading.Thread(target=relay,args=(client,),daemon=True).start()`;

export class CloudDesktops {
  constructor(host, { image, bytes, idleMs = 30 * 60000, egressDNS, egressDenyIPv4, nftBinary }) {
    if (!/^(?:[a-zA-Z0-9./:_-]+@)?sha256:[a-f0-9]{64}$/.test(image || '')) throw new Error('desktop requires immutable reviewed image');
    if (!Number.isSafeInteger(idleMs) || idleMs < 1000 || idleMs > 86400000) throw new Error('invalid desktop idle timeout');
    this.host = host; this.image = image; this.idleMs = idleMs;
    this.dir = privateDir(join(host.stateDir, 'desktops')); this.store = new Store(join(this.dir, 'metadata'));
    this.store.db.exec('CREATE TABLE IF NOT EXISTS desktops(id TEXT PRIMARY KEY,password TEXT NOT NULL)');
    this.disks = new BoundedDisks({ stateDir: this.dir, store: this.store, bytes, owner: 1000 });
    this.backups = new Backups({ stateDir: this.dir, store: this.store, disks: this.disks });
    this.egress = host.egress ? new Egress({ namespace: host.namespace, store: this.store, dns: egressDNS, denyIPv4: egressDenyIPv4, binary: nftBinary }) : null;
    // A different table and bridge per desktop; the runtime and desktop never share a network.
    if (this.egress) { this.egress.table += '_d'; this.egress.owner += ':desktop'; const bridge = this.egress.bridge.bind(this.egress); this.egress.bridge = id => 'dcd' + bridge(id).slice(3); }
    this.servers = new Map(); this.queues = new Map(); this.streams = new Set(); this.lastUsed = new Map(); this.busy = new Map(); this.allowed = () => false;
    this.stopping = new Set();
    this.timer = setInterval(() => {
      for (const [id, at] of this.lastUsed) {
        if (this.allowed(id) && (this.busy.get(id) || Date.now() - at <= this.idleMs)) continue;
        this.disconnect(id);
        if (this.stopping.has(id)) continue;
        this.stopping.add(id);
        void this.serial(id, () => this.stop(id)).catch(() => {}).finally(() => this.stopping.delete(id));
      }
    }, 250); this.timer.unref();
  }
  names(id) { instanceID(id); const prefix = this.host.names(id).container + '-desktop'; return { container: prefix, volume: prefix + '-home', network: prefix + '-net', edge: join(this.dir, id), bridge: this.egress?.bridge(id) }; }
  labels(id) { return { ...this.host.labels(id), 'cn.donebot.cloud.role': 'desktop' }; }
  serial(id, fn) { const next = (this.queues.get(id) || Promise.resolve()).catch(() => {}).then(fn); this.queues.set(id, next); return next; }
  authorize(id) { if (!this.allowed(id)) throw new Fault(403, 'desktop_runtime_lease_expired'); }
  touch(id) { this.lastUsed.set(id, Date.now()); }
  claim(id) {
    this.authorize(id); if ((this.busy.get(id) || 0) >= 4) throw new Fault(429, 'desktop_busy');
    this.busy.set(id, (this.busy.get(id) || 0) + 1); let closed = false;
    return () => { if (!closed) { closed = true; this.busy.set(id, this.busy.get(id) - 1); } };
  }
  async hold(id, task, activity = true) { const release = this.claim(id); if (activity) this.touch(id); try { return await task(); } finally { if (activity) this.touch(id); release(); } }
  checkLabels(value, id) { for (const [k, v] of Object.entries(this.labels(id))) if ((value?.Config?.Labels || value?.Labels || {})[k] !== v) throw new Fault(409, 'desktop_resource_ownership_mismatch'); }
  checkVolume(value, id) { this.checkLabels(value, id); const expected = this.disks.options(id); if (value.Driver !== 'local' || JSON.stringify(Object.entries(value.Options || {}).sort()) !== JSON.stringify(Object.entries(expected).sort())) throw new Fault(409, 'desktop_storage_mismatch'); this.disks.check(id); }
  networkOptions(id) { return { 'com.docker.network.bridge.name': this.egress.bridge(id), 'com.docker.network.bridge.enable_icc': 'false', 'com.docker.network.bridge.enable_ip_masquerade': 'true' }; }
  checkNetwork(value, id) {
    this.checkLabels(value, id);
    const expected = this.networkOptions(id), address = value.IPAM?.Config?.[0]?.Subnet;
    if (value.Driver !== 'bridge' || value.Internal || value.EnableIPv6 || value.Ingress || value.IPAM?.Config?.length !== 1 || !/^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)/.test(address || '') || JSON.stringify(Object.entries(value.Options || {}).sort()) !== JSON.stringify(Object.entries(expected).sort()) || Object.values(value.Containers || {}).some(c => c.Name !== this.names(id).container)) throw new Fault(409, 'desktop_network_mismatch');
  }
  check(value, id) {
    this.checkLabels(value, id); const h = value.HostConfig, n = this.names(id), mounts = value.Mounts.filter(m => m.Type !== 'tmpfs');
    const network = this.egress ? n.network : 'none';
    const tmpfs = { '/tmp': 'rw,nosuid,nodev,size=256m,mode=1777', '/run': 'rw,nosuid,nodev,size=16m,mode=755', '/var/log': 'rw,nosuid,nodev,size=64m,mode=755' };
    if (value.Config.Hostname !== 'donebot-desktop' || h.ExtraHosts?.join(',') !== 'donebot-desktop:127.0.0.1') throw new Fault(409, 'desktop_resource_spec_mismatch');
    if (JSON.stringify(value.Config.Entrypoint) !== '["/bin/sh"]' || JSON.stringify(value.Config.Cmd) !== JSON.stringify(['-c', init]) || !value.Config.Env.includes('VNC_PW=' + this.password(id)) || h.ShmSize !== 512 * 1024 ** 2 || mounts.some(m => !m.RW) || Object.entries(tmpfs).some(([key, expected]) => h.Tmpfs?.[key] !== expected)) throw new Fault(409, 'desktop_resource_spec_mismatch');
    if (value.Config.Image !== this.image || value.Config.User !== '0:0' || !h.ReadonlyRootfs || h.Privileged || h.Memory !== 2147483648 || h.MemorySwap !== 2147483648 || h.NanoCpus !== 1e9 || h.PidsLimit !== 512 || h.CapDrop?.join(',') !== 'ALL' || (h.CapAdd || []).map(cap => cap.replace(/^CAP_/, '')).sort().join(',') !== 'CHOWN,DAC_OVERRIDE,FOWNER,SETGID,SETUID' || !h.SecurityOpt?.includes('no-new-privileges') || h.NetworkMode !== network || Object.keys(value.NetworkSettings.Networks).some(name => name !== network) || Object.keys(h.PortBindings || {}).length || mounts.length !== 2 || !mounts.some(m => m.Type === 'volume' && m.Name === n.volume && m.Destination === '/home/cua') || !mounts.some(m => m.Type === 'bind' && m.Source === n.edge && m.Destination === '/run/donebot-desktop') || h.RestartPolicy?.Name !== 'no' || h.PidMode || h.IpcMode !== 'private' || h.CgroupnsMode !== 'private' || h.Devices?.length || h.DeviceRequests?.length || Object.keys(h.Tmpfs || {}).sort().join(',') !== '/run,/tmp,/var/log' || (this.egress && h.Dns.join(',') !== this.egress.dns.join(','))) throw new Fault(409, 'desktop_resource_spec_mismatch');
  }
  async imageReady() {
    const image = await this.host.inspect('image', this.image);
    const labels = image?.Config?.Labels || {};
    return !!image && labels['com.donebot.local-vm'] === '1' && labels['com.donebot.cua-driver'] === '0.37.0' && labels['com.donebot.cua-base'] === BASE && labels['com.donebot.image-layer'] === '8';
  }
  async status(id) {
    const n = this.names(id), value = await this.host.inspect('container', n.container); if (value) this.check(value, id);
    const image = await this.imageReady(), running = !!value?.State.Running;
    let ready = false;
    if (running) { try { await this.host.docker(['container', 'exec', '-u', '1000:1000', n.container, CUA, 'call', 'get_desktop_state', '{}', '--socket', CUA_SOCKET, '--screenshot-out-file', '/tmp/dbc-ready.png']); ready = true; } catch {} }
    const state = !value ? 'missing' : running ? 'running' : 'stopped';
    return { cloud_managed: true, idle_timeout_ms: this.idleMs, platform: 'linux', runtime: 'docker', available: ['docker'], daemonUp: true, image, imageMatches: !value || value.Config.Image === this.image, managed: !!value, container: state, network: 'loopback', security: 'hardened', persistence: 'durable', desktopReady: ready, desktop_error: null, stopped_at: value?.State.FinishedAt || null, resumable: !!value && !running && image, create_supported: image, ready, problem: !image ? 'Cloud desktop image unavailable' : ready ? null : state === 'missing' ? 'Create the Cloud desktop' : state === 'stopped' ? 'The Cloud desktop is stopped' : 'Cloud desktop is starting', image_ref: this.image, image_id: this.image, base_image_ref: BASE, driver_version: '0.37.0', container_name: 'cloud-private-desktop', target_key: 'shared', workspace_path: '', workspace_guest_path: '/home/cua/workspace', viewer_port: null, viewer_url: running ? 'http://cloud-desktop.invalid/#password=' + this.password(id) : '' };
  }
  password(id) { const row = this.store.get('SELECT password FROM desktops WHERE id=?', id); return row ? this.store.vault.open(row.password) : ''; }
  async ensureStorage(id) {
    const n = this.names(id), labels = Object.entries(this.labels(id)).flatMap(([k, v]) => ['--label', k + '=' + v]);
    let volume = await this.host.inspect('volume', n.volume); if (volume) this.checkLabels(volume, id);
    this.backups.recover(id); await this.disks.ensure(id, !!volume);
    if (!volume) { await this.host.docker(['volume', 'create', '--driver', 'local', ...Object.entries(this.disks.options(id)).flatMap(([k, v]) => ['--opt', k + '=' + v]), ...labels, n.volume]); volume = await this.host.inspect('volume', n.volume); }
    this.checkVolume(volume, id);
  }
  async start(id) {
    this.authorize(id); if (!await this.imageReady()) throw new Fault(503, 'desktop_image_unavailable');
    const n = this.names(id), labels = Object.entries(this.labels(id)).flatMap(([k, v]) => ['--label', k + '=' + v]);
    let value = await this.host.inspect('container', n.container); if (value) this.check(value, id);
    await this.ensureStorage(id);
    if (this.egress) {
      await this.egress.update(id, true); let network = await this.host.inspect('network', n.network);
      if (!network) { await this.host.docker(['network', 'create', '--driver', 'bridge', ...Object.entries(this.networkOptions(id)).flatMap(([k, v]) => ['--opt', k + '=' + v]), ...labels, n.network]); network = await this.host.inspect('network', n.network); }
      this.checkNetwork(network, id);
    }
    if (!this.store.get('SELECT id FROM desktops WHERE id=?', id)) this.store.run('INSERT INTO desktops VALUES(?,?)', id, this.store.vault.seal(randomBytes(18).toString('base64url')));
    mkdirSync(n.edge, { mode: 0o700, recursive: true }); chownSync(n.edge, 1000, 1000);
    if (!value) {
      await this.host.docker(['container', 'create', '--name', n.container, ...labels, '--user', '0:0', '--hostname', 'donebot-desktop', '--add-host', 'donebot-desktop:127.0.0.1', '--read-only', '--cap-drop', 'ALL', ...['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETGID', 'SETUID'].flatMap(cap => ['--cap-add', cap]), '--security-opt', 'no-new-privileges', '--memory', '2g', '--memory-swap', '2g', '--cpus', '1', '--pids-limit', '512', '--shm-size', '512m', '--ipc', 'private', '--cgroupns', 'private', '--network', this.egress ? n.network : 'none', ...(this.egress ? this.egress.dns.flatMap(ip => ['--dns', ip]) : []), '--restart', 'no', '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m,mode=1777', '--tmpfs', '/run:rw,nosuid,nodev,size=16m,mode=755', '--tmpfs', '/var/log:rw,nosuid,nodev,size=64m,mode=755', '--mount', `type=volume,src=${n.volume},dst=/home/cua`, '--mount', `type=bind,src=${n.edge},dst=/run/donebot-desktop`, '--env', 'VNC_PW=' + this.password(id), '--entrypoint', '/bin/sh', this.image, '-c', init]);
      value = await this.host.inspect('container', n.container); this.check(value, id);
    }
    this.authorize(id);
    this.touch(id);
    if (!value.State.Running) {
      await this.host.docker(['container', 'start', n.container]);
      await this.host.docker(['container', 'exec', '-d', '-u', '1000:1000', n.container, '/opt/venv/bin/python', '-c', viewerBridge]);
    }
    const until = Date.now() + 90000;
    while (Date.now() < until) { this.authorize(id); if ((await this.status(id)).ready) return; await new Promise(r => setTimeout(r, 500)); }
    throw new Fault(504, 'desktop_health_timeout');
  }
  disconnect(id) { for (const stream of this.streams) if (stream.id === id) { stream.kill(); this.streams.delete(stream); } }
  async stop(id) { this.disconnect(id); this.lastUsed.delete(id); const n = this.names(id), value = await this.host.inspect('container', n.container); if (value) { this.check(value, id); if (value.State.Running) await this.host.docker(['container', 'stop', '--time', '10', n.container]); } }
  async remove(id) { await this.stop(id); const n = this.names(id), value = await this.host.inspect('container', n.container); if (value) { this.check(value, id); await this.host.docker(['container', 'rm', n.container]); } }
  async prepareUpgrade(id, previousImage) {
    if (!/^(?:[a-zA-Z0-9./:_-]+@)?sha256:[a-f0-9]{64}$/.test(previousImage || '')) throw new Fault(400, 'immutable_previous_image_required');
    const main = await this.host.inspect('container', this.host.names(id).container);
    if (main) { this.host.checkLabels(main, id); if (main.State.Running) throw new Fault(409, 'stop_instance_before_upgrade'); }
    const n = this.names(id), value = await this.host.inspect('container', n.container); if (!value) return;
    const desired = this.image;
    try { this.image = value.Config.Image === desired ? desired : previousImage; this.check(value, id); }
    finally { this.image = desired; }
    if (value.State.Running) throw new Fault(409, 'stop_desktop_before_upgrade');
    this.checkVolume(await this.host.inspect('volume', n.volume), id);
    await this.host.docker(['container', 'rm', n.container]);
  }
  async purge(id) {
    await this.remove(id); const n = this.names(id), volume = await this.host.inspect('volume', n.volume);
    if (volume) { this.checkVolume(volume, id); await this.host.docker(['volume', 'rm', n.volume]); }
    await this.disks.remove(id); this.backups.purge(id);
    if (this.egress) { const network = await this.host.inspect('network', n.network); if (network) { this.checkNetwork(network, id); await this.host.docker(['network', 'rm', n.network]); } await this.egress.update(id, false); }
    rmSync(n.edge, { recursive: true, force: true }); this.store.run('DELETE FROM desktops WHERE id=?', id);
    const listener = this.servers.get(id);
    if (listener) { for (const socket of listener.sockets) socket.destroy(); await close(listener.server); rmSync(listener.path, { force: true }); this.servers.delete(id); }
  }
  async recover() {
    const names = (await this.host.docker(['container', 'ls', '-a', '--filter', `label=cn.donebot.cloud.deployment=${this.host.namespace}`, '--filter', 'label=cn.donebot.cloud.role=desktop', '--format', '{{.Names}}'])).trim().split('\n').filter(Boolean);
    for (const name of names) { const value = await this.host.inspect('container', name), id = instanceID(value?.Config?.Labels?.['cn.donebot.cloud.instance']); if (name !== this.names(id).container) throw new Fault(409, 'desktop_resource_ownership_mismatch'); await this.stop(id); }
  }
  async exec(id, input) {
    if (typeof input.command !== 'string' || !input.command.trim() || input.command.length > 20000 || input.timeout_seconds !== undefined && !Number.isFinite(input.timeout_seconds)) throw new Fault(400, 'invalid_desktop_command');
    const seconds = Math.min(300, Math.max(1, Math.floor(input.timeout_seconds ?? 60))), n = this.names(id);
    const value = await this.host.inspect('container', n.container); if (!value?.State.Running) throw new Fault(409, 'desktop_not_running'); this.check(value, id);
    const args = ['container', 'exec', '-u', '1000:1000', '-w', '/home/cua/workspace', '-e', 'HOME=/home/cua', '-e', 'DISPLAY=:1', n.container, 'timeout', '-k', '5', String(seconds), 'sh', '-lc', input.command];
    try { const out = await execute(this.host.binary, args, { timeout: (seconds + 20) * 1000, maxBuffer: 1024 * 1024 }); return { exitCode: 0, stdout: out.stdout.slice(-20000), stderr: out.stderr.slice(-20000), timedOut: false }; }
    catch (e) { if (typeof e.code !== 'number') throw new Fault(502, 'desktop_exec_failed'); return { exitCode: e.code, stdout: (e.stdout || '').slice(-20000), stderr: (e.stderr || '').slice(-20000), timedOut: [124, 137].includes(e.code) }; }
  }
  async frame(id) {
    const n = this.names(id), value = await this.host.inspect('container', n.container); if (!value?.State.Running) throw new Fault(409, 'desktop_not_running'); this.check(value, id);
    await this.host.docker(['container', 'exec', '-u', '1000:1000', n.container, CUA, 'call', 'get_desktop_state', '{}', '--socket', CUA_SOCKET, '--screenshot-out-file', '/tmp/dbc-frame.png']);
    return { png: (await this.host.docker(['container', 'exec', '-u', '1000:1000', n.container, 'base64', '-w0', '/tmp/dbc-frame.png'])).trim(), format: 'png' };
  }
  async file(id, input, res) {
    if (typeof input.path !== 'string' || input.path.length > 8192 || !input.path.startsWith('/home/cua/workspace/') || input.path.includes('\0')) throw new Fault(400, 'invalid_desktop_file');
    const n = this.names(id), value = await this.host.inspect('container', n.container);
    if (!value?.State.Running) throw new Fault(409, 'desktop_not_running'); this.check(value, id); this.authorize(id);
    const child = spawn(this.host.binary, ['container', 'exec', '-i', '-u', '1000:1000', n.container, '/opt/venv/bin/python', '-c', readFile, input.path], { stdio: ['ignore', 'pipe', 'ignore'] });
    const item = { id, kill: () => { child.kill(); res.destroy(); } }; this.streams.add(item);
    await new Promise((resolve, reject) => {
      let header = Buffer.alloc(0), expected = null, sent = 0;
      const timer = setTimeout(item.kill, 120000); timer.unref();
      res.once('close', () => { clearTimeout(timer); child.kill(); this.streams.delete(item); resolve(); });
      child.once('error', () => { if (!res.headersSent) reject(new Fault(502, 'desktop_file_failed')); else res.destroy(); });
      child.stdout.on('data', chunk => {
        if (expected === null) {
          header = Buffer.concat([header, chunk]); if (header.length < 8) return;
          expected = Number(header.readBigUInt64BE()); chunk = header.subarray(8);
          if (!Number.isSafeInteger(expected) || expected > 100 * 1024 ** 2 || !this.allowed(id)) { item.kill(); return; }
          res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': expected, 'cache-control': 'no-store' });
        }
        sent += chunk.length; if (sent > expected) { item.kill(); return; }
        if (!res.write(chunk)) child.stdout.pause();
      });
      res.on('drain', () => child.stdout.resume());
      child.once('close', code => {
        if (code !== 0 || expected === null || sent !== expected) { if (!res.headersSent) reject(new Fault(404, 'desktop_file_not_found')); else res.destroy(); }
        else res.end();
      });
    });
  }
  pinViewer(id) {
    const fd = openSync(join(this.names(id).edge, 'viewer.sock'), 0x200000 | 0x20000), stat = fstatSync(fd);
    if (!stat.isSocket() || stat.uid !== 1000) { closeSync(fd); throw new Fault(409, 'desktop_viewer_socket_mismatch'); }
    let closed = false;
    return { path: '/proc/self/fd/' + fd, release: () => { if (!closed) { closed = true; closeSync(fd); } } };
  }
  async serve(id, edge) {
    if (this.servers.has(id)) return;
    const server = createServer(async (req, res) => {
      try {
        this.authorize(id);
        if (req.method === 'GET' && req.url === '/status') return json(res, 200, await this.hold(id, () => this.status(id), false));
        if (req.method === 'POST' && req.url === '/action') {
          const input = await body(req); if (Object.keys(input).join(',') !== 'action' || !['pull', 'run', 'start', 'stop', 'remove'].includes(input.action)) throw new Fault(400, 'invalid_desktop_action');
          await this.serial(id, async () => {
            this.authorize(id);
            if (input.action === 'pull') { if (!await this.imageReady()) throw new Fault(503, 'desktop_image_unavailable'); }
            else if (['run', 'start'].includes(input.action)) { try { await this.hold(id, () => this.start(id)); this.authorize(id); } catch (e) { await this.stop(id); throw e; } }
            else await this.removeOrStop(id, input.action);
          }); return json(res, 200, { ok: true });
        }
        if (req.method === 'POST' && req.url === '/exec') { const input = await body(req, 24000); return json(res, 200, await this.hold(id, () => this.exec(id, input))); }
        if (req.method === 'GET' && req.url === '/frame') return json(res, 200, await this.hold(id, () => this.frame(id)));
        if (req.method === 'POST' && req.url === '/file') { const input = await body(req); await this.hold(id, () => this.file(id, input, res)); return; }
        throw new Fault(404, 'not_found');
      } catch (e) { fail(res, e); }
    });
    const sockets = new Set(); server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    server.on('upgrade', async (req, socket, head) => {
      socket.on('error', () => socket.destroy());
      try {
        this.authorize(id);
        if (req.url === '/mcp' && req.headers.upgrade === 'donebot-mcp') {
          const n = this.names(id), value = await this.host.inspect('container', n.container); if (!value?.State.Running) throw new Fault(409, 'desktop_not_running'); this.check(value, id); this.authorize(id);
          const release = this.claim(id);
          const child = spawn(this.host.binary, ['container', 'exec', '-i', '-u', '1000:1000', '-e', 'HOME=/home/cua', '-e', 'DISPLAY=:1', n.container, CUA, 'mcp', '--socket', CUA_SOCKET], { stdio: ['pipe', 'pipe', 'ignore'] });
          const item = { id, kill: () => { child.kill(); socket.destroy(); } }; this.streams.add(item); this.touch(id);
          socket.once('close', () => { child.kill(); this.streams.delete(item); release(); this.touch(id); }); child.once('error', () => socket.destroy()); child.once('exit', () => socket.destroy()); child.stdin.on('error', () => socket.destroy());
          socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: donebot-mcp\r\n\r\n');
          if (head.length) child.stdin.write(head); socket.pipe(child.stdin); child.stdout.pipe(socket); return;
        }
        if (req.url !== '/websockify' || req.headers.upgrade?.toLowerCase() !== 'websocket') throw new Fault(404, 'not_found');
        const pinned = this.pinViewer(id);
        let release; try { release = this.claim(id); } catch (e) { pinned.release(); throw e; }
        socket.once('close', () => { release(); this.touch(id); });
        const upstream = request({ socketPath: pinned.path, path: '/websockify', agent: false, headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': req.headers['sec-websocket-key'], 'sec-websocket-version': '13' } });
        const item = { id, kill: () => { upstream.destroy(); socket.destroy(); } }; this.streams.add(item); this.touch(id);
        upstream.once('close', pinned.release); upstream.once('error', () => socket.destroy()); upstream.once('response', res => { res.resume(); socket.destroy(); });
        socket.once('close', () => { upstream.destroy(); this.streams.delete(item); });
        upstream.once('upgrade', (res, peer, upstreamHead) => {
          upstream.setTimeout(0);
          if (!this.allowed(id) || socket.destroyed) { peer.destroy(); socket.destroy(); return; }
          item.kill = () => { peer.destroy(); upstream.destroy(); socket.destroy(); };
          socket.once('close', () => peer.destroy()); peer.on('error', () => socket.destroy()); peer.once('close', () => socket.destroy());
          socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${res.headers['sec-websocket-accept']}\r\n\r\n`);
          if (upstreamHead.length) socket.write(upstreamHead); if (head.length) peer.write(head); socket.pipe(peer).pipe(socket);
        }); upstream.setTimeout(10000, () => upstream.destroy()); upstream.end();
      } catch (e) { socket.end(`HTTP/1.1 ${e.status || 503} Rejected\r\nConnection: close\r\n\r\n`); }
    });
    server.maxConnections = 32;
    const path = join(edge, 'cloud-desktop.sock'); rmSync(path, { force: true }); await listen(server, path); chownSync(path, 1001, 1001); chmodSync(path, 0o600);
    this.servers.set(id, { server, sockets, path });
  }
  async removeOrStop(id, action) { if (action === 'remove') await this.remove(id); else await this.stop(id); }
  async drain(id) { await this.queues.get(id)?.catch(() => {}); }
  resources(id) {
    const stat = this.disks.mounted(id) ? statfsSync(this.disks.mountPath(id)) : null;
    return { enabled: true, cpu_cores: 1, memory_bytes: 2147483648, storage: { enforced: true, limit_bytes: this.disks.bytes, ...(stat ? { available_bytes: stat.bavail * stat.bsize, total_bytes: stat.blocks * stat.bsize } : {}) }, idle_timeout_seconds: this.idleMs / 1000 };
  }
  async close() { clearInterval(this.timer); for (const item of this.streams) item.kill(); for (const { server, sockets, path } of this.servers.values()) { for (const socket of sockets) socket.destroy(); await close(server); rmSync(path, { force: true }); } await Promise.allSettled(this.queues.values()); this.store.close(); }
}
