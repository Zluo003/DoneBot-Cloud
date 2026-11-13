import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { diagnoseModels } from '../scripts/diagnose-models.mjs';

test('model diagnosis checks exact ownership, exposes no inspect secrets and only executes its read probe', async () => {
  const dir = await mkdtemp('/tmp/dbc-diagnose-'), deployment = randomUUID(), instance = randomUUID(), name = `dbc-${deployment}-${instance}`, calls = [];
  await writeFile(join(dir, 'deployment-id'), deployment);
  const container = { Name: '/' + name, Config: { Env: ['SECRET=synthetic-private'], Labels: { 'cn.donebot.cloud.deployment': deployment, 'cn.donebot.cloud.instance': instance } }, State: { Running: true, Status: 'running' }, HostConfig: { NetworkMode: 'none', Dns: [] } };
  const execute = async (_binary, args) => { calls.push(args); return { stdout: JSON.stringify(args[1] === 'inspect' ? [container] : { models: { status: 401 } }) }; };
  try {
    const result = await diagnoseModels({ instance, stateDir: dir }, execute);
    assert.equal(result.network_mode, 'none'); assert.equal(result.probe.models.status, 401);
    assert.doesNotMatch(JSON.stringify(result), /SECRET|synthetic-private/);
    assert.deepEqual(calls[0], ['container', 'inspect', name]);
    assert.deepEqual(calls[1].slice(0, 6), ['container', 'exec', name, 'node', '--input-type=module', '-e']);
    container.Config.Labels['cn.donebot.cloud.instance'] = randomUUID();
    await assert.rejects(diagnoseModels({ instance, stateDir: dir }, execute), /ownership/);
    assert.equal(calls.length, 3);
    await assert.rejects(diagnoseModels({ instance: 'untrusted;command', stateDir: dir }, execute));
    assert.equal(calls.length, 3);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
