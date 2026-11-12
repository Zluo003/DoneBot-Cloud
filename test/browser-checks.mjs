import assert from 'node:assert/strict';
import { request } from 'node:http';
import { once } from 'node:events';
import WebSocket from 'ws';

export const fixtureBrowserUA = 'donebot-cloud-fixture-browser';
export function browserRequest(master, target, path, { cookie, origin, value, method = value === undefined ? 'GET' : 'POST', userAgent = fixtureBrowserUA, extra = {} } = {}) {
  const server = new URL(master), browser = new URL(target);
  return new Promise((resolve, reject) => {
    const req = request({ hostname: server.hostname, port: server.port, path, method, headers: { host: browser.host, 'user-agent': userAgent, ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}), ...(value ? { 'content-type': 'application/json' } : {}), ...extra }, signal: AbortSignal.timeout(10000) }, res => {
      let text = ''; res.on('data', b => text += b); res.on('end', () => { let value; try { value = JSON.parse(text); } catch { value = text; } resolve({ status: res.statusCode, headers: res.headers, value }); });
    });
    req.on('error', reject); req.end(value === undefined ? undefined : JSON.stringify(value));
  });
}
export async function browserSessionChecks({ config, api, a, b }) {
  const launch = async (token, id) => {
    const result = await api(token, `/fixture/browser/launch/${id}`, {});
    assert.equal(result.status, 200); return new URL(result.value.data.url);
  };
  const urlA = await launch(config.users.a, a.id), urlB = await launch(config.users.b, b.id);
  const requestA = (path, options) => browserRequest(config.masterOrigin, urlA, path, options);
  const requestB = (path, options) => browserRequest(config.masterOrigin, urlB, path, options);
  const codeA = new URLSearchParams(urlA.hash.slice(1)).get('code');
  const codeB = new URLSearchParams(urlB.hash.slice(1)).get('code');
  assert.equal((await api(config.users.a, `/fixture/browser/launch/${b.id}`, {})).status, 404);
  assert.equal((await requestA('/__cloud/launch')).status, 200);
  assert.equal((await requestB('/__cloud/exchange', { origin: urlB.origin, value: { code: codeA } })).status, 401);
  assert.equal((await requestA('/__cloud/exchange', { origin: urlB.origin, value: { code: codeA } })).status, 403);
  assert.equal((await requestA('/__cloud/exchange', { origin: urlA.origin, userAgent: 'another-browser', value: { code: codeA } })).status, 401);
  const redeemed = await Promise.all([0, 1].map(() => requestA('/__cloud/exchange', { origin: urlA.origin, value: { code: codeA } })));
  assert.deepEqual(redeemed.map(r => r.status).sort(), [200, 401]);
  const responseA = redeemed.find(r => r.status === 200), cookieA = responseA.headers['set-cookie'][0].split(';')[0];
  assert.match(responseA.headers['set-cookie'][0], /HttpOnly/); assert.match(responseA.headers['set-cookie'][0], /SameSite=Strict/); assert.doesNotMatch(responseA.headers['set-cookie'][0], /Domain=/i);
  const responseB = await requestB('/__cloud/exchange', { origin: urlB.origin, value: { code: codeB } }), cookieB = responseB.headers['set-cookie'][0].split(';')[0];
  assert.equal((await requestA('/api/value', { cookie: cookieA })).value.value, 'A-private');
  assert.equal((await requestB('/api/value', { cookie: cookieB })).value.value, 'B-private');
  assert.equal((await requestB('/api/value', { cookie: cookieA })).status, 401);
  assert.equal((await requestA('/api/value', { cookie: cookieA, userAgent: 'another-browser' })).status, 401);
  assert.equal((await requestA('/api/value', { cookie: cookieA, origin: urlB.origin, value: { value: 'tampered' } })).status, 403);
  assert.equal((await requestA('/api/value', { cookie: cookieA, extra: { 'sec-fetch-site': 'same-site' } })).status, 403);
  assert.equal((await requestA('/api/value?token=' + config.users.a)).status, 401);
  assert.equal((await requestA('/api/auth/pairing', { cookie: cookieA, origin: urlA.origin, value: {} })).status, 403);
  const navigation = await requestA('/', { extra: { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } });
  assert.equal(navigation.status, 303); assert.equal(navigation.headers.location, config.masterOrigin + '/cloud');
  const wsOptions = { headers: { host: urlA.host, origin: urlA.origin, cookie: cookieA, 'user-agent': fixtureBrowserUA } };
  const wsURL = config.masterOrigin.replace('http:', 'ws:') + '/api/ws';
  const wrong = new WebSocket(wsURL, { headers: { ...wsOptions.headers, origin: urlB.origin } }); wrong.on('error', () => {});
  const denied = await once(wrong, 'unexpected-response'); assert.equal(denied[1].statusCode, 403); denied[1].resume(); wrong.terminate();
  const ws = new WebSocket(wsURL, wsOptions); await once(ws, 'open');
  const message = once(ws, 'message'); ws.send('browser-cookie'); assert.equal((await message)[0].toString(), 'browser-cookie');
  const closed = once(ws, 'close'); assert.equal((await api(config.users.a, '/fixture/browser/revoke', {}, 'POST')).status, 200); await closed;
  assert.equal((await requestA('/api/value', { cookie: cookieA })).status, 401);
  assert.equal((await requestB('/api/value', { cookie: cookieB })).value.value, 'B-private');
  const reopened = await launch(config.users.a, a.id), code = new URLSearchParams(reopened.hash.slice(1)).get('code');
  const fresh = await requestA('/__cloud/exchange', { origin: urlA.origin, value: { code } });
  const freshCookie = fresh.headers['set-cookie'][0].split(';')[0];
  return { cookie: freshCookie, url: urlA, wsURL, wsOptions: { headers: { ...wsOptions.headers, cookie: freshCookie } } };
}
