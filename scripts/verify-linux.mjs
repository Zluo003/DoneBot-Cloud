import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { release } from 'node:os';
import { DockerRuntime } from '../src/docker.mjs';

if (process.platform !== 'linux' || process.env.CLOUD_DISPOSABLE_LINUX !== '1') throw new Error('run only inside an explicitly disposable Linux fixture (CLOUD_DISPOSABLE_LINUX=1)');
const dir = await mkdtemp('/tmp/dbc-linux-'), ids = [randomUUID(), randomUUID()];
const runtime = new DockerRuntime({ stateDir: join(dir, 'resources'), image: process.env.CLOUD_DONEBOT_IMAGE, binary: process.env.CLOUD_DOCKER_BINARY || '/usr/bin/docker' });
const inside = (id, script, ...args) => runtime.docker(['container', 'exec', runtime.names(id).container, 'node', '--input-type=module', '-e', script, ...args]);
try {
  for (const [i, id] of ids.entries()) {
    await runtime.start(id);
    await inside(id, "import{writeFileSync}from'node:fs';writeFileSync('/data/cloud-fixture.txt',process.argv[1]);", String(i));
  }
  const namespaces = await Promise.all(ids.map(id => inside(id, "import{readlinkSync}from'node:fs';process.stdout.write(readlinkSync('/proc/self/ns/net'));")));
  assert.notEqual(namespaces[0], namespaces[1]);
  for (const [i, id] of ids.entries()) {
    const other = ids[1 - i], volume = await runtime.inspect('volume', runtime.names(other).volume);
    const result = JSON.parse(await inside(id, "import{existsSync,readFileSync}from'node:fs';let networkDenied=false;try{await fetch('http://10.0.2.2:18991/',{signal:AbortSignal.timeout(1000)})}catch{networkDenied=true}process.stdout.write(JSON.stringify({marker:readFileSync('/data/cloud-fixture.txt','utf8'),otherVolume:existsSync(process.argv[1]),docker:existsSync('/var/run/docker.sock'),controlSecrets:Object.keys(process.env).some(k=>k.startsWith('CLOUD_')),networkDenied}));", volume.Mountpoint));
    assert.deepEqual(result, { marker: String(i), otherVolume: false, docker: false, controlSecrets: false, networkDenied: true });
  }
  await runtime.stop(ids[0]); await runtime.start(ids[0]);
  assert.equal(await inside(ids[0], "import{readFileSync}from'node:fs';process.stdout.write(readFileSync('/data/cloud-fixture.txt'));"), '0');
  await runtime.purge(ids[0]); assert.equal((await runtime.status(ids[0])).state, 'absent'); assert.equal(await runtime.inspect('volume', runtime.names(ids[0]).volume), null);
  assert.equal(await inside(ids[1], "import{readFileSync}from'node:fs';process.stdout.write(readFileSync('/data/cloud-fixture.txt'));"), '1');
  const dockerServer = (await runtime.docker(['version', '--format', '{{.Server.Version}}'])).trim();
  console.log(JSON.stringify({ result: 'linux_fixture_passed', platform: process.platform, arch: process.arch, kernel: release(), node: process.version, dockerServer, image: runtime.image, users: 2, separateNetworkNamespaces: true, crossVolumeDenied: true, dockerSocketAbsent: true, controlSecretsAbsent: true, networkDenied: true, persistence: true, scopedPurge: true, publicInternetEgress: false }));
} finally {
  const cleanup = await Promise.allSettled(ids.map(id => runtime.purge(id))); runtime.close();
  if (cleanup.every(r => r.status === 'fulfilled')) await rm(dir, { recursive: true, force: true });
  else throw new Error('fixture cleanup incomplete; preserve its private state directory for recovery: ' + dir);
}
