// The sign-in and settings dialogs (OAuth device flow, first-run client id screen, token paste fallback).
import { DeviceFlow, AuthError, loadSettings, saveSettings, SCOPES, DEFAULT_PROXY } from './auth.js';
import { esc, externalLink } from './render.js';

const scopeRadios = cur => Object.entries(SCOPES).map(([k, v]) => `<label class="radio"><input type="radio" name="scope" value="${k}" ${cur === k ? 'checked' : ''}> <code>${k}</code> <span class="muted">${esc(v.help)}</span></label>`).join('');
const pickScope = d => (d.querySelector('input[name=scope]:checked') || {}).value || 'repo';

/** ctx: { openDialog(html) -> dialog, finish(token, kind) -> Promise, pasteToken(), fetchImpl?, sleep? } */
export function signInDialog(ctx) {
  const d = ctx.openDialog('');
  let cancelled = false;
  d.addEventListener('close', () => { cancelled = true; }, { once: true });
  const settings = loadSettings();
  const origin = location.origin + location.pathname.replace(/[^/]*$/, '');
  const msg = (t, bad) => { const m = d.querySelector('#si-msg'); if (m) { m.textContent = t || ''; m.className = bad ? 'err' : 'muted'; } };

  function setup(note) {
    d.innerHTML = `<h2>Sign in with GitHub</h2>
      <p>PR viewer signs in with GitHub's <b>device flow</b>: it shows a code, you enter it on github.com. That needs an <b>OAuth App client id</b>, a one-time setup of about a minute (the client id is public, not a secret):</p>
      <ol class="steps">
        <li>On GitHub open <b>Settings → Developer settings → OAuth Apps → New OAuth App</b> (${externalLink('https://github.com/settings/applications/new', 'github.com/settings/applications/new')}).</li>
        <li>Application name <code>PR viewer</code>. Homepage URL <code>${esc(origin)}</code>. Authorization callback URL: the same address (device flow never uses it).</li>
        <li>Tick <b>Enable Device Flow</b>, then <b>Register application</b>.</li>
        <li>Copy the <b>Client ID</b> and paste it here.</li></ol>
      ${note ? '<p class="err">' + esc(note) + '</p>' : ''}
      <label>Client ID<br><input id="si-cid" type="text" autocomplete="off" spellcheck="false" placeholder="Ov23li…" value="${esc(settings.clientId)}"></label>
      <p><b>Access</b><br>${scopeRadios(settings.scope)}</p>
      <details><summary>CORS proxy</summary><label>GitHub's device-flow endpoints send no CORS headers, so the page goes through your <code>workers/cors-proxy</code> Worker. It must allow <code>github.com/login/device/code</code>, <code>github.com/login/oauth/access_token</code> and this page's origin.<br><input id="si-proxy" type="text" autocomplete="off" placeholder="${esc(DEFAULT_PROXY)}" value="${esc(settings.proxy === DEFAULT_PROXY ? '' : settings.proxy)}"></label></details>
      <div class="row2"><button id="si-paste">Use a token instead</button><button id="si-cancel">Cancel</button><button id="si-go" class="on">Save and sign in</button></div><div id="si-msg" class="muted"></div>`;
    d.querySelector('#si-cancel').onclick = () => d.close();
    d.querySelector('#si-paste').onclick = () => { d.close(); ctx.pasteToken(); };
    d.querySelector('#si-go').onclick = () => {
      const cid = d.querySelector('#si-cid').value.trim();
      if (!/^[A-Za-z0-9._-]{8,}$/.test(cid)) return msg('Paste the Client ID from your OAuth App (letters and digits, e.g. Ov23li…).', true);
      Object.assign(settings, { clientId: cid, scope: pickScope(d), proxy: d.querySelector('#si-proxy').value.trim().replace(/\/+$/, '') || DEFAULT_PROXY });
      saveSettings(settings);
      begin();
    };
  }

  function ready() {
    d.innerHTML = `<h2>Sign in with GitHub</h2>
      <p>You will get a short code to enter on github.com. The token stays in this browser.</p>
      <p><b>Access</b><br>${scopeRadios(settings.scope)}</p>
      <p class="muted">OAuth App client id: <code>${esc(settings.clientId)}</code> <a href="#" id="si-change">change</a> · or <a href="#" id="si-paste">paste a token</a></p>
      <div class="row2"><button id="si-cancel">Cancel</button><button id="si-go" class="on">Sign in with GitHub</button></div><div id="si-msg" class="muted"></div>`;
    d.querySelector('#si-cancel').onclick = () => d.close();
    d.querySelector('#si-change').onclick = e => { e.preventDefault(); setup(); };
    d.querySelector('#si-paste').onclick = e => { e.preventDefault(); d.close(); ctx.pasteToken(); };
    d.querySelector('#si-go').onclick = () => { settings.scope = pickScope(d); saveSettings(settings); begin(); };
  }

  async function begin() {
    let flow, dev;
    d.innerHTML = '<h2>Sign in with GitHub</h2><p class="muted">Asking GitHub for a code…</p><div class="row2"><button id="si-cancel">Cancel</button></div>';
    d.querySelector('#si-cancel').onclick = () => d.close();
    try {
      flow = new DeviceFlow({ clientId: settings.clientId, proxy: settings.proxy, scope: settings.scope, fetchImpl: ctx.fetchImpl, sleep: ctx.sleep });
      dev = await flow.start();
    } catch (e) {
      if (cancelled) return;
      return e instanceof AuthError && ['device_flow_disabled', 'incorrect_client_credentials', 'Not Found'].includes(e.code) ? setup(e.message) : fail(e);
    }
    if (cancelled) return;
    d.innerHTML = `<h2>Enter this code on GitHub</h2>
      <div class="usercode" id="si-code" aria-label="Device code">${esc(dev.user_code)}</div>
      <p>Open ${externalLink(dev.verification_uri, dev.verification_uri.replace(/^https?:\/\//, ''))}, enter the code and approve <b>PR viewer</b>. This window signs you in when you are done.</p>
      <div class="row2"><button id="si-copy">Copy code</button><button id="si-cancel">Cancel</button></div><div id="si-msg" class="muted">Waiting for approval…</div>`;
    d.querySelector('#si-cancel').onclick = () => d.close();
    d.querySelector('#si-copy').onclick = () => { try { navigator.clipboard.writeText(dev.user_code); msg('Copied. Waiting for approval…'); } catch { /* clipboard blocked */ } };
    try {
      const token = await flow.poll(dev, { isCancelled: () => cancelled });
      msg('Signed in. Loading your profile…');
      await ctx.finish(token, 'oauth');
    } catch (e) { if (!cancelled && !(e instanceof AuthError && e.code === 'cancelled')) fail(e); }
  }
  function fail(e) {
    d.innerHTML = `<h2>Sign-in failed</h2><p class="err">${esc(e.message || String(e))}</p><div class="row2"><button id="si-cancel">Close</button><button id="si-retry" class="on">Try again</button></div>`;
    d.querySelector('#si-cancel').onclick = () => d.close();
    d.querySelector('#si-retry').onclick = () => ready();
  }

  if (!settings.clientId) setup(); else ready();
  return d;
}

