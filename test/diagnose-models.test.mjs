import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { diagnoseModels } from '../scripts/diagnose-models.mjs';

test('model diagnosis checks exact ownership, exposes no inspect secrets and only executes its read probe', async () => {
  const dir = await mkdtemp('/tmp/dbc-diagnose-'), deployment = randomUUID(), instance = randomUUID(), name = `dbc-${deployment}-${instance}`, calls = [];
  await writeFile(join(dir, 'deployment-id'), deployment);
  const container = { Name: '/' + name, Config: { Image: 'sha256:' + 'a'.repeat(64), Env: ['SECRET=synthetic-private'], Labels: { 'cn.donebot.cloud.deployment': deployment, 'cn.donebot.cloud.instance': instance } }, State: { Running: true, Status: 'running' }, HostConfig: { NetworkMode: 'none', Dns: [] } };
  const execute = async (_binary, args) => { calls.push(args); return { stdout: JSON.stringify(args[1] === 'inspect' ? [container] : { models: { status: 401 } }) }; };
  try {
    const result = await diagnoseModels({ instance, stateDir: dir }, execute);
    assert.equal(result.image, container.Config.Image);
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

test('mobile diagnosis runs its emitted probe and exposes only known status fields', async () => {
  const dir = await mkdtemp('/tmp/dbc-diagnose-'), deployment = randomUUID(), instance = randomUUID(), name = `dbc-${deployment}-${instance}`;
  await writeFile(join(dir, 'deployment-id'), deployment);
  let source;
  const execute = async (_binary, args) => {
    if (args[1] === 'inspect') return { stdout: JSON.stringify([{ Name: '/' + name, Config: { Labels: { 'cn.donebot.cloud.deployment': deployment, 'cn.donebot.cloud.instance': instance } }, State: { Running: true } }]) };
    source = args.at(-1);
    return { stdout: '{}' };
  };
  try {
    await diagnoseModels({ instance, stateDir: dir }, execute);
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const run = new AsyncFunction('readFile', 'lookup', 'fetch', 'console', source.replace(/^import .+;\n/gm, ''));
    const probe = async mobile => {
      let output;
      const requests = [];
      await run(async () => { throw Error('no fixture credential'); }, async () => [{ family: 4 }], async (url, options) => {
        requests.push(url);
        assert.equal(options.credentials, 'omit');
        assert.equal(options.redirect, 'error');
        assert.equal(options.headers?.authorization, undefined);
        if (url === 'http://127.0.0.1:18899/api/donebot/mobile/status') return mobile();
        assert.equal(url, 'https://donebot.cn/v1/donebot/runtime/models');
        return new Response('{}', { status: 401 });
      }, { log: value => { output = JSON.parse(value); } });
      assert.equal(requests.length, 2);
      assert.doesNotMatch(JSON.stringify(output), /synthetic-private/);
      return output.mobile;
    };
    assert.deepEqual(await probe(() => Response.json({ authenticated: true, registered: true, relay: 'connected', problem: '', node: 'relay1.donebot.cn', token: 'synthetic-private' })), { status: 200, authenticated: true, registered: true, relay: 'connected', problem: '', node: 'relay1.donebot.cn' });
    assert.deepEqual(await probe(() => new Response('not found', { status: 404 })), { status: 404 });
    assert.deepEqual(await probe(() => Response.json({ authenticated: 'true', relay: 'synthetic-private', problem: 'synthetic-private', node: 'synthetic-private' })), { status: 200, authenticated: false, registered: false, relay: 'unknown', problem: 'unknown' });
    assert.deepEqual(await probe(() => { throw Object.assign(new Error('synthetic-private'), { code: 'ECONNREFUSED' }); }), { error: 'ECONNREFUSED' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
