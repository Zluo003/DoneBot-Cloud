import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createServer, get } from 'node:http';
import { createSocket } from 'node:dgram';
import { join } from 'node:path';
import { release } from 'node:os';
import { DockerRuntime } from '../src/docker.mjs';

if (process.platform !== 'linux' || process.getuid() !== 0 || process.env.CLOUD_DISPOSABLE_LINUX !== '1') throw new Error('requires root inside an explicitly disposable Linux fixture');
const exec = promisify(execFile), suffix = randomUUID().slice(0, 8), namespace = `dbc-fx-${suffix}`, hostLink = `dbch${suffix}`, peerLink = `dbcp${suffix}`;
const dir = await mkdtemp('/tmp/dbc-egress-'), ids = [randomUUID(), randomUUID()];
const publicIP = '11.22.33.44', deniedPublicIP = '11.22.33.45', hostPublicIP = '11.22.33.46';
const privateIPs = ['10.46.87.1', '100.100.100.200', '169.254.169.254', '168.63.129.16', '192.168.44.7', '192.0.2.2'];
// These public-looking addresses are assigned ONLY inside the disposable fixture.
// Exact routes keep all synthetic requests inside the VM; none go to their real owners.
const routed = [publicIP, deniedPublicIP, ...privateIPs.filter(ip => ip !== '192.0.2.2')], routes = [];
const run = (binary, args) => exec(binary, args, { timeout: 20000, maxBuffer: 1024 * 1024 });
const ip = (...args) => run('/usr/sbin/ip', args);
const config = { stateDir: join(dir, 'resources'), image: process.env.CLOUD_DONEBOT_IMAGE, binary: process.env.CLOUD_DOCKER_BINARY || '/usr/bin/docker', egress: 'public-web', egressDenyIPv4: [deniedPublicIP] };
let runtime = new DockerRuntime(config), probeRuntime, server, namespaceCreated = false, linkCreated = false, hostAddress = false;
const extraHostServers = [];
let publicServer;
const inside = (id, script, ...args) => runtime.docker(['container', 'exec', runtime.names(id).container, 'node', '--input-type=module', '-e', script, ...args]);
const requestScript = `import http from 'node:http';
const targets=JSON.parse(process.argv[1]);
const results=await Promise.all(targets.map(target=>new Promise(resolve=>{
 const url=target.url||target; const req=http.get(url,{agent:false,signal:AbortSignal.timeout(1200),...(target.lookup?{lookup:(_h,o,cb)=>o.all?cb(null,[{address:target.lookup,family:4}]):cb(null,target.lookup,4)}:{})},res=>{res.resume();resolve(res.statusCode===200)});
 req.on('error',()=>resolve(false));
})));process.stdout.write(JSON.stringify(results));`;
const requests = async (id, targets) => JSON.parse(await inside(id, requestScript, JSON.stringify(targets)));
async function hostRequest(url) {
  return new Promise((resolve, reject) => {
    const req = get(url, { agent: false }, res => { let text = ''; res.on('data', b => text += b); res.on('end', () => { try { assert.equal(text, 'fixture'); resolve(); } catch (e) { reject(e); } }); });
    req.on('error', reject); req.setTimeout(3000, () => req.destroy(new Error('host probe timeout')));
  });
}
async function hostUDP(port) {
  await new Promise((resolve, reject) => {
    const socket = createSocket('udp4'), timer = setTimeout(() => done(new Error('UDP fixture unavailable')), 3000);
    function done(error) { clearTimeout(timer); socket.close(); error ? reject(error) : resolve(); }
    socket.once('error', done); socket.once('message', () => done()); socket.send('probe', port, publicIP);
  });
}
try {
  await ip('netns', 'add', namespace); namespaceCreated = true;
  await ip('link', 'add', hostLink, 'type', 'veth', 'peer', 'name', peerLink); linkCreated = true;
  await ip('link', 'set', peerLink, 'netns', namespace);
  await ip('address', 'add', '192.0.2.1/30', 'dev', hostLink); await ip('link', 'set', hostLink, 'up');
  await ip('-n', namespace, 'address', 'add', '192.0.2.2/30', 'dev', peerLink); await ip('-n', namespace, 'link', 'set', peerLink, 'up'); await ip('-n', namespace, 'link', 'set', 'lo', 'up');
  await ip('-n', namespace, 'route', 'add', 'default', 'via', '192.0.2.1');
  for (const address of routed) {
    await ip('-n', namespace, 'address', 'add', `${address}/32`, 'dev', 'lo');
    await ip('route', 'add', `${address}/32`, 'via', '192.0.2.2', 'dev', hostLink); routes.push(address);
  }
  await ip('address', 'add', `${hostPublicIP}/32`, 'dev', 'lo'); hostAddress = true;
  server = createServer((_req, res) => res.end('fixture')); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(443, '0.0.0.0', resolve); });
  for (const port of [80, 18991]) {
    const target = createServer((_req, res) => res.end('fixture')); extraHostServers.push(target);
    await new Promise((resolve, reject) => { target.once('error', reject); target.listen(port, '0.0.0.0', resolve); });
    await hostRequest(`http://${hostPublicIP}:${port}`);
  }
  publicServer = spawn('/usr/sbin/ip', ['netns', 'exec', namespace, process.execPath, '--input-type=module', '-e', `
    import{createServer}from'node:http';import{createSocket}from'node:dgram';
    for(const port of [22,80,443,8080])createServer((_req,res)=>res.end('fixture')).listen(port,'0.0.0.0');
    for(const port of [53,443]){const s=createSocket('udp4');s.on('message',(message,r)=>s.send(message,r.port,r.address));s.bind(port,'0.0.0.0');}
  `], { stdio: ['ignore', 'ignore', 'pipe'] });
  let serverError = ''; publicServer.stderr.on('data', b => serverError += b.toString());
  for (let i = 0; ; i++) { try { await hostRequest(`http://${publicIP}`); break; } catch { if (i > 20 || publicServer.exitCode !== null) throw new Error('synthetic destination unavailable: ' + serverError); await new Promise(resolve => setTimeout(resolve, 100)); } }
  for (const address of [...routed, hostPublicIP]) await hostRequest(`http://${address}:443`);
  await hostRequest(`http://${publicIP}:22`); await hostRequest(`http://${publicIP}:8080`);
  await hostUDP(53); await hostUDP(443);

  // A missing firewall must fail BEFORE creating a network, container or data volume.
  probeRuntime = new DockerRuntime({ ...config, stateDir: join(dir, 'unavailable'), nftBinary: '/nonexistent/fixture-nft' });
  const probeID = randomUUID();
  await assert.rejects(probeRuntime.start(probeID), { code: 'egress_firewall_failed' });
  for (const [kind, name] of [['container', 'container'], ['volume', 'volume'], ['network', 'network']]) assert.equal(await probeRuntime.inspect(kind, probeRuntime.names(probeID)[name]), null);
  probeRuntime.egress.binary = '/usr/sbin/nft';
  const foreignTable = probeRuntime.egress.table;
  await probeRuntime.egress.nft(['-f', '-'], `table inet ${foreignTable} { comment "fixture-other-owner"; }\n`);
  try {
    await assert.rejects(probeRuntime.start(probeID), { code: 'egress_firewall_failed' });
    const untouched = JSON.parse((await run('/usr/sbin/nft', ['-j', 'list', 'table', 'inet', foreignTable])).stdout);
    assert.equal(untouched.nftables.find(item => item.table)?.table.comment, 'fixture-other-owner');
  } finally { await probeRuntime.egress.nft(['delete', 'table', 'inet', foreignTable]); }
  await probeRuntime.purge(probeID); probeRuntime.close(); probeRuntime = undefined;

  for (const id of ids) {
    await runtime.start(id);
    await runtime.docker(['exec', '-d', runtime.names(id).container, 'node', '-e', "require('http').createServer((q,r)=>r.end('tenant')).listen(443,'0.0.0.0')"]);
  }
  const containers = await Promise.all(ids.map(id => runtime.inspect('container', runtime.names(id).container)));
  const tenantIPs = containers.map((c, i) => c.NetworkSettings.Networks[runtime.names(ids[i]).network].IPAddress);
  const gateways = containers.map((c, i) => c.NetworkSettings.Networks[runtime.names(ids[i]).network].Gateway);
  assert.notEqual(tenantIPs[0], tenantIPs[1]); assert.notEqual(gateways[0], gateways[1]);
  for (const [index, id] of ids.entries()) {
    assert.deepEqual(await requests(id, ['http://127.0.0.1:443', `http://${publicIP}`, `http://${publicIP}:443`]), [true, true, true]);
    const denied = [...privateIPs, hostPublicIP, deniedPublicIP, ...gateways, tenantIPs[1 - index]];
    assert.deepEqual(await requests(id, denied.map(address => `http://${address}:443`)), denied.map(() => false));
    assert.deepEqual(await requests(id, [`http://${publicIP}:22`, `http://${publicIP}:8080`, `http://[::ffff:10.46.87.1]:443`, 'http://[64:ff9b::a2e:5701]:443', 'http://[2606:4700:4700::1111]:443', { url: 'http://rebind.fixture.invalid:443', lookup: '10.46.87.1' }]), Array(6).fill(false));
    const udp = JSON.parse(await inside(id, `import{createSocket}from'node:dgram';const result=await Promise.all([53,443].map(port=>new Promise(resolve=>{const s=createSocket('udp4');const timer=setTimeout(()=>{s.close();resolve(false)},1000);s.on('error',()=>{clearTimeout(timer);s.close();resolve(false)});s.on('message',()=>{clearTimeout(timer);s.close();resolve(true)});s.send('probe',port,process.argv[1]);})));process.stdout.write(JSON.stringify(result));`, publicIP));
    assert.deepEqual(udp, [false, false]);
    await assert.rejects(fetch(`http://${tenantIPs[index]}:443`, { signal: AbortSignal.timeout(1000) }));
    const inbound = await run('/usr/sbin/ip', ['netns', 'exec', namespace, process.execPath, '--input-type=module', '-e', requestScript, JSON.stringify([`http://${tenantIPs[index]}:443`])]);
    assert.deepEqual(JSON.parse(inbound.stdout), [false]);
    const internet = JSON.parse(await inside(id, `const web=await fetch('https://example.com',{signal:AbortSignal.timeout(20000)});const gateway=await fetch('https://donebot.cn/api/v1/auth/me',{signal:AbortSignal.timeout(20000)});process.stdout.write(JSON.stringify({web:web.status,gateway:gateway.status}));`));
    assert.deepEqual(internet, { web: 200, gateway: 401 });
  }
  // A rejected atomic update leaves the previous deny rules in place.
  await assert.rejects(runtime.egress.nft(['-f', '-'], `delete table inet ${runtime.egress.table}\nthis is intentionally invalid\n`), { code: 'egress_firewall_failed' });
  assert.deepEqual(await requests(ids[0], [`http://${publicIP}`, `http://${hostPublicIP}:443`]), [true, false]);
  // Only an explicit public gateway IP may reach the shared host's HTTPS listener.
  runtime.close(); runtime = new DockerRuntime({ ...config, gatewayIPv4: [hostPublicIP] });
  for (const [index, id] of ids.entries()) {
    await runtime.start(id);
    assert.deepEqual(await requests(id, [`http://${hostPublicIP}:443`, `http://${hostPublicIP}:80`, `http://${hostPublicIP}:18991`, ...gateways.map(address => `http://${address}:443`), `http://${tenantIPs[1 - index]}:443`, `http://${privateIPs[0]}:443`]), [true, false, false, false, false, false, false]);
  }
  // Agent process recreation retains the owned networks and reinstalls the complete set.
  runtime.close(); runtime = new DockerRuntime(config);
  for (const id of ids) await runtime.start(id);
  assert.deepEqual(await requests(ids[0], [`http://${hostPublicIP}:443`]), [false]);
  await runtime.purge(ids[0]);
  assert.equal(await runtime.inspect('network', runtime.names(ids[0]).network), null);
  assert.deepEqual(await requests(ids[1], [`http://${publicIP}`, `http://${hostPublicIP}:443`]), [true, false]);
  console.log(JSON.stringify({ result: 'controlled_egress_fixture_passed', kernel: release(), node: process.version, docker: (await runtime.docker(['version', '--format', '{{.Server.Version}}'])).trim(), nft: (await run('/usr/sbin/nft', ['--version'])).stdout.trim(), image: runtime.image, users: 2, publicHTTP: true, publicHTTPSAndDNS: true, gatewayAnonymous401: true, tenantNetworkDenied: true, hostPrivateAndPublicDenied: true, metadataDenied: true, customPublicRangeDenied: true, unapprovedTCPAndUDPDenied: true, IPv6Denied: true, mappedIPv4AndRebindingDenied: true, unsolicitedInboundDenied: true, firewallUnavailableBlocksCreation: true, foreignFirewallTablePreserved: true, failedAtomicUpdateRetainsPolicy: true, explicitCohostGatewayHTTPS: true, cohostOtherPortsAndHostAddressesDenied: true, cohostCrossTenantDenied: true, gatewayExceptionRemovalRestoresDeny: true, agentRecreation: true, scopedNetworkRemoval: true }));
} finally {
  const cleanup = await Promise.allSettled(ids.map(id => runtime.purge(id)));
  runtime.close(); probeRuntime?.close();
  publicServer?.kill('SIGTERM');
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  for (const target of extraHostServers) if (target.listening) await new Promise(resolve => target.close(resolve));
  for (const address of routes.reverse()) await ip('route', 'del', `${address}/32`, 'via', '192.0.2.2', 'dev', hostLink);
  if (hostAddress) await ip('address', 'del', `${hostPublicIP}/32`, 'dev', 'lo');
  if (namespaceCreated) await ip('netns', 'del', namespace);
  if (linkCreated) { try { await ip('link', 'del', hostLink); } catch { /* Removing the namespace also removes its veth peer. */ } }
  if (cleanup.every(r => r.status === 'fulfilled')) await rm(dir, { recursive: true, force: true });
  else throw new Error('container/network cleanup incomplete; preserve private recovery state: ' + dir);
}
