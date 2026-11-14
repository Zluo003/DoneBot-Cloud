import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readRunLeases, runLeaseDeadline, runLeaseValid, runLeaseUntil, MAX_RUN_LEASE_MS } from '../src/run-lease.mjs';

test('run leases discount request latency and reject invalid or excessive grants atomically', () => {
  const now = Date.now(), id = randomUUID();
  const response = { server_time: new Date(now).toISOString(), leases: [{ instance_id: id, generation: 1, authorized_until: new Date(now + 1800000).toISOString() }] };
  const leases = readRunLeases(response, now - 9000);
  assert.equal(leases.get(id).until, now + 1800000 - 9000);
  for (const invalid of [
    { ...response.leases[0], authorized_until: new Date(now + MAX_RUN_LEASE_MS + 1).toISOString() },
    { ...response.leases[0], authorized_until: 'invalid' },
    { ...response.leases[0], generation: 1.5 },
    { ...response.leases[0], instance_id: 'invalid' },
    response.leases[0],
  ]) assert.throws(() => readRunLeases({ ...response, leases: [...response.leases, invalid] }, now));
  assert.equal(leases.size, 1);
  assert.equal(leases.get(id).until, now + 1800000 - 9000);
});

test('wall clock rollback cannot extend a runtime lease', t => {
  const now = Date.now();
  let elapsed = 100;
  t.mock.timers.enable({ apis: ['Date'], now });
  t.mock.method(performance, 'now', () => elapsed);
  const lease = runLeaseDeadline(now + 1800000);
  assert.equal(runLeaseValid(lease), true);
  t.mock.timers.setTime(now - 3600000);
  assert.ok(runLeaseUntil(lease) <= Date.now() + 1800000, 'forwarding to the agent preserves the remaining monotonic budget');
  elapsed += 1800001;
  assert.equal(runLeaseValid(lease), false);
});
