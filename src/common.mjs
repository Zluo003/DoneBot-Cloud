import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';

export class Fault extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function instanceID(id) { if (!uuidPattern.test(id)) throw new Fault(400, 'invalid_instance'); return id; }
export const hash = value => createHash('sha256').update(value).digest('hex');
export const secret = () => randomBytes(32).toString('base64url');
export function privateDir(path) { mkdirSync(path, { recursive: true, mode: 0o700 }); chmodSync(path, 0o700); return path; }
export function vault(dir) {
  privateDir(dir);
  const path = join(dir, 'key');
  try { writeFileSync(path, randomBytes(32), { mode: 0o600, flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  const key = readFileSync(path);
  if (key.length !== 32) throw new Error('invalid vault key');
  return {
    seal(value) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()]).toString('base64'); },
    open(value) { const b = Buffer.from(value, 'base64'), d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12)); d.setAuthTag(b.subarray(-16)); return JSON.parse(Buffer.concat([d.update(b.subarray(12, -16)), d.final()]).toString()); },
  };
}
export async function body(req, max = 16384) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > max) throw new Fault(413, 'body_too_large'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { throw new Fault(400, 'invalid_json'); }
}
export function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(value));
}
export function fail(res, error) { if (res.headersSent) return res.destroy(); json(res, error.status || 503, { error: error.code || 'service_unavailable' }); }
export async function listen(server, address) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(address, resolve); });
  return server.address();
}
export async function close(server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
export function socketJSON(socketPath, path, method = 'GET', value, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method, agent: false, headers: { 'content-type': 'application/json' }, timeout: timeoutMs }, async res => {
      try { const result = await body(res, 1024 * 1024); if (res.statusCode >= 400) reject(new Fault(res.statusCode, result.error || 'agent_failed')); else resolve(result); } catch (e) { reject(e); }
    });
    req.on('timeout', () => req.destroy(new Fault(504, 'agent_timeout'))); req.on('error', reject); req.end(value === undefined ? undefined : JSON.stringify(value));
  });
}
