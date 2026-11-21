import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { TEAM_PROTOCOL } from '../src/team-runtime.mjs';
import { hash } from '../src/common.mjs';

export function teamFixture() {
  const keys = generateKeyPairSync('ed25519'), id = randomUUID();
  const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  const team = { protocol: TEAM_PROTOCOL, instance_id: id, team_id: randomUUID(), name: 'Studio fixture', public_key: publicKey,
    runtime: { cpu_millis: 2000, memory_mib: 4096, storage_gib: 8, pids: 384 },
    desktop: { cpu_millis: 3000, memory_mib: 6144, storage_gib: 12, pids: 640 }, shared_quota_bytes: 2 * 1024 ** 3, max_file_bytes: 100 * 1024 ** 2 };
  const grant = (path, role = 'member', patch = {}, method = 'GET') => {
    const bytes = Buffer.from(JSON.stringify({ protocol: TEAM_PROTOCOL, instance_id: id, team_id: team.team_id,
      user_id: '303', email: 'member@fixture.invalid', role, member_version: 2, expires: Math.floor(Date.now() / 1000) + 9,
      runtime_hash: hash(`${method}\n${path}`), ...patch }));
    return bytes.toString('base64url') + '.' + sign(null, bytes, keys.privateKey).toString('base64url');
  };
  const coordinator = { protocol: TEAM_PROTOCOL, instance_id: id, team_id: team.team_id, generation: 1, credential: 'dbtc_' + Buffer.alloc(32, 3).toString('base64url') };
  return { ...keys, publicKey, id, team, grant, coordinator };
}
