// Sign in with GitHub: OAuth device flow through the generic CORS proxy (workers/cors-proxy), plus the stored token and settings.
// github.com/login/device/code and github.com/login/oauth/access_token send no CORS headers, so the page calls
//   <proxy>/github.com/login/device/code   and   <proxy>/github.com/login/oauth/access_token
// The proxy only routes; the OAuth App client id is public (device flow has no client secret).

export const DEFAULT_PROXY = 'https://cors-proxy.ref12cf.workers.dev';
export const SCOPES = {
  repo: { label: 'repo', help: 'private and public repositories; needed to comment on private ones' },
  public_repo: { label: 'public_repo', help: 'public repositories only (lighter)' },
};
export const GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

const KEY = 'prview.';
/** Settings: { clientId, proxy, scope }. Missing values get defaults. */
export function loadSettings(storage = localStorage) {
  let s = {};
  try { s = JSON.parse(storage.getItem(KEY + 'settings') || '{}') || {}; } catch { /* corrupt: use defaults */ }
  return { clientId: String(s.clientId || '').trim(), proxy: String(s.proxy || '').trim().replace(/\/+$/, '') || DEFAULT_PROXY, scope: s.scope === 'public_repo' ? 'public_repo' : 'repo' };
}
export function saveSettings(s, storage = localStorage) { storage.setItem(KEY + 'settings', JSON.stringify({ clientId: s.clientId.trim(), proxy: (s.proxy || '').trim().replace(/\/+$/, ''), scope: s.scope })); }

export function getSession(storage = localStorage) {
  const token = storage.getItem(KEY + 'token') || '';
  let user = null;
  try { user = JSON.parse(storage.getItem(KEY + 'user') || 'null'); } catch { /* none */ }
  return { token, user: token ? user : null, kind: storage.getItem(KEY + 'auth') || (token ? 'paste' : '') };
}
export function setSession({ token, user, kind }, storage = localStorage) {
  storage.setItem(KEY + 'token', token); storage.setItem(KEY + 'auth', kind || 'paste');
  if (user) storage.setItem(KEY + 'user', JSON.stringify({ login: user.login, name: user.name || '', avatar: user.avatar_url || user.avatar || '' })); else storage.removeItem(KEY + 'user');
}
export function clearSession(storage = localStorage) { for (const k of ['token', 'user', 'auth']) storage.removeItem(KEY + k); }

export class AuthError extends Error { constructor(code, message) { super(message); this.code = code; } }

const MESSAGES = {
  device_flow_disabled: 'Device flow is not enabled for this OAuth App. In GitHub: Settings → Developer settings → OAuth Apps → your app → tick "Enable Device Flow".',
  incorrect_client_credentials: 'GitHub does not know this client id. Check it in Settings.',
  expired_token: 'The code expired. Start again.',
  access_denied: 'Sign-in was cancelled on github.com.',
  unsupported_grant_type: 'GitHub refused the request (unsupported grant type).',
};

export class DeviceFlow {
  /** fetchImpl and sleep are injectable for tests. */
  constructor({ clientId, proxy = DEFAULT_PROXY, scope = 'repo', fetchImpl = (...a) => fetch(...a), sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
    if (!clientId) throw new AuthError('no_client_id', 'Set the OAuth App client id first.');
    this.clientId = clientId; this.base = proxy.replace(/\/+$/, ''); this.scope = scope; this.fetch = fetchImpl; this.sleep = sleep;
  }
  async post(path, fields) {
    let res;
    try {
      res = await this.fetch(this.base + '/github.com' + path, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });
    } catch (e) { throw new AuthError('network', 'Could not reach the CORS proxy (' + this.base + '). Is it deployed, and does it allow this page\'s origin and github.com? ' + (e.message || '')); }
    let j = null;
    try { j = await res.json(); } catch { /* not json */ }
    if (res.status === 403 && !j) throw new AuthError('proxy', 'The CORS proxy refused the request (403): add github.com/login/device/code and github.com/login/oauth/access_token to its ALLOWED_HOSTS and this page\'s origin to ALLOWED_ORIGINS.');
    if (!j) throw new AuthError('http', 'Unexpected answer from GitHub (' + res.status + ').');
    return j;
  }
  /** -> { device_code, user_code, verification_uri, expires_in, interval } */
  async start() {
    const j = await this.post('/login/device/code', { client_id: this.clientId, scope: this.scope });
    if (j.error) throw new AuthError(j.error, MESSAGES[j.error] || j.error_description || j.error);
    if (!j.device_code || !j.user_code) throw new AuthError('http', 'GitHub did not return a device code.');
    return { ...j, verification_uri: j.verification_uri || 'https://github.com/login/device' };
  }
  /** Waits until the user approves; resolves with the access token string. isCancelled() stops it. */
  async poll(dev, { isCancelled = () => false, onWait = () => {} } = {}) {
    let interval = Math.max(1, Number(dev.interval) || 5);
    const deadline = Date.now() + (Number(dev.expires_in) || 900) * 1000;
    while (!isCancelled()) {
      await this.sleep(interval * 1000);
      if (isCancelled()) break;
      if (Date.now() > deadline) throw new AuthError('expired_token', MESSAGES.expired_token);
      const j = await this.post('/login/oauth/access_token', { client_id: this.clientId, device_code: dev.device_code, grant_type: GRANT });
      if (j.access_token) return j.access_token;
      if (j.error === 'authorization_pending') { onWait(); continue; }
      if (j.error === 'slow_down') { interval = Number(j.interval) || interval + 5; continue; }
      throw new AuthError(j.error || 'http', MESSAGES[j.error] || j.error_description || j.error || 'Sign-in failed.');
    }
    throw new AuthError('cancelled', 'Cancelled.');
  }
}