/** Settings: the OAuth App, the proxy, the signed-in state and the token fallback. */
export function settingsDialog({ openDialog, session, finish, signOut, signIn }) {
  const s = loadSettings();
  const d = openDialog(`<h2>Settings</h2>
    <p><b>Account</b><br>${session.token ? `Signed in${session.user ? ' as <b>' + esc(session.user.login) + '</b>' : ''} (${session.kind === 'oauth' ? 'GitHub sign-in' : 'pasted token'}). <button id="st-out">Sign out</button>` : 'Not signed in. Public repositories work, with GitHub\'s 60 requests per hour. <button id="st-in" class="on">Sign in with GitHub</button>'}</p>
    <details ${session.token ? '' : 'open'}><summary>OAuth App for sign-in</summary>
      <label>Client ID<br><input id="st-cid" type="text" autocomplete="off" spellcheck="false" placeholder="not set yet" value="${esc(s.clientId)}"></label>
      <p>${scopeRadios(s.scope)}</p>
      <label>CORS proxy URL<br><input id="st-proxy" type="text" autocomplete="off" placeholder="${esc(DEFAULT_PROXY)}" value="${esc(s.proxy === DEFAULT_PROXY ? '' : s.proxy)}"></label></details>
    <details><summary>Paste a token instead</summary>
      <p class="muted">A personal access token (classic: <code>repo</code> or <code>public_repo</code>; fine-grained: <i>Pull requests</i> and <i>Contents</i>, read and write to comment). Stored only in this browser's localStorage and sent only to api.github.com. ${externalLink('https://github.com/settings/tokens/new?scopes=repo&description=PR+viewer', 'Create a token')}</p>
      <label>Token<br><input id="tok" type="password" autocomplete="off" placeholder="ghp_… / github_pat_…" value="${session.kind === 'paste' ? esc(session.token) : ''}"></label></details>
    <div class="row2"><button id="st-close">Cancel</button><button id="st-save" class="on">Save</button></div><div id="st-msg" class="err"></div>`);
  d.querySelector('#st-close').onclick = () => d.close();
  const out = d.querySelector('#st-out'); if (out) out.onclick = () => { d.close(); signOut(); };
  const inn = d.querySelector('#st-in'); if (inn) inn.onclick = () => { d.close(); signIn(); };
  d.querySelector('#st-save').onclick = async () => {
    const cid = d.querySelector('#st-cid').value.trim();
    saveSettings({ clientId: cid, scope: pickScope(d), proxy: d.querySelector('#st-proxy').value.trim() });
    const tok = d.querySelector('#tok').value.trim();
    if (tok && tok !== session.token) {
      d.querySelector('#st-msg').textContent = '';
      try { await finish(tok, 'paste'); } catch (e) { d.querySelector('#st-msg').textContent = e.message; return; }
    }
    d.close();
  };
}
