import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { chownSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DockerRuntime } from '../src/docker.mjs';
import { createAgent } from '../src/agent.mjs';
import { socketJSON } from '../src/common.mjs';

if (process.platform !== 'linux' || process.getuid() !== 0 || process.env.CLOUD_DISPOSABLE_LINUX !== '1') throw new Error('run only in a disposable root Linux fixture');
const seed = JSON.parse(readFileSync(process.env.CLOUD_BROWSER_SEED_FILE, 'utf8'));
assert.equal(seed.length, 1); assert.equal(seed[0].name, 'Offline browser fixture');
const dir = await mkdtemp('/tmp/dbc-browser-'), ids = [randomUUID(), randomUUID()];
const runtime = new DockerRuntime({ stateDir: join(dir, 'resources'), image: process.env.CLOUD_DONEBOT_IMAGE, binary: '/usr/bin/docker', storage: 'bounded-ext4', storageBytes: 512 * 1024 ** 2, egress: 'public-web', nftBinary: '/usr/sbin/nft' });
const socketPath = join(dir, 'agent.sock'), origin = 'https://donebot.cn';
const agent = await createAgent({ socketPath, runtime, publicOrigin: origin, development: true });
const prefix = id => `/v1/instances/${id}/proxy`;
async function api(id, path, method = 'GET', body) {
  return await new Promise((resolve, reject) => {
    const req = request({ socketPath, path: prefix(id) + path, method, agent: false, headers: { 'x-cloud-origin': origin, 'content-type': 'application/json' }, timeout: 90000 }, res => {
      let text = ''; res.on('data', b => text += b); res.on('end', () => { try { assert.equal(res.statusCode, 200, text); resolve(JSON.parse(text)); } catch (e) { reject(e); } });
    }); req.on('error', reject); req.on('timeout', () => req.destroy(new Error('API timeout'))); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const streams = [];
async function live(id, bot) {
  const messages = []; let error, viewer;
  const req = request({ socketPath, path: prefix(id) + `/api/bots/${bot}/browser/live`, agent: false, headers: { 'x-cloud-origin': origin } }, res => {
    let pending = ''; res.setEncoding('utf8');
    res.on('data', text => {
      pending += text; let index;
      while ((index = pending.indexOf('\n\n')) >= 0) {
        const event = pending.slice(0, index); pending = pending.slice(index + 2);
        const data = event.split('\n').find(line => line.startsWith('data: ')); if (!data) continue;
        const type = event.split('\n').find(line => line.startsWith('event: '))?.slice(7);
        const message = { type, ...JSON.parse(data.slice(6)) }; messages.push(message);
        if (message.type === 'ready') viewer = message.viewerId;
        if (message.type === 'error') error = new Error(message.message);
        if (message.type === 'frame' && viewer) void api(id, `/api/bots/${bot}/browser/action`, 'POST', { viewerId: viewer, type: 'ack', seq: message.seq }).catch(() => {});
      }
    });
    res.on('error', e => { error = e; });
    if (res.statusCode !== 200) res.on('end', () => { error = new Error(pending); });
  }); req.on('error', e => { error = e; }); req.end(); streams.push(req);
  const wait = async predicate => {
    const until = Date.now() + 90000;
    while (!predicate(messages)) { if (error) throw error; if (Date.now() > until) throw new Error('browser stream timeout: ' + JSON.stringify(messages.map(m => ({ type: m.type, message: m.message })))); await new Promise(r => setTimeout(r, 100)); }
  };
  await wait(() => viewer);
  const action = value => api(id, `/api/bots/${bot}/browser/action`, 'POST', { viewerId: viewer, ...value });
  return { req, viewer, action, wait };
}
const profileStorage = async (id, value) => JSON.parse(await runtime.docker(['container', 'exec', runtime.names(id).container, 'node', '--input-type=module', '-e', `
import{readdirSync,readFileSync,existsSync}from'node:fs';import{join}from'node:path';
const roots=['/data/.donebot/agent-browser-profiles','/data/.donebot/browser/profiles'];let port;
function scan(path,depth=0){if(depth>4||!existsSync(path))return;for(const e of readdirSync(path,{withFileTypes:true})){const p=join(path,e.name);if(e.name==='DevToolsActivePort'){port=Number(readFileSync(p,'utf8').split('\\n')[0]);return}if(e.isDirectory())scan(p,depth+1)}}
for(const root of roots)scan(root);if(!port)throw Error('no private Chrome debugging port');
const pages=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();const page=pages.find(p=>p.url.startsWith('https://example.com'));if(!page)throw Error('public HTTPS page not loaded');
const ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true})});
const value=JSON.parse(process.argv[1]);const expression=value===null?"localStorage.getItem('dbc-fixture')":"localStorage.setItem('dbc-fixture',"+JSON.stringify(value)+");localStorage.getItem('dbc-fixture')";
const answer=new Promise((r,j)=>{const t=setTimeout(()=>j(Error('CDP timeout')),10000);ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id===1){clearTimeout(t);r(m)}})});ws.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression,returnByValue:true}}));const result=await answer;ws.close();process.stdout.write(JSON.stringify(result.result.result.value));
`, JSON.stringify(value)]));
try {
  const bots = [];
  for (const id of ids) {
    await socketJSON(socketPath, `/v1/instances/${id}/start`, 'POST', {});
    await api(id, '/api/config', 'PATCH', { features: { browser: true } });
    await socketJSON(socketPath, `/v1/instances/${id}/stop`, 'POST', {});
    const registry = join(runtime.disks.mountPath(id), '.donebot', 'bots.json');
    writeFileSync(registry, JSON.stringify(seed), { mode: 0o600 }); chownSync(registry, 1001, 1001);
    await socketJSON(socketPath, `/v1/instances/${id}/start`, 'POST', {});
    const bot = seed[0].id; bots.push(bot);
    const view = await live(id, bot); await view.action({ type: 'take' });
    await view.action({ type: 'navigate', url: 'https://example.com' });
    await view.wait(messages => messages.some(m => m.type === 'frame'));
    assert.equal(await profileStorage(id, null), null);
    assert.equal(await profileStorage(id, id), id);
    await view.action({ type: 'release' }); view.req.destroy();
  }
  await socketJSON(socketPath, `/v1/instances/${ids[0]}/stop`, 'POST', {});
  await socketJSON(socketPath, `/v1/instances/${ids[0]}/start`, 'POST', {});
  const restored = await live(ids[0], bots[0]); await restored.action({ type: 'take' });
  await restored.action({ type: 'navigate', url: 'https://example.com' });
  assert.equal(await profileStorage(ids[0], null), ids[0]);
  assert.equal(await profileStorage(ids[1], null), ids[1]);
  await assert.rejects(api(ids[1], `/api/bots/${bots[1]}/browser/action`, 'POST', { viewerId: restored.viewer, type: 'take' }));
  console.log(JSON.stringify({ result: 'linux_browser_fixture_passed', actualLinuxContainers: true, users: 2, nativeBrowserSSE: true, renderedFrames: true, publicHTTPSNavigation: true, separateChromeProfiles: true, localStorageSurvivesRestart: true, crossInstanceViewerRejected: true, privateCDPInsideTenantOnly: true, realModelCalls: false }));
} finally {
  for (const stream of streams) stream.destroy(); await agent.close();
  const cleanup = new DockerRuntime({ stateDir: join(dir, 'resources'), image: process.env.CLOUD_DONEBOT_IMAGE, binary: '/usr/bin/docker', storage: 'bounded-ext4', storageBytes: 512 * 1024 ** 2, egress: 'public-web', nftBinary: '/usr/sbin/nft' });
  const results = await Promise.allSettled(ids.map(id => cleanup.purge(id))); cleanup.close();
  if (results.every(r => r.status === 'fulfilled')) await rm(dir, { recursive: true, force: true }); else throw new Error('browser cleanup incomplete; preserve state: ' + dir);
}
