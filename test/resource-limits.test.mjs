import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, openSync, closeSync, ftruncateSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cloudStorageLimits, requireDesktopImage } from '../src/resource-limits.mjs';
import { DockerRuntime } from '../src/docker.mjs';
import { LEGACY_PERSONAL_RUNTIME, PERSONAL_RUNTIME } from '../src/team-runtime.mjs';
import { BoundedDisks } from '../src/storage.mjs';
import { Backups } from '../src/backups.mjs';
import { Store } from '../src/store.mjs';

const GiB = 1024 ** 3;
test('personal Cloud defaults to 20 GiB runtime data disk without requiring a graphical desktop image', () => {
  assert.deepEqual(cloudStorageLimits(), { runtime: 20 * GiB, desktop: 0 });
  assert.deepEqual(cloudStorageLimits(10 * GiB), { runtime: 10 * GiB, desktop: 0 });
  assert.deepEqual(cloudStorageLimits(10 * GiB, 10 * GiB), { runtime: 10 * GiB, desktop: 10 * GiB });
  for (const [runtime, desktop] of [[21 * GiB, 0], [20 * GiB, 11 * GiB], [NaN, 0], [GiB + 1, 0], [0, 0]]) assert.throws(() => cloudStorageLimits(runtime, desktop));
  assert.doesNotThrow(() => requireDesktopImage(undefined, false));
  assert.doesNotThrow(() => requireDesktopImage('sha256:' + 'a'.repeat(64), false));
  assert.throws(() => requireDesktopImage('latest', false), /immutable/);
  assert.doesNotThrow(() => requireDesktopImage(undefined, true));
});
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dbc-quota-')), store = new Store(dir);
  store.db.exec('CREATE TABLE disks(id TEXT PRIMARY KEY,bytes INTEGER NOT NULL,state TEXT NOT NULL)');
  const disks = Object.assign(Object.create(BoundedDisks.prototype), { bytes: 10 * GiB, store, dir });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { disks, store, dir };
}
test('existing smaller disk sizes survive restart without expanding or rewriting metadata', t => {
  const { disks, store } = fixture(t), old = randomUUID();
  store.run('INSERT INTO disks VALUES(?,?,?)', old, 5 * GiB, 'ready');
  assert.equal(disks.bytesFor(old), 5 * GiB);
  assert.equal(disks.bytesFor(randomUUID()), 10 * GiB);
  assert.equal(store.get('SELECT bytes FROM disks WHERE id=?', old).bytes, 5 * GiB);
  for (const size of [11 * GiB, 0, GiB + 1]) {
    store.run('UPDATE disks SET bytes=? WHERE id=?', size, old);
    assert.throws(() => disks.bytesFor(old), { code: 'storage_spec_mismatch' });
  }
});
test('legacy disk backup and restore use persisted size after the configured default increases', async t => {
  const { disks, store, dir } = fixture(t), id = randomUUID(), oldBytes = 128 * 1024 ** 2;
  store.run('INSERT INTO disks VALUES(?,?,?)', id, oldBytes, 'ready');
  const fd = openSync(disks.path(id), 'wx', 0o600); ftruncateSync(fd, oldBytes); closeSync(fd);
  writeFileSync(disks.path(id), 'before', { flag: 'r+' });
  Object.assign(disks, { check() {}, unmount: async () => {}, mounted: () => false, run: async () => {} });
  const backups = new Backups({ stateDir: dir, store, disks });
  const snapshot = await backups.create(id, randomUUID());
  assert.equal(snapshot.bytes, oldBytes);
  writeFileSync(disks.path(id), 'after!', { flag: 'r+' });
  await backups.restore(id, snapshot.id);
  const buffer = readFileSync(disks.path(id));
  assert.equal(buffer.length, oldBytes); assert.equal(buffer.subarray(0, 6).toString(), 'before');
  assert.equal(disks.bytesFor(id), oldBytes);
});

test('personal Cloud enforces 2c/4g runtime while allowing legacy 1c/2g containers during prepare-upgrade', () => {
  assert.deepEqual(PERSONAL_RUNTIME, { cpu_millis: 2000, memory_mib: 4096, pids: 512 });
  assert.deepEqual(LEGACY_PERSONAL_RUNTIME, { cpu_millis: 1000, memory_mib: 2048, pids: 256 });
  const id = randomUUID(), image = 'sha256:' + 'a'.repeat(64);
  const runtime = Object.create(DockerRuntime.prototype);
  Object.assign(runtime, {
    image,
    stateDir: '/tmp/dbc-spec-test',
    namespace: randomUUID(),
    gatewayRequired: false,
    desktops: null,
    egress: null,
    teamSecurity: null,
    teamConfiguration: () => null,
  });
  const names = runtime.names(id);
  const makeContainer = spec => ({
    Config: { Image: image, User: '1001:1001', Env: [], Labels: runtime.labels(id) },
    HostConfig: {
      ReadonlyRootfs: true,
      Privileged: false,
      Memory: spec.memory_mib * 1024 ** 2,
      MemorySwap: spec.memory_mib * 1024 ** 2,
      NanoCpus: spec.cpu_millis * 1e6,
      PidsLimit: spec.pids,
      CapDrop: ['ALL'],
      CapAdd: [],
      SecurityOpt: ['no-new-privileges:true'],
      Tmpfs: { '/run': 'rw', '/tmp': 'rw' },
      NetworkMode: 'none',
      Dns: [],
      PortBindings: {},
    },
    Mounts: [
      { Type: 'volume', Name: names.volume, Destination: '/data' },
      { Type: 'bind', Source: names.edge, Destination: '/run/donebot' },
    ],
    NetworkSettings: { Networks: { none: {} } },
  });
  assert.doesNotThrow(() => runtime.checkContainer(makeContainer(PERSONAL_RUNTIME), id, names));
  assert.throws(() => runtime.checkContainer(makeContainer(LEGACY_PERSONAL_RUNTIME), id, names), { code: 'resource_spec_mismatch' });
  assert.doesNotThrow(() => runtime.checkContainer(makeContainer(LEGACY_PERSONAL_RUNTIME), id, names, { allowLegacyPersonalSpec: true }));
});
