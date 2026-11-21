import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DockerRuntime } from '../src/docker.mjs';
import { BoundedDisks } from '../src/storage.mjs';
import { TEAM_PROTOCOL, teamConfiguration, teamCoordinatorConfiguration, teamEnvironment, teamRequest } from '../src/team-runtime.mjs';
import { teamFixture } from './team-fixtures.mjs';



test('team host configuration pins identity and copies only validated specifications', () => {
  const f = teamFixture(), clean = teamConfiguration({ ...f.team, gateway: 'never-copy', payer: 101 }, f.id, f.publicKey);
  assert.deepEqual(clean, f.team);
  assert.ok(!JSON.stringify(teamEnvironment(clean)).includes('gateway'));
  for (const patch of [{ protocol: 'future' }, { instance_id: randomUUID() }, { team_id: '../x' }, { public_key: teamFixture().publicKey },
    { runtime: { ...f.team.runtime, cpu_millis: 0 } }, { shared_quota_bytes: 9 * 1024 ** 3 }, { max_file_bytes: 3 * 1024 ** 3 }]) {
    assert.throws(() => teamConfiguration({ ...f.team, ...patch }, f.id, f.publicKey));
  }
  clean.runtime.cpu_millis = 999;
  assert.equal(f.team.runtime.cpu_millis, 2000);
});

test('member signatures bind exact method, query, tenant, instance, role and short expiry', () => {
  const f = teamFixture(), path = '/api/events?cursor=exact';
  const check = (token, method = 'GET', uri = path) => teamRequest(f.team, { method, headers: { 'x-donebot-team-grant': token } }, uri);
  assert.equal(check(f.grant(path)).role, 'member');
  for (const patch of [{ team_id: randomUUID() }, { instance_id: randomUUID() }, { role: 'root' }, { user_id: '0' }, { member_version: 0 },
    { expires: Math.floor(Date.now() / 1000) - 1 }, { expires: Math.floor(Date.now() / 1000) + 30 }, { protocol: 'future' }]) assert.throws(() => check(f.grant(path, 'member', patch)));
  assert.throws(() => check(f.grant(path), 'POST'));
  assert.throws(() => check(f.grant(path), 'GET', '/api/events?cursor=other'));
  assert.throws(() => check(f.grant(path) + 'x'));
  assert.throws(() => check(undefined));
});

test('host metadata persists purchased resources and prevents personal/team takeover', async t => {
  const dir = await mkdtemp('/tmp/dbc-team-meta-'), f = teamFixture();
  const runtime = new DockerRuntime({ stateDir: dir, image: 'fixture', development: true, teamsEnabled: true, teamPublicKey: f.publicKey });
  t.after(async () => { runtime.store.close(); await rm(dir, { recursive: true, force: true }); });
  runtime.inspect = async () => null;
  await runtime.configureTeam(f.id, f.team);
  await runtime.configureTeam(f.id, { ...f.team, name: 'Renamed team' });
  assert.deepEqual(runtime.teamConfiguration(f.id), f.team);
  await assert.rejects(runtime.configureTeam(f.id, { ...f.team, runtime: { ...f.team.runtime, memory_mib: 8192 } }), { code: 'team_runtime_spec_immutable' });
  await assert.rejects(runtime.configureTeam(f.id, { ...f.team, team_id: randomUUID() }), { code: 'team_runtime_spec_immutable' });
  assert.throws(() => runtime.configureGateway(f.id, {}), { code: 'team_personal_credential_forbidden' });
  assert.throws(() => runtime.writeGateway(f.id, join(dir, 'missing-directory')), { code: 'runtime_credential_required' });
  const personal = randomUUID();
  runtime.store.run('INSERT INTO runtime_credentials VALUES(?,?)', personal, 'synthetic');
  await assert.rejects(runtime.configureTeam(personal, { ...f.team, instance_id: personal }), { code: 'team_personal_credential_forbidden' });
  runtime.inspect = async () => ({ Config: {} });
  const other = randomUUID();
  await assert.rejects(runtime.configureTeam(other, { ...f.team, instance_id: other }), { code: 'team_runtime_scope_immutable' });
  runtime.teamsEnabled = false;
  await assert.rejects(runtime.configureTeam(f.id, f.team), { code: 'team_runtime_disabled' });
});

