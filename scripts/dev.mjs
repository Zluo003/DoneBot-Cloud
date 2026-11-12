import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createAgent } from '../src/agent.mjs';
import { createControl } from '../src/control.mjs';
import { Gateway } from '../src/gateway.mjs';
import { SyntheticRuntime, syntheticGateway } from './fixtures.mjs';

const dir = await mkdtemp('/tmp/dbc-dev-'), gateway = await syntheticGateway(), runtime = new SyntheticRuntime(join(dir, 'tenants'));
const agentSocket = join(dir, 'agent.sock');
const agent = await createAgent({ socketPath: agentSocket, runtime, development: true });
const control = await createControl({ stateDir: join(dir, 'control'), agentSocket, gateway: new Gateway({ ...gateway, mode: 'development' }) });
console.log(JSON.stringify({ origin: control.origin, mode: 'synthetic-only', users: ['a', 'b', 'poor'], temporaryPassword: gateway.password }));
let closing = false;
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => { if (closing) return; closing = true; await control.close(); await agent.close(); await gateway.close(); await rm(dir, { recursive: true, force: true }); });
