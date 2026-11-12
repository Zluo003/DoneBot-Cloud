import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DockerRuntime } from '../src/docker.mjs';
import { createAgent } from '../src/agent.mjs';
import { close, listen, socketJSON } from '../src/common.mjs';

if (process.platform !== 'linux' || process.getuid() !== 0 || process.env.CLOUD_DISPOSABLE_LINUX !== '1') throw new Error('run only inside a disposable root Linux fixture');
const dir = await mkdtemp('/tmp/dbc-socket-'), ids = [randomUUID(), randomUUID()];
const runtime = new DockerRuntime({ stateDir: join(dir, 'resources'), image: process.env.CLOUD_DONEBOT_IMAGE, binary: '/usr/bin/docker', storage: 'bounded-ext4', storageBytes: 128 * 1024 ** 2, gatewayRequired: true });
const origin = 'https://donebot.cn', socket = join(dir, 'agent.sock');
let canaryHits = 0;
const canary = createServer((_req, res) => { canaryHits++; res.end('host-service-canary'); });
await listen(canary, join(dir, 'host-canary.sock'));
const agent = await createAgent({ socketPath: socket, runtime, publicOrigin: origin, development: true });
const get = (socketPath, path, headers = {}) => new Promise((resolve, reject) => { const req = request({ socketPath, path, headers, timeout: 5000 }, res => { let text = ''; res.on('data', b => text += b); res.on('end', () => resolve({ status: res.statusCode, text })); }); req.on('error', reject); req.on('timeout', () => req.destroy(new Error('fixture timeout'))); req.end(); });
try {
  for (const [i, id] of ids.entries()) {
    runtime.configureGateway(id, { installationId: id, credential: 'sk-donebot-' + randomBytes(32).toString('hex'), user: { id: String(101 + i), email: `synthetic${i}@example.test` } });
    await socketJSON(socket, `/v1/instances/${id}/start`, 'POST', {});
    const session = await get(socket, `/v1/instances/${id}/proxy/api/auth/session`, { 'x-cloud-origin': origin }); assert.equal(session.status, 200);
    const state = await get(socket, `/v1/instances/${id}/proxy/api/donebot/state`, { 'x-cloud-origin': origin });
    const account = JSON.parse(state.text); assert.equal(account.authenticated, true); assert.equal(account.user.id, String(101 + i)); assert.doesNotMatch(state.text, /sk-donebot-|accessToken|refreshToken/);
  }
  const pinned = runtime.pinSocket(ids[0]);
  assert.equal(JSON.parse((await get(pinned.socketPath, '/api/health')).text).app, 'donebot');
  await runtime.docker(['container', 'exec', runtime.names(ids[0]).container, 'node', '--input-type=module', '-e', "import{unlinkSync,symlinkSync}from'node:fs';unlinkSync('/run/donebot/http.sock');symlinkSync(process.argv[1],'/run/donebot/http.sock');", join(dir, 'host-canary.sock')]);
  assert.throws(() => runtime.pinSocket(ids[0]), { code: 'instance_socket_ownership_mismatch' });
  assert.equal(JSON.parse((await get(pinned.socketPath, '/api/health')).text).app, 'donebot'); pinned.release();
  await assert.rejects(runtime.authProbe(ids[0], 'synthetic-native-session-canary'), { code: 'instance_socket_ownership_mismatch' });
  assert.equal((await get(socket, `/v1/instances/${ids[0]}/proxy/containers/json`, { 'x-cloud-origin': origin })).status, 409);
  assert.equal(canaryHits, 0);
  assert.equal((await get(socket, `/v1/instances/${ids[1]}/proxy/api/auth/session`, { 'x-cloud-origin': origin })).status, 200);
  console.log(JSON.stringify({ result: 'socket_bootstrap_fixture_passed', actualLinuxContainers: true, users: 2, automaticCredentialRestore: true, separateGatewayIdentity: true, credentialAbsentFromPublicState: true, socketSymlinkRejected: true, socketReplacementRacePinned: true, credentialProbePinned: true, hostSocketNeverReached: true, otherUserUnaffected: true }));
} finally {
  await agent.close(); await close(canary);
  const cleanup = new DockerRuntime({ stateDir: join(dir, 'resources'), image: process.env.CLOUD_DONEBOT_IMAGE, binary: '/usr/bin/docker', storage: 'bounded-ext4', storageBytes: 128 * 1024 ** 2, gatewayRequired: true });
  const result = await Promise.allSettled(ids.map(id => cleanup.purge(id))); cleanup.close();
  if (result.every(r => r.status === 'fulfilled')) await rm(dir, { recursive: true, force: true });
  else throw new Error('socket fixture cleanup failed; preserve state: ' + dir);
}
