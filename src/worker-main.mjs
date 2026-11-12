import { resolve } from 'node:path';
import { createWorker } from './worker.mjs';

const worker = await createWorker({
  masterOrigin: process.env.CLOUD_MASTER_ORIGIN || 'https://donebot.cn',
  nodeId: process.env.CLOUD_NODE_ID, nodeToken: process.env.CLOUD_NODE_TOKEN,
  publicKey: process.env.CLOUD_MASTER_PUBLIC_KEY,
  stateDir: resolve(process.env.CLOUD_WORKER_STATE_DIR || '.local/worker'),
  agentSocket: resolve(process.env.CLOUD_AGENT_SOCKET || '.local/agent/agent.sock'),
  host: process.env.CLOUD_WORKER_HOST || '127.0.0.1', port: Number(process.env.CLOUD_WORKER_PORT || 18991),
  development: process.env.CLOUD_MODE === 'development',
});
console.log(JSON.stringify({ app: 'donebot-cloud-worker', origin: worker.origin }));
let closing = false;
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => { if (closing) return; closing = true; await worker.close(); });
