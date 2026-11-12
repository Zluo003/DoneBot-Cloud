import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DockerRuntime } from '../src/docker.mjs';
if (process.platform !== 'linux' || process.getuid() !== 0 || process.env.CLOUD_DISPOSABLE_LINUX !== '1') throw new Error('run only in a disposable root Linux fixture');
const dir = await mkdtemp('/tmp/dbc-upgrade-'), id = randomUUID();
const old = process.env.CLOUD_DONEBOT_IMAGE, next = process.env.CLOUD_UPGRADE_IMAGE;
if (old === next || !next) throw new Error('two distinct immutable reviewed images required');
const config = { stateDir: join(dir, 'resources'), binary: '/usr/bin/docker', storage: 'bounded-ext4', storageBytes: 128 * 1024 ** 2 };
let runtime = new DockerRuntime({ ...config, image: old });
try {
  await runtime.start(id);
  await assert.rejects(runtime.prepareUpgrade(id, old), { code: 'stop_instance_before_upgrade' });
  await runtime.docker(['container', 'exec', runtime.names(id).container, 'node', '-e', "require('node:fs').writeFileSync('/data/upgrade-marker','retained')"]);
  await runtime.stop(id); runtime.close(); runtime = new DockerRuntime({ ...config, image: next });
  await assert.rejects(runtime.start(id), { code: 'resource_spec_mismatch' });
  await runtime.prepareUpgrade(id, old); await runtime.prepareUpgrade(id, old);
  assert.ok(await runtime.inspect('volume', runtime.names(id).volume));
  await runtime.start(id);
  assert.equal((await runtime.inspect('container', runtime.names(id).container)).Config.Image, next);
  assert.equal(await runtime.docker(['container', 'exec', runtime.names(id).container, 'node', '-e', "process.stdout.write(require('node:fs').readFileSync('/data/upgrade-marker'))"]), 'retained');
  console.log(JSON.stringify({ result: 'upgrade_fixture_passed', actualLinuxContainers: true, liveUpgradeRejected: true, implicitImageReplacementRejected: true, explicitStoppedUpgrade: true, retainedVolume: true, idempotentPreparation: true, noAutomaticRollbackOfData: true }));
} finally { await runtime.purge(id); runtime.close(); await rm(dir, { recursive: true, force: true }); }
