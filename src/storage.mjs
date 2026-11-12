import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { closeSync, existsSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, rmdirSync, statfsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Fault, instanceID, privateDir } from './common.mjs';

const execute = promisify(execFile);

export class BoundedDisks {
  constructor({ stateDir, store, bytes = 5 * 1024 ** 3, owner = 1001 }) {
    if (process.platform !== 'linux' || process.getuid() !== 0) throw new Error('bounded-ext4 storage requires a local root Linux agent');
    if (!Number.isSafeInteger(bytes) || bytes < 128 * 1024 ** 2 || bytes > 1024 ** 4 || bytes % (1024 ** 2)) throw new Error('storage size must be 128 MiB–1 TiB in whole MiB');
    if (![1000, 1001].includes(owner)) throw new Error('invalid storage owner');
    this.dir = privateDir(join(stateDir, 'disks')); this.store = store; this.bytes = bytes; this.owner = owner;
    store.db.exec('CREATE TABLE IF NOT EXISTS disks(id TEXT PRIMARY KEY,bytes INTEGER NOT NULL,state TEXT NOT NULL)');
  }
  path(id) { return join(this.dir, instanceID(id) + '.ext4'); }
  mountPath(id) { return join(this.dir, instanceID(id) + '-mount'); }
  options(id) { return { type: 'none', device: this.mountPath(id), o: 'bind' }; }
  mounted(id) {
    const decode = value => value.replace(/\\(040|011|012|134)/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
    const entry = readFileSync('/proc/self/mountinfo', 'utf8').split('\n').map(line => line.split(' ')).find(fields => decode(fields[4] || '') === this.mountPath(id));
    if (!entry) return false;
    const separator = entry.indexOf('-'), source = entry[separator + 2];
    if (entry[separator + 1] !== 'ext4' || !/^\/dev\/loop[0-9]+$/.test(source) || !entry[5].split(',').includes('nodev') || !entry[5].split(',').includes('nosuid')) throw new Fault(409, 'storage_mount_ownership_mismatch');
    const backing = readFileSync('/sys/block/' + source.slice(5) + '/loop/backing_file', 'utf8').trim();
    if (backing !== this.path(id)) throw new Fault(409, 'storage_mount_ownership_mismatch');
    return true;
  }
  async mount(id) {
    if (this.mounted(id)) return;
    mkdirSync(this.mountPath(id), { mode: 0o700, recursive: true });
    const stat = lstatSync(this.mountPath(id));
    if (!stat.isDirectory() || stat.uid !== 0) throw new Fault(409, 'storage_mount_ownership_mismatch');
    await this.run('/usr/bin/mount', ['-t', 'ext4', '-o', 'loop,nodev,nosuid', this.path(id), this.mountPath(id)]);
    if (!this.mounted(id)) throw new Fault(503, 'storage_mount_failed');
  }
  async unmount(id) { if (this.mounted(id)) await this.run('/usr/bin/umount', [this.mountPath(id)]); }
  check(id) {
    const saved = this.store.get('SELECT * FROM disks WHERE id=?', id);
    if (!saved || saved.state !== 'ready' || saved.bytes !== this.bytes) throw new Fault(409, 'storage_spec_mismatch');
    const stat = lstatSync(this.path(id));
    if (!stat.isFile() || stat.uid !== 0 || stat.nlink !== 1 || stat.size !== this.bytes || (stat.mode & 0o077)) throw new Fault(409, 'storage_ownership_mismatch');
  }
  async run(binary, args) {
    try { return (await execute(binary, args, { timeout: 120000, env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LC_ALL: 'C' }, maxBuffer: 1024 * 1024 })).stdout; }
    catch { throw new Fault(503, 'storage_setup_failed'); }
  }
  async ensure(id, existingVolume) {
    const path = this.path(id);
    let saved = this.store.get('SELECT * FROM disks WHERE id=?', id);
    if (saved?.state === 'ready') { this.check(id); await this.mount(id); return; }
    if (existingVolume || saved && saved.bytes !== this.bytes || !saved && existsSync(path)) throw new Fault(409, 'storage_ownership_mismatch');
    const free = statfsSync(this.dir);
    if (free.bavail * free.bsize < this.bytes + 512 * 1024 ** 2) throw new Fault(503, 'host_storage_insufficient');
    if (!saved) {
      this.store.run('INSERT INTO disks VALUES(?,?,?)', id, this.bytes, 'formatting');
      saved = { bytes: this.bytes };
    }
    if (!existsSync(path)) {
      const fd = openSync(path, 'wx', 0o600);
      try { ftruncateSync(fd, this.bytes); } finally { closeSync(fd); }
    }
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.uid !== 0 || stat.nlink !== 1 || stat.size !== saved.bytes || (stat.mode & 0o077)) throw new Fault(409, 'storage_ownership_mismatch');
    await this.run('/usr/bin/fallocate', ['--length', String(this.bytes), path]);
    await this.run('/usr/sbin/mkfs.ext4', ['-F', '-q', '-m', '0', '-N', '65536', '-E', 'nodiscard,lazy_itable_init=0,lazy_journal_init=0', path]);
    await this.run('/usr/sbin/debugfs', ['-w', '-R', `set_inode_field <2> uid ${this.owner}`, path]);
    await this.run('/usr/sbin/debugfs', ['-w', '-R', `set_inode_field <2> gid ${this.owner}`, path]);
    const root = await this.run('/usr/sbin/debugfs', ['-R', 'stat <2>', path]);
    if (!new RegExp(`User:\\s+${this.owner}\\s+Group:\\s+${this.owner}`).test(root)) throw new Fault(503, 'storage_setup_failed');
    this.store.run("UPDATE disks SET state='ready' WHERE id=?", id);
    this.check(id);
    await this.mount(id);
  }
  async remove(id) {
    const saved = this.store.get('SELECT * FROM disks WHERE id=?', id);
    if (!saved) { if (existsSync(this.path(id))) throw new Fault(409, 'storage_ownership_mismatch'); return; }
    await this.unmount(id);
    if (existsSync(this.mountPath(id))) rmdirSync(this.mountPath(id));
    if (existsSync(this.path(id))) {
      const stat = lstatSync(this.path(id));
      if (!stat.isFile() || stat.uid !== 0 || stat.nlink !== 1 || stat.size !== saved.bytes) throw new Fault(409, 'storage_ownership_mismatch');
      unlinkSync(this.path(id));
    }
    this.store.run('DELETE FROM disks WHERE id=?', id);
  }
}
