// The token dialog (sign in = add a GitHub token) and the settings dialog (account, file view).
import { externalLink } from './render.js';
import { esc } from './render.js';

const TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new';
const tokenHelp = () => `<ol class="steps">
  <li>Open ${externalLink(TOKEN_URL, 'github.com/settings/personal-access-tokens/new')} (fine-grained token).</li>
  <li>Give it a name and an expiry. Under <b>Repository access</b> choose the repositories you review (or all).</li>
  <li>Under <b>Permissions → Repository permissions</b> set <b>Pull requests: Read and write</b> and <b>Contents: Read-only</b>.</li>
  <li>Click <b>Generate token</b>, copy it (<code>github_pat_…</code>) and paste it below.</li></ol>
<p class="muted">Or a classic token with <code>public_repo</code> (public repositories) or <code>repo</code> (private ones too). The token stays in this browser's localStorage and is sent only to api.github.com. <b>Sign out</b> removes it.</p>`;

/** Wire a token form inside d: #tok input, #tok-save button, #si-msg message. onToken(token) -> Promise (throws Error to show it). */
function wireToken(d, onToken) {
  const msg = t => { const m = d.querySelector('#si-msg'); if (m) m.textContent = t || ''; };
  const go = async () => {
    const tok = d.querySelector('#tok').value.trim();
    if (!tok) return msg('Paste a token first.');
    if (/\s/.test(tok)) return msg('A token has no spaces: paste just the token.');
    msg('Checking the token…');
    try { await onToken(tok); } catch (e) { msg(e.message || String(e)); }
  };
  d.querySelector('#tok-save').onclick = go;
  d.querySelector('#tok').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
}

/** ctx: { openDialog(html) -> dialog, finish(token) -> Promise } */
export function signInDialog(ctx) {
  const d = ctx.openDialog(`<h2>Add a GitHub token to comment</h2>
    <p>Reading public pull requests needs nothing. To <b>comment, review, open private repositories</b> and get 5,000 API requests an hour, add a personal access token:</p>
    ${tokenHelp()}
    <label>Token<br><input id="tok" type="password" autocomplete="off" spellcheck="false" placeholder="github_pat_… / ghp_…"></label>
    <div class="row2"><button id="si-cancel">Cancel</button><button id="tok-save" class="on">Save token</button></div><div id="si-msg" class="err"></div>`);
  d.querySelector('#si-cancel').onclick = () => d.close();
  wireToken(d, tok => ctx.finish(tok, 'paste'));
  return d;
}

/** Settings: the account (token) and the file view. */
export function settingsDialog({ view, setView, openDialog, session, finish, signOut }) {
  const d = openDialog(`<h2>Settings</h2>
    <p><label><input type="checkbox" id="st-stack" ${view === 'all' ? 'checked' : ''}> <b>All files stacked</b> <span class="muted">(default: one file at a time)</span></label></p>
    <p><b>Account</b><br>${session.token ? `Signed in${session.user ? ' as <b>' + esc(session.user.login) + '</b>' : ''} with a pasted token. <button id="st-out">Sign out</button>` : 'Not signed in: public repositories only, 60 requests per hour, no commenting.'}</p>
    <details ${session.token ? '' : 'open'}><summary>${session.token ? 'Replace the token' : 'Add a GitHub token'}</summary>
      ${tokenHelp()}
      <label>Token<br><input id="tok" type="password" autocomplete="off" spellcheck="false" placeholder="github_pat_… / ghp_…"></label>
      <div class="row2"><button id="tok-save" class="on">Save token</button></div></details>
    <div class="row2"><button id="st-close">Close</button></div><div id="si-msg" class="err"></div>`);
  d.querySelector('#st-close').onclick = () => d.close();
  d.querySelector('#st-stack').onchange = e => setView && setView(e.target.checked ? 'all' : 'one');
  const out = d.querySelector('#st-out'); if (out) out.onclick = () => { d.close(); signOut(); };
  wireToken(d, tok => finish(tok, 'paste'));
  return d;
}
