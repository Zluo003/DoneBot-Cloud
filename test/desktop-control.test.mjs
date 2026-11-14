import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { DesktopControl, trackDesktopMcp } from '../src/desktop-control.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dbc-control-')), store = new Store(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, control: new DesktopControl(store) };
}
test('local, cloud and viewer compete for one seat and completed calls release it', t => {
  const { control } = fixture(t), local = control.enter('fixture', 'local');
  assert.throws(() => control.enter('fixture', 'cloud'), { code: 'desktop_control_occupied' });
  assert.throws(() => control.enter('fixture', 'viewer'), { code: 'desktop_control_occupied' });
  const forwarded = [], mcp = trackDesktopMcp(local, chunk => forwarded.push(chunk));
  const request = Buffer.from(JSON.stringify({ id: 1, method: 'tools/call', params: { text: '中文' } }) + '\n');
  for (const byte of request) mcp.input(Buffer.from([byte]));
  assert.equal(Buffer.concat(forwarded).toString(), request.toString());
  mcp.output(Buffer.from('{"id":1,"result":{}}\n')); mcp.close();
  assert.deepEqual(control.status('fixture'), { occupied: false, review_required: false });
  control.enter('fixture', 'cloud').release();
});
test('lost response persists review state and prevents takeover after restart', t => {
  const { store, control } = fixture(t), lease = control.enter('fixture', 'local');
  const mcp = trackDesktopMcp(lease, () => {});
  mcp.input(Buffer.from('{"id":1,"method":"tools/call"}\n')); mcp.close();
  const restarted = new DesktopControl(store);
  assert.throws(() => restarted.enter('fixture', 'cloud'), { code: 'desktop_interrupted_action_requires_review' });
  restarted.reset('fixture'); restarted.enter('fixture', 'viewer').release();
});
test('one interrupted channel blocks other channels even with the same controller', t => {
  const { control } = fixture(t), first = control.enter('fixture', 'cloud'), second = control.enter('fixture', 'cloud');
  const mcp = trackDesktopMcp(first, () => {});
  mcp.input(Buffer.from('{"id":1,"method":"tools/call"}\n')); mcp.close();
  assert.throws(() => second.begin('next'), { code: 'desktop_control_lost' });
  assert.throws(() => control.reset('fixture'), { code: 'desktop_control_occupied' });
  second.release(); assert.equal(control.status('fixture').review_required, true);
});
test('stop excludes new operations and retires late disconnects only after confirmed stop', async t => {
  const { control } = fixture(t), old = control.enter('fixture', 'local');
  old.begin('in-flight');
  let finish;
  const stopping = control.stopAndReset('fixture', () => new Promise(resolve => { finish = resolve; }));
  assert.throws(() => control.enter('fixture', 'viewer'), { code: 'desktop_control_occupied' });
  assert.throws(() => old.begin('next'), { code: 'desktop_control_lost' });
  finish(); await stopping;
  const current = control.enter('fixture', 'cloud');
  old.interrupt(); old.finish('in-flight'); old.release();
  assert.deepEqual(control.status('fixture'), { occupied: true, review_required: false });
  current.release();
});
test('failed stop preserves uncertainty and the original seat', async t => {
  const { control } = fixture(t), old = control.enter('fixture', 'local');
  old.begin('in-flight');
  await assert.rejects(control.stopAndReset('fixture', async () => { throw new Error('stop failed'); }));
  assert.equal(control.status('fixture').occupied, true);
  old.interrupt(); old.release();
  assert.equal(control.status('fixture').review_required, true);
});
