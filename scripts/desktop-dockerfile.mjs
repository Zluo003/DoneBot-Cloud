import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const [source, output] = process.argv.slice(2);
if (!source || !output) throw new Error('usage: node scripts/desktop-dockerfile.mjs DONEBOT_SOURCE OUTPUT_DOCKERFILE');
const fixtureHome = await mkdtemp(join(tmpdir(), 'dbc-desktop-build-'));
try {
  const module = pathToFileURL(resolve(source, 'server/container-computer.ts')).href;
  const code = `const {managedImageDockerfile}=await import(process.argv[1]);process.stdout.write(managedImageDockerfile());`;
  const result = await promisify(execFile)(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', code, module], {
    env: { ...process.env, HOME: fixtureHome, USERPROFILE: fixtureHome, DONEBOT_DATA_DIR: join(fixtureHome, 'data') }, maxBuffer: 1024 * 1024,
  });
  await writeFile(resolve(output), result.stdout, { flag: 'wx', mode: 0o600 });
} finally { await rm(fixtureHome, { recursive: true, force: true }); }
