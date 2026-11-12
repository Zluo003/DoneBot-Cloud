import { resolve } from 'node:path';
import { createControl } from './control.mjs';
import { Gateway } from './gateway.mjs';

const mode = process.env.CLOUD_MODE || 'production';
if (mode !== 'development') throw new Error('the local control server is a development fixture; production authority belongs to donebot-api, run npm start for a worker');
const app = await createControl({
  stateDir: resolve(process.env.CLOUD_STATE_DIR || '.local/control'),
  agentSocket: resolve(process.env.CLOUD_AGENT_SOCKET || '.local/agent/agent.sock'),
  gateway: new Gateway({ mode, origin: process.env.CLOUD_GATEWAY_ORIGIN || 'https://donebot.cn', serviceToken: process.env.CLOUD_GATEWAY_SERVICE_TOKEN }),
  host: process.env.CLOUD_HOST || '127.0.0.1', port: Number(process.env.CLOUD_PORT || 18990),
  publicOrigin: process.env.CLOUD_PUBLIC_ORIGIN,
});
console.log(JSON.stringify({ app: 'donebot-cloud', origin: app.origin }));
let closing = false;
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => { if (closing) return; closing = true; await app.close(); });
