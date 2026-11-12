import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DockerRuntime } from '../src/docker.mjs';

if (process.platform !== 'linux' || process.getuid() !== 0 || process.env.CLOUD_DISPOSABLE_LINUX !== '1') throw new Error('disposable root Linux fixture required');
const dir = mkdtempSync('/var/tmp/dbc-backup-groups-'), id = randomUUID();
const runtime = new DockerRuntime({ stateDir: join(dir, 'resources'), image: process.env.CLOUD_DONEBOT_IMAGE, desktopImage: process.env.CLOUD_DESKTOP_IMAGE, storage: 'bounded-ext4', storageBytes: 128 * 1024 ** 2, desktopBytes: 128 * 1024 ** 2, binary: '/usr/bin/docker' });
const expected = new Map();
async function markers(text) {
  await runtime.disks.ensure(id, false); await runtime.desktops.ensureStorage(id);
  writeFileSync(join(runtime.disks.mountPath(id), 'marker'), 'main-' + text);
  writeFileSync(join(runtime.desktops.disks.mountPath(id), 'marker'), 'desktop-' + text);
}
try {
  await markers('initial');
  const key = randomUUID(), create = runtime.desktops.backups.create.bind(runtime.desktops.backups);
  runtime.desktops.backups.create = async () => { throw new Error('fixture desktop snapshot interruption'); };
  await assert.rejects(runtime.backups.create(id, key));
  runtime.desktops.backups.create = create;
  const first = await runtime.backups.create(id, key);
  assert.equal((await runtime.backups.create(id, key)).id, first.id);
  const firstFiles = [runtime.backups.main.path(first.main), runtime.desktops.backups.path(first.desktop)];
  for (let i = 0; i < 5; i++) {
    await markers(String(i)); const row = await runtime.backups.automatic(id, 1); expected.set(row.id, String(i));
    assert.ok(runtime.backups.list(id).length <= 3);
  }
  assert.equal(runtime.backups.list(id).length, 3);
  assert.equal(runtime.backups.main.list(id).length, 3); assert.equal(runtime.desktops.backups.list(id).length, 3);
  for (const file of firstFiles) assert.equal(existsSync(file), false);
  const snapshot = runtime.backups.list(id)[1];
  await markers('changed'); await runtime.backups.restore(id, snapshot.id, randomUUID());
  await runtime.disks.ensure(id, false); await runtime.desktops.ensureStorage(id);
  assert.equal(readFileSync(join(runtime.disks.mountPath(id), 'marker'), 'utf8'), 'main-' + expected.get(snapshot.id));
  assert.equal(readFileSync(join(runtime.desktops.disks.mountPath(id), 'marker'), 'utf8'), 'desktop-' + expected.get(snapshot.id));
  console.log(JSON.stringify({ result: 'paired_backups_fixture_passed', actualExt4Filesystems: 2, desktopContainersStarted: false, interruptedSnapshotRetry: true, noDuplicateSnapshots: true, automaticRotationKeepsThreePairs: true, evictedPairFilesRemoved: true, retainedPairRestoresBothMarkers: true }));
} finally { await runtime.purge(id); await runtime.close(); rmSync(dir, { recursive: true, force: true }); }