test('coordinator secrets are encrypted outside tenant data and fenced by instance generation', async t => {
  const dir = await mkdtemp('/tmp/dbc-team-coordinator-'), f = teamFixture();
  const runtime = new DockerRuntime({ stateDir: dir, image: 'fixture', development: true, teamsEnabled: true, teamPublicKey: f.publicKey });
  t.after(async () => { runtime.store.close(); await rm(dir, { recursive: true, force: true }); });
  runtime.inspect = async () => null;
  assert.throws(() => runtime.configureTeamCoordinator(f.id, f.coordinator), { code: 'invalid_team_coordinator' });
  await runtime.configureTeam(f.id, f.team);
  for (const patch of [{ instance_id: randomUUID() }, { team_id: randomUUID() }, { generation: -1 }, { generation: 0.5 }, { protocol: 'future' }, { credential: 'sk-donebot-forbidden' }, { credential: 'dbtc_' + 'x'.repeat(43) }]) {
    assert.throws(() => runtime.configureTeamCoordinator(f.id, { ...f.coordinator, ...patch }), { code: 'invalid_team_coordinator' });
  }
  runtime.configureTeamCoordinator(f.id, { ...f.coordinator, payer_id: 101 });
  const saved = runtime.store.get('SELECT value FROM team_coordinators WHERE id=?', f.id).value;
  assert.ok(!saved.includes(f.coordinator.credential));
  assert.deepEqual(runtime.store.vault.open(saved), f.coordinator);
  assert.deepEqual(teamCoordinatorConfiguration(f.coordinator, f.team), f.coordinator);
  assert.ok(!JSON.stringify(teamEnvironment(f.team)).includes(f.coordinator.credential));
  runtime.configureTeamCoordinator(f.id, { ...f.coordinator, generation: 2 });
  assert.throws(() => runtime.configureTeamCoordinator(f.id, f.coordinator), { code: 'team_coordinator_generation_mismatch' });
  assert.throws(() => runtime.configureTeamCoordinator(f.id, { ...f.coordinator, generation: 2, credential: 'dbtc_' + Buffer.alloc(32, 4).toString('base64url') }), { code: 'team_coordinator_generation_mismatch' });
});

test('team disks use per-instance limits and preserve existing smaller disks', async t => {
  const dir = await mkdtemp('/tmp/dbc-team-disk-'), f = teamFixture();
  const runtime = new DockerRuntime({ stateDir: dir, image: 'fixture', development: true, teamsEnabled: true, teamPublicKey: f.publicKey });
  t.after(async () => { runtime.store.close(); await rm(dir, { recursive: true, force: true }); });
  runtime.store.db.exec('CREATE TABLE disks(id TEXT PRIMARY KEY,bytes INTEGER NOT NULL,state TEXT NOT NULL)');
  const disks = Object.assign(Object.create(BoundedDisks.prototype), { bytes: 5 * 1024 ** 3, store: runtime.store,
    limitFor: id => id === f.id ? f.team.runtime.storage_gib * 1024 ** 3 : 5 * 1024 ** 3 });
  assert.equal(disks.bytesFor(f.id), 8 * 1024 ** 3);
  assert.equal(disks.bytesFor(randomUUID()), 5 * 1024 ** 3);
  runtime.store.run('INSERT INTO disks VALUES(?,?,?)', f.id, 4 * 1024 ** 3, 'ready');
  assert.equal(disks.bytesFor(f.id), 4 * 1024 ** 3);
  runtime.store.run('UPDATE disks SET bytes=? WHERE id=?', 9 * 1024 ** 3, f.id);
  assert.throws(() => disks.bytesFor(f.id), { code: 'storage_spec_mismatch' });
});
