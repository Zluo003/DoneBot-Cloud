import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmodSync, chownSync, closeSync, fchownSync, fstatSync, mkdirSync, openSync, readFileSync, renameSync, statfsSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Fault, instanceID, privateDir, socketJSON } from './common.mjs';
import { Store } from './store.mjs';
import { Egress } from './egress.mjs';
import { BoundedDisks } from './storage.mjs';
import { Backups } from './backups.mjs';
import { CloudDesktops } from './desktops.mjs';
import { InstanceBackups } from './instance-backups.mjs';
import { cloudStorageLimits, CLOUD_STORAGE_MAX_BYTES } from './resource-limits.mjs';
import { PERSONAL_RUNTIME, TEAM_PROTOCOL, teamConfiguration, teamCoordinatorConfiguration, teamEnvironment, teamPublicKey } from './team-runtime.mjs';
import { checkContainerSecurityOpts, resolveTeamSecurityConfig, teamSecurityArgs } from './team-security.mjs';

const execute = promisify(execFile);
// Executed only by the host agent, with no user-supplied command or arguments.
const pairingScript = `const origin='http://127.0.0.1:18899';
const call=async(path,body)=>{const r=await fetch(origin+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(5000)});if(!r.ok)throw Error('pairing failed');return r.json()};
const p=await call('/api/auth/pairing',{label:'DoneBot Cloud access',scopes:['admin','client'],tokenTtlMs:86400000});
const s=await call('/api/auth/pair',{code:p.code,label:'DoneBot Cloud access'});process.stdout.write(JSON.stringify(s));`;

