import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createAgent } from '../src/agent.mjs';
import { createControl } from '../src/control.mjs';
import { Gateway } from '../src/gateway.mjs';
import { syntheticGateway } from './fixtures.mjs';
import { DoneBotFixtureRuntime } from './donebot-fixture.mjs';
import { socketJSON } from '../src/common.mjs';

const dir = await mkdtemp('/tmp/dbc-real-'), upstream = await syntheticGateway(), runtime = new DoneBotFixtureRuntime(dir, process.env.DONEBOT_SOURCE_DIR), agentSocket = join(dir, 'agent.sock');
let agent, app;
try {
  agent = await createAgent({ socketPath: agentSocket, runtime, development: true });
  const config = { stateDir: join(dir, 'control'), agentSocket, gateway: new Gateway({ ...upstream, mode: 'development' }), intervalMs: 60000 };
  app = await createControl(config);
  const api = async (token, path, method = 'GET', value, raw = false) => {
    const r = await fetch(app.origin + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': raw ? 'text/plain' : 'application/json', 'idempotency-key': `${method}-${path.replaceAll(/[^A-Za-z0-9]/g, '_')}`.slice(0, 100) }, body: value === undefined ? undefined : raw ? value : JSON.stringify(value), signal: AbortSignal.timeout(45000) });
    const out = await r.json(); assert.ok(r.ok, `${method} ${path} returned ${r.status}: ${JSON.stringify(out)}`); return out;
  };
  const wait = async (token, id) => {
    for (let i = 0; i < 600; i++) { const ops = (await api(token, `/v1/instances/${id}/operations`)).operations; if (ops.some(o => o.state === 'failed')) assert.fail(JSON.stringify(ops)); if (ops.length && ops.every(o => o.state === 'succeeded')) return; await new Promise(resolve => setTimeout(resolve, 100)); }
    assert.fail('fixture operation timed out');
  };
  const users = [];
  for (const name of ['a', 'b']) {
    const token = (await api('', '/v1/login', 'POST', { email: name, password: upstream.password })).token;
    const id = (await api(token, '/v1/instances', 'POST', {})).instance.id; await wait(token, id);
    const prefix = `/v1/instances/${id}/proxy`;
    const bot = (await api(token, prefix + '/api/bots?messages=0')).bots[0];
    await api(token, prefix + `/api/bots/${bot.id}`, 'PATCH', { name: `Cloud ${name}` });
    await api(token, prefix + `/api/bots/${bot.id}/memory`, 'PUT', { text: `Private memory ${name}` });
    const uploaded = await api(token, prefix + '/api/files?name=private.txt', 'POST', `Private file ${name}`, true);
    await api(token, prefix + `/api/bots/${bot.id}/messages`, 'POST', { text: `Private chat ${name}`, threadId: bot.threadId });
    let messages;
    for (let i = 0; i < 400; i++) { messages = await api(token, prefix + `/api/threads/${bot.threadId}/messages?limit=10`); if (messages.messages?.some(m => m.role === 'bot' && m.kind === 'text')) break; await new Promise(resolve => setTimeout(resolve, 100)); }
    assert.ok(messages.messages.some(m => m.role === 'bot' && m.kind === 'text'), 'fake engine did not reply');
    users.push({ name, token, id, prefix, bot, uploaded });
    await assert.rejects(socketJSON(runtime.instances.get(id).target.socketPath, '/api/auth/session'), e => [401, 403].includes(e.status));
  }
  for (const [own, other] of [[users[0], users[1]], [users[1], users[0]]]) {
    const r = await fetch(app.origin + other.prefix + `/api/bots/${other.bot.id}/memory`, { headers: { authorization: `Bearer ${own.token}`, 'x-user-id': other.name } }); assert.equal(r.status, 404);
    await api(own.token, `/v1/instances/${own.id}/stop`, 'POST', {}); await wait(own.token, own.id);
    await api(own.token, `/v1/instances/${own.id}/start`, 'POST', {}); await wait(own.token, own.id);
  }
  await app.close(); app = await createControl(config);
  for (const u of users) {
    assert.equal((await api(u.token, u.prefix + '/api/bots?messages=0')).bots[0].name, `Cloud ${u.name}`);
    assert.equal((await api(u.token, u.prefix + `/api/bots/${u.bot.id}/memory`)).text, `Private memory ${u.name}`);
    const messages = await api(u.token, u.prefix + `/api/threads/${u.bot.threadId}/messages?limit=10`);
    assert.ok(messages.messages.some(m => m.text === `Private chat ${u.name}`));
    const file = await readFile(u.uploaded.path, 'utf8'); assert.equal(file, `Private file ${u.name}`);
  }
  console.log(JSON.stringify({ result: 'passed', users: 2, actualDoneBotProcesses: true, fakeEngineReplies: true, stopStartPersistence: ['chat', 'file', 'memory', 'profile'], cloudRestart: true, crossOwnerDenied: true, directUnauthenticatedSessionDenied: true, linuxContainersVerified: false, fixtureLogs: [...runtime.instances.values()].map(e => e.fixture.info.logPath) }, null, 2));
} finally {
  await app?.close(); await agent?.close(); await upstream.close(); await rm(dir, { recursive: true, force: true });
}
