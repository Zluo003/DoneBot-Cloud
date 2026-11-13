import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { prepareImages } from '../scripts/prepare-images.mjs';

async function fixture(t) {
  const root = await mkdtemp('/tmp/dbc-images-'), source = join(root, 'DoneBot');
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(source);
  const real = async (bin, args) => (await promisify(execFile)(bin, args)).stdout;
  const git = args => real('git', ['-C', source, ...args]);
  await git(['init', '-q']); await writeFile(join(source, 'Dockerfile'), 'FROM scratch AS server\n');
  await git(['add', 'Dockerfile']); await git(['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);
  const revision = (await git(['rev-parse', 'HEAD'])).trim(), calls = [], images = new Map();
  let architecture = 'amd64';
  const run = async (bin, args) => {
    if (bin === 'git' || bin === 'tar') return real(bin, args);
    calls.push({ bin, args });
    if (bin === process.execPath) { await writeFile(args[2], 'FROM scratch\n'); return ''; }
    assert.equal(bin, 'docker'); assert.deepEqual(args.slice(0, 2), ['--context', 'fixture-only']);
    args = args.slice(2);
    if (args[0] === 'build') {
      const id = 'sha256:' + (images.size ? 'b' : 'a').repeat(64);
      await writeFile(args[args.indexOf('--iidfile') + 1], id);
      images.set(id, { Id: id, Os: 'linux', Architecture: architecture, Config: { Labels: { 'org.opencontainers.image.revision': revision } } });
    } else if (args[0] === 'image') return JSON.stringify([images.get(args[2])]);
    else if (args[0] === 'save') await writeFile(args[2], 'synthetic-image-bundle');
    else assert.fail('unexpected Docker operation');
    return '';
  };
  return { source, revision, platform: 'linux/amd64', output: join(root, 'bundle'), context: 'fixture-only', run, calls, set architecture(value) { architecture = value; } };
}

test('prepares both fixed images and an offline bundle without modifying source', async t => {
  const f = await fixture(t), result = await prepareImages(f, f.run);
  assert.equal(result.images.service.id, 'sha256:' + 'a'.repeat(64));
  assert.equal(result.images.desktop.id, 'sha256:' + 'b'.repeat(64));
  const bundle = await readFile(join(f.output, 'images.tar'));
  assert.equal(result.bundle.sha256, createHash('sha256').update(bundle).digest('hex'));
  assert.equal(await readFile(join(f.output, 'checksums.txt'), 'utf8'), result.bundle.sha256 + '  images.tar\n');
  assert.match(await readFile(join(f.output, 'agent-images.env'), 'utf8'), /^CLOUD_DONEBOT_IMAGE=sha256:[a-f0-9]{64}\nCLOUD_DESKTOP_IMAGE=sha256:[a-f0-9]{64}\n$/);
  const builds = f.calls.filter(c => c.args.includes('build'));
  assert.equal(builds.length, 2); assert.ok(builds[0].args.includes('--target')); assert.ok(builds[0].args.includes('server'));
  assert.ok(!builds.some(c => c.args.includes('--build-arg') || c.args.includes('cloud-home')));
  assert.equal((await promisify(execFile)('git', ['-C', f.source, 'status', '--porcelain'])).stdout, '');
});

test('source revision and cleanliness are checked before invoking Docker', async t => {
  const f = await fixture(t);
  await assert.rejects(prepareImages({ ...f, revision: '0'.repeat(40) }, f.run), /reviewed revision/);
  await writeFile(join(f.source, 'unreviewed'), 'change');
  await assert.rejects(prepareImages(f, f.run), /must be clean/);
  assert.equal(f.calls.length, 0);
  await assert.rejects(access(f.output));
});

test('wrong architecture never produces a usable manifest or environment file', async t => {
  const f = await fixture(t); f.architecture = 'arm64';
  await assert.rejects(prepareImages(f, f.run), /platform mismatch/);
  await assert.rejects(access(join(f.output, 'manifest.json')));
  await assert.rejects(access(join(f.output, 'agent-images.env')));
  assert.ok(!f.calls.some(c => c.args.includes('save')));
});
