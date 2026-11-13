import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { Egress } from '../src/egress.mjs';
import { errorFields } from '../src/worker-errors.mjs';

test('nft uses private regular file and cleans up on success and failure', async () => {
  const dir = await mkdtemp('/tmp/dbc-nft-test-');
  const binary = join(dir, 'nft');
  try {
    await writeFile(binary, `#!${process.execPath}
const fs=require('fs');const p=process.argv[3];
if(process.argv[2]!=='-f'||p==='-')process.exit(11);
if(!fs.statSync(p).isFile()||(fs.statSync(p).mode&0o777)!==0o600||(fs.statSync(require('path').dirname(p)).mode&0o777)!==0o700)process.exit(12);
const text=fs.readFileSync(p,'utf8');fs.writeFileSync(${JSON.stringify(join(dir,'path'))},p);if(text==='fail')process.exit(1);
`, { mode: 0o700 });
    const e = Object.create(Egress.prototype); e.binary = binary;
    const { readFile } = await import('node:fs/promises');
    for (const value of ['table test', 'fail']) {
      if(value === 'fail') await assert.rejects(e.nft(['-f','-'], value), {code:'egress_firewall_failed'});
      else await e.nft(['-f','-'], value);
      const path = await readFile(join(dir,'path'),'utf8');
      await assert.rejects(access(path));
    }
    assert.deepEqual(errorFields({code:'egress_firewall_failed',status:503}),{code:'egress_firewall_failed',status:503});
  } finally { await rm(dir,{recursive:true,force:true}); }
});
