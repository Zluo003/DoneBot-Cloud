import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DockerRuntime } from '../src/docker.mjs';
import { TEAM_PROTOCOL } from '../src/team-runtime.mjs';
import { teamFixture } from './team-fixtures.mjs';
import {
  DEFAULT_TEAM_APPARMOR_PROFILE,
  DEFAULT_TEAM_SECCOMP_PATH,
  checkContainerSecurityOpts,
  loadTeamSeccomp,
  resolveTeamSecurityConfig,
  teamSecurityArgs,
  validateAppArmorProfileName,
  validateTeamSeccompDocument,
} from '../src/team-security.mjs';

test('bundled team-seccomp.json passes strict validation and denies high-risk kernel syscalls', () => {
  const loaded = loadTeamSeccomp(DEFAULT_TEAM_SECCOMP_PATH);
  assert.equal(loaded.path, DEFAULT_TEAM_SECCOMP_PATH);
  assert.match(loaded.digest, /^[a-f0-9]{64}$/);
  const parsed = JSON.parse(readFileSync(DEFAULT_TEAM_SECCOMP_PATH, 'utf8'));
  assert.equal(parsed.defaultAction, 'SCMP_ACT_ERRNO');
  assert.equal(validateTeamSeccompDocument(parsed), loaded.digest);
});

test('seccomp validator refuses unconfined, permissive defaults, and forbidden syscalls', async t => {
  const dir = await mkdtemp('/tmp/dbc-seccomp-');
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  assert.throws(() => loadTeamSeccomp('unconfined'), { code: 'invalid_team_seccomp_path' });
  assert.throws(() => loadTeamSeccomp('relative/seccomp.json'), { code: 'invalid_team_seccomp_path' });

  const base = JSON.parse(readFileSync(DEFAULT_TEAM_SECCOMP_PATH, 'utf8'));
  for (const forbidden of ['bpf', 'ptrace', 'add_key', 'keyctl', 'io_uring_setup', 'kexec_load', 'chroot', 'setns', 'reboot']) {
    const mutated = structuredClone(base);
    mutated.syscalls.push({ names: [forbidden], action: 'SCMP_ACT_ALLOW' });
    assert.throws(() => validateTeamSeccompDocument(mutated), { code: 'forbidden_team_seccomp_syscall' }, forbidden);
  }
  const allowAll = structuredClone(base);
  allowAll.defaultAction = 'SCMP_ACT_ALLOW';
  assert.throws(() => validateTeamSeccompDocument(allowAll), { code: 'invalid_team_seccomp' });

  const missingUnshare = structuredClone(base);
  missingUnshare.syscalls = missingUnshare.syscalls.filter(r => !r.names?.includes('pivot_root'));
  assert.throws(() => validateTeamSeccompDocument(missingUnshare), { code: 'incomplete_team_seccomp' });

  const badFile = join(dir, 'bad.json');
  await writeFile(badFile, JSON.stringify(allowAll));
  assert.throws(() => loadTeamSeccomp(badFile), { code: 'invalid_team_seccomp' });
});

test('AppArmor profile validator rejects unconfined and docker-default', () => {
  assert.equal(validateAppArmorProfileName(DEFAULT_TEAM_APPARMOR_PROFILE), 'donebot-team-container');
  assert.throws(() => validateAppArmorProfileName('unconfined'), { code: 'invalid_team_apparmor_profile' });
  assert.throws(() => validateAppArmorProfileName('docker-default'), { code: 'invalid_team_apparmor_profile' });
  assert.throws(() => validateAppArmorProfileName('../escape'), { code: 'invalid_team_apparmor_profile' });
});

