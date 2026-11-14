import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DockerRuntime } from '../src/docker.mjs';
import { hostLock } from '../src/host-lock.mjs';
import { socketJSON } from '../src/common.mjs';

if (process.platform !== 'linux' || process.getuid() !== 0 || process.env.CLOUD_DISPOSABLE_LINUX !== '1') throw new Error('run only in a disposable root Linux fixture');
const run = promisify(execFile), dir = await mkdtemp('/var/tmp/dbc-service-'), stateDir = join(dir, 'state'), id = randomUUID();
const socket = join(dir, 'agent.sock'), unit = 'dbc-fixture-' + randomUUID() + '.service', root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const config = { stateDir, image: process.env.CLOUD_DONEBOT_IMAGE, desktopImage: process.env.CLOUD_DESKTOP_IMAGE, desktopBytes: 128 * 1024 ** 2, binary: '/usr/bin/docker', storage: 'bounded-ext4', storageBytes: 128 * 1024 ** 2, gatewayRequired: true };
const system = (...args) => run('/usr/bin/systemctl', args, { timeout: 160000 });
const childLock = () => run(process.execPath, ['--input-type=module', '-e', `import{hostLock}from${JSON.stringify(new URL('../src/host-lock.mjs', import.meta.url).href)};const release=hostLock(process.argv[1]);release();`, stateDir]);
const runtime = new DockerRuntime(config);
async function until(check) { for (let i = 0; i < 200; i++) { try { if (await check()) return; } catch {} await new Promise(r => setTimeout(r, 100)); } throw new Error('fixture service timeout'); }
try {
  const unlock = hostLock(stateDir); try { await assert.rejects(childLock()); } finally { unlock(); }
  await childLock();
  const env = { CLOUD_AGENT_STATE_DIR: stateDir, CLOUD_AGENT_SOCKET: socket, CLOUD_DOCKER_BINARY: '/usr/bin/docker', CLOUD_DONEBOT_IMAGE: config.image, CLOUD_STORAGE_BYTES: String(config.storageBytes), CLOUD_DESKTOP_IMAGE: config.desktopImage, CLOUD_DESKTOP_STORAGE_BYTES: String(config.desktopBytes), CLOUD_PUBLIC_ORIGIN: 'https://donebot.cn' };
  await run('/usr/bin/systemd-run', [`--unit=${unit}`, '--property=Type=simple', '--property=PrivateMounts=false', '--property=NoNewPrivileges=true', '--property=TimeoutStopSec=150', `--property=ExecStopPost=${process.execPath} ${root}/src/maintenance.mjs fence`, ...Object.entries(env).map(([k, v]) => `--setenv=${k}=${v}`), process.execPath, join(root, 'src/agent-main.mjs')]);
  await until(async () => (await socketJSON(socket, '/healthz', 'GET', undefined, 1000)).ready);
  await socketJSON(socket, `/v1/instances/${id}/start`, 'POST', { authorized_until: Date.now() + 20000, gateway: { installationId: id, credential: 'sk-donebot-' + randomBytes(32).toString('hex'), user: { id: '10001', email: 'service-fixture@example.test' } } });
  assert.equal((await runtime.status(id)).state, 'running');
  await system('kill', '--signal=KILL', '--kill-whom=main', unit);
  await until(async () => (await system('show', '--property=ActiveState', '--value', unit)).stdout.trim() === 'failed');
  assert.equal((await runtime.status(id)).state, 'stopped');
  await childLock();
  console.log(JSON.stringify({ result: 'systemd_fixture_passed', actualLinuxContainers: true, exclusiveHostLock: true, lockReleasedAfterExit: true, systemdAgentStarted: true, hostMountVisibleToDocker: true, readiness: true, killedAgentFencedByExecStopPost: true, stoppedDataRetained: true }));
} finally {
  await system('stop', unit).catch(() => {}); await system('reset-failed', unit).catch(() => {});
  await runtime.purge(id); runtime.close(); await rm(dir, { recursive: true, force: true });
}
