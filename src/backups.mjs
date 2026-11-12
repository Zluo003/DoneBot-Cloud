import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, readSync, renameSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { createGzip, createGunzip } from 'node:zlib';
import { join } from 'node:path';
import { Fault, instanceID, privateDir } from './common.mjs';

const flush = path => { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } };

export class Backups {
  constructor({ stateDir, store, disks }) {
    this.dir = privateDir(join(stateDir, 'backups')); this.store = store; this.disks = disks;
    const keyPath = join(this.dir, 'key');
    try { writeFileSync(keyPath, randomBytes(32), { flag: 'wx', mode: 0o600 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    this.key = readFileSync(keyPath); if (this.key.length !== 32) throw new Error('invalid backup key');
    store.db.exec('CREATE TABLE IF NOT EXISTS backups(id TEXT PRIMARY KEY,instance TEXT NOT NULL,request_key TEXT NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL,bytes INTEGER NOT NULL,UNIQUE(instance,request_key))');
    if (!store.all('PRAGMA table_info(backups)').some(column => column.name === 'origin')) store.db.exec("ALTER TABLE backups ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual'");
    store.db.exec('CREATE TABLE IF NOT EXISTS backup_restores(instance TEXT NOT NULL,request_key TEXT NOT NULL,snapshot TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(instance,request_key))');
  }
  path(id) { return join(this.dir, instanceID(id) + '.enc'); }
  list(id) { return this.store.all('SELECT id,state,created_at,bytes FROM backups WHERE instance=? ORDER BY created_at DESC', instanceID(id)); }
  get(id, snapshot) {
    const row = this.store.get('SELECT * FROM backups WHERE instance=? AND id=?', instanceID(id), instanceID(snapshot));
    if (!row || row.state !== 'ready') throw new Fault(404, 'backup_not_found');
    const stat = lstatSync(this.path(snapshot));
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size < 28) throw new Fault(409, 'backup_ownership_mismatch');
    return { ...row, size: stat.size };
  }
  async create(id, requestKey, { automatic = false } = {}) {
    instanceID(requestKey); this.disks.check(id);
    let row = this.store.get('SELECT * FROM backups WHERE instance=? AND request_key=?', id, requestKey);
    if (row?.state === 'ready') return this.get(id, row.id);
    this.capacity();
    if (!row) {
      if (this.list(id).length >= (automatic ? 4 : 3)) throw new Fault(409, 'backup_limit_reached');
      row = { id: randomUUID(), bytes: this.disks.bytes };
      this.store.run('INSERT INTO backups(id,instance,request_key,state,created_at,bytes,origin) VALUES(?,?,?,?,?,?,?)', row.id, id, requestKey, 'writing', new Date().toISOString(), row.bytes, automatic ? 'automatic' : 'manual');
    }
    await this.disks.unmount(id);
    const path = this.path(row.id), temporary = path + '.part'; rmSync(temporary, { force: true });
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(`${id}\n${row.id}\n${row.bytes}`));
    try {
      writeFileSync(temporary, nonce, { flag: 'wx', mode: 0o600 });
      await pipeline(createReadStream(this.disks.path(id)), createGzip(), cipher, createWriteStream(temporary, { flags: 'a' }), { signal: AbortSignal.timeout(110000) });
      writeFileSync(temporary, cipher.getAuthTag(), { flag: 'a' });
      flush(temporary); renameSync(temporary, path); flush(this.dir);
      this.store.run("UPDATE backups SET state='ready' WHERE id=?", row.id);
      return this.get(id, row.id);
    } catch (e) { this.store.run("UPDATE backups SET state='failed' WHERE id=?", row.id); throw e; }
    finally { rmSync(temporary, { force: true }); }
  }
  async restore(id, snapshot, requestKey = randomUUID()) {
    try { await this.stageRestore(id, snapshot, requestKey); this.commitRestore(id, requestKey); }
    catch (error) { this.abortRestore(id, requestKey); throw error; }
    this.disks.check(id);
  }
  abortRestore(id, requestKey) {
    const previous = this.store.get('SELECT state FROM backup_restores WHERE instance=? AND request_key=?', instanceID(id), instanceID(requestKey));
    if (previous?.state !== 'prepared') return;
    rmSync(this.disks.path(id) + '.restore-' + requestKey, { force: true });
    this.store.run('DELETE FROM backup_restores WHERE instance=? AND request_key=?', id, requestKey);
  }
  async stageRestore(id, snapshot, requestKey) {
    instanceID(requestKey);
    const previous = this.store.get('SELECT * FROM backup_restores WHERE instance=? AND request_key=?', id, requestKey);
    if (previous && previous.snapshot !== snapshot) throw new Fault(409, 'idempotency_conflict');
    if (previous?.state === 'ready') return;
    if (previous?.state === 'committing') { this.finishRestore(id, requestKey); return; }
    this.capacity();
    const row = this.get(id, snapshot); this.disks.check(id);
    if (row.bytes !== this.disks.bytes) throw new Fault(409, 'backup_size_mismatch');
    await this.disks.unmount(id);
    const path = this.path(snapshot), fd = openSync(path, 'r'), nonce = Buffer.alloc(12), tag = Buffer.alloc(16);
    try { readSync(fd, nonce, 0, 12, 0); readSync(fd, tag, 0, 16, row.size - 16); } finally { closeSync(fd); }
    const decipher = createDecipheriv('aes-256-gcm', this.key, nonce); decipher.setAuthTag(tag); decipher.setAAD(Buffer.from(`${id}\n${snapshot}\n${row.bytes}`));
    const temporary = this.disks.path(id) + '.restore-' + requestKey; rmSync(temporary, { force: true }); let count = 0, staged = false;
    const budget = new Transform({ transform(chunk, _, callback) { count += chunk.length; if (count > row.bytes) callback(new Fault(409, 'backup_size_mismatch')); else callback(null, chunk); } });
    try {
      await pipeline(createReadStream(path, { start: 12, end: row.size - 17 }), decipher, createGunzip(), budget, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), { signal: AbortSignal.timeout(110000) });
      if (count !== row.bytes) throw new Fault(409, 'backup_size_mismatch');
      await this.disks.run('/usr/bin/fallocate', ['--length', String(row.bytes), temporary]);
      flush(temporary); flush(this.disks.dir);
      this.store.run("INSERT OR REPLACE INTO backup_restores VALUES(?,?,?,'prepared')", id, requestKey, snapshot); staged = true;
    } finally { if (!staged) rmSync(temporary, { force: true }); }
  }
  commitRestore(id, requestKey) {
    const previous = this.store.get('SELECT state FROM backup_restores WHERE instance=? AND request_key=?', instanceID(id), instanceID(requestKey));
    if (previous?.state === 'ready') return;
    if (!previous) throw new Fault(409, 'restore_not_prepared');
    this.store.run("UPDATE backup_restores SET state='committing' WHERE instance=? AND request_key=?", id, requestKey);
    this.finishRestore(id, requestKey);
  }
  finishRestore(id, requestKey) {
    if (this.disks.mounted(id)) throw new Fault(409, 'restore_disk_is_mounted');
    const temporary = this.disks.path(id) + '.restore-' + instanceID(requestKey);
    if (existsSync(temporary)) {
      const stat = lstatSync(temporary);
      if (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1 || stat.size !== this.disks.bytes) throw new Fault(409, 'restore_ownership_mismatch');
      renameSync(temporary, this.disks.path(id)); flush(this.disks.dir);
    }
    this.store.run("UPDATE backup_restores SET state='ready' WHERE instance=? AND request_key=?", id, requestKey);
  }
  recover(id) {
    for (const row of this.store.all("SELECT request_key FROM backup_restores WHERE instance=? AND state='committing'", id)) this.finishRestore(id, row.request_key);
  }
  due(id, intervalMs) {
    const recent = this.store.get("SELECT created_at FROM backups WHERE instance=? AND state='ready' ORDER BY created_at DESC LIMIT 1", id);
    return !recent || Date.parse(recent.created_at) + intervalMs <= Date.now();
  }
  async automatic(id, intervalMs) {
    const digest = createHash('sha256').update(id + ':' + Math.floor(Date.now() / intervalMs)).digest('hex');
    const key = digest.slice(0, 8) + '-' + digest.slice(8, 12) + '-4' + digest.slice(13, 16) + '-a' + digest.slice(17, 20) + '-' + digest.slice(20, 32);
    for (const row of this.store.all("SELECT id FROM backups WHERE instance=? AND origin='automatic' AND state<>'ready' AND request_key<>?", id, key)) this.remove(id, row.id);
    const result = await this.create(id, key, { automatic: true });
    for (const row of this.list(id).slice(3)) this.remove(id, row.id);
    return result;
  }
  capacity() {
    const free = statfsSync(this.dir);
    if (free.bavail * free.bsize < this.disks.bytes + 512 * 1024 ** 2) throw new Fault(503, 'host_storage_insufficient');
  }
  remove(id, snapshot) {
    const row = this.store.get('SELECT id FROM backups WHERE instance=? AND id=?', instanceID(id), instanceID(snapshot));
    if (!row) throw new Fault(404, 'backup_not_found');
    for (const suffix of ['', '.part']) rmSync(this.path(snapshot) + suffix, { force: true });
    this.store.run('DELETE FROM backups WHERE instance=? AND id=?', id, snapshot);
  }
  purge(id) {
    for (const row of this.list(id)) this.remove(id, row.id);
    for (const row of this.store.all('SELECT request_key FROM backup_restores WHERE instance=?', instanceID(id))) rmSync(this.disks.path(id) + '.restore-' + instanceID(row.request_key), { force: true });
    this.store.run('DELETE FROM backup_restores WHERE instance=?', id);
  }
}
