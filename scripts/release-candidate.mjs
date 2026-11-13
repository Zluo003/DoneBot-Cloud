import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, readlink, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const cloud = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repos = { cloud, donebot: resolve(cloud, '../DoneBot'), gateway: resolve(cloud, '../donebot-api') };
const digest = value => createHash('sha256').update(value).digest('hex');
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message || result.stderr?.toString()}`);
  return result.stdout;
}
async function fingerprint(root) {
  const files = [...new Set(run('git', ['ls-files', '-c', '-o', '--exclude-standard', '-z'], { cwd: root }).toString().split('\0').filter(Boolean))].sort();
  const entries = [];
  for (const path of files) {
    if (isAbsolute(path) || path.split('/').includes('..')) throw new Error('Unsafe source path');
    if (/(^|\/)\.env($|\.(?!example$|sample$|template$))|\.(pem|key|p12|pfx)$/.test(path)) throw new Error(`Credential-shaped file cannot enter source candidate: ${path}`);
    let info; try { info = await lstat(join(root, path)); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (info.isSymbolicLink()) {
      const target = await readlink(join(root, path));
      const resolved = resolve(dirname(join(root, path)), target);
      if (isAbsolute(target) || !resolved.startsWith(root + sep)) throw new Error(`Source link leaves repository: ${path}`);
      entries.push({ path, kind: 'symlink', target, sha256: digest(target) });
    } else if (info.isFile()) entries.push({ path, kind: 'file', executable: !!(info.mode & 0o111), bytes: info.size, sha256: digest(await readFile(join(root, path))) });
    else throw new Error(`Unsupported source entry: ${path}`);
  }
  return { entries, sourceSha256: digest(JSON.stringify(entries)) };
}

if (process.argv[2] === '--verify') {
  const manifestPath = resolve(process.argv[3] || '');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.schema !== 1 || Object.keys(manifest.repositories).sort().join() !== Object.keys(repos).sort().join()) throw new Error('Invalid candidate manifest');
  for (const [name, root] of Object.entries(repos)) {
    const expected = manifest.repositories[name];
    if ((await fingerprint(root)).sourceSha256 !== expected.sourceSha256) throw new Error(`${name} source changed since candidate`);
    if (digest(await readFile(join(dirname(manifestPath), expected.archive.file))) !== expected.archive.sha256) throw new Error(`${name} source archive changed`);
  }
  console.log(JSON.stringify({ result: 'release_candidate_verified', productionPublished: false }));
} else {
  if (!process.argv[2]) throw new Error('Usage: node scripts/release-candidate.mjs EMPTY_OUTPUT_DIRECTORY | --verify MANIFEST');
  const output = resolve(process.argv[2]);
  await mkdir(output, { recursive: true, mode: 0o700 });
  const destination = await realpath(output);
  for (const root of Object.values(repos)) if (!relative(root, destination).startsWith('..' + sep)) throw new Error('Candidate output must be outside all three repositories');
  if ((await readdir(output)).length) throw new Error('Candidate output must be empty');
  const manifest = { schema: 1, createdAt: new Date().toISOString(), status: 'source-candidate', productionPublished: false,
    requirements: { gatewayMigrations: [260, 261, 262, 263, 264], node: '>=24.13.0 <25', donebotImageTarget: 'server', registryImages: 'not-published', packagedElectronGUI: 'not-qualified' }, repositories: {} };
  for (const [name, root] of Object.entries(repos)) {
    const before = await fingerprint(root), archive = name + '-source.tar.gz';
    run('tar', ['--null', '--no-recursion', '-czf', join(output, archive), '-C', root, '-T', '-'], {
      env: { ...process.env, COPYFILE_DISABLE: '1' },
      input: Buffer.from(before.entries.map(entry => entry.path).join('\0') + '\0'),
    });
    if ((await fingerprint(root)).sourceSha256 !== before.sourceSha256) throw new Error(`${name} changed during archiving; discard this candidate and retry`);
    const headResult = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root });
    if (headResult.status !== 0 && name !== 'cloud') throw new Error(`${name} HEAD unavailable`);
    manifest.repositories[name] = { head: headResult.status === 0 ? headResult.stdout.toString().trim() : null,
      sourceSha256: before.sourceSha256, entries: before.entries,
      archive: { file: archive, sha256: digest(await readFile(join(output, archive))) },
      workingTreeStatus: run('git', ['status', '--short', '--untracked-files=all'], { cwd: root }).toString().trim().split('\n').filter(Boolean) };
  }
  await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ result: 'release_candidate_prepared', manifest: join(output, 'manifest.json'), productionPublished: false }));
}
