import { execFileSync } from 'node:child_process';
import { closeSync, constants, fstatSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { privateDir } from './common.mjs';

export function hostLock(stateDir) {
  if (process.platform !== 'linux' || process.getuid() !== 0) throw new Error('host lock requires root Linux');
  const fd = openSync(join(privateDir(stateDir), 'agent.lock'), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== 0 || stat.nlink !== 1 || (stat.mode & 0o077)) throw new Error('invalid agent lock ownership');
    // flock survives its child process because the parent retains the same open file description.
    execFileSync('/usr/bin/flock', ['--nonblock', '3'], { stdio: ['ignore', 'pipe', 'pipe', fd] });
  } catch { closeSync(fd); throw new Error('another agent or maintenance operation owns this state directory'); }
  let closed = false;
  return () => { if (!closed) { closed = true; closeSync(fd); } };
}
