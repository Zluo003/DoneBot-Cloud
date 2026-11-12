import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { release } from 'node:os';
import { DockerRuntime } from '../src/docker.mjs';

if (process.platform !== 'linux' || process.getuid() !== 0 || process.env.CLOUD_DISPOSABLE_LINUX !== '1') throw new Error('run only as root inside an explicitly disposable Linux fixture');
const dir = await mkdtemp('/tmp/dbc-storage-'), ids = [randomUUID(), randomUUID(), randomUUID()];
const config = { stateDir: join(dir, 'resources'), image: process.env.CLOUD_DONEBOT_IMAGE, binary: '/usr/bin/docker', storage: 'bounded-ext4', storageBytes: 128 * 1024 ** 2 };
let runtime = new DockerRuntime(config);
const inside = (id, script, ...args) => runtime.docker(['container', 'exec', runtime.names(id).container, 'node', '--input-type=module', '-e', script, ...args]);
try {
  for (const [i, id] of ids.slice(0, 2).entries()) {
    await runtime.start(id);
    await inside(id, "import{writeFileSync}from'node:fs';writeFileSync('/data/marker.txt',process.argv[1]);", String(i));
    const volume = await runtime.inspect('volume', runtime.names(id).volume);
    assert.deepEqual(volume.Options, runtime.disks.options(id));
    const resources = await runtime.resources(id);
    assert.equal(resources.storage.enforced, true); assert.equal(resources.storage.limit_bytes, config.storageBytes);
    assert.ok(resources.storage.available_bytes < config.storageBytes && resources.storage.available_bytes > 16 * 1024 ** 2);
  }
  const full = JSON.parse(await inside(ids[0], "import{openSync,writeSync,closeSync}from'node:fs';const f=openSync('/data/fill.bin','wx');const b=Buffer.alloc(1024*1024,1);let written=0,error;try{for(let i=0;i<256;i++)written+=writeSync(f,b)}catch(e){error=e.code}finally{closeSync(f)}process.stdout.write(JSON.stringify({written,error}));"));
  assert.equal(full.error, 'ENOSPC'); assert.ok(full.written > 16 * 1024 ** 2 && full.written < config.storageBytes);
  await inside(ids[1], "import{writeFileSync,readFileSync}from'node:fs';writeFileSync('/data/unaffected.txt','B');process.stdout.write(readFileSync('/data/marker.txt')); ").then(value => assert.equal(value, '1'));
  await inside(ids[0], "import{unlinkSync}from'node:fs';unlinkSync('/data/fill.bin');");
  await runtime.stop(ids[0]); await runtime.start(ids[0]);
  assert.equal(await inside(ids[0], "import{readFileSync,writeFileSync}from'node:fs';writeFileSync('/data/recovered.txt','A');process.stdout.write(readFileSync('/data/marker.txt'));"), '0');
  const originalRun = runtime.disks.run.bind(runtime.disks);
  runtime.disks.run = async () => { throw new Error('fixture format interruption'); };
  await assert.rejects(runtime.start(ids[2]));
  assert.equal(await runtime.inspect('container', runtime.names(ids[2]).container), null);
  assert.equal(await runtime.inspect('volume', runtime.names(ids[2]).volume), null);
  runtime.disks.run = originalRun;
  runtime.close(); runtime = new DockerRuntime(config);
  await runtime.start(ids[2]); await runtime.purge(ids[2]);
  assert.equal(existsSync(runtime.disks.path(ids[2])), false);
  await runtime.purge(ids[0]);
  assert.equal(await runtime.inspect('volume', runtime.names(ids[0]).volume), null);
  assert.equal(existsSync(runtime.disks.path(ids[0])), false);
  assert.equal(await inside(ids[1], "import{readFileSync}from'node:fs';process.stdout.write(readFileSync('/data/unaffected.txt'));"), 'B');
  console.log(JSON.stringify({ result: 'bounded_storage_fixture_passed', platform: process.platform, arch: process.arch, kernel: release(), image: runtime.image, users: 2, bytesPerFilesystem: config.storageBytes, fixedCapacityFilesystem: true, realENOSPC: true, otherUserUnaffected: true, persistenceAndSpaceRecovery: true, interruptedFormatRecovery: true, scopedFilesystemDeletion: true, actualLinuxContainers: true }));
} finally {
  const results = await Promise.allSettled(ids.map(id => runtime.purge(id))); runtime.close();
  if (results.every(r => r.status === 'fulfilled')) await rm(dir, { recursive: true, force: true });
  else throw new Error('storage cleanup incomplete; preserve private fixture state: ' + dir);
}
