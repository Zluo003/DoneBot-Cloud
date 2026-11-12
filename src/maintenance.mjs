import { connect } from 'node:net';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DockerRuntime } from './docker.mjs';
import { instanceID } from './common.mjs';
import { hostLock } from './host-lock.mjs';

if (process.platform !== 'linux' || process.getuid() !== 0 || process.env.CLOUD_MODE === 'development') throw new Error('maintenance requires a root production Linux agent configuration');
const [action, rawID, previousImage] = process.argv.slice(2);
if (!['prepare-upgrade', 'prepare-desktop-upgrade', 'fence'].includes(action)) throw new Error('supported actions: fence | prepare-upgrade INSTANCE_UUID PREVIOUS_IMAGE_DIGEST | prepare-desktop-upgrade INSTANCE_UUID PREVIOUS_DESKTOP_IMAGE_DIGEST');
const id = action !== 'fence' ? instanceID(rawID) : null;
const stateDir = resolve(process.env.CLOUD_AGENT_STATE_DIR || '/var/lib/donebot-cloud-agent');
const unlock = hostLock(stateDir);
const socketPath = resolve(process.env.CLOUD_AGENT_SOCKET || `${stateDir}/agent.sock`);
if (existsSync(socketPath)) {
  const absent = await new Promise(resolve => { const socket = connect(socketPath); socket.once('connect', () => { socket.destroy(); resolve(false); }); socket.once('error', e => resolve(e.code === 'ECONNREFUSED' || e.code === 'ENOENT')); socket.setTimeout(1000, () => { socket.destroy(); resolve(false); }); });
  if (!absent) throw new Error('stop this node worker and agent before maintenance');
}
const runtime = new DockerRuntime({ stateDir, image: process.env.CLOUD_DONEBOT_IMAGE, binary: process.env.CLOUD_DOCKER_BINARY || '/usr/bin/docker', storage: 'bounded-ext4', storageBytes: process.env.CLOUD_STORAGE_BYTES === undefined ? undefined : Number(process.env.CLOUD_STORAGE_BYTES), gatewayRequired: true,
  desktopImage: process.env.CLOUD_DESKTOP_IMAGE, desktopBytes: process.env.CLOUD_DESKTOP_STORAGE_BYTES === undefined ? undefined : Number(process.env.CLOUD_DESKTOP_STORAGE_BYTES), desktopIdleMs: process.env.CLOUD_DESKTOP_IDLE_MINUTES === undefined ? undefined : Number(process.env.CLOUD_DESKTOP_IDLE_MINUTES) * 60000,
  egress: process.env.CLOUD_EGRESS_MODE || 'none', egressDNS: process.env.CLOUD_EGRESS_DNS?.split(','), egressDenyIPv4: process.env.CLOUD_EGRESS_DENY_IPV4?.split(','), nftBinary: process.env.CLOUD_NFT_BINARY || '/usr/sbin/nft' });
try {
  if (action === 'fence') { await runtime.recover(); console.log(JSON.stringify({ fenced: true, data_retained: true })); }
  else {
    if (action === 'prepare-desktop-upgrade') { if (!runtime.desktops) throw new Error('desktop configuration required'); await runtime.desktops.prepareUpgrade(id, previousImage); }
    else await runtime.prepareUpgrade(id, previousImage);
    console.log(JSON.stringify({ prepared: true, instance: id, data_retained: true, started: false }));
  }
}
finally { await runtime.close(); unlock(); }