export class DockerRuntime {
  constructor({ stateDir, image, development = false, binary = '/usr/local/bin/docker', healthTimeoutMs = 90000, egress = 'none', egressDNS, egressDenyIPv4, gatewayIPv4, nftBinary, gatewayRequired = false, storage = 'volume', storageBytes, desktopImage, desktopBytes, desktopIdleMs, teamsEnabled = false, teamPublicKey: pinnedTeamKey, teamSeccompPath, teamAppArmorProfile, readAppArmor }) {
    if (!development && !/^(?:[a-zA-Z0-9./:_-]+@)?sha256:[a-f0-9]{64}$/.test(image || '')) throw new Error('production requires an immutable DoneBot image digest');
    if (!image || /\s|[\x00-\x1f]/.test(image)) throw new Error('invalid image');
    if (!['none', 'public-web'].includes(egress)) throw new Error('invalid egress mode');
    if (egress !== 'none' && (process.platform !== 'linux' || process.getuid() !== 0 || !/^unix:\/\/\//.test(process.env.DOCKER_HOST || 'unix:///var/run/docker.sock'))) throw new Error('public-web egress requires root and a local Linux Docker engine');
    const limits = cloudStorageLimits(storageBytes, desktopBytes);
    this.stateDir = privateDir(stateDir); this.image = image; this.binary = binary; this.healthTimeoutMs = healthTimeoutMs;
    this.gatewayRequired = gatewayRequired; this.teamsEnabled = teamsEnabled; this.pinnedTeamKey = pinnedTeamKey;
    if (teamsEnabled) teamPublicKey(pinnedTeamKey);
    this.teamSecurity = resolveTeamSecurityConfig({ teamsEnabled, seccompPath: teamSeccompPath, appArmorProfile: teamAppArmorProfile, readAppArmor });
    const path = join(stateDir, 'deployment-id');
    try { writeFileSync(path, randomUUID(), { mode: 0o600, flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    this.namespace = instanceID(readFileSync(path, 'utf8'));
    this.store = new Store(join(stateDir, 'metadata'));
    this.store.db.exec('CREATE TABLE IF NOT EXISTS credentials(id TEXT PRIMARY KEY,value TEXT NOT NULL)');
    this.store.db.exec('CREATE TABLE IF NOT EXISTS runtime_credentials(id TEXT PRIMARY KEY,value TEXT NOT NULL)');
    this.store.db.exec('CREATE TABLE IF NOT EXISTS team_runtimes(id TEXT PRIMARY KEY,value TEXT NOT NULL)');
    this.store.db.exec('CREATE TABLE IF NOT EXISTS team_coordinators(id TEXT PRIMARY KEY,value TEXT NOT NULL)');
    this.egress = egress === 'none' ? null : new Egress({ namespace: this.namespace, store: this.store, dns: egressDNS, denyIPv4: egressDenyIPv4, gatewayIPv4, binary: nftBinary });
    if (!['volume', 'bounded-ext4'].includes(storage)) throw new Error('invalid storage mode');
    if (storage === 'bounded-ext4' && !/^unix:\/\/\//.test(process.env.DOCKER_HOST || 'unix:///var/run/docker.sock')) throw new Error('bounded storage requires local Docker');
    this.disks = storage === 'bounded-ext4' ? new BoundedDisks({ stateDir: this.stateDir, store: this.store, bytes: limits.runtime, limitFor: id => { const team = this.teamConfiguration(id); return team ? team.runtime.storage_gib * 1024 ** 3 : limits.runtime; } }) : null;
    this.backups = this.disks ? new Backups({ stateDir: this.stateDir, store: this.store, disks: this.disks }) : null;
    this.desktops = desktopImage ? new CloudDesktops(this, { image: desktopImage, bytes: limits.desktop, idleMs: desktopIdleMs, egressDNS, egressDenyIPv4, nftBinary }) : null;
    if (this.desktops && !this.backups) throw new Error('Cloud desktops require bounded-ext4 storage');
    if (this.desktops) this.backups = new InstanceBackups(this.backups, this.desktops, this.store);
  }
  names(id) { instanceID(id); const prefix = `dbc-${this.namespace}-${id}`; return { container: prefix, volume: prefix + '-data', network: prefix + '-net', bridge: this.egress?.bridge(id), edge: join(this.stateDir, id), socketPath: join(this.stateDir, id, 'http.sock') }; }
  async docker(args) {
    try { return (await execute(this.binary, args, { timeout: 120000, maxBuffer: 4 * 1024 * 1024, env: { PATH: '/usr/bin:/bin', DOCKER_HOST: process.env.DOCKER_HOST || 'unix:///var/run/docker.sock' } })).stdout; }
    catch (e) { if (/No such (container|object|volume|network)|network .* not found/i.test(e.stderr || '')) throw new Fault(404, 'docker_resource_missing'); throw new Fault(503, e.killed ? 'docker_timeout' : 'docker_failed'); }
  }
  async inspect(kind, name) { try { return JSON.parse(await this.docker([kind, 'inspect', name]))[0]; } catch (e) { if (e.status === 404) return null; throw e; } }
  labels(id) { return { 'cn.donebot.cloud.deployment': this.namespace, 'cn.donebot.cloud.instance': id }; }
  checkVolume(value, id) {
    this.checkLabels(value, id);
    const expected = this.disks?.options(id) || {}, options = value.Options || {};
    if (value.Driver !== 'local' || Object.keys(options).length !== Object.keys(expected).length || Object.entries(expected).some(([key, val]) => options[key] !== val)) throw new Fault(409, 'storage_spec_mismatch');
    this.disks?.check(id);
  }
  checkLabels(value, id) { const labels = value?.Config?.Labels || value?.Labels || {}; for (const [key, expected] of Object.entries(this.labels(id))) if (labels[key] !== expected) throw new Fault(409, 'resource_ownership_mismatch'); }
  networkOptions(id) { return { 'com.docker.network.bridge.name': this.egress.bridge(id), 'com.docker.network.bridge.enable_icc': 'false', 'com.docker.network.bridge.enable_ip_masquerade': 'true' }; }
  checkNetwork(value, id) {
    this.checkLabels(value, id);
    const options = this.networkOptions(id), address = value.IPAM?.Config?.[0]?.Subnet;
    // Only Docker-allocated private IPv4 bridges, with at most this instance attached.
    if (value.Driver !== 'bridge' || value.Scope !== 'local' || value.Internal || value.EnableIPv6 || value.Ingress || value.IPAM?.Config?.length !== 1 || !/^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)/.test(address || '') || Object.keys(value.Options || {}).length !== Object.keys(options).length || Object.entries(options).some(([key, expected]) => value.Options[key] !== expected) || Object.values(value.Containers || {}).some(c => c.Name !== this.names(id).container)) throw new Fault(409, 'network_spec_mismatch');
  }
  async ensureNetwork(id, labels) {
    // Persist the bridge and install its deny rules BEFORE Docker creates a usable network.
    await this.egress.update(id, true);
    const names = this.names(id);
    let network = await this.inspect('network', names.network);
    if (!network) {
      const options = Object.entries(this.networkOptions(id)).flatMap(([key, value]) => ['--opt', `${key}=${value}`]);
      await this.docker(['network', 'create', '--driver', 'bridge', ...options, ...labels, names.network]);
      network = await this.inspect('network', names.network);
    }
    this.checkNetwork(network, id);
  }
  checkContainer(value, id, names) {
    this.checkLabels(value, id);
    const team = this.teamConfiguration(id), limits = team?.runtime || PERSONAL_RUNTIME;
    const env = value.Config.Env || [];
    if (team && (teamEnvironment(team).some(entry => !env.includes(entry)) || env.some(entry => entry.startsWith('DONEBOT_CLOUD_CREDENTIAL_FILE='))) || !team && env.some(entry => entry.startsWith('DONEBOT_TEAM_'))) throw new Fault(409, 'team_runtime_trust_mismatch');
    if (this.gatewayRequired && !team && !env.includes('DONEBOT_CLOUD_CREDENTIAL_FILE=/run/donebot/gateway.json')) throw new Fault(409, 'resource_spec_mismatch');
    if (this.desktops && !value.Config.Env?.includes('DONEBOT_CLOUD_DESKTOP_SOCKET=/run/donebot/cloud-desktop.sock')) throw new Fault(409, 'resource_spec_mismatch');
    const h = value.HostConfig, mounts = value.Mounts.filter(m => m.Type !== 'tmpfs');
    if (value.Mounts.some(m => m.Type === 'tmpfs' && !['/tmp', '/run'].includes(m.Destination)) || Object.keys(h.Tmpfs || {}).sort().join(',') !== '/run,/tmp') throw new Fault(409, 'resource_spec_mismatch');
    const network = this.egress ? names.network : 'none';
    if (h.NetworkMode !== network || Object.keys(value.NetworkSettings.Networks).some(name => name !== network) || (this.egress && h.Dns.join(',') !== this.egress.dns.join(','))) throw new Fault(409, 'network_spec_mismatch');
    const teamSecurity = team && this.teamSecurity ? { seccomp: this.teamSecurity.seccomp, appArmor: this.teamSecurity.readAppArmor(this.teamSecurity.profile) } : null;
    if (team && !teamSecurity) throw new Fault(503, 'team_runtime_disabled');
    if (value.Config.Image !== this.image || value.Config.User !== '1001:1001' || !h.ReadonlyRootfs || h.Privileged || h.Memory !== limits.memory_mib * 1024 ** 2 || h.MemorySwap !== limits.memory_mib * 1024 ** 2 || h.NanoCpus !== limits.cpu_millis * 1e6 || h.PidsLimit !== limits.pids || h.CapDrop?.join(',') !== 'ALL' || h.CapAdd?.length || !checkContainerSecurityOpts(h.SecurityOpt, teamSecurity, h) || mounts.length !== 2 || !mounts.some(m => m.Type === 'volume' && m.Name === names.volume && m.Destination === '/data') || !mounts.some(m => m.Type === 'bind' && m.Source === names.edge && m.Destination === '/run/donebot') || Object.keys(h.PortBindings || {}).length) throw new Fault(409, 'resource_spec_mismatch');
  }
  async status(id) { const names = this.names(id), value = await this.inspect('container', names.container); if (!value) return { state: 'absent' }; this.checkContainer(value, id, names); return { state: value.State.Running ? 'running' : 'stopped' }; }
  configureGateway(id, value) {
    instanceID(id);
    if (this.teamConfiguration(id)) throw new Fault(403, 'team_personal_credential_forbidden');
    if (!value || value.installationId !== id || !/^sk-donebot-[a-f0-9]{64}$/.test(value.credential || '') || !/^[1-9][0-9]{0,19}$/.test(value.user?.id || '') || typeof value.user?.email !== 'string' || !value.user.email || value.user.email.length > 320) throw new Fault(400, 'invalid_runtime_credential');
    const clean = { installationId: id, credential: value.credential, user: { id: value.user.id, email: value.user.email } };
    this.store.run('INSERT OR REPLACE INTO runtime_credentials VALUES(?,?)', id, this.store.vault.seal(clean));
  }
  teamConfiguration(id) {
    const saved = this.store.get('SELECT value FROM team_runtimes WHERE id=?', instanceID(id));
    return saved ? teamConfiguration(JSON.parse(saved.value), id, this.pinnedTeamKey) : null;
  }
  async configureTeam(id, value) {
    if (!this.teamsEnabled) throw new Fault(503, 'team_runtime_disabled');
    const clean = teamConfiguration(value, id, this.pinnedTeamKey), saved = this.teamConfiguration(id);
    if (this.store.get('SELECT id FROM runtime_credentials WHERE id=?', id)) throw new Fault(403, 'team_personal_credential_forbidden');
    if (saved) {
      const { name: oldName, ...before } = saved, { name: newName, ...after } = clean;
      if (JSON.stringify(before) !== JSON.stringify(after)) throw new Fault(409, 'team_runtime_spec_immutable');
      return;
    }
    const names = this.names(id);
    if (await this.inspect('container', names.container) || await this.inspect('volume', names.volume)) throw new Fault(409, 'team_runtime_scope_immutable');
    this.store.run('INSERT INTO team_runtimes VALUES(?,?)', id, JSON.stringify(clean));
  }
  configureTeamCoordinator(id, value) {
    if (!this.teamsEnabled) throw new Fault(503, 'team_runtime_disabled');
    const clean = teamCoordinatorConfiguration(value, this.teamConfiguration(id));
    const saved = this.store.get('SELECT value FROM team_coordinators WHERE id=?', id);
    if (saved) {
      const before = teamCoordinatorConfiguration(this.store.vault.open(saved.value), this.teamConfiguration(id));
      if (clean.generation < before.generation || clean.generation === before.generation && clean.credential !== before.credential) throw new Fault(409, 'team_coordinator_generation_mismatch');
    }
    this.store.run('INSERT OR REPLACE INTO team_coordinators VALUES(?,?)', id, this.store.vault.seal(clean));
  }
  writeGateway(id, edge) {
    const team = this.teamConfiguration(id);
    const saved = this.store.get(team ? 'SELECT value FROM team_coordinators WHERE id=?' : 'SELECT value FROM runtime_credentials WHERE id=?', id);
    if (!saved) { if (team || this.gatewayRequired) throw new Fault(503, 'runtime_credential_required'); return; }
    const value = this.store.vault.open(saved.value);
    if (team) teamCoordinatorConfiguration(value, team);
    const temporary = join(edge, '.gateway-' + randomUUID());
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      try { writeFileSync(fd, JSON.stringify(value)); fchownSync(fd, 1001, 1001); }
      finally { closeSync(fd); }
      // The tenant can replace files inside this directory; rename never follows its symlink.
      renameSync(temporary, join(edge, team ? 'team-coordinator.json' : 'gateway.json'));
    } finally { rmSync(temporary, { force: true }); }
  }
  async recover() {
    await this.desktops?.recover();
    const names = (await this.docker(['container', 'ls', '-a', '--filter', `label=cn.donebot.cloud.deployment=${this.namespace}`, '--format', '{{.Names}}'])).trim().split('\n').filter(Boolean);
    for (const name of names) {
      const container = await this.inspect('container', name);
      const id = instanceID(container?.Config?.Labels?.['cn.donebot.cloud.instance']);
      if (container.Config.Labels['cn.donebot.cloud.role'] === 'desktop' && this.desktops && name === this.desktops.names(id).container) continue;
      if (name !== this.names(id).container) throw new Fault(409, 'resource_ownership_mismatch');
      await this.stop(id);
    }
  }
  async prepareUpgrade(id, previousImage) {
    if (!/^(?:[a-zA-Z0-9./:_-]+@)?sha256:[a-f0-9]{64}$/.test(previousImage || '')) throw new Fault(400, 'immutable_previous_image_required');
    const names = this.names(id), container = await this.inspect('container', names.container);
    if (!container) return;
    const desired = this.image;
    try { this.image = container.Config.Image === desired ? desired : previousImage; this.checkContainer(container, id, names); }
    finally { this.image = desired; }
    if (container.State.Running) throw new Fault(409, 'stop_instance_before_upgrade');
    this.checkVolume(await this.inspect('volume', names.volume), id);
    await this.docker(['container', 'rm', names.container]);
  }
  async start(id) {
    try { return await this.startRuntime(id); }
    catch (e) { await this.stop(id); throw e; }
  }
  async startRuntime(id) {
    const team = this.teamConfiguration(id), limits = team?.runtime || PERSONAL_RUNTIME;
    if (team && !this.teamsEnabled) throw new Fault(503, 'team_runtime_disabled');
    const names = this.names(id), labels = Object.entries(this.labels(id)).flatMap(([k, v]) => ['--label', `${k}=${v}`]);
    let container = await this.inspect('container', names.container);
    if (container) this.checkContainer(container, id, names);
    if (this.gatewayRequired && !team && !this.store.get('SELECT id FROM runtime_credentials WHERE id=?', id)) throw new Fault(503, 'runtime_credential_required');
    if (this.disks) {
      this.backups.recover(id);
      const volume = await this.inspect('volume', names.volume);
      if (volume) this.checkLabels(volume, id);
      await this.disks.ensure(id, !!volume);
    }
    if (this.egress) await this.ensureNetwork(id, labels);
    if (!container) {
      const volume = await this.inspect('volume', names.volume);
      if (volume) this.checkLabels(volume, id);
      if (volume) this.checkVolume(volume, id);
      else {
        const options = Object.entries(this.disks?.options(id) || {}).flatMap(([key, value]) => ['--opt', `${key}=${value}`]);
        await this.docker(['volume', 'create', '--driver', 'local', ...options, ...labels, names.volume]);
      }
      mkdirSync(names.edge, { recursive: true, mode: 0o700 }); chownSync(names.edge, 1001, 1001); chmodSync(names.edge, 0o700);
      this.writeGateway(id, names.edge);
      const securityArgs = team ? teamSecurityArgs({ seccomp: this.teamSecurity.seccomp, appArmor: this.teamSecurity.readAppArmor(this.teamSecurity.profile) }) : ['--security-opt', 'no-new-privileges'];
      await this.docker(['container', 'create', '--name', names.container, ...labels, '--init', '--user', '1001:1001', '--read-only', '--cap-drop', 'ALL', ...securityArgs, '--memory', `${limits.memory_mib}m`, '--memory-swap', `${limits.memory_mib}m`, '--cpus', String(limits.cpu_millis / 1000), '--pids-limit', String(limits.pids), '--shm-size', '512m', '--network', this.egress ? names.network : 'none', ...(this.egress ? this.egress.dns.flatMap(ip => ['--dns', ip]) : []), '--restart', 'no', '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m,mode=1777', '--tmpfs', '/run:rw,nosuid,nodev,size=8m,mode=755', '--mount', `type=volume,src=${names.volume},dst=/data`, '--mount', `type=bind,src=${names.edge},dst=/run/donebot`, '--env', 'DONEBOT_TUNNEL_SOCKET=/run/donebot/http.sock', '--env', 'DONEBOT_PORT=18899', '--env', 'DONEBOT_WEBHOOK_PORT=18900', ...(team ? teamEnvironment(team).flatMap(entry => ['--env', entry]) : this.gatewayRequired ? ['--env', 'DONEBOT_CLOUD_CREDENTIAL_FILE=/run/donebot/gateway.json'] : []), ...(this.desktops ? ['--env', 'DONEBOT_CLOUD_DESKTOP_SOCKET=/run/donebot/cloud-desktop.sock'] : []), this.image]);
      container = await this.inspect('container', names.container); this.checkContainer(container, id, names);
    }
    if (this.disks) this.checkVolume(await this.inspect('volume', names.volume), id);
    this.writeGateway(id, names.edge);
    await this.desktops?.serve(id, names.edge);
    if (!container.State.Running) await this.docker(['container', 'start', names.container]);
    const deadline = Date.now() + this.healthTimeoutMs;
    while (Date.now() < deadline) {
      let pinned;
      try { pinned = this.pinSocket(id); const health = await socketJSON(pinned.socketPath, '/api/health', 'GET', undefined, 2000); if (health.app === 'donebot' && (!team || health.team_protocol === TEAM_PROTOCOL && health.ready === true)) break; } catch { /* The socket appears after DoneBot initializes. */ }
      finally { pinned?.release(); }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (Date.now() >= deadline) throw new Fault(504, 'instance_health_timeout');
    if (team) return { socketPath: names.socketPath, team, expiresAt: Number.MAX_SAFE_INTEGER };
    const saved = this.store.get('SELECT value FROM credentials WHERE id=?', id);
    let credential = saved ? this.store.vault.open(saved.value) : null;
    if (credential && credential.expiresAt > Date.now() + 60000) {
      const valid = await this.authProbe(id, credential.token).catch(() => false);
      if (!valid) credential = null;
    } else credential = null;
    if (!credential) {
      const result = JSON.parse(await this.docker(['container', 'exec', names.container, 'node', '--input-type=module', '-e', pairingScript]));
      if (!/^omb_sess_[A-Za-z0-9_-]+$/.test(result.token || '') || !Number.isFinite(result.session?.expiresAt)) throw new Fault(502, 'invalid_instance_session');
      credential = { token: result.token, expiresAt: result.session.expiresAt };
      if (!await this.authProbe(id, credential.token)) throw new Fault(502, 'instance_auth_failed');
      this.store.run('INSERT OR REPLACE INTO credentials VALUES(?,?)', id, this.store.vault.seal(credential));
    }
    return { socketPath: names.socketPath, ...credential };
  }
  async authProbe(id, token) {
    const pinned = this.pinSocket(id);
    const { request } = await import('node:http');
    try { return await new Promise(resolve => { const req = request({ socketPath: pinned.socketPath, agent: false, path: '/api/auth/session', headers: { authorization: `Bearer ${token}`, host: 'donebot-cloud.internal' }, timeout: 5000 }, async res => { try { const { body } = await import('./common.mjs'); const value = await body(res); resolve(res.statusCode === 200 && value.kind === 'session'); } catch { resolve(false); } }); req.on('error', () => resolve(false)); req.on('timeout', () => req.destroy()); req.end(); }); }
    finally { pinned.release(); }
  }
  pinSocket(id) {
    if (process.platform !== 'linux') throw new Fault(503, 'linux_socket_pinning_required');
    // Linux O_PATH | O_NOFOLLOW pins the socket inode, including across a tenant rename.
    const fd = openSync(this.names(id).socketPath, 0x200000 | 0x20000);
    const stat = fstatSync(fd);
    if (!stat.isSocket() || stat.uid !== 1001) { closeSync(fd); throw new Fault(409, 'instance_socket_ownership_mismatch'); }
    let closed = false;
    return { socketPath: `/proc/self/fd/${fd}`, release() { if (!closed) { closed = true; closeSync(fd); } } };
  }
  async stop(id) {
    await this.desktops?.drain(id);
    await this.desktops?.stop(id);
    const names = this.names(id), container = await this.inspect('container', names.container);
    if (!container) return;
    this.checkContainer(container, id, names);
    if (container.State.Running) await this.docker(['container', 'stop', '--time', '10', names.container]);
  }
  async resources(id) {
    const names = this.names(id), container = await this.inspect('container', names.container);
    if (!container) throw new Fault(404, 'instance_not_found');
    this.checkContainer(container, id, names);
    const volume = await this.inspect('volume', names.volume); this.checkVolume(volume, id);
    const team = this.teamConfiguration(id), limits = team?.runtime || PERSONAL_RUNTIME;
    const result = { cpu_cores: limits.cpu_millis / 1000, memory_bytes: limits.memory_mib * 1024 ** 2, pids: limits.pids, storage: { enforced: !!this.disks, limit_bytes: this.disks?.bytesFor(id) ?? null } };
    if (this.desktops) {
      result.desktop = this.desktops.resources(id);
      result.total = { cpu_cores: result.cpu_cores + result.desktop.cpu_cores, memory_bytes: result.memory_bytes + result.desktop.memory_bytes,
        storage: { enforced: !!this.disks, limit_bytes: result.storage.limit_bytes + result.desktop.storage.limit_bytes, maximum_bytes: team ? (team.runtime.storage_gib + team.desktop.storage_gib) * 1024 ** 3 : CLOUD_STORAGE_MAX_BYTES } };
    }
    if (this.disks && container.State.Running) {
      const stat = statfsSync(volume.Mountpoint);
      result.storage.available_bytes = stat.bavail * stat.bsize;
      result.storage.total_bytes = stat.blocks * stat.bsize;
      result.storage.available_inodes = stat.ffree;
    }
    return result;
  }
  async health() {
    try {
      await this.docker(['version', '--format', '{{.Server.Version}}']);
      const filesystem = statfsSync(this.stateDir), available = filesystem.bavail * filesystem.bsize;
      const desktop = this.desktops ? await this.desktops.imageReady() : true;
      const appArmor = this.teamSecurity ? this.teamSecurity.readAppArmor(this.teamSecurity.profile) : null;
      const appArmorReady = !appArmor || (appArmor.enabled && appArmor.profileLoaded);
      const team = this.teamsEnabled && appArmorReady && (await this.inspect('image', this.image))?.Config?.Labels?.['cn.donebot.teams.protocol'] === TEAM_PROTOCOL;
      return { ready: available > 512 * 1024 ** 2 && desktop, docker: true, desktop_image_ready: desktop, ...(this.teamsEnabled ? { team_apparmor_ready: appArmorReady } : {}), ...(team ? { team_protocol: TEAM_PROTOCOL } : {}), disk_available_bytes: available };
    } catch { return { ready: false, docker: false }; }
  }
  async purge(id) {
    await this.stop(id);
    await this.desktops?.purge(id);
    const names = this.names(id), container = await this.inspect('container', names.container);
    if (container) { this.checkContainer(container, id, names); await this.docker(['container', 'rm', names.container]); }
    const volume = await this.inspect('volume', names.volume);
    if (volume) { this.checkVolume(volume, id); await this.docker(['volume', 'rm', names.volume]); }
    await this.disks?.remove(id);
    this.backups?.purge(id);
    if (this.egress) {
      const network = await this.inspect('network', names.network);
      if (network) { this.checkNetwork(network, id); await this.docker(['network', 'rm', names.network]); }
      // Keep deny rules if removal failed. Only release them after the bridge is gone.
      await this.egress.update(id, false);
    }
    rmSync(names.edge, { recursive: true, force: true });
    this.store.run('DELETE FROM credentials WHERE id=?', id);
    this.store.run('DELETE FROM runtime_credentials WHERE id=?', id);
    this.store.run('DELETE FROM team_runtimes WHERE id=?', id);
    this.store.run('DELETE FROM team_coordinators WHERE id=?', id);
  }
  close() { if (this.desktops) return this.desktops.close().then(() => this.store.close()); this.store.close(); }
}
