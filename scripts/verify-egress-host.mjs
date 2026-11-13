import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Egress } from '../src/egress.mjs';
import { Store } from '../src/store.mjs';

if (process.platform !== 'linux' || process.getuid() !== 0 || process.env.CLOUD_DISPOSABLE_LINUX !== '1') throw new Error('requires an explicitly disposable root Linux fixture');
const execute = promisify(execFile), dir = await mkdtemp('/tmp/dbc-nft-host-');
const store = new Store(dir), egress = new Egress({ namespace: randomUUID(), store });
const ids = [randomUUID(), randomUUID()];
const nft = async args => JSON.parse((await execute(egress.binary, ['-j', ...args])).stdout);
const ownTable = value => value.nftables.find(entry => entry.table?.family === 'inet' && entry.table.name === egress.table)?.table;
try {
  await egress.update(ids[0], true);
  await egress.update(ids[1], true);
  await egress.update(ids[0], false);
  await egress.update(ids[1], false);
  assert.equal(ownTable(await nft(['list', 'tables'])), undefined);
  console.log(JSON.stringify({ result: 'egress_host_fixture_passed', nft: (await execute(egress.binary, ['--version'])).stdout.trim(), atomicUpdates: true, scopedCleanup: true }));
} catch (error) {
  const diagnostic = { event: 'egress_host_fixture_failed', code: error.code || 'unknown' };
  for (const [key, args] of [['nft_version', ['--version']], ['listed_table', ['-j', 'list', 'tables']], ['full_table', ['-j', 'list', 'table', 'inet', egress.table]]]) {
    try {
      const { stdout } = await execute(egress.binary, args);
      diagnostic[key] = key === 'nft_version' ? stdout.trim() : ownTable(JSON.parse(stdout));
    } catch (failure) { diagnostic[key] = (failure.stderr || failure.code || '').slice(0, 3000); }
  }
  try {
    const check = execute(egress.binary, ['--check', '-f', '-']);
    check.child.stdin.on('error', () => {});
    check.child.stdin.end(`${diagnostic.full_table?.name ? `delete table inet ${egress.table}\n` : ''}${egress.rules(ids.map(id => egress.bridge(id)))}\n`);
    await check;
    diagnostic.rules_check = 'passed';
  } catch (failure) { diagnostic.rules_check = (failure.stderr || failure.code || '').slice(0, 5000); }
  console.error(JSON.stringify(diagnostic));
  throw error;
} finally {
  const listed = ownTable(await nft(['list', 'tables']));
  if (listed) {
    const actual = ownTable(await nft(['list', 'table', 'inet', egress.table]));
    assert.equal(actual?.comment, egress.owner, 'refuse to clean another owner’s table');
    await execute(egress.binary, ['delete', 'table', 'inet', egress.table]);
  }
  store.close(); await rm(dir, { recursive: true, force: true });
}
