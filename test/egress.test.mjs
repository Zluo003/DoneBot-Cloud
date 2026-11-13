import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { Egress } from '../src/egress.mjs';
import { Store } from '../src/store.mjs';

test('gateway HTTPS exceptions require explicit unblocked public IPv4 addresses', async t => {
  const dir = await mkdtemp('/tmp/dbc-gateway-test-'), store = new Store(dir), namespace = randomUUID();
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  for (const ip of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '168.63.129.16', '::1', '11.22.33.44/24', 'donebot.cn', '11.22.33.44;anything']) {
    assert.throws(() => new Egress({ namespace, store, gatewayIPv4: [ip] }), /explicit unblocked public IPv4/);
  }
  assert.throws(() => new Egress({ namespace, store, gatewayIPv4: ['11.22.33.44'], denyIPv4: ['11.22.33.0/24'] }));
  assert.deepEqual(new Egress({ namespace, store, gatewayIPv4: ['11.22.33.44', '11.22.33.44'] }).gatewayIPv4, ['11.22.33.44']);
});

test('nft rules use a private regular file and clean it after success or failure', async t => {
  const dir = await mkdtemp('/tmp/dbc-nft-test-'), record = join(dir, 'observed.json'), binary = join(dir, 'nft-fixture');
  const store = new Store(join(dir, 'metadata'));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  await writeFile(binary, `#!${process.execPath}\n` + `
import { statSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
const path=process.argv.at(-1);
if(path==='-' || !statSync(path).isFile()) process.exit(2);
const file=statSync(path), parent=statSync(dirname(path));
writeFileSync(${JSON.stringify(record)},JSON.stringify({path,fileMode:file.mode&0o777,parentMode:parent.mode&0o777,input:readFileSync(path,'utf8')}));
if(process.argv.includes('--invalid')) process.exit(1);
`, { mode: 0o700 });
  const egress = new Egress({ namespace: randomUUID(), store, binary });
  const input = egress.rules([egress.bridge(randomUUID())]);
  await egress.nft(['-f', '-'], input);
  let value = JSON.parse(await readFile(record, 'utf8'));
  assert.equal(value.input, input); assert.equal(value.fileMode, 0o600); assert.equal(value.parentMode, 0o700);
  await assert.rejects(stat(value.path), { code: 'ENOENT' });
  await assert.rejects(stat(dirname(value.path)), { code: 'ENOENT' });
  await assert.rejects(egress.nft(['--invalid', '-f', '-'], input), { code: 'egress_firewall_failed' });
  value = JSON.parse(await readFile(record, 'utf8'));
  assert.equal(value.input, input);
  await assert.rejects(stat(value.path), { code: 'ENOENT' });
  await assert.rejects(stat(dirname(value.path)), { code: 'ENOENT' });
});
