import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { DockerRuntime } from '../src/docker.mjs';
import { createAgent } from '../src/agent.mjs';
import { socketJSON } from '../src/common.mjs';

if (process.platform !== 'linux' || process.getuid() !== 0 || process.env.CLOUD_DISPOSABLE_LINUX !== '1') throw new Error('disposable root Linux fixture required');
const dir = await mkdtemp('/var/tmp/dbc-desktop-'), ids = [randomUUID(), randomUUID()];
const config = { stateDir: join(dir, 'resources'), image: process.env.CLOUD_DONEBOT_IMAGE, binary: '/usr/bin/docker', storage: 'bounded-ext4', storageBytes: 256 * 1024 ** 2, desktopImage: process.env.CLOUD_DESKTOP_IMAGE, desktopBytes: 512 * 1024 ** 2, desktopIdleMs: 30000, egress: 'public-web', nftBinary: '/usr/sbin/nft' };
let runtime = new DockerRuntime(config);
const socket = join(dir, 'agent.sock');
let agent = await createAgent({ socketPath: socket, runtime, publicOrigin: 'https://donebot.cn', development: true, requireLease: true });
const leaseIDs = new Set(ids);
const renewals = setInterval(() => { for (const id of leaseIDs) void socketJSON(socket, `/v1/instances/${id}/lease`, 'POST', { authorized_until: Date.now() + 20000 }).catch(() => {}); }, 4000);
const desk = (id, path, value) => socketJSON(join(runtime.names(id).edge, 'cloud-desktop.sock'), path, value === undefined ? 'GET' : 'POST', value);
const inside = (id, code, ...args) => runtime.docker(['container', 'exec', runtime.names(id).container, 'node', '--input-type=module', '-e', code, ...args]);
async function until(check, label) { for (let i = 0; i < 150; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 100)); } throw new Error('timeout: ' + label); }
const clients = [];
const proxy = (id, path, value) => new Promise((resolve, reject) => {
  const req = request({ socketPath: socket, path: `/v1/instances/${id}/proxy` + path, method: value === undefined ? 'GET' : 'POST', agent: false, headers: { 'x-cloud-origin': 'https://donebot.cn', 'content-type': 'application/json' }, timeout: 120000 }, res => {
    let text = ''; res.on('data', b => text += b); res.on('end', () => { try { const out = JSON.parse(text); if (res.statusCode >= 400) throw Object.assign(Error(JSON.stringify(out)), { status: res.statusCode }); resolve(out); } catch(e) { reject(e); } });
  }); req.on('error', reject); req.end(value === undefined ? undefined : JSON.stringify(value));
});
async function mcp(id) {
  const child = spawn('/usr/bin/docker', ['container', 'exec', '-i', runtime.names(id).container, 'node', '/app/dist-server/container-mcp.js', 'cloud', 'cloud-private-desktop', '/run/user/1000/donebot-cua.sock']);
  clients.push({ terminate: () => child.kill() });
  const waiting = new Map(); let pending = '', count = 0, error = '';
  child.stderr.on('data', b => { error += b; });
  child.stdout.on('data', b => { pending += b; let index; while ((index = pending.indexOf('\n')) >= 0) { const line = pending.slice(0, index); pending = pending.slice(index + 1); try { const out = JSON.parse(line); waiting.get(out.id)?.(out); } catch {} } });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++count, timer = setTimeout(() => reject(Error('MCP timeout ' + method + ' ' + error)), 30000);
    waiting.set(n, value => { clearTimeout(timer); waiting.delete(n); resolve(value); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
  });
  const init = await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'dbc-disposable-fixture', version: '1' } }); assert.ok(init.result, JSON.stringify(init));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const list = await call('tools/list'); assert.ok(list.result?.tools.some(t => t.name === 'get_desktop_state'), JSON.stringify(list));
  const state = await call('tools/call', { name: 'get_desktop_state', arguments: {} }); assert.ok(state.result && !state.result.isError, JSON.stringify(state).slice(0, 800));
  child.stdin.end(); child.kill();
}
try {
  for (const [i, id] of ids.entries()) {
    await socketJSON(socket, `/v1/instances/${id}/start`, 'POST', { authorized_until: Date.now() + 20000 });
    assert.equal((await desk(id, '/status')).container, 'missing');
    await assert.rejects(desk(id, '/action', { action: 'run', instance_id: ids[1-i] }), { status: 400 });
    await desk(id, '/action', { action: 'run' });
    const native = await proxy(id, '/api/local-computer'); assert.equal(native.cloud_managed, true); assert.equal(native.ready, true);
    assert.match(native.viewer_url, /^\/desktop-viewer#/); assert.equal(native.commands.run, null);
    assert.equal((await desk(id, '/status')).ready, true);
    assert.equal((await desk(id, '/exec', { command: `printf user${i} > marker.txt; id -u` })).stdout.trim(), '1000');
    const frame = await desk(id, '/frame'); assert.ok(Buffer.from(frame.png, 'base64').subarray(0, 4).equals(Buffer.from([137,80,78,71])));
    await assert.rejects(desk(id, `/instances/${ids[1-i]}/exec`, { command: 'id' }), { status: 404 });
    const otherPath = join(runtime.names(ids[1-i]).edge, 'cloud-desktop.sock');
    assert.equal(await inside(id, "import{connect}from'node:net';const s=connect(process.argv[1]);s.on('error',()=>{process.stdout.write('denied')});s.on('connect',()=>{process.stdout.write('connected');s.destroy()});", otherPath), 'denied');
    const home = await runtime.inspect('volume', runtime.desktops.names(id).volume);
    assert.equal(await inside(id, "import{existsSync}from'node:fs';process.stdout.write(String(existsSync(process.argv[1])));", home.Mountpoint), 'false');
  }
  const a = ids[0], b = ids[1];
  await desk(a, '/action', { action: 'start' });
  await runtime.docker(['container', 'exec', '-d', '-u', '1000:1000', runtime.desktops.names(b).container, '/opt/venv/bin/python', '-m', 'http.server', '80', '--bind', '0.0.0.0', '--directory', '/tmp']);
  await until(async () => { const localHTTP = await desk(b, '/exec', { command: "/opt/venv/bin/python -c \"import urllib.request; print(urllib.request.urlopen('http://127.0.0.1').status)\"" }); return localHTTP.stdout.trim() === '200'; }, 'fixture HTTP target');
  const peerIP = (await runtime.inspect('container', runtime.desktops.names(b).container)).NetworkSettings.Networks[runtime.desktops.names(b).network].IPAddress;
  const denied = await desk(a, '/exec', { command: `/opt/venv/bin/python -c 'import socket\ntry: socket.create_connection(("${peerIP}",80),2);print("connected")\nexcept OSError: print("denied")'` }); assert.equal(denied.stdout.trim(), 'denied');
  assert.match((await proxy(a, '/api/local-computer/screenshot', {})).image, /^data:image\/png;base64,/);
  await proxy(a, '/api/local-computer/start', {});
  await mcp(a);
  const downloaded = await new Promise((resolve, reject) => {
    const req = request({ socketPath: join(runtime.names(a).edge, 'cloud-desktop.sock'), path: '/file', method: 'POST', agent: false, headers: { 'content-type': 'application/json' } }, res => { let text=''; res.on('data', b=>text+=b); res.on('end',()=> res.statusCode === 200 ? resolve(text) : reject(Error(text))); }); req.on('error',reject); req.end(JSON.stringify({ path: '/home/cua/workspace/marker.txt' }));
  }); assert.equal(downloaded, 'user0');
  await desk(a, '/action', { action: 'stop' }); await desk(a, '/action', { action: 'start' });
  assert.equal((await desk(a, '/exec', { command: 'cat marker.txt' })).stdout, 'user0');
  await desk(b, '/action', { action: 'start' });
  assert.equal((await desk(b, '/exec', { command: 'cat marker.txt' })).stdout, 'user1');
  const ws = new WebSocket(`ws+unix://${join(runtime.names(a).edge, 'cloud-desktop.sock')}:/websockify`); clients.push(ws);
  const rfb = once(ws, 'message'); await once(ws, 'open'); assert.match((await rfb)[0].toString(), /RFB 003/);
  const nativeWS = new WebSocket(`ws+unix://${socket}:/v1/instances/${a}/proxy/api/desktop-viewer/local/shared/websockify`, { headers: { 'x-cloud-origin': 'https://donebot.cn', origin: 'https://donebot.cn' } }); clients.push(nativeWS);
  const nativeRfb = once(nativeWS, 'message'); await once(nativeWS, 'open'); assert.match((await nativeRfb)[0].toString(), /RFB 003/);
  const disconnected = once(ws, 'close'), nativeDisconnected = once(nativeWS, 'close'); await socketJSON(socket, `/v1/instances/${a}/stop`, 'POST', {}); await Promise.all([disconnected, nativeDisconnected]);
  assert.equal((await desk(b, '/exec', { command: 'cat marker.txt' })).stdout, 'user1');
  await assert.rejects(desk(a, '/exec', { command: 'id' }), { status: 403 });
  await socketJSON(socket, `/v1/instances/${a}/start`, 'POST', { authorized_until: Date.now() + 20000 }); await desk(a, '/action', { action: 'start' });
  await inside(a, "import{writeFileSync}from'node:fs';writeFileSync('/data/main-marker','before');");
  const key = randomUUID(); const snapshot = await proxy(a, '/api/cloud/backups', { request_key: key, confirm: true });
  assert.equal((await proxy(a, '/api/cloud/backups', { request_key: key, confirm: true })).id, snapshot.id);
  await desk(a, '/action', { action: 'start' });
  await desk(a, '/exec', { command: 'printf after > marker.txt' });
  await inside(a, "import{writeFileSync}from'node:fs';writeFileSync('/data/main-marker','after');");
  const group = runtime.backups.get(a, snapshot.id), childPath = runtime.desktops.backups.path(group.desktop), encrypted = readFileSync(childPath);
  const corrupt = Buffer.from(encrypted); corrupt[15] ^= 1; writeFileSync(childPath, corrupt);
  await assert.rejects(proxy(a, `/api/cloud/backups/${snapshot.id}/restore`, { request_key: randomUUID(), confirm: true }));
  assert.equal(runtime.store.get("SELECT count(*) AS n FROM backup_restores WHERE instance=? AND state='prepared'", a).n, 0);
  assert.equal(await inside(a, "import{readFileSync}from'node:fs';process.stdout.write(readFileSync('/data/main-marker'));"), 'after');
  writeFileSync(childPath, encrypted);
  const restoreKey = randomUUID(); await proxy(a, `/api/cloud/backups/${snapshot.id}/restore`, { request_key: restoreKey, confirm: true });
  await proxy(a, `/api/cloud/backups/${snapshot.id}/restore`, { request_key: restoreKey, confirm: true });
  assert.equal(await inside(a, "import{readFileSync}from'node:fs';process.stdout.write(readFileSync('/data/main-marker'));"), 'before');
  await desk(a, '/action', { action: 'start' }); assert.equal((await desk(a, '/exec', { command: 'cat marker.txt' })).stdout, 'user0');
  await desk(a, '/exec', { command: 'printf interrupted > marker.txt' });
  await inside(a, "import{writeFileSync}from'node:fs';writeFileSync('/data/main-marker','interrupted');");
  await socketJSON(socket, `/v1/instances/${a}/stop`, 'POST', {});
  const interruptedKey = randomUUID();
  await runtime.backups.main.stageRestore(a, group.main, interruptedKey);
  await runtime.desktops.backups.stageRestore(a, group.desktop, interruptedKey);
  runtime.store.run("INSERT INTO instance_restores VALUES(?,?,?,'committing')", a, interruptedKey, snapshot.id);
  runtime.backups.main.commitRestore(a, interruptedKey);
  await agent.close(); runtime = new DockerRuntime(config); await runtime.recover();
  agent = await createAgent({ socketPath: socket, runtime, publicOrigin: 'https://donebot.cn', development: true, requireLease: true });
  await socketJSON(socket, `/v1/instances/${a}/start`, 'POST', { authorized_until: Date.now() + 20000 }); await desk(a, '/action', { action: 'start' });
  assert.equal(await inside(a, "import{readFileSync}from'node:fs';process.stdout.write(readFileSync('/data/main-marker'));"), 'before');
  assert.equal((await desk(a, '/exec', { command: 'cat marker.txt' })).stdout, 'user0');
  runtime.desktops.idleMs = 2000;
  await until(async () => (await desk(a, '/status')).container === 'stopped', 'idle desktop stop');
  runtime.desktops.idleMs = 30000;
  await socketJSON(socket, `/v1/instances/${a}/stop`, 'POST', {});
  const previous = runtime.desktops.image; runtime.desktops.image = 'sha256:' + 'b'.repeat(64);
  await runtime.desktops.prepareUpgrade(a, previous); await runtime.desktops.prepareUpgrade(a, previous);
  assert.notEqual(await runtime.inspect('volume', runtime.desktops.names(a).volume), null);
  runtime.desktops.image = previous;
  await socketJSON(socket, `/v1/instances/${a}/start`, 'POST', { authorized_until: Date.now() + 20000 });
  await desk(a, '/action', { action: 'start' }); assert.equal((await desk(a, '/exec', { command: 'cat marker.txt' })).stdout, 'user0');
  const expiring = new WebSocket(`ws+unix://${join(runtime.names(a).edge, 'cloud-desktop.sock')}:/websockify`); clients.push(expiring);
  const expiringRfb = once(expiring, 'message'); await once(expiring, 'open'); await expiringRfb;
  leaseIDs.delete(a); const expiredConnection = once(expiring, 'close');
  await socketJSON(socket, `/v1/instances/${a}/lease`, 'POST', { authorized_until: Date.now() + 1000 });
  await expiredConnection;
  await until(async () => (await runtime.status(a)).state === 'stopped', 'expired runtime stopped');
  assert.equal((await runtime.desktops.status(a)).container, 'stopped');
  await assert.rejects(desk(a, '/exec', { command: 'id' }), { status: 403 });
  await socketJSON(socket, `/v1/instances/${b}/start`, 'POST', { authorized_until: Date.now() + 20000 });
  await desk(b, '/action', { action: 'start' }); assert.equal((await desk(b, '/exec', { command: 'cat marker.txt' })).stdout, 'user1');
  await socketJSON(socket, `/v1/instances/${a}/purge`, 'POST', {});
  assert.equal(await runtime.inspect('container', runtime.desktops.names(a).container), null);
  assert.equal(await runtime.inspect('volume', runtime.desktops.names(a).volume), null);
  console.log(JSON.stringify({ result: 'linux_desktop_fixture_passed', image: runtime.image, desktopImage: runtime.desktops.image, users: 2, actualDesktopContainers: true, nativeDoneBotStatus: true, nativeCUAFrame: true, originalMCPBridge: true, boundedFileDownload: true, executionUID1000: true, otherSocketAndVolumeDenied: true, crossDesktopNetworkDenied: true, stopStartPersistence: true, rawViewerWebSocket: true, nativeViewerWebSocket: true, runtimeLeaseExpiryStopsAndDisconnectsDesktop: true, subscriptionStopDisconnectsViewer: true, stoppedRuntimeRefusesDesktopAccess: true, combinedEncryptedBackups: true, corruptionRejectsBeforeEitherOverwrite: true, idempotentTwoDiskRestore: true, interruptedTwoDiskRestoreRecovered: true, explicitDesktopUpgradeRetainsHome: true, idleStop: true, purgeRemovesDesktopData: true }));
} catch (error) {
  console.error(JSON.stringify({ event: 'desktop_fixture_failed', code: error.code || 'unknown', name: error.name, frames: error.stack?.split('\n').filter(line => /^\s+at /.test(line)) }));
  for (const id of ids) {
    for (const [role, name] of [['service', runtime.names(id).container], ['desktop', runtime.desktops.names(id).container]]) {
      try {
        const value = await runtime.inspect('container', name);
        console.error(JSON.stringify({ event: 'desktop_fixture_container', instance_id: id, role, state: value?.State?.Status, error: value?.State?.Error, exit_code: value?.State?.ExitCode }));
      } catch (failure) { console.error(JSON.stringify({ event: 'desktop_fixture_inspect_failed', instance_id: id, role, code: failure.code || 'unknown' })); }
    }
  }
  throw error;
} finally {
  clearInterval(renewals);
  for (const client of clients) client.terminate();
  try { await agent.close(); } catch { console.error(JSON.stringify({ event: 'desktop_fixture_agent_close_failed' })); }
  const cleanup = new DockerRuntime(config);
  const results = await Promise.allSettled(ids.map(id => cleanup.purge(id))); await cleanup.close();
  if (results.every(r => r.status === 'fulfilled')) await rm(dir, { recursive: true, force: true });
  else {
    console.error(JSON.stringify({ event: 'desktop_fixture_cleanup_failed', directory: dir, errors: results.map((result, i) => ({ instance_id: ids[i], code: result.reason?.code || (result.status === 'fulfilled' ? '' : 'unknown') })) }));
    if (process.exitCode === undefined) process.exitCode = 1;
  }
}
