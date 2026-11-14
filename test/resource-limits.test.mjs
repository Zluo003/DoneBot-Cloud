import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, openSync, closeSync, ftruncateSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cloudStorageLimits, requireDesktopImage } from '../src/resource-limits.mjs';
import { BoundedDisks } from '../src/storage.mjs';
import { Backups } from '../src/backups.mjs';
import { Store } from '../src/store.mjs';

const GiB = 1024 ** 3;
test('standard runtime and graphical desktop have a hard combined 15 GiB ceiling', () => {
  assert.deepEqual(cloudStorageLimits(), { runtime: 5 * GiB, desktop: 10 * GiB });
  assert.deepEqual(cloudStorageLimits(6 * GiB, 9 * GiB), { runtime: 6 * GiB, desktop: 9 * GiB });
  for (const [runtime, desktop] of [[5 * GiB, 11 * GiB], [16 * GiB, GiB], [NaN, GiB], [GiB + 1, GiB], [0, GiB]]) assert.throws(() => cloudStorageLimits(runtime, desktop));
  assert.throws(() => requireDesktopImage(undefined, false), /CLOUD_DESKTOP_IMAGE/);
  assert.doesNotThrow(() => requireDesktopImage('sha256:' + 'a'.repeat(64), false));
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
