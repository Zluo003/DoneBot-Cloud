import { request } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { Fault } from './common.mjs';

// Credentials and forwarding headers are reconstructed at each trust boundary.
export function proxyHeaders(req, origin, bearer) {
  const headers = { host: new URL(origin).host, 'x-forwarded-proto': new URL(origin).protocol.slice(0, -1) };
  for (const name of ['content-type', 'accept', 'range', 'if-range', 'if-none-match', 'last-event-id', 'user-agent']) if (typeof req.headers[name] === 'string') headers[name] = req.headers[name];
  if (req.headers.origin) headers.origin = origin;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  return headers;
}
export function safePath(path) {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || /[\r\n\x00]/.test(path)) throw new Fault(400, 'invalid_proxy_path');
  const pathname = path.split('?')[0];
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { throw new Fault(400, 'invalid_proxy_path'); }
  if (decoded !== pathname || decoded.split('/').some(p => p === '.' || p === '..')) throw new Fault(400, 'invalid_proxy_path');
  if (/^\/api\/(auth(?:\/|$)|pair(?:\/|$))/.test(pathname) && !['/api/auth/session', '/api/auth/stream-ticket'].includes(pathname)) throw new Fault(403, 'instance_auth_managed_by_cloud');
  return path;
}
export function httpProxy(req, res, options, headers, track = () => () => {}) {
  // Pinned Linux socket descriptors can reuse a number for another tenant after close.
  const outgoing = request({ ...options, agent: false, method: req.method, headers }, incoming => {
    const clean = { ...incoming.headers };
    for (const name of ['set-cookie', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-authenticate', 'access-control-allow-origin']) delete clean[name];
    clean['cache-control'] = 'no-store';
    res.writeHead(incoming.statusCode, clean); incoming.pipe(res);
    incoming.on('error', () => res.destroy());
  });
  const remove = track(() => { outgoing.destroy(); res.destroy(); });
  outgoing.on('error', () => { if (!res.headersSent) { res.writeHead(502); res.end(); } else res.destroy(); });
  res.once('close', () => { remove(); outgoing.destroy(); });
  req.once('aborted', () => outgoing.destroy()); req.pipe(outgoing);
  return outgoing;
}
export const wsServer = () => new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024, perMessageDeflate: false });
export function wsProxy(wss, req, socket, head, options, headers, track = () => () => {}) {
  // Wait for upstream authentication before acknowledging the client's upgrade.
  const url = options.socketPath ? `ws+unix://${options.socketPath}:${options.path}` : `ws://${options.hostname || '127.0.0.1'}:${options.port}${options.path}`;
  const upstream = new WebSocket(url, { headers, agent: false, handshakeTimeout: 10000, maxPayload: 8 * 1024 * 1024, perMessageDeflate: false });
  const remove = track(() => { upstream.terminate(); socket.destroy(); });
  socket.once('close', () => { remove(); upstream.terminate(); });
  upstream.once('error', () => socket.destroy());
  upstream.once('unexpected-response', (_, res) => { res.resume(); upstream.terminate(); socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); });
  upstream.once('open', () => {
    if (socket.destroyed) return upstream.terminate();
    wss.handleUpgrade(req, socket, head, client => {
      upstream.on('message', (data, binary) => { if (client.readyState === WebSocket.OPEN) client.send(data, { binary }); if (client.bufferedAmount > 8 * 1024 * 1024) client.terminate(); });
      client.on('message', (data, binary) => { if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary }); if (upstream.bufferedAmount > 8 * 1024 * 1024) upstream.terminate(); });
      client.on('error', () => upstream.terminate()); client.on('close', () => upstream.terminate()); upstream.on('close', () => client.terminate());
    });
  });
  return upstream;
}
