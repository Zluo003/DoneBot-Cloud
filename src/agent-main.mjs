import { resolve } from 'node:path';
import { createAgent } from './agent.mjs';
import { DockerRuntime } from './docker.mjs';
import { privateDir } from './common.mjs';
import { hostLock } from './host-lock.mjs';

const stateDir = privateDir(resolve(process.env.CLOUD_AGENT_STATE_DIR || '.local/agent'));
const development = process.env.CLOUD_MODE === 'development';
const unlock = development ? () => {} : hostLock(stateDir);
const app = await createAgent({ socketPath: resolve(process.env.CLOUD_AGENT_SOCKET || `${stateDir}/agent.sock`), publicOrigin: process.env.CLOUD_PUBLIC_ORIGIN, development,
  backupIntervalMs: Number(process.env.CLOUD_BACKUP_INTERVAL_HOURS || '0') * 3600000,
  socketGroup: process.env.CLOUD_AGENT_SOCKET_GID === undefined ? undefined : Number(process.env.CLOUD_AGENT_SOCKET_GID),
  runtime: new DockerRuntime({ stateDir, image: process.env.CLOUD_DONEBOT_IMAGE, development, binary: process.env.CLOUD_DOCKER_BINARY || '/usr/bin/docker',
    gatewayRequired: !development,
    desktopImage: process.env.CLOUD_DESKTOP_IMAGE, desktopBytes: process.env.CLOUD_DESKTOP_STORAGE_BYTES === undefined ? undefined : Number(process.env.CLOUD_DESKTOP_STORAGE_BYTES), desktopIdleMs: process.env.CLOUD_DESKTOP_IDLE_MINUTES === undefined ? undefined : Number(process.env.CLOUD_DESKTOP_IDLE_MINUTES) * 60000,
    storage: development ? 'volume' : 'bounded-ext4', storageBytes: process.env.CLOUD_STORAGE_BYTES === undefined ? undefined : Number(process.env.CLOUD_STORAGE_BYTES),
    egress: process.env.CLOUD_EGRESS_MODE || 'none', egressDNS: process.env.CLOUD_EGRESS_DNS?.split(','), egressDenyIPv4: process.env.CLOUD_EGRESS_DENY_IPV4?.split(','), nftBinary: process.env.CLOUD_NFT_BINARY || '/usr/sbin/nft' }),
});
console.log(JSON.stringify({ app: 'donebot-cloud-agent', ready: true }));
let closing = false;
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => { if (closing) return; closing = true; try { await app.close(); } finally { unlock(); } });
