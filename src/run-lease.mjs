import { Fault, instanceID } from './common.mjs';

export const MAX_RUN_LEASE_MS = 60 * 60 * 1000;

export function runLeaseDeadline(until) {
  return { until, monotonicUntil: performance.now() + Math.max(0, until - Date.now()) };
}

export function runLeaseValid(lease) {
  return !!lease && lease.until > Date.now() && lease.monotonicUntil > performance.now();
}

export function runLeaseUntil(lease) {
  const now = Date.now();
  return now + Math.floor(Math.min(lease.until - now, lease.monotonicUntil - performance.now()));
}

export function readRunLeases(response, claimStarted, monotonicStarted = performance.now() - Math.max(0, Date.now() - claimStarted)) {
  const serverTime = Date.parse(response?.server_time);
  if (!Number.isFinite(serverTime) || !Array.isArray(response?.leases)) throw new Fault(502, 'invalid_master_lease');
  const leases = new Map();
  for (const lease of response.leases) {
    const duration = Date.parse(lease?.authorized_until) - serverTime;
    if (!Number.isFinite(duration) || duration > MAX_RUN_LEASE_MS || !Number.isSafeInteger(lease?.generation) || lease.generation < 1) throw new Fault(502, 'invalid_master_lease');
    const id = instanceID(lease.instance_id);
    if (leases.has(id)) throw new Fault(502, 'invalid_master_lease');
    leases.set(id, { until: claimStarted + duration, monotonicUntil: monotonicStarted + duration, generation: lease.generation });
  }
  return leases;
}