test('container security options enforce strict separation between personal and team containers', () => {
  const seccomp = loadTeamSeccomp(DEFAULT_TEAM_SECCOMP_PATH);
  const rawJson = JSON.stringify(JSON.parse(readFileSync(DEFAULT_TEAM_SECCOMP_PATH, 'utf8')));
  const withAppArmor = { seccomp, appArmor: { enabled: true, profileLoaded: true, profile: DEFAULT_TEAM_APPARMOR_PROFILE } };
  const withoutAppArmor = { seccomp, appArmor: { enabled: false, profileLoaded: false, profile: DEFAULT_TEAM_APPARMOR_PROFILE } };
  const missingAppArmor = { seccomp, appArmor: { enabled: true, profileLoaded: false, profile: DEFAULT_TEAM_APPARMOR_PROFILE } };

  // Personal containers must stay on Docker defaults with no-new-privileges only.
  assert.equal(checkContainerSecurityOpts(['no-new-privileges'], null), true);
  assert.equal(checkContainerSecurityOpts(['no-new-privileges', `seccomp=${seccomp.path}`], null), false);
  assert.equal(checkContainerSecurityOpts(['no-new-privileges', 'seccomp=unconfined'], null), false);
  assert.equal(checkContainerSecurityOpts(['no-new-privileges', 'systempaths=unconfined'], null), false);

  // Team containers require exact seccomp (by path or daemon-inlined JSON), enforce AppArmor, and compensated systempaths.
  assert.deepEqual(teamSecurityArgs(withAppArmor), [
    '--security-opt', 'no-new-privileges',
    '--security-opt', `seccomp=${seccomp.path}`,
    '--security-opt', 'apparmor=donebot-team-container',
    '--security-opt', 'systempaths=unconfined',
  ]);
  assert.throws(() => teamSecurityArgs(missingAppArmor), { code: 'team_apparmor_profile_missing' });
  assert.throws(() => teamSecurityArgs(withoutAppArmor), { code: 'team_apparmor_profile_missing' });
  assert.equal(checkContainerSecurityOpts(['no-new-privileges', `seccomp=${seccomp.path}`, 'apparmor=donebot-team-container', 'systempaths=unconfined'], withAppArmor), true);
  assert.equal(checkContainerSecurityOpts(['no-new-privileges:true', `seccomp=${rawJson}`, 'apparmor=donebot-team-container', 'systempaths=unconfined'], withAppArmor), true);
  assert.equal(checkContainerSecurityOpts(['no-new-privileges', `seccomp=${seccomp.path}`, 'apparmor=donebot-team-container'], withAppArmor), false);
  assert.equal(checkContainerSecurityOpts(['no-new-privileges', `seccomp=${seccomp.path}`, 'apparmor=unconfined', 'systempaths=unconfined'], withAppArmor), false);
  assert.equal(checkContainerSecurityOpts(['no-new-privileges', 'seccomp=unconfined', 'apparmor=donebot-team-container', 'systempaths=unconfined'], withAppArmor), false);
  assert.equal(checkContainerSecurityOpts(['no-new-privileges', `seccomp=${seccomp.path}`, 'systempaths=unconfined'], withAppArmor), false);
  assert.equal(checkContainerSecurityOpts(['no-new-privileges', `seccomp=${seccomp.path}`, 'apparmor=donebot-team-container', 'systempaths=unconfined'], withoutAppArmor), false);

  assert.equal(resolveTeamSecurityConfig({ teamsEnabled: false }), null);
});

test('DockerRuntime health gates team_protocol on loaded host AppArmor profile', async t => {
  const dir = await mkdtemp('/tmp/dbc-team-aa-');
  const f = teamFixture();
  let appArmorState = { enabled: true, profileLoaded: false, profile: DEFAULT_TEAM_APPARMOR_PROFILE };
  const runtime = new DockerRuntime({
    stateDir: dir,
    image: 'fixture',
    development: true,
    teamsEnabled: true,
    teamPublicKey: f.publicKey,
    readAppArmor: () => appArmorState,
  });
  t.after(async () => { runtime.store.close(); await rm(dir, { recursive: true, force: true }); });
  runtime.docker = async () => '28.0.4';
  runtime.inspect = async () => ({ Config: { Labels: { 'cn.donebot.teams.protocol': TEAM_PROTOCOL } } });

  const missing = await runtime.health();
  assert.equal(missing.ready, true);
  assert.equal(missing.team_apparmor_ready, false);
  assert.equal(missing.team_protocol, undefined);

  appArmorState = { enabled: true, profileLoaded: true, profile: DEFAULT_TEAM_APPARMOR_PROFILE };
  const loaded = await runtime.health();
  assert.equal(loaded.ready, true);
  assert.equal(loaded.team_apparmor_ready, true);
  assert.equal(loaded.team_protocol, TEAM_PROTOCOL);

  appArmorState = { enabled: false, profileLoaded: false, profile: DEFAULT_TEAM_APPARMOR_PROFILE };
  const noAppArmor = await runtime.health();
  assert.equal(noAppArmor.ready, true);
  assert.equal(noAppArmor.team_apparmor_ready, false);
  assert.equal(noAppArmor.team_protocol, undefined);
});
