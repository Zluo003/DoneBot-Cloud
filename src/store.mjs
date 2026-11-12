import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { Fault, hash, privateDir, vault } from './common.mjs';

export class Store {
  constructor(dir) {
    privateDir(dir); this.vault = vault(dir);
    const path = join(dir, 'cloud.sqlite');
    this.db = new DatabaseSync(path); chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS instances (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL UNIQUE, desired TEXT NOT NULL,
        actual TEXT NOT NULL, error TEXT, paid_until INTEGER NOT NULL DEFAULT 0,
        subscription_state TEXT NOT NULL DEFAULT 'unpaid', created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS operations (
        id TEXT PRIMARY KEY, instance_id TEXT NOT NULL REFERENCES instances(id),
        request_key TEXT NOT NULL, action TEXT NOT NULL, state TEXT NOT NULL, error TEXT,
        created_at INTEGER NOT NULL, session_hash TEXT, UNIQUE(instance_id,request_key));
      CREATE TABLE IF NOT EXISTS sessions (
        hash TEXT PRIMARY KEY, owner TEXT NOT NULL, credentials TEXT NOT NULL,
        expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY CHECK(id=1), holder TEXT NOT NULL, expires_at INTEGER NOT NULL);`);
  }
  get(sql, ...params) { return this.db.prepare(sql).get(...params); }
  all(sql, ...params) { return this.db.prepare(sql).all(...params); }
  run(sql, ...params) { return this.db.prepare(sql).run(...params); }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const result = fn(); this.db.exec('COMMIT'); return result; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  acquire(holder, now = Date.now()) {
    return this.transaction(() => {
      const current = this.get('SELECT * FROM lease WHERE id=1');
      if (current && current.holder !== holder && current.expires_at > now) throw new Fault(503, 'controller_already_running');
      this.run('INSERT OR REPLACE INTO lease VALUES(1,?,?)', holder, now + 15000);
    });
  }
  owned(id, owner) { const row = this.get('SELECT * FROM instances WHERE id=? AND owner=?', id, owner); if (!row) throw new Fault(404, 'instance_not_found'); return row; }
  session(token) {
    if (typeof token !== 'string' || token.length > 256) throw new Fault(401, 'login_required');
    const row = this.get('SELECT * FROM sessions WHERE hash=?', hash(token));
    if (!row || row.expires_at <= Date.now()) throw new Fault(401, 'login_required');
    return { ...row, credentials: this.vault.open(row.credentials) };
  }
  close() { this.db.close(); }
}
