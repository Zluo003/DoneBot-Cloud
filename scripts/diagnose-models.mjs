import { execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { instanceID } from '../src/common.mjs';

// Runs only explicit GETs inside the selected tenant; credentials never leave that process.
const probe = `
import { readFile } from 'node:fs/promises';
import { lookup } from 'node:dns/promises';
const result = {}, allowed = new Set(['ENOTFOUND','EAI_AGAIN','ECONNREFUSED','ECONNRESET','ENETUNREACH','EHOSTUNREACH','ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','CERT_HAS_EXPIRED','DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN','UNABLE_TO_VERIFY_LEAF_SIGNATURE','UNABLE_TO_GET_ISSUER_CERT_LOCALLY','ERR_TLS_CERT_ALTNAME_INVALID']);
const reasons = new Set(['API_KEY_REQUIRED','INVALID_API_KEY','API_KEY_DISABLED','USER_NOT_FOUND','USER_INACTIVE','ACCESS_DENIED','GROUP_NOT_ALLOWED','GROUP_DISABLED','DONEBOT_INSTALL_NOT_FOUND','DONEBOT_INSTALL_REVOKED','API_KEY_NOT_FOUND']);
const failure = error => ({ error: allowed.has(error?.cause?.code || error?.code) ? error?.cause?.code || error?.code : error?.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK_FAILED' });
try { const addresses = await lookup('donebot.cn', { all: true }); result.dns = { ok: true, ipv4: addresses.filter(x => x.family === 4).length, ipv6: addresses.filter(x => x.family === 6).length }; } catch (error) { result.dns = failure(error); }
let credential;
try {
  const value = JSON.parse(await readFile('/run/donebot/gateway.json', 'utf8'));
  if (!/^sk-donebot-[a-f0-9]{64}$/.test(value.credential || '') || !/^[0-9a-f-]{36}$/.test(value.installationId || '')) throw Error();
  credential = value; result.credential_file = 'valid_shape';
} catch { result.credential_file = 'unavailable_or_invalid'; }
async function request(operation, authenticated) {
  try {
    const response = await fetch('https://donebot.cn/v1/donebot/runtime/' + operation, { headers: authenticated ? { authorization: 'Bearer ' + credential.credential, 'X-DoneBot-Installation': credential.installationId } : {}, redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(12000) });
    const out = { status: response.status }, id = response.headers.get('x-request-id');
    if (/^[A-Za-z0-9._:-]{1,128}$/.test(id || '')) out.request_id = id;
    const reader = response.body?.getReader(), chunks = []; let size = 0;
    if (reader) try { while (true) { const item = await reader.read(); if (item.done) break; size += item.value.length; if (size > 1024 * 1024) return { ...out, json: 'too_large' }; chunks.push(item.value); } } finally { await reader.cancel().catch(() => {}); }
    let data; try { data = JSON.parse(Buffer.concat(chunks).toString()); out.json = true; } catch { return { ...out, json: false }; }
    if (reasons.has(data?.reason)) out.reason = data.reason;
    const value = data?.code === 0 && data?.data ? data.data : data;
    if (response.ok && operation === 'models') { out.model_count = Array.isArray(value?.models) ? value.models.length : null; out.contract = Number.isInteger(value?.gateway_contract_version) ? value.gateway_contract_version : null; }
    if (response.ok && operation === 'account') out.concurrency_valid = Number.isSafeInteger(value?.concurrency) && value.concurrency > 0;
    return out;
  } catch (error) { return failure(error); }
}
result.anonymous_models = await request('models', false);
if (credential) [result.models, result.account] = await Promise.all([request('models', true), request('account', true)]);
console.log(JSON.stringify(result));
`;

export async function diagnoseModels({ instance, stateDir, binary = '/usr/bin/docker' }, execute = promisify(execFile)) {
  instanceID(instance);
  const deployment = instanceID((await readFile(join(stateDir, 'deployment-id'), 'utf8')).trim());
  const name = `dbc-${deployment}-${instance}`;
  const run = args => execute(binary, args, { timeout: 45000, maxBuffer: 4 * 1024 * 1024 });
  const values = JSON.parse((await run(['container', 'inspect', name])).stdout), container = values[0];
  if (values.length !== 1 || container?.Config?.Labels?.['cn.donebot.cloud.deployment'] !== deployment || container?.Config?.Labels?.['cn.donebot.cloud.instance'] !== instance || container?.Name !== '/' + name) throw new Error('diagnostic_ownership_mismatch');
  const result = { instance_id: instance, state: container.State?.Status, network_mode: container.HostConfig?.NetworkMode, dns: container.HostConfig?.Dns || [], probe: null };
  if (container.State?.Running) result.probe = JSON.parse((await run(['container', 'exec', name, 'node', '--input-type=module', '-e', probe])).stdout);
  return result;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { values } = parseArgs({ options: { instance: { type: 'string' } } });
    console.log(JSON.stringify(await diagnoseModels({ instance: values.instance, stateDir: resolve(process.env.CLOUD_AGENT_STATE_DIR || '/var/lib/donebot-cloud-agent'), binary: process.env.CLOUD_DOCKER_BINARY || '/usr/bin/docker' }), null, 2));
  } catch { console.error(JSON.stringify({ error: 'model_diagnostic_failed', hint: 'Check instance ID, state directory, Docker access and resource ownership.' })); process.exitCode = 1; }
}
