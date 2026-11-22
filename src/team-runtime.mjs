import { createPublicKey, verify } from 'node:crypto';
import { Fault, hash, instanceID } from './common.mjs';

export const TEAM_PROTOCOL = 'donebot.teams.v1';
export const PERSONAL_RUNTIME = Object.freeze({ cpu_millis: 1000, memory_mib: 2048, pids: 256 });
export const PERSONAL_DESKTOP = Object.freeze({ cpu_millis: 1000, memory_mib: 2048, pids: 512 });
const integer = (n, min, max) => Number.isSafeInteger(n) && n >= min && n <= max;
function resources(value) {
  if (!value || !integer(value.cpu_millis, 250, 32000) || !integer(value.memory_mib, 512, 65536) ||
      !integer(value.storage_gib, 1, 1024) || !integer(value.pids, 64, 4096)) throw new Fault(400, 'invalid_team_resources');
  return { cpu_millis: value.cpu_millis, memory_mib: value.memory_mib, storage_gib: value.storage_gib, pids: value.pids };
}
export function teamPublicKey(value) {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'base64') : Buffer.alloc(0);
  if (bytes.length !== 32 || bytes.toString('base64') !== value) throw new Fault(400, 'invalid_team_public_key');
  return createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), bytes]), type: 'spki', format: 'der' });
}
export function teamConfiguration(value, id, pinnedKey) {
  if (!value || value.protocol !== TEAM_PROTOCOL || value.instance_id !== instanceID(id) || value.public_key !== pinnedKey) throw new Fault(403, 'team_runtime_trust_mismatch');
  teamPublicKey(value.public_key);
  const teamId = instanceID(value.team_id);
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 100) throw new Fault(400, 'invalid_team_name');
  const runtime = resources(value.runtime), desktop = resources(value.desktop);
  if (!integer(value.shared_quota_bytes, 1, runtime.storage_gib * 1024 ** 3) || !integer(value.max_file_bytes, 1, value.shared_quota_bytes)) throw new Fault(400, 'invalid_team_file_limits');
  return { protocol: TEAM_PROTOCOL, instance_id: id, team_id: teamId, name: value.name, public_key: value.public_key,
    runtime, desktop, shared_quota_bytes: value.shared_quota_bytes, max_file_bytes: value.max_file_bytes };
}
export function teamEnvironment(value) {
  return [`DONEBOT_TEAM_RUNTIME=1`, `DONEBOT_TEAM_ID=${value.team_id}`, `DONEBOT_TEAM_NAME=${value.name}`,
    `DONEBOT_TEAM_INSTANCE_ID=${value.instance_id}`, `DONEBOT_TEAM_PUBLIC_KEY=${value.public_key}`,
    `DONEBOT_TEAM_SHARED_QUOTA_BYTES=${value.shared_quota_bytes}`, `DONEBOT_TEAM_MAX_FILE_BYTES=${value.max_file_bytes}`,
    'DONEBOT_TEAM_FILES_ENABLED=1', 'DONEBOT_TEAM_TEMPLATES_ENABLED=1', 'DONEBOT_TEAM_EXECUTION_ENABLED=1',
    'DONEBOT_TEAM_COORDINATOR_FILE=/run/donebot/team-coordinator.json'];
}

export function teamCoordinatorConfiguration(value, team) {
  if (!team || !value || value.protocol !== TEAM_PROTOCOL || value.instance_id !== team.instance_id || value.team_id !== team.team_id ||
      !integer(value.generation, 0, Number.MAX_SAFE_INTEGER) || typeof value.credential !== 'string' || !/^dbtc_[A-Za-z0-9_-]{43}$/.test(value.credential) ||
      Buffer.from(value.credential.slice(5), 'base64url').toString('base64url') !== value.credential.slice(5)) throw new Fault(403, 'invalid_team_coordinator');
  return { protocol: TEAM_PROTOCOL, instance_id: team.instance_id, team_id: team.team_id, generation: value.generation, credential: value.credential };
}
// Grants are bound to the inner runtime URI; a trusted proxy must never replace them with an owner session.
export function teamRequest(value, req, path, now = Date.now()) {
  const token = req.headers['x-donebot-team-grant'];
  if (typeof token !== 'string' || token.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw new Fault(401, 'team_member_grant_required');
  try {
    const [encoded, signature] = token.split('.'), bytes = Buffer.from(encoded, 'base64url');
    if (!verify(null, bytes, teamPublicKey(value.public_key), Buffer.from(signature, 'base64url'))) throw new Error();
    const claim = JSON.parse(bytes), until = claim.expires * 1000;
    if (claim.protocol !== TEAM_PROTOCOL || claim.instance_id !== value.instance_id || claim.team_id !== value.team_id ||
        !/^[1-9][0-9]{0,19}$/.test(claim.user_id || '') || typeof claim.email !== 'string' || !claim.email.includes('@') || claim.email.length > 254 ||
        !['owner', 'admin', 'member'].includes(claim.role) || !integer(claim.member_version, 1, Number.MAX_SAFE_INTEGER) ||
        !Number.isSafeInteger(claim.expires) || until <= now || until > now + 10000 || claim.runtime_hash !== hash(`${req.method || 'GET'}\n${path}`)) throw new Error();
    return { token, role: claim.role, userId: claim.user_id };
  } catch { throw new Fault(401, 'invalid_team_member_grant'); }
}
