import { createHash, randomUUID } from 'node:crypto';
import { Fault, instanceID } from './common.mjs';

// Both files are authenticated before either disk is replaced. A durable commit
// intent fences startup until a crash-interrupted two-disk restore is finished.
export class InstanceBackups {
  constructor(main, desktop, store) {
    this.main = main; this.desktop = desktop; this.store = store;
    store.db.exec(`CREATE TABLE IF NOT EXISTS instance_backups(
      id TEXT PRIMARY KEY,instance TEXT NOT NULL,request_key TEXT NOT NULL,state TEXT NOT NULL,
      created_at TEXT NOT NULL,bytes INTEGER NOT NULL,main TEXT,desktop TEXT,origin TEXT NOT NULL,
      UNIQUE(instance,request_key));
      CREATE TABLE IF NOT EXISTS instance_restores(instance TEXT NOT NULL,request_key TEXT NOT NULL,
      snapshot TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(instance,request_key))`);
  }
  list(id) { return this.store.all('SELECT id,state,created_at,bytes FROM instance_backups WHERE instance=? ORDER BY created_at DESC', instanceID(id)); }
  get(id, snapshot) {
    const row = this.store.get('SELECT * FROM instance_backups WHERE instance=? AND id=?', instanceID(id), instanceID(snapshot));
    if (!row || row.state !== 'ready') throw new Fault(404, 'backup_not_found');
    this.main.get(id, row.main); this.desktop.backups.get(id, row.desktop); return row;
  }
  async create(id, key, { automatic = false } = {}) {
    instanceID(id); instanceID(key);
    let row = this.store.get('SELECT * FROM instance_backups WHERE instance=? AND request_key=?', id, key);
    if (row?.state === 'ready') return this.get(id, row.id);
    if (!row) {
      if (this.list(id).length >= (automatic ? 4 : 3)) throw new Fault(409, 'backup_limit_reached');
      row = { id: randomUUID(), bytes: this.main.disks.bytes + this.desktop.disks.bytes };
      this.store.run("INSERT INTO instance_backups VALUES(?,?,?,'writing',?,?,NULL,NULL,?)", row.id, id, key, new Date().toISOString(), row.bytes, automatic ? 'automatic' : 'manual');
    }
    try {
      await this.desktop.ensureStorage(id);
      const main = await this.main.create(id, key, { automatic });
      this.store.run('UPDATE instance_backups SET main=? WHERE id=?', main.id, row.id);
      const desktop = await this.desktop.backups.create(id, key, { automatic });
      this.store.run("UPDATE instance_backups SET desktop=?,state='ready' WHERE id=?", desktop.id, row.id);
      return this.get(id, row.id);
    } catch (error) { this.store.run("UPDATE instance_backups SET state='failed' WHERE id=?", row.id); throw error; }
  }
  async restore(id, snapshot, key) {
    instanceID(id); instanceID(key);
    const previous = this.store.get('SELECT * FROM instance_restores WHERE instance=? AND request_key=?', id, key);
    if (previous && previous.snapshot !== snapshot) throw new Fault(409, 'idempotency_conflict');
    if (previous?.state === 'ready') return;
    if (previous?.state === 'committing') return this.finish(id, key);
    const row = this.get(id, snapshot);
    await this.desktop.ensureStorage(id);
    try {
      await this.main.stageRestore(id, row.main, key);
      await this.desktop.backups.stageRestore(id, row.desktop, key);
    } catch (error) { this.main.abortRestore(id, key); this.desktop.backups.abortRestore(id, key); throw error; }
    this.store.run("INSERT OR REPLACE INTO instance_restores VALUES(?,?,?,'committing')", id, key, snapshot);
    this.finish(id, key);
  }
  finish(id, key) {
    this.main.commitRestore(id, key); this.desktop.backups.commitRestore(id, key);
    this.store.run("UPDATE instance_restores SET state='ready' WHERE instance=? AND request_key=?", id, key);
  }
  recover(id) {
    this.main.recover(id); this.desktop.backups.recover(id);
    for (const row of this.store.all("SELECT request_key FROM instance_restores WHERE instance=? AND state='committing'", id)) this.finish(id, row.request_key);
  }
  remove(id, snapshot) {
    const row = this.store.get('SELECT * FROM instance_backups WHERE instance=? AND id=?', instanceID(id), instanceID(snapshot));
    if (!row) throw new Fault(404, 'backup_not_found');
    if (this.store.get("SELECT 1 FROM instance_restores WHERE instance=? AND snapshot=? AND state='committing'", id, snapshot)) throw new Fault(409, 'restore_in_progress');
    for (const backup of [this.main, this.desktop.backups]) {
      const child = backup.store.get('SELECT id FROM backups WHERE instance=? AND request_key=?', id, row.request_key);
      if (child) backup.remove(id, child.id);
    }
    this.store.run('DELETE FROM instance_backups WHERE instance=? AND id=?', id, snapshot);
  }
  purge(id) { for (const row of this.list(id)) { this.store.run('DELETE FROM instance_restores WHERE instance=?', id); this.remove(id, row.id); } this.main.purge(id); this.desktop.backups.purge(id); }
  due(id, intervalMs) { const row = this.list(id).find(row => row.state === 'ready'); return !row || Date.parse(row.created_at) + intervalMs <= Date.now(); }
  async automatic(id, intervalMs) {
    const digest = createHash('sha256').update(id + ':' + Math.floor(Date.now() / intervalMs)).digest('hex');
    const key = digest.slice(0,8) + '-' + digest.slice(8,12) + '-4' + digest.slice(13,16) + '-a' + digest.slice(17,20) + '-' + digest.slice(20,32);
    for (const row of this.store.all("SELECT id FROM instance_backups WHERE instance=? AND origin='automatic' AND state<>'ready' AND request_key<>?", id, key)) this.remove(id, row.id);
    const result = await this.create(id, key, { automatic: true });
    for (const row of this.list(id).slice(3)) this.remove(id, row.id);
    return result;
  }
}
