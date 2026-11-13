import { execFile, spawn } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
async function command(binary, args, { capture = true } = {}) {
  if (capture) return (await promisify(execFile)(binary, args, { maxBuffer: 4 * 1024 * 1024 })).stdout;
  await new Promise((accept, reject) => {
    const child = spawn(binary, args, { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? accept() : reject(new Error(`${binary} failed (${signal || code})`)));
  });
  return '';
}
const outside = (root, target) => { const path = relative(root, target); return path.startsWith('..' + '/') || path === '..' || isAbsolute(path); };

export async function prepareImages({ source, revision, platform, output, context, archive = true, dryRun = false }, run = command) {
  if (!source || !output || !/^[a-f0-9]{40}$/.test(revision || '') || !['linux/amd64', 'linux/arm64'].includes(platform)) throw new Error('source, full revision, platform (linux/amd64 or linux/arm64) and new output directory are required');
  if (context !== undefined && !/^[a-zA-Z0-9_.-]{1,128}$/.test(context)) throw new Error('invalid Docker context');
  source = await realpath(resolve(source));
  output = join(await realpath(dirname(resolve(output))), resolve(output).split('/').at(-1));
  if (!outside(source, output)) throw new Error('output must be outside the DoneBot checkout');
  const git = args => run('git', ['-C', source, ...args]);
  if ((await git(['rev-parse', '--show-toplevel'])).trim() !== source) throw new Error('source must be the DoneBot repository root');
  async function checkSource() {
    if ((await git(['rev-parse', 'HEAD'])).trim() !== revision) throw new Error('DoneBot HEAD does not match the reviewed revision');
    if ((await git(['status', '--porcelain', '--untracked-files=all'])).trim()) throw new Error('DoneBot source must be clean; commit or set aside changes before building');
  }
  await checkSource();
  const plan = { source_revision: revision, platform, output, docker_context: context || 'current', archive };
  if (dryRun) return { ...plan, dry_run: true };
  await mkdir(output, { mode: 0o700 });
  const staging = await mkdtemp(join(tmpdir(), 'dbc-image-build-'));
  const docker = args => run('docker', [...(context ? ['--context', context] : []), ...args], { capture: args[0] !== 'build' && args[0] !== 'save' });
  try {
    const snapshot = join(staging, 'source'), desktop = join(output, 'desktop');
    await mkdir(snapshot); await mkdir(desktop, { mode: 0o700 });
    await git(['archive', '--format=tar', '--output', join(staging, 'source.tar'), revision]);
    await run('tar', ['-xf', join(staging, 'source.tar'), '-C', snapshot]);
    // The upstream generator imports server config; it runs with a temporary HOME.
    await symlink(join(source, 'node_modules'), join(snapshot, 'node_modules'), 'dir');
    await run(process.execPath, [join(scriptDir, 'desktop-dockerfile.mjs'), snapshot, join(desktop, 'Dockerfile')]);
    const suffix = `${revision.slice(0, 12)}-${platform.split('/')[1]}-${randomBytes(4).toString('hex')}`;
    const images = {};
    for (const kind of ['service', 'desktop']) {
      const iidfile = join(staging, kind + '.iid');
      await docker(['build', '--platform', platform, ...(kind === 'service' ? ['--target', 'server'] : []), '--label', 'org.opencontainers.image.revision=' + revision, '--iidfile', iidfile, '--tag', `donebot-cloud-build:${kind}-${suffix}`, kind === 'service' ? snapshot : desktop]);
      const id = (await readFile(iidfile, 'utf8')).trim();
      if (!/^sha256:[a-f0-9]{64}$/.test(id)) throw new Error(`invalid ${kind} image ID`);
      const inspected = JSON.parse(await docker(['image', 'inspect', id]));
      const image = inspected[0];
      if (inspected.length !== 1 || image.Id !== id || `${image.Os}/${image.Architecture}` !== platform || image.Config?.Labels?.['org.opencontainers.image.revision'] !== revision) throw new Error(`${kind} image provenance or platform mismatch`);
      images[kind] = { id, platform, revision };
    }
    let bundle;
    if (archive) {
      const name = 'images.tar', path = join(output, name);
      await docker(['save', '--output', path, images.service.id, images.desktop.id]);
      const digest = createHash('sha256');
      for await (const chunk of createReadStream(path)) digest.update(chunk);
      bundle = { file: name, sha256: digest.digest('hex') };
      await writeFile(join(output, 'checksums.txt'), `${bundle.sha256}  ${name}\n`, { flag: 'wx', mode: 0o600 });
    }
    await checkSource();
    const manifest = { ...plan, images, bundle };
    await writeFile(join(output, 'agent-images.env'), `CLOUD_DONEBOT_IMAGE=${images.service.id}\nCLOUD_DESKTOP_IMAGE=${images.desktop.id}\n`, { flag: 'wx', mode: 0o600 });
    await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return manifest;
  } finally { await rm(staging, { recursive: true, force: true }); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { values } = parseArgs({ options: { source: { type: 'string' }, revision: { type: 'string' }, platform: { type: 'string' }, output: { type: 'string' }, context: { type: 'string' }, 'no-archive': { type: 'boolean' }, 'dry-run': { type: 'boolean' } } });
  try { console.log(JSON.stringify(await prepareImages({ ...values, archive: !values['no-archive'], dryRun: values['dry-run'] }), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
