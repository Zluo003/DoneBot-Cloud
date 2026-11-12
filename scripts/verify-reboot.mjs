import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DockerRuntime } from '../src/docker.mjs';

if (process.platform !== 'linux' || process.getuid() !== 0 || process.env.CLOUD_DISPOSABLE_LINUX !== '1') throw new Error('run only in a disposable root Linux fixture');
const [phase, saved] = process.argv.slice(2);
const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
const path = phase === 'prepare' ? join(mkdtempSync('/var/tmp/dbc-reboot-'), 'fixture.json') : saved;
if (!/^\/var\/tmp\/dbc-reboot-[a-zA-Z0-9]+\/fixture\.json$/.test(path || '')) throw new Error('explicit owned fixture manifest required');
const dir = path.slice(0, -'/fixture.json'.length);
const value = phase === 'prepare' ? { boot, ids: [randomUUID(), randomUUID()], config: { stateDir: join(dir, 'resources'), image: process.env.CLOUD_DONEBOT_IMAGE, binary: '/usr/bin/docker', storage: 'bounded-ext4', storageBytes: 128 * 1024 ** 2, ...(process.env.CLOUD_DESKTOP_IMAGE ? { desktopImage: process.env.CLOUD_DESKTOP_IMAGE, desktopBytes: 512 * 1024 ** 2 } : {}) } } : JSON.parse(readFileSync(path));
if (value.config.stateDir !== join(dir, 'resources')) throw new Error('fixture manifest ownership mismatch');
const runtime = new DockerRuntime(value.config);
if (runtime.desktops) runtime.desktops.allowed = id => value.ids.includes(id);
let closed = false;
const inside = (id, code, ...args) => runtime.docker(['container', 'exec', runtime.names(id).container, 'node', '--input-type=module', '-e', code, ...args]);
try {
  if (phase === 'prepare') {
    writeFileSync(path, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    for (const [i, id] of value.ids.entries()) {
      await runtime.start(id); await inside(id, "import{writeFileSync}from'node:fs';writeFileSync('/data/reboot-marker',process.argv[1]);", String(i));
      if (runtime.desktops) { await runtime.desktops.start(id); assert.equal((await runtime.desktops.exec(id, { command: `printf desktop${i} > reboot-marker` })).exitCode, 0); }
    }
    console.log(JSON.stringify({ result: 'reboot_prepared', manifest: path, users: 2, boot }));
  } else if (phase === 'verify') {
    assert.notEqual(boot, value.boot, 'a new Linux kernel boot is required');
    for (const id of value.ids) assert.equal((await runtime.status(id)).state, 'stopped');
    if (runtime.desktops) for (const id of value.ids) assert.equal((await runtime.desktops.status(id)).container, 'stopped');
    await runtime.recover();
    for (const [i, id] of value.ids.entries()) {
      await runtime.start(id); assert.equal(await inside(id, "import{readFileSync}from'node:fs';process.stdout.write(readFileSync('/data/reboot-marker'));"), String(i));
      if (runtime.desktops) { await runtime.desktops.start(id); assert.equal((await runtime.desktops.exec(id, { command: 'cat reboot-marker' })).stdout, `desktop${i}`); }
    }
    for (const id of value.ids) await runtime.purge(id);
    console.log(JSON.stringify({ result: 'linux_reboot_fixture_passed', actualKernelReboot: true, users: 2, noAutomaticContainerRestart: true, diskRemounted: true, persistentUsersSeparated: true, desktopsVerified: !!runtime.desktops, scopedPurge: true }));
    await runtime.close(); closed = true; rmSync(dir, { recursive: true, force: true });
  } else throw new Error('use prepare or verify');
} finally { if (!closed) await runtime.close(); }
