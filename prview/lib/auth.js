// The signed-in state: a personal access token the user pastes (fine-grained or classic), kept only in localStorage and
// sent only to api.github.com. No OAuth, no proxy.

const KEY = 'prview.';

export function getSession(storage = localStorage) {
  const token = storage.getItem(KEY + 'token') || '';
  let user = null;
  try { user = JSON.parse(storage.getItem(KEY + 'user') || 'null'); } catch { /* none */ }
  return { token, user: token ? user : null, kind: token ? 'paste' : '' };
}
export function setSession({ token, user }, storage = localStorage) {
  storage.setItem(KEY + 'token', token);
  if (user) storage.setItem(KEY + 'user', JSON.stringify({ login: user.login, name: user.name || '', avatar: user.avatar_url || user.avatar || '' })); else storage.removeItem(KEY + 'user');
}
/** Sign out; also drops keys older versions wrote (OAuth sign-in kind and settings). */
export function clearSession(storage = localStorage) { for (const k of ['token', 'user', 'auth', 'settings']) storage.removeItem(KEY + k); }
