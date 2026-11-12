import { Fault } from './common.mjs';

export class Gateway {
  constructor({ origin, serviceToken, mode = 'production', fetcher = fetch }) {
    const url = new URL(origin);
    if (url.origin !== origin || url.username || url.password || url.hash || url.search) throw new Error('invalid gateway origin');
    if (mode === 'production' ? origin !== 'https://donebot.cn' : !(mode === 'development' && url.hostname === '127.0.0.1' && url.protocol === 'http:')) throw new Error('gateway origin forbidden for mode');
    this.origin = origin; this.serviceToken = serviceToken; this.fetcher = fetcher;
  }
  async call(path, method = 'GET', value, accessToken, internal = false) {
    const headers = { 'content-type': 'application/json', 'user-agent': 'DoneBot-Cloud/0.1' };
    if (accessToken) headers.authorization = `Bearer ${accessToken}`;
    if (internal) { if (!this.serviceToken) throw new Fault(503, 'billing_not_configured'); headers['x-donebot-cloud-service'] = this.serviceToken; }
    let res;
    try { res = await this.fetcher(`${this.origin}/api/v1/${path}`, { method, headers, body: value === undefined ? undefined : JSON.stringify(value), redirect: 'error', signal: AbortSignal.timeout(10000) }); }
    catch { throw new Fault(503, 'gateway_unavailable'); }
    let result;
    try { const text = await res.text(); if (text.length > 1_000_000) throw new Error(); result = JSON.parse(text); } catch { throw new Fault(502, 'invalid_gateway_response'); }
    if (!res.ok || result.code !== 0) throw new Fault([400, 401, 402, 403, 409, 429].includes(res.status) ? res.status : 503, res.status === 402 ? 'insufficient_balance' : res.status === 401 ? 'gateway_login_required' : 'gateway_request_failed');
    return result.data;
  }
  async identity(token) {
    const user = await this.call('auth/me', 'GET', undefined, token);
    if (!Number.isSafeInteger(user?.id) || user.id <= 0 || user.status !== 'active') throw new Fault(401, 'invalid_gateway_identity');
    return String(user.id);
  }
  async login(input, twoFactor = false) {
    const allowed = twoFactor ? ['temp_token', 'totp_code'] : ['email', 'password', 'turnstile_token', 'tencent_captcha_ticket', 'tencent_captcha_randstr'];
    const payload = Object.fromEntries(allowed.filter(k => typeof input[k] === 'string').map(k => [k, input[k]]));
    const result = await this.call(twoFactor ? 'auth/login/2fa' : 'auth/login', 'POST', payload);
    if (result?.requires_2fa === true) return { requires_2fa: true, temp_token: result.temp_token };
    return this.credentials(result);
  }
  credentials(result) {
    if (typeof result?.access_token !== 'string' || typeof result.refresh_token !== 'string' || !Number.isFinite(result.expires_in) || result.expires_in <= 0) throw new Fault(502, 'invalid_gateway_session');
    return { accessToken: result.access_token, refreshToken: result.refresh_token, expiresAt: Date.now() + result.expires_in * 1000 };
  }
  async verify(session) {
    let credentials = session.credentials;
    if (credentials.expiresAt <= Date.now() + 30000) credentials = this.credentials(await this.call('auth/refresh', 'POST', { refresh_token: credentials.refreshToken }));
    if (await this.identity(credentials.accessToken) !== session.owner) throw new Fault(401, 'identity_changed');
    return credentials;
  }
  subscription(id, action = 'status', accessToken) { return this.call(`donebot/cloud/billing/instances/${id}/${action}`, action === 'status' ? 'GET' : 'POST', action === 'status' ? undefined : {}, accessToken, true); }
}
