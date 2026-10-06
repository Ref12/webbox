// PR viewer: GitHub pull requests in an Azure DevOps style layout. No build step; ES modules only.
import { GitHub, GhError, skipReason } from './lib/github.js';
import { diffFile, layoutRows, wordDiff } from './lib/diff.js';
import { buildTree, flattenTree, orderedFiles, STATUS } from './lib/tree.js';
import { parsePrRef, parseRoute, toRoute, githubUrl } from './lib/url.js';
import { esc, lineHtml, mdLite, ago, shortSha, externalLink } from './lib/render.js';
import { getSession, setSession, clearSession } from './lib/auth.js';
import { signInDialog, settingsDialog as settingsUi } from './lib/signin.js';
import { renderHome } from './lib/home.js';
import { buildThreads, pendingThread, indexThreads, parsePatch, lineInDiff, excerpt, lineRange } from './lib/threads.js';

const $ = s => document.querySelector(s);
const store = {
  get(k, d) { try { const v = localStorage.getItem('prview.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('prview.' + k, JSON.stringify(v)); } catch { /* storage full or blocked */ } },
};
let auth = getSession();          // { token, user, kind }: the signed-in state (localStorage)
const getToken = () => auth.token;

const HEAD_H = 60, ROW_H = 20, GAP_H = 28, NOTE_H = 56, TREE_ROW = 26, CM_H = 120;
const PHONE = () => matchMedia('(max-width: 800px)').matches;

let S = null;                 // the open pull request (null on the landing page)
let hl = null;                // lazily imported highlighter
let charW = 7.6;
const defaultView = () => store.get('view', 'one') === 'all' ? 'all' : 'one';
const ui = { mode: store.get('mode', 'inline'), full: false };

// ---------------------------------------------------------------- banner, rate, dialogs
function banner(html) { const b = $('#banner'); b.innerHTML = html || ''; b.hidden = !html; }
function showError(e) {
  if (e instanceof GhError && e.kind === 'rate') {
    const when = e.reset ? ' It resets at ' + new Date(e.reset).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + '.' : '';
    banner('<b>Rate limit reached.</b> ' + esc(e.message) + when + (e.authed ? ' With a token you get 5,000 per hour.' : ' A GitHub token raises the limit to 5,000 requests per hour. <button data-act="signin">Add a token</button>'));
  } else banner(esc(e.message || String(e)) + (e.kind === 'auth' ? ' <button data-act="signin">Sign in again</button>' : e.kind === 'notfound' ? (auth.token ? ' <button data-act="settings">Settings</button>' : ' <button data-act="signin">Sign in</button> to open private repositories.') : e.kind === 'forbidden' ? ' <button data-act="signin">Sign in again</button>' : ''));
}
function showRate(r) {
  const el = $('#rate');
  el.textContent = 'API ' + r.remaining + '/' + r.limit;
  el.title = (r.authed ? 'Signed in: 5,000 requests per hour. ' : 'Anonymous: 60 requests per hour per IP. Sign in for 5,000. ') + 'Resets ' + new Date(r.reset).toLocaleTimeString();
  el.style.color = r.remaining < 8 ? 'var(--bad)' : '';
}
function openDialog(html) { const d = $('#dlg'); d.innerHTML = html; if (!d.open) d.showModal(); return d; }
// ---------------------------------------------------------------- sign in (pasted token), settings, who
async function finishSignIn(token) {
  // verify the token and learn who it belongs to before keeping it
  const gh = new GitHub({ token });
  let user;
  try { user = await gh.user(); } catch (e) { if (e.kind === 'auth') throw new Error('GitHub rejected that token.'); user = null; /* rate limit or network: keep the token, no avatar */ }
  setSession({ token, user });
  auth = getSession();
  $('#dlg').open && $('#dlg').close();
  location.reload();
}
function signIn() { closePopovers(); signInDialog({ openDialog, finish: finishSignIn }); }
function signOut() { clearSession(); auth = getSession(); location.reload(); }
function settingsDialog() { settingsUi({ view: defaultView(), setView, openDialog, session: auth, finish: finishSignIn, signOut }); }
function renderWho() {
  const el = $('#who');
  if (!auth.token) { el.innerHTML = '<button id="signin-btn" class="on" title="Add a GitHub token to comment">Sign in</button>'; $('#signin-btn').onclick = signIn; return; }
  const u = auth.user;
  el.innerHTML = `<button id="who-btn" class="who" title="Signed in${u ? ' as ' + esc(u.login) : ''}" aria-haspopup="menu">${u && u.avatar ? `<img class="av" src="${esc(u.avatar)}" alt="" width="22" height="22" referrerpolicy="no-referrer">` : ''}<b id="who-login">${esc(u ? u.login : 'token')}</b> ▾</button>`;
  $('#who-btn').onclick = () => {
    if ($('#whomenu')) return closePopovers();
    closePopovers();
    const r = $('#who-btn').getBoundingClientRect(), pop = document.createElement('div');
    pop.className = 'pop'; pop.id = 'whomenu'; pop.style.right = '8px'; pop.style.top = r.bottom + 4 + 'px'; pop.style.minWidth = '200px';
    pop.innerHTML = `<div class="hint">Signed in${u ? ' as <b>' + esc(u.login) + '</b>' : ''}<br>pasted token</div><div class="opt" data-w="settings">Settings</div><div class="opt" data-w="out" id="signout">Sign out</div>`;
    pop.onclick = e => { const w = e.target.closest('[data-w]'); if (!w) return; closePopovers(); w.dataset.w === 'out' ? signOut() : settingsDialog(); };
    document.body.appendChild(pop);
    setTimeout(() => document.addEventListener('click', outsideClose, true), 0);
  };
}
function helpDialog() {
  const d = openDialog(`<h2>Keyboard</h2><table>
    <tr><td><kbd>j</kbd> / <kbd>k</kbd></td><td>next / previous file</td></tr>
    <tr><td><kbd>n</kbd> / <kbd>p</kbd></td><td>next / previous change</td></tr>
    <tr><td><kbd>r</kbd></td><td>mark the current file reviewed</td></tr>
    <tr><td><kbd>c</kbd></td><td>comment on the line under the pointer (or the first changed line in view)</td></tr>
    <tr><td><kbd>x</kbd></td><td>collapse / expand the current file</td></tr>
    <tr><td><kbd>m</kbd></td><td>comments panel</td></tr>
    <tr><td><kbd>s</kbd></td><td>inline / side-by-side</td></tr>
    <tr><td><kbd>f</kbd></td><td>changes only / full file for everything</td></tr>
    <tr><td><kbd>a</kbd></td><td>all files stacked / one file at a time</td></tr>
    <tr><td><kbd>/</kbd></td><td>filter files</td></tr>
    <tr><td><kbd>t</kbd></td><td>show / hide the file tree (phone)</td></tr>
    <tr><td><kbd>?</kbd></td><td>this help</td></tr></table>
    <div class="row2"><button id="h-close" class="on">Close</button></div>`);
  d.querySelector('#h-close').onclick = () => d.close();
}

// ---------------------------------------------------------------- routing
window.addEventListener('hashchange', () => { if (S && S.hashSet === location.hash) return; route(); });
function syncHash() {
  if (!S) return;
  const p = { f: S.view === 'one' ? S.selected : S.selected && S.selected !== S.order[0]?.filename ? S.selected : '', c: S.cparam || '', m: ui.mode === 'split' ? 'split' : '', v: S.view !== defaultView() ? S.view : '', x: ui.full ? '1' : '' };
  const h = toRoute(S.ref, p, S.tab);
  if (h !== location.hash) { S.hashSet = h; history.replaceState(null, '', h); }
}

async function route() {
  const { ref, tab, params } = parseRoute(location.hash);
  closePopovers();
  if (!ref) { S = null; return landing(params); }
  if (S && S.key === ref.owner + '/' + ref.repo + '#' + ref.number) {
    S.tab = tab; S.hashSet = null;
    if (params.m) ui.mode = params.m === 'split' ? 'split' : 'inline';
    renderPage();
    if (S.rangeReady && (params.c || '') !== S.cparam) await applyRange(params.c || '');
    if (S.rangeReady && params.f && S.tab === 'files' && S.fl.some(f => f.filename === params.f)) selectFile(params.f);
    return;
  }
  await openPr(ref, tab, params);
}

function landing(params = {}) {
  document.title = 'PR viewer';
  banner('');
  $('#main').innerHTML = `<div class="landing"><h1>Pull request viewer</h1>
    <p>Review a GitHub pull request the way Azure DevOps shows it: a file tree with change badges, full-file diffs with expandable context, inline or side-by-side, reviewed checkboxes and a commit picker.</p>
    <form id="land-form"><input id="land-in" type="text" placeholder="https://github.com/owner/repo/pull/123" spellcheck="false" autofocus aria-label="GitHub pull request URL"><button class="on">Open</button></form>
    <div id="land-err" class="muted"></div>
    <p>Try <a href="#/dotnet/runtime/pull/135064">dotnet/runtime#135064</a>. Public repositories need no sign-in; <b>Sign in</b> with a GitHub token for private ones, to comment, and for 5,000 requests per hour instead of 60.</p>
    <div id="home-root"></div>
    <p class="muted">Keys: <kbd>j</kbd>/<kbd>k</kbd> files, <kbd>n</kbd>/<kbd>p</kbd> changes, <kbd>r</kbd> reviewed, <kbd>s</kbd> side-by-side, <kbd>?</kbd> all.</p></div>`;
  $('#land-form').onsubmit = e => { e.preventDefault(); goto($('#land-in').value, '#land-err'); };
  renderHome($('#home-root'), { gh: new GitHub({ token: getToken(), onRate: showRate }), signedIn: !!auth.token, store, href: ref => toRoute(ref), signIn, params, recent: store.get('recent', []), onError: showError });
}
function goto(text, errSel) {
  const ref = parsePrRef(text);
  if (!ref) { const e = $(errSel); if (e) e.textContent = 'That does not look like a GitHub pull request URL (https://github.com/owner/repo/pull/123).'; return; }
  location.hash = toRoute(ref);
}
$('#goto').onsubmit = e => { e.preventDefault(); const v = $('#goto-in').value; goto(v, '#land-err'); $('#goto-in').value = ''; $('#goto-in').blur(); };
$('#settings-btn').onclick = settingsDialog;
$('#menu').onclick = () => document.body.classList.toggle('drawer');
document.addEventListener('click', e => { const b = e.target.closest('#banner [data-act]'); if (!b) return; if (b.dataset.act === 'settings') settingsDialog(); else if (b.dataset.act === 'signin') signIn(); });

// ---------------------------------------------------------------- loading a pull request
async function openPr(ref, tab, params) {
  banner('');
  $('#main').innerHTML = '<div class="empty">Loading ' + esc(ref.owner + '/' + ref.repo + '#' + ref.number) + '…</div>';
  const gh = new GitHub({ token: getToken(), onRate: showRate });
  const s = S = {
    ref, key: ref.owner + '/' + ref.repo + '#' + ref.number, gh, tab, view: params.v === 'all' || params.v === 'one' ? params.v : defaultView(), filter: '', collapsedDirs: new Set(),
    items: [], tops: new Float64Array(0), cmH: new Map(), gen: 0, loadQueue: [], active: 0, winFiles: new Set(), selected: params.f || null, current: null, treeRows: [], comments: null, threads: [], gql: null, pending: [], composer: null, drafts: new Map(), tOpen: new Map(), terr: new Map(), outOpen: new Set(), panel: false, pfilter: 'all', vw: 0, threadItem: new Map(),
  };
  if (params.m) ui.mode = params.m === 'split' ? 'split' : 'inline';
  ui.full = params.x === '1';
  try {
    const [pr, files, commits] = await Promise.all([gh.pr(ref), gh.prFiles(ref), gh.prCommits(ref)]);
    if (S !== s) return;
    s.pr = pr; s.prFiles = files; s.commits = commits;
    s.mergeBase = pr.base.sha;
    s.headSha = pr.head.sha;
    document.title = pr.title + ' · ' + s.key;
    const recent = store.get('recent', []).filter(r => r.ref.owner !== ref.owner || r.ref.repo !== ref.repo || r.ref.number !== ref.number);
    recent.unshift({ ref, title: pr.title, at: new Date().toISOString() }); store.set('recent', recent.slice(0, 30));
    s.pending = store.get('pend:' + s.key + '@' + s.headSha, []);
    s.reviewed = new Set(store.get('rev:' + s.key + '@' + s.headSha, []));
    gh.mergeBase(ref, pr.base.sha, pr.head.sha).then(sha => { if (sha) s.mergeBase = sha; }).catch(() => {}).then(() => { if (S === s) { s.mbReady = true; if (s.gen === 0) applyRange(params.c || '', true); } });
    loadComments(s);
    renderPage();
    $('#diff') && ($('#diff').dataset.state = 'loading');
  } catch (e) { if (S === s) { $('#main').innerHTML = '<div class="empty">Could not open this pull request.</div>'; showError(e); } }
}

function commitIndex(prefix) { return S.commits.findIndex(c => c.sha.startsWith(prefix)); }
function parseRange(c) {
  if (!c) return null;
  const [a, b] = c.split('..');
  const i = commitIndex(a), j = b ? commitIndex(b) : i;
  if (i < 0 || j < 0) return null;
  return { i: Math.min(i, j), j: Math.max(i, j) };
}
function rangeLabel() {
  const r = S.range, n = S.commits.length;
  if (!r) return 'All changes';
  return r.i === r.j ? 'Commit ' + (r.i + 1) + ' of ' + n : 'Commits ' + (r.i + 1) + '–' + (r.j + 1) + ' of ' + n;
}

/** Choose which commits are shown: '' = everything in the PR. */
async function applyRange(cparam, first) {
  const s = S, gen = ++s.gen;
  s.range = parseRange(cparam);
  s.cparam = s.range ? (s.range.i === s.range.j ? shortSha(s.commits[s.range.i].sha) : shortSha(s.commits[s.range.i].sha) + '..' + shortSha(s.commits[s.range.j].sha)) : '';
  let files;
  try {
    if (!s.range) { s.fromSha = s.mergeBase; s.toSha = s.headSha; files = s.prFiles; }
    else {
      const first = s.commits[s.range.i], last = s.commits[s.range.j];
      s.fromSha = first.parents[0] ? first.parents[0].sha : s.mergeBase; s.toSha = last.sha;
      s.busy = true; updateToolbar();
      files = (await s.gh.compare(s.ref, s.fromSha, s.toSha)).files;
    }
  } catch (e) { s.busy = false; showError(e); updateToolbar(); return; }
  if (S !== s || s.gen !== gen) return;
  s.busy = false;
  s.fl = files.map(f => ({ ...f, st: { status: 'idle', collapsed: false, expand: {}, full: false, wd: new Map() } }));
  s.tree = buildTree(s.fl);
  s.order = orderedFiles(s.tree);
  s.collapsedDirs = new Set();
  s.rangeReady = true;
  if (!s.selected || !s.order.some(f => f.filename === s.selected)) s.selected = s.order[0] ? s.order[0].filename : null;
  s.current = s.order.find(f => f.filename === s.selected) || null;
  buildCommentIndex();
  refreshTree();
  updateToolbar();
  relayout(false);
  if (first && s.selected && s.view === 'all') scrollToFile(s.selected, true);
  syncHash();
  if (s.tab === 'files') renderDiffSoon();
}

// ---------------------------------------------------------------- review threads: load, index, post
async function loadComments(s, fresh) {
  if (fresh) s.gh.cache.delete('comments');
  try {
    const [c, g] = await Promise.all([s.gh.prComments(s.ref), s.gh.token ? s.gh.reviewThreads(s.ref).catch(() => null) : null]);
    if (S !== s) return;
    s.comments = c; s.gql = g;
  } catch (e) { s.comments = s.comments || []; if (S === s) showError(e); }
  if (S === s) rebuildThreads();
}
/** Thread state (resolved, thread id) comes from GraphQL; refresh it after something changed. */
async function refreshGql() {
  const s = S; if (!s || !s.gh.token) return;
  try { const g = await s.gh.reviewThreads(s.ref); if (S === s) { s.gql = g; rebuildThreads(); } } catch { /* resolve stays unavailable */ }
}
function rebuildThreads() {
  const s = S; if (!s) return;
  s.threads = buildThreads(s.comments || [], s.gql);
  buildCommentIndex();
  if (s.rangeReady) { relayout(true); updateToolbar(); }
  renderPanel();
}
const me = () => (auth.user ? { login: auth.user.login, avatar_url: auth.user.avatar } : null);
function allThreads() { return [...(S.threads || []), ...(S.pending || []).map(p => pendingThread({ ...p, user: me() }))]; }
function buildCommentIndex() {
  const s = S;
  s.cAll = allThreads();
  s.cIndex = indexThreads(s.cAll);
  s.commentsShown = !!s.fl && s.fromSha === s.mergeBase && s.toSha === s.headSha; // positions refer to the PR head
}
function savePending() { store.set('pend:' + S.key + '@' + S.headSha, S.pending); }
function findThread(id) { return (S.cAll || []).find(t => String(t.id) === String(id)); }
function canComment(f, side, line) { return !!auth.token && commentable(f, side, line); }
function commentable(f, side, line) {
  if (!S.commentsShown || !f || f.st.status !== 'ready') return false;
  if (f.hunks === undefined) f.hunks = parsePatch(f.patch);
  return lineInDiff(f.hunks, side === 'L' ? 'LEFT' : 'RIGHT', line);
}
/** The + in the gutter. Signed out it is a dimmed hint that opens the sign-in dialog. */
function addBtn(f, sd, ln) {
  if (!commentable(f, sd, ln)) return '';
  return auth.token ? '<button class="addc" data-act="addc" title="Comment on this line (c). Shift-click or drag for several lines." aria-label="Add comment">+</button>' : '<button class="addc hint" data-act="addc" title="Add a GitHub token to comment" aria-label="Add a GitHub token to comment">+</button>';
}
/** The comment targets of a row: [{side:'R'|'L', line}] where the add-comment affordance goes. */
function rowTarget(row) {
  if (row.k === 'gap') return [];
  if (ui.mode === 'split') {
    if (row.k === 'eq') return [{ side: 'R', line: row.b + 1 }];
    const out = [];
    if (row.a != null) out.push({ side: 'L', line: row.a + 1 });
    if (row.b != null) out.push({ side: 'R', line: row.b + 1 });
    return out;
  }
  return row.k === 'del' ? [{ side: 'L', line: row.a + 1 }] : [{ side: 'R', line: row.b + 1 }];
}
const inSel = (f, side, line) => {
  const c = S.drag && S.drag.cur != null ? { path: S.drag.f.filename, side: S.drag.side, from: Math.min(S.drag.anchor, S.drag.cur), to: Math.max(S.drag.anchor, S.drag.cur) }
    : S.composer ? { path: S.composer.path, side: S.composer.side, from: S.composer.startLine || S.composer.line, to: S.composer.line } : null;
  return !!c && c.path === f.filename && c.side === side && line >= c.from && line <= c.to;
};

// ---- rendering of thread boxes, composer
const avatarHtml = u => u && u.avatar_url ? '<img class="av" src="' + esc(u.avatar_url) + '" alt="" width="24" height="24" loading="lazy" referrerpolicy="no-referrer">' : '<span class="av"></span>';
const threadOpen = t => S.tOpen.has(String(t.id)) ? S.tOpen.get(String(t.id)) : !t.resolved;
function commentHtml(c, t, i) {
  const mine = t.pending;
  return '<div class="c">' + avatarHtml(c.user) + '<div class="cb"><div class="who"><b>' + esc(c.user ? c.user.login : 'ghost') + '</b> · ' + esc(ago(c.created_at)) + ' ' + (c.html_url ? externalLink(c.html_url, '↗') : '') + (mine ? ' <span class="status s-pending">Pending</span>' : '') + '</div>' +
    (S.editing === String(t.id) && mine ? '<textarea data-fid="e:' + esc(t.id) + '" rows="3">' + esc(S.editBody) + '</textarea><div class="rbtns"><button data-act="esave" class="on">Save</button><button data-act="ecancel">Cancel</button></div>' : '<div class="md">' + mdLite(c.body) + '</div>') + '</div></div>';
}
function threadBox(t) {
  const id = String(t.id), open = threadOpen(t), all = [t.root, ...t.replies];
  const status = t.pending ? 'Pending' : t.resolved ? 'Resolved' : t.outdated ? 'Outdated' : 'Active';
  const where = t.startLine && t.line ? 'lines ' + t.startLine + '–' + t.line : t.line ? 'line ' + t.line : t.originalLine ? 'was line ' + t.originalLine : '';
  const head = '<div class="th"><span class="tcol" data-act="tcol" role="button" tabindex="0" aria-label="' + (open ? 'Collapse' : 'Expand') + ' thread" title="Collapse / expand">' + (open ? '▾' : '▸') + '</span><span class="status s-' + status.toLowerCase() + '">' + status + '</span>' +
    '<span class="muted">' + all.length + ' comment' + (all.length === 1 ? '' : 's') + (where ? ' · ' + where : '') + '</span><span class="sp"></span>' +
    (t.pending ? '<button data-act="tedit">Edit</button><button data-act="tdel">Delete</button>' : t.gid && t.canResolve ? '<button data-act="resolve" title="' + (t.resolved ? 'Reopen this thread' : 'Mark as resolved') + '">' + (t.resolved ? 'Unresolve' : 'Resolve') + '</button>' : '') + '</div>';
  const cls = 'thread' + (t.resolved ? ' resolved' : '') + (t.pending ? ' pending' : '') + (t.outdated ? ' old' : '') + (S.flash === id ? ' flash' : '');
  if (!open) return '<div class="' + cls + ' collapsed" data-tid="' + esc(id) + '">' + head + '<div class="tsum">' + esc(t.root.user ? t.root.user.login : 'ghost') + ': ' + esc(excerpt(t.root.body)) + '</div></div>';
  const err = S.terr.get(id);
  const reply = !t.pending && auth.token ? '<div class="reply"><textarea data-fid="r:' + esc(id) + '" rows="2" placeholder="Reply…">' + esc(S.drafts.get(id) || '') + '</textarea><div class="rbtns">' + (err ? '<span class="err">' + esc(err) + '</span>' : '') + '<button data-act="reply" class="on">Reply</button></div></div>'   : !t.pending && !auth.token ? '<div class="reply"><button data-act="signin" class="hint-reply" title="Add a GitHub token to comment">Add a GitHub token to reply</button></div>' : err ? '<div class="err pad">' + esc(err) + '</div>' : '';
  return '<div class="' + cls + '" data-tid="' + esc(id) + '">' + head + all.map((c, i) => commentHtml(c, t, i)).join('') + reply + '</div>';
}
function composerHtml(c) {
  const lbl = c.startLine ? 'lines ' + c.startLine + '–' + c.line : 'line ' + c.line;
  const prev = c.tab === 'preview';
  return '<div class="thread composer" data-cc="1"><div class="th"><b>New comment</b><span class="muted">' + esc(c.path.split('/').pop()) + ' · ' + (c.side === 'L' ? 'old ' : '') + lbl + '</span><span class="sp"></span>' +
    '<span class="seg"><button data-act="ctab" data-tab="write" class="' + (prev ? '' : 'on') + '">Write</button><button data-act="ctab" data-tab="preview" class="' + (prev ? 'on' : '') + '">Preview</button></span></div>' +
    (prev ? '<div class="md preview">' + (c.body.trim() ? mdLite(c.body) : '<span class="muted">Nothing to preview</span>') + '</div>'
      : '<textarea data-fid="c" rows="5" placeholder="Write a comment. Markdown is supported; Ctrl+Enter posts, Esc cancels.">' + esc(c.body) + '</textarea>') +
    '<div class="rbtns">' + (c.side === 'R' ? '<button data-act="csugg" title="Quote the selected lines as a suggested change">± Suggest</button>' : '') + '<span class="sp"></span>' + (c.err ? '<span class="err">' + esc(c.err) + '</span>' : '') +
    '<button data-act="ccancel">Cancel</button><button data-act="cpend" title="Keep it as part of a review you finish later"' + (c.busy ? ' disabled' : '') + '>Add to review</button><button data-act="cpost" class="on"' + (c.busy ? ' disabled' : '') + '>' + (c.busy ? 'Posting…' : 'Comment') + '</button></div></div>';
}
function outdatedHtml(it) {
  const open = S.outOpen.has(it.f.filename);
  return '<div class="olist"><button data-act="outl" aria-expanded="' + open + '">' + (open ? '▾' : '▸') + ' Outdated comments (' + it.threads.length + ')</button><span class="muted"> on lines that are no longer in this diff</span></div>' + (open ? it.threads.map(threadBox).join('') : '');
}

// ---- actions
function relayoutKeepFocus() { relayout(true); }
function openComposer(f, side, line, startLine) {
  if (!auth.token) return signIn();
  if (!S.commentsShown) return banner('Comments can be added in <b>All changes</b>, not while a single commit or a range is selected.');
  const keep = S.composer ? S.composer.body : '';
  S.composer = { path: f.filename, side, line, startLine: startLine && startLine !== line ? startLine : null, body: keep, tab: 'write', busy: false, err: '' };
  S.focusId = 'c'; S.caret = keep.length;
  relayout(true);
  requestAnimationFrame(() => { const k = S.itemIndex.get(S.composerKey); const el = $('#diff'); if (k !== undefined && el && (S.tops[k] < el.scrollTop || S.tops[k] > el.scrollTop + el.clientHeight - 160)) el.scrollTop = S.tops[k] - el.clientHeight / 2; });
}
async function postComposer(asPending) {
  const s = S, c = s.composer; if (!c || c.busy) return;
  if (!c.body.trim()) { c.err = 'Write something first.'; return relayout(true); }
  const f = s.fl.find(x => x.filename === c.path);
  if (asPending) {
    s.pending.push({ id: 'p' + Date.now().toString(36) + s.pending.length, path: c.path, line: c.line, side: c.side === 'L' ? 'LEFT' : 'RIGHT', startLine: c.startLine, startSide: c.side === 'L' ? 'LEFT' : 'RIGHT', body: c.body, at: new Date().toISOString() });
    savePending(); s.composer = null; S.focusId = null; return rebuildThreads();
  }
  c.busy = true; c.err = ''; relayout(true);
  try {
    const made = await s.gh.postComment(s.ref, { body: c.body, commitId: s.headSha, path: c.path, line: c.line, side: c.side === 'L' ? 'LEFT' : 'RIGHT', startLine: c.startLine, startSide: c.side === 'L' ? 'LEFT' : 'RIGHT' });
    if (S !== s) return;
    s.comments = [...(s.comments || []), made]; s.gh.cache.delete('comments');
    s.composer = null; s.focusId = null; s.flash = String(made.id);
    rebuildThreads(); refreshGql();
    setTimeout(() => { if (S === s) { s.flash = null; document.querySelectorAll('.thread.flash').forEach(e => e.classList.remove('flash')); } }, 1800);
  } catch (e) { if (S === s && s.composer === c) { c.busy = false; c.err = e.message; relayout(true); } else showError(e); }
}
async function postReply(t) {
  const s = S, id = String(t.id), body = (s.drafts.get(id) || '').trim();
  if (!body) { s.terr.set(id, 'Write something first.'); return relayout(true); }
  s.terr.delete(id);
  try {
    const made = await s.gh.replyTo(s.ref, t.root.id, body);
    if (S !== s) return;
    s.comments = [...s.comments, made]; s.gh.cache.delete('comments'); s.drafts.delete(id); s.focusId = null;
    rebuildThreads();
  } catch (e) { if (S === s) { s.terr.set(id, e.message); relayout(true); } }
}
async function toggleResolve(t) {
  const s = S, id = String(t.id), to = !t.resolved;
  s.terr.delete(id);
  try {
    await s.gh.setThreadResolved(t.gid, to);
    if (S !== s) return;
    const g = s.gql && s.gql.get(t.root.id); if (g) g.resolved = to;
    s.tOpen.set(id, !to);
    rebuildThreads();
  } catch (e) { if (S === s) { s.terr.set(id, e.message); relayout(true); } }
}
function commentAction(act, el, f, e) {
  const tb = el.closest('[data-tid]'), t = tb ? findThread(tb.dataset.tid) : null;
  switch (act) {
    case 'addc': {
      if (S.suppressClick) { S.suppressClick = false; return true; }
      const cl = el.closest('[data-cl]').dataset.cl, side = cl[0], line = Number(cl.slice(2));
      const c = S.composer;
      if (e.shiftKey && c && c.path === f.filename && c.side === side) { const r = lineRange(c.startLine || c.line, line); openComposer(f, side, r.line, r.startLine); }
      else if (e.shiftKey && S.lastCl && S.lastCl.path === f.filename && S.lastCl.side === side) { const r = lineRange(S.lastCl.line, line); openComposer(f, side, r.line, r.startLine); }
      else openComposer(f, side, line);
      S.lastCl = { path: f.filename, side, line };
      return true;
    }
    case 'signin': signIn(); return true;
    case 'tcol': if (t) { S.tOpen.set(String(t.id), !threadOpen(t)); relayout(true); } return true;
    case 'outl': S.outOpen.has(f.filename) ? S.outOpen.delete(f.filename) : S.outOpen.add(f.filename); relayout(true); return true;
    case 'resolve': if (t) toggleResolve(t); return true;
    case 'reply': if (t) postReply(t); return true;
    case 'ctab': S.composer.tab = el.dataset.tab; if (el.dataset.tab === 'write') S.focusId = 'c'; relayout(true); return true;
    case 'ccancel': S.composer = null; S.focusId = null; relayout(true); return true;
    case 'cpost': postComposer(false); return true;
    case 'cpend': postComposer(true); return true;
    case 'csugg': {
      const c = S.composer, from = (c.startLine || c.line) - 1, to = c.line;
      const text = f.st.diff ? f.st.diff.b.slice(from, to).join('\n') : '';
      c.body += (c.body && !c.body.endsWith('\n') ? '\n' : '') + '```suggestion\n' + text + '\n```\n';
      c.tab = 'write'; S.focusId = 'c'; S.caret = c.body.length; relayout(true); return true;
    }
    case 'tdel': if (t) { S.pending = S.pending.filter(p => p.id !== t.id); savePending(); rebuildThreads(); } return true;
    case 'tedit': if (t) { S.editing = String(t.id); S.editBody = t.root.body; S.focusId = 'e:' + t.id; relayout(true); } return true;
    case 'ecancel': S.editing = null; relayout(true); return true;
    case 'esave': { const p = S.pending.find(x => x.id === S.editing); if (p) { p.body = S.editBody; savePending(); } S.editing = null; rebuildThreads(); return true; }
  }
  return false;
}
// typing: keep the text in state (the virtual list re-creates boxes as you scroll)
function onDiffInput(e) {
  const fid = e.target.dataset && e.target.dataset.fid; if (!fid || !S) return;
  if (fid === 'c' && S.composer) { S.composer.body = e.target.value; S.composer.err = ''; }
  else if (fid.startsWith('r:')) S.drafts.set(fid.slice(2), e.target.value);
  else if (fid.startsWith('e:')) S.editBody = e.target.value;
  S.caret = e.target.selectionStart;
}
function onDiffKey(e) {
  const fid = e.target.dataset && e.target.dataset.fid; if (!fid) return;
  if (e.key === 'Escape') { e.preventDefault(); if (fid === 'c') { S.composer = null; S.focusId = null; relayout(true); } else e.target.blur(); }
  else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    if (fid === 'c') postComposer(false);
    else if (fid.startsWith('r:')) { const t = findThread(fid.slice(2)); if (t) postReply(t); }
  }
}
function restoreFocus() {
  if (!S.focusId) return;
  const el = document.querySelector('#win [data-fid="' + CSS.escape(S.focusId) + '"]');
  if (el && document.activeElement !== el) { el.focus({ preventScroll: true }); try { el.setSelectionRange(S.caret ?? el.value.length, S.caret ?? el.value.length); } catch { /* not a text control */ } }
}
// hover, drag across lines
function onDiffOver(e) {
  const c = e.target.closest && e.target.closest('[data-cl]'); if (!c) return;
  const it = c.closest('.it'); if (!it) return;
  S.hoverCl = { i: Number(it.dataset.i), cl: c.dataset.cl, path: S.items[Number(it.dataset.i)].f.filename };
  if (S.drag && c.dataset.cl[0] === S.drag.side && S.items[Number(it.dataset.i)].f === S.drag.f) {
    const n = Number(c.dataset.cl.slice(2));
    if (n !== S.drag.cur) { S.drag.cur = n; paintSel(); }
  }
}
function paintSel() {
  document.querySelectorAll('#win [data-cl]').forEach(el => { const it = el.closest('.it'); const f = S.items[Number(it.dataset.i)].f; el.classList.toggle('sel', inSel(f, el.dataset.cl[0], Number(el.dataset.cl.slice(2)))); });
}
function onDiffDown(e) {
  const b = e.target.closest && e.target.closest('.addc'); if (!b || e.button !== 0 || e.shiftKey) return;
  const c = b.closest('[data-cl]'), it = b.closest('.it'); if (!c || !it) return;
  S.drag = { f: S.items[Number(it.dataset.i)].f, side: c.dataset.cl[0], anchor: Number(c.dataset.cl.slice(2)), cur: null };
}
document.addEventListener('mouseup', () => {
  const d = S && S.drag; if (!d) return;
  S.drag = null;
  if (d.cur != null && d.cur !== d.anchor) { const r = lineRange(d.anchor, d.cur); S.suppressClick = true; setTimeout(() => { if (S) S.suppressClick = false; }, 50); openComposer(d.f, d.side, r.line, r.startLine); }
  else paintSel();
});

/** 'c': comment on the line under the pointer, else the first commentable line in view. */
function commentAtCursor() {
  if (!auth.token) return signIn();
  const el = $('#diff');
  const h = S.hoverCl;
  if (h && S.items[h.i] && S.items[h.i].f.filename === h.path) {
    const row = el.querySelector('.it[data-i="' + h.i + '"] [data-cl="' + h.cl + '"]');
    if (row) { const r = row.getBoundingClientRect(), d = el.getBoundingClientRect(); if (r.top >= d.top && r.bottom <= d.bottom) { return openComposer(S.items[h.i].f, h.cl[0], Number(h.cl.slice(2))); } }
  }
  for (let i = firstVisible(el.scrollTop + HEAD_H); i < S.items.length && S.tops[i] < el.scrollTop + el.clientHeight; i++) {
    const it = S.items[i]; if (it.type !== 'row') continue;
    for (const tg of rowTarget(it.row)) if (canComment(it.f, tg.side, tg.line)) return openComposer(it.f, tg.side, tg.line);
  }
  banner('No line to comment on in view. Scroll to a changed line (or hover one) and press <kbd>c</kbd>.');
}

// ---- finishing a review
function reviewDialog() {
  if (!auth.token) return signIn();
  const n = S.pending.length;
  const d = openDialog('<h2>Finish review</h2><p class="muted">' + n + ' pending comment' + (n === 1 ? '' : 's') + ' will be posted with it.</p>' +
    '<label>Summary (Markdown)<br><textarea id="rv-body" rows="5" placeholder="Leave a summary"></textarea></label>' +
    '<p><label class="radio"><input type="radio" name="rv" value="COMMENT" checked> <b>Comment</b> <span class="muted">general feedback without approval</span></label>' +
    '<label class="radio"><input type="radio" name="rv" value="APPROVE"> <b>Approve</b> <span class="muted">approve these changes</span></label>' +
    '<label class="radio"><input type="radio" name="rv" value="REQUEST_CHANGES"> <b>Request changes</b> <span class="muted">a summary is required</span></label></p>' +
    '<div class="row2">' + (n ? '<button id="rv-discard">Discard pending</button>' : '') + '<button id="rv-cancel">Cancel</button><button id="rv-go" class="on">Submit review</button></div><div id="rv-msg" class="err"></div>');
  d.querySelector('#rv-cancel').onclick = () => d.close();
  const dis = d.querySelector('#rv-discard');
  if (dis) dis.onclick = () => { S.pending = []; savePending(); d.close(); rebuildThreads(); };
  d.querySelector('#rv-go').onclick = async () => {
    const s = S, event = d.querySelector('input[name=rv]:checked').value, body = d.querySelector('#rv-body').value.trim(), msg = d.querySelector('#rv-msg');
    if (event === 'REQUEST_CHANGES' && !body && !n) return (msg.textContent = 'Add a summary to request changes.');
    if (event === 'COMMENT' && !body && !n) return (msg.textContent = 'Add a summary or a pending comment.');
    d.querySelector('#rv-go').disabled = true; msg.textContent = '';
    try {
      await s.gh.submitReview(s.ref, { commitId: s.headSha, body, event, comments: s.pending });
      if (S !== s) return;
      s.pending = []; savePending(); d.close();
      banner('Review submitted (' + ({ COMMENT: 'comment', APPROVE: 'approved', REQUEST_CHANGES: 'changes requested' }[event]) + ').');
      s.gh.cache.delete('comments'); await loadComments(s, true);
    } catch (e) { msg.textContent = e.message; d.querySelector('#rv-go').disabled = false; }
  };
}

// ---- the comments panel and jumping to a thread
function threadStatus(t) { return t.pending ? 'pending' : t.resolved ? 'resolved' : t.outdated ? 'outdated' : 'active'; }
function renderPanel() {
  const el = $('#cpanel'); if (!el || !S) return;
  el.hidden = !S.panel;
  $('#cm-btn') && $('#cm-btn').classList.toggle('on', !!S.panel);
  if (!S.panel) return;
  const all = S.cAll || [], f = S.pfilter || 'all';
  const list = all.filter(t => f === 'all' || threadStatus(t) === f);
  const byFile = new Map();
  for (const t of list) { if (!byFile.has(t.path)) byFile.set(t.path, []); byFile.get(t.path).push(t); }
  const counts = k => all.filter(t => k === 'all' || threadStatus(t) === k).length;
  el.innerHTML = '<div class="ph"><b>Comments</b> <span class="muted">' + all.length + ' thread' + (all.length === 1 ? '' : 's') + '</span><button class="icon" data-p="close" aria-label="Close comments">✕</button></div>' +
    '<div class="chips">' + ['all', 'active', 'resolved', 'outdated', 'pending'].map(k => '<button data-pf="' + k + '" class="' + (f === k ? 'on' : '') + '">' + k[0].toUpperCase() + k.slice(1) + ' ' + counts(k) + '</button>').join('') + '</div>' +
    (list.length ? [...byFile].map(([path, ts]) => '<div class="pf" title="' + esc(path) + '">' + esc(path) + '</div>' + ts.map(t => '<a class="pt" role="button" tabindex="0" data-jump="' + esc(String(t.id)) + '">' + avatarHtml(t.root.user) + '<span class="pm"><span class="who"><b>' + esc(t.root.user ? t.root.user.login : 'ghost') + '</b> · ' + (t.line ? 'line ' + t.line : t.originalLine ? 'was line ' + t.originalLine : '') + ' <span class="status s-' + threadStatus(t) + '">' + threadStatus(t) + '</span> <span class="muted">' + (t.replies.length ? t.replies.length + ' repl' + (t.replies.length === 1 ? 'y' : 'ies') : '') + '</span></span><span class="ex">' + esc(excerpt(t.root.body)) + '</span></span></a>').join('')).join('')
      : '<p class="muted pad">' + (all.length ? 'Nothing in this filter.' : 'No review comments yet.') + '</p>');
}
async function jumpToThread(id) {
  const s = S, t = findThread(id); if (!t) return;
  if (s.tab !== 'files') { location.hash = toRoute(s.ref, { f: t.path }, 'files'); return; }
  if (!s.commentsShown) await applyRange('');
  if (S !== s) return;
  s.filter = ''; const fi = $('#filter'); if (fi) fi.value = '';
  if (t.outdated || !t.line) s.outOpen.add(t.path);
  s.tOpen.set(String(t.id), true);
  s.selected = t.path; s.current = s.fl.find(x => x.filename === t.path) || s.current;
  s.jump = String(t.id); s.jumpTries = 0;
  if (s.view === 'one') relayout(false); else { refreshTree(); relayout(false); }
  const fl = s.fl.find(x => x.filename === t.path);
  if (fl && fl.st.collapsed) { fl.st.collapsed = false; relayout(true); }
  tryJump();
  if (document.body.classList.contains('phone-panel')) document.body.classList.remove('phone-panel');
}
function tryJump() {
  const s = S; if (!s || !s.jump) return;
  const key = s.threadItem && s.threadItem.get(s.jump), el = $('#diff');
  if (key !== undefined && s.itemIndex.has(key)) {
    const id = s.jump; s.jump = null;
    el.scrollTop = Math.max(0, s.tops[s.itemIndex.get(key)] - HEAD_H - 70);
    s.flash = id; s.winKey = null; renderDiff(); renderTree();
    setTimeout(() => { if (S === s) { s.flash = null; document.querySelectorAll('.thread.flash').forEach(e => e.classList.remove('flash')); } }, 1800);
    return;
  }
  const t = findThread(s.jump);
  if (t && s.jumpTries++ < 3) { const i = s.itemIndex.get('h:' + t.path); if (i !== undefined) el.scrollTop = s.tops[i]; s.winKey = null; renderDiff(); }
}

// ---------------------------------------------------------------- page skeleton
function renderPage() {
  const s = S;
  if (!s.pr) return;
  const pr = s.pr;
  const state = pr.merged ? 'merged' : pr.draft ? 'draft' : pr.state;
  const tabs = ['files', 'overview', 'commits'];
  $('#main').innerHTML = `<div id="prhead"><h1>${esc(pr.title)} <span class="muted">#${pr.number}</span></h1>
    <div class="meta"><span class="badge ${state}">${state[0].toUpperCase() + state.slice(1)}</span>
      <span>${esc(pr.user.login)} wants to merge <span class="branch">${esc(pr.head.label || pr.head.ref)}</span> into <span class="branch">${esc(pr.base.ref)}</span></span>
      ${externalLink(pr.html_url, 'Open on GitHub ↗')}</div>
    <nav class="tabs">${tabs.map(t => `<a href="${toRoute(s.ref, { c: s.cparam, m: ui.mode === 'split' ? 'split' : '' }, t)}" class="${s.tab === t ? 'on' : ''}" data-tab="${t}">${t[0].toUpperCase() + t.slice(1)}${t === 'files' ? ' ' + (s.prFiles.length) : t === 'commits' ? ' ' + s.commits.length : ''}</a>`).join('')}</nav></div>
    <div id="page"></div>`;
  if (s.tab === 'overview') return renderOverview();
  if (s.tab === 'commits') return renderCommits();
  $('#page').outerHTML = `<div id="toolbar">
      <button id="picker-btn" aria-haspopup="listbox"></button>
      <input id="filter" type="search" placeholder="Filter files (/)" aria-label="Filter files" autocomplete="off" value="${esc(s.filter)}">
      <span id="count" class="progress"></span>
      <span class="sp"></span>
      <span class="seg" role="group" aria-label="Diff layout"><button id="m-inline" title="Inline (s)">Inline</button><button id="m-split" title="Side-by-side (s)">Side-by-side</button></span>
      <button id="full-btn" class="hide-phone" title="Show changes only or the full file (f)"></button>
      <button id="view-btn" class="hide-phone" title="One file at a time or all files stacked (a)"></button>
      <span class="seg" id="file-nav"><button id="prev-file" title="Previous file (k)" aria-label="Previous file">‹</button><span id="file-pos" class="fpos"></span><button id="next-file" title="Next file (j)" aria-label="Next file">›</button></span>
      <button id="coll-btn" class="hide-phone" title="Collapse or expand every file"></button>
      <span class="seg hide-phone"><button id="prev-chg" title="Previous change (p)">↑</button><button id="next-chg" title="Next change (n)">↓</button></span>
      <button id="cm-btn" title="All comment threads">💬 <span id="cm-n"></span></button>
      <button id="rv-btn" title="Post your pending comments as a review, or approve / request changes" hidden>Finish review</button>
      <button id="help-btn" class="icon hide-phone" title="Keyboard (?)">?</button></div>
    <div id="body"><aside id="tree" aria-label="Changed files"><div id="tspacer" style="position:relative"></div></aside><div id="scrim"></div>
      <section id="diff" aria-label="Changes"><div id="stick"></div><div id="spacer"><div id="win"></div></div></section><aside id="cpanel" aria-label="Comments" hidden></aside></div>`;
  wireFiles();
  S.vw = $('#diff').clientWidth;
  updateToolbar();
  refreshTree();
  measureChar();
  relayout(false);
}

function wireFiles() {
  $('#filter').addEventListener('input', e => { S.filter = e.target.value; refreshTree(); relayout(false); $('#diff').scrollTop = 0; });
  $('#picker-btn').onclick = openPicker;
  $('#m-inline').onclick = () => setMode('inline');
  $('#m-split').onclick = () => setMode('split');
  $('#full-btn').onclick = () => { ui.full = !ui.full; if (ui.full) S.fl.forEach(f => (f.st.expand = {})); relayout(true); updateToolbar(); syncHash(); };
  $('#view-btn').onclick = toggleView;
  $('#prev-file').onclick = () => stepFile(-1);
  $('#next-file').onclick = () => stepFile(1);
  wireSwipe($('#diff'));
  $('#coll-btn').onclick = () => { const all = S.fl.every(f => f.st.collapsed); S.fl.forEach(f => (f.st.collapsed = !all)); relayout(true); updateToolbar(); };
  $('#next-chg').onclick = () => stepChange(1);
  $('#prev-chg').onclick = () => stepChange(-1);
  $('#help-btn').onclick = helpDialog;
  renderPanel();
  $('#scrim').onclick = () => document.body.classList.remove('drawer');
  $('#diff').addEventListener('scroll', renderDiffSoon, { passive: true });
  $('#tree').addEventListener('scroll', renderTreeSoon, { passive: true });
  $('#tree').addEventListener('click', onTreeClick);
  $('#diff').addEventListener('click', onDiffClick);
  for (const ev of ['wheel', 'touchstart', 'mousedown', 'keydown']) $('#diff').addEventListener(ev, () => { if (S) S.pin = null; }, { passive: true });
  $('#diff').addEventListener('input', onDiffInput);
  $('#diff').addEventListener('keydown', onDiffKey);
  $('#diff').addEventListener('mouseover', onDiffOver);
  $('#diff').addEventListener('mousedown', onDiffDown);
  $('#cpanel').addEventListener('click', onPanelClick);
  $('#cm-btn').onclick = () => { S.panel = !S.panel; if (PHONE()) document.body.classList.toggle('phone-panel', S.panel); renderPanel(); };
  $('#rv-btn').onclick = reviewDialog;
  $('#stick').addEventListener('click', onDiffClick);
  new ResizeObserver(() => { const d = $('#diff'); if (d) { d.style.setProperty('--vw', d.clientWidth + 'px'); const w = d.clientWidth; if (S && Math.abs(w - S.vw) > 1) { S.vw = w; if (ui.mode === 'split' && S.fl) relayout(true); } renderDiffSoon(true); renderTreeSoon(); } }).observe($('#diff'));
}

function updateToolbar() {
  const s = S;
  if (!$('#picker-btn')) return;
  $('#picker-btn').textContent = rangeLabel() + (s.busy ? ' …' : '') + ' ▾';
  $('#m-inline').classList.toggle('on', ui.mode === 'inline');
  $('#m-split').classList.toggle('on', ui.mode === 'split');
  $('#full-btn').textContent = ui.full ? 'Full files' : 'Changes only';
  $('#full-btn').classList.toggle('on', ui.full);
  $('#view-btn').textContent = s.view === 'all' ? 'All files' : 'One file';
  { const list = viewFilesAll(), i = list.findIndex(f => s.current && f.filename === s.current.filename); $('#file-pos').textContent = list.length ? (i + 1) + ' / ' + list.length : ''; $('#prev-file').disabled = i <= 0; $('#next-file').disabled = i < 0 || i >= list.length - 1; $('#file-nav').hidden = s.view === 'all' ? false : false; }
  const files = s.fl || [];
  const done = files.filter(f => s.reviewed.has(f.filename)).length;
  $('#count').textContent = files.length + ' changed file' + (files.length === 1 ? '' : 's') + ' · ' + done + ' reviewed' + (s.commentsShown ? '' : s.comments && s.comments.length ? ' · comments are shown in All changes' : '');
  const nthreads = (s.cAll || []).length;
  $('#cm-n').textContent = nthreads ? String(nthreads) : '';
  const rb = $('#rv-btn'); rb.hidden = !auth.token || !s.commentsShown; rb.textContent = s.pending.length ? 'Finish review (' + s.pending.length + ')' : 'Review'; rb.classList.toggle('on', s.pending.length > 0);
  $('#coll-btn').textContent = files.length && files.every(f => f.st.collapsed) ? 'Expand all' : 'Collapse all';
}

function onPanelClick(e) {
  if (e.target.closest('[data-p=close]')) { S.panel = false; document.body.classList.remove('phone-panel'); return renderPanel(); }
  const pf = e.target.closest('[data-pf]'); if (pf) { S.pfilter = pf.dataset.pf; return renderPanel(); }
  const j = e.target.closest('[data-jump]'); if (j) jumpToThread(j.dataset.jump);
}

function measureChar() {
  const m = document.createElement('span');
  m.style.cssText = 'position:absolute;visibility:hidden;font:12.5px ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;white-space:pre';
  m.textContent = 'x'.repeat(100); document.body.appendChild(m);
  charW = m.getBoundingClientRect().width / 100 || 7.6; m.remove();
}

function setMode(m) { ui.mode = m; store.set('mode', m); relayout(true); updateToolbar(); syncHash(); }
function setView(v) { store.set('view', v); if (S && S.view !== v) toggleView(); }
function wireSwipe(el) {
  let x0 = 0, y0 = 0, t0 = 0, ok = false;
  el.addEventListener('touchstart', e => { ok = S && S.view === 'one' && e.touches.length === 1 && !e.target.closest('textarea,input,pre,.tx'); x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; t0 = Date.now(); }, { passive: true });
  el.addEventListener('touchend', e => {
    if (!ok) return; ok = false;
    const t = e.changedTouches[0], dx = t.clientX - x0, dy = t.clientY - y0;
    if (Date.now() - t0 < 700 && Math.abs(dx) > 70 && Math.abs(dx) > 2 * Math.abs(dy)) stepFile(dx < 0 ? 1 : -1);
  }, { passive: true });
}
function toggleView() {
  S.view = S.view === 'all' ? 'one' : 'all';
  relayout(false);
  if (S.view === 'all') scrollToFile(S.selected, true); else $('#diff').scrollTop = 0;
  updateToolbar(); syncHash();
}

// ---------------------------------------------------------------- commit picker (AzDO "updates")
function openPicker() {
  closePopovers();
  const s = S, btn = $('#picker-btn'), r = btn.getBoundingClientRect();
  const pop = document.createElement('div');
  pop.className = 'pop'; pop.id = 'picker'; pop.setAttribute('role', 'listbox');
  pop.style.left = Math.max(4, Math.min(r.left, innerWidth - 340)) + 'px'; pop.style.top = r.bottom + 4 + 'px';
  const draw = () => {
    pop.innerHTML = `<div class="opt ${s.range ? '' : 'sel'}" data-i="all" role="option"><span class="n">☰</span><span><b>All changes</b><br><span class="muted">${s.commits.length} commit${s.commits.length === 1 ? '' : 's'}, ${s.prFiles.length} file${s.prFiles.length === 1 ? '' : 's'}</span></span></div>` +
      s.commits.map((c, i) => `<div class="opt ${s.range && i >= s.range.i && i <= s.range.j ? 'sel' : ''}" data-i="${i}" role="option"><span class="n">${i + 1}</span><span><b>${esc(c.commit.message.split('\n')[0])}</b><br><span class="muted"><code>${shortSha(c.sha)}</code> ${esc((c.author && c.author.login) || c.commit.author.name)} · ${esc(ago(c.commit.author.date))}</span></span></div>`).join('') +
      '<div class="hint">Click a commit to see only its changes. Shift-click another to see a range.</div>';
  };
  draw();
  pop.addEventListener('click', e => {
    const o = e.target.closest('.opt'); if (!o) return;
    let c = '';
    if (o.dataset.i !== 'all') {
      const k = Number(o.dataset.i);
      const a = e.shiftKey && s.pickAnchor !== undefined && s.pickAnchor !== null ? s.pickAnchor : k;
      s.pickAnchor = e.shiftKey ? s.pickAnchor ?? k : k;
      const i = Math.min(a, k), j = Math.max(a, k);
      c = i === j ? shortSha(s.commits[i].sha) : shortSha(s.commits[i].sha) + '..' + shortSha(s.commits[j].sha);
    } else s.pickAnchor = null;
    applyRange(c).then(draw);
    s.range = parseRange(c); draw(); updateToolbar();
  });
  document.body.appendChild(pop);
  setTimeout(() => document.addEventListener('click', outsideClose, true), 0);
}
function outsideClose(e) { if (!e.target.closest('#picker') && !e.target.closest('#picker-btn') && !e.target.closest('#whomenu') && !e.target.closest('#who-btn') && !e.target.closest('#cpop')) closePopovers(); }
function closePopovers() { document.querySelectorAll('.pop').forEach(p => p.remove()); document.removeEventListener('click', outsideClose, true); }

// ---------------------------------------------------------------- tree (virtualized)
function refreshTree() {
  if (!S.tree) return;
  S.treeRows = flattenTree(S.tree, { collapsed: S.collapsedDirs, filter: S.filter });
  const sp = $('#tspacer'); if (sp) sp.style.height = S.treeRows.length * TREE_ROW + 'px';
  renderTree();
}
let treeRaf = 0;
function renderTreeSoon() { if (!treeRaf) treeRaf = requestAnimationFrame(() => { treeRaf = 0; renderTree(); }); }
function renderTree() {
  const el = $('#tree'), sp = $('#tspacer'); if (!el || !sp || !S.tree) return;
  const rows = S.treeRows, first = Math.max(0, Math.floor(el.scrollTop / TREE_ROW) - 4), last = Math.min(rows.length, Math.ceil((el.scrollTop + el.clientHeight) / TREE_ROW) + 4);
  let html = '';
  for (let i = first; i < last; i++) {
    const { node, depth } = rows[i], pad = 8 + depth * 14;
    if (node.type === 'dir') {
      const open = S.filter || !S.collapsedDirs.has(node.path);
      html += `<div class="tr" style="top:${i * TREE_ROW}px;position:absolute;left:0;right:0;padding-left:${pad}px" data-dir="${esc(node.path)}"><span class="chev">${open ? '▾' : '▸'}</span><span class="nm" title="${esc(node.path)}">${esc(node.name)}</span><span class="cnt"><span class="a">+${node.add}</span> <span class="d">−${node.del}</span></span></div>`;
    } else {
      const f = node.file, b = STATUS[f.status] || STATUS.modified, rv = S.reviewed.has(f.filename);
      html += `<div class="tr ${S.selected === f.filename ? 'sel' : ''} ${S.current && S.current.filename === f.filename ? 'cur' : ''} ${rv ? 'done' : ''}" style="top:${i * TREE_ROW}px;position:absolute;left:0;right:0;padding-left:${pad}px" data-path="${esc(f.filename)}" title="${esc(f.filename)} — ${b.label}">
        <span class="rv">${rv ? '✓' : ''}</span><span class="tb ${b.badge}">${b.badge}</span><span class="nm">${esc(node.name)}</span><span class="cnt"><span class="a">+${f.additions}</span> <span class="d">−${f.deletions}</span></span></div>`;
    }
  }
  sp.innerHTML = html;
}
function onTreeClick(e) {
  const row = e.target.closest('.tr'); if (!row) return;
  if (row.dataset.dir !== undefined) {
    const p = row.dataset.dir; S.collapsedDirs.has(p) ? S.collapsedDirs.delete(p) : S.collapsedDirs.add(p);
    refreshTree();
  } else {
    selectFile(row.dataset.path);
    document.body.classList.remove('drawer');
  }
}

// ---------------------------------------------------------------- diff pane: items, layout, virtual window
function viewFiles() {
  const q = S.filter.trim().toLowerCase();
  const list = q ? S.order.filter(f => f.filename.toLowerCase().includes(q)) : S.order;
  if (S.view === 'one') { const f = list.find(x => x.filename === S.selected) || list[0]; return f ? [f] : []; }
  return list;
}
function fileComments(f) { return S.commentsShown ? S.cIndex.get(f.filename) : null; }

function fileRows(f) {
  const st = f.st, ce = fileComments(f);
  const key = ui.mode + '|' + (ui.full || st.full) + '|' + JSON.stringify(st.expand) + '|' + (ce ? ce.R.size + ':' + ce.L.size : 0);
  if (st.rkey === key) return st.rows;
  const pin = ce ? { a: new Set([...ce.L.keys()].map(n => n - 1)), b: new Set([...ce.R.keys()].map(n => n - 1)) } : null;
  st.rows = layoutRows(st.diff.segs, { mode: ui.mode, ctx: ui.full || st.full ? Infinity : 3, expand: st.expand, pin });
  st.rkey = key;
  return st.rows;
}

function visLen(s) { let n = Math.min(s.length, 3002); for (let i = 0; i < n; i++) if (s.charCodeAt(i) === 9) n += 3; return n; }
/** Row height: 20 px per text line; side-by-side rows grow when a long line wraps in its pane. */
function rowHeight(f, row) {
  if (ui.mode !== 'split') return ROW_H;
  const cpl = Math.max(8, Math.floor(((S.vw || 1000) / 2 - 1 - 46 - 16 - 8) / charW));
  let n = 1;
  if (row.a != null) n = Math.max(n, Math.ceil(visLen(f.st.diff.a[row.a]) / cpl));
  if (row.b != null) n = Math.max(n, Math.ceil(visLen(f.st.diff.b[row.b]) / cpl));
  return n * ROW_H;
}
function buildItems() {
  const items = [], files = viewFiles();
  S.threadItem = new Map();
  let maxW = 0;
  for (const f of files) {
    const st = f.st;
    items.push({ key: 'h:' + f.filename, type: 'head', h: HEAD_H, f });
    if (st.collapsed) continue;
    const ce = fileComments(f);
    if (ce && ce.loose.length) { const k = 'cl:' + f.filename + ':' + S.outOpen.has(f.filename); items.push({ key: k, type: 'cm', f, threads: ce.loose, outdated: true, h: S.cmH.get(k) || 40 }); if (S.outOpen.has(f.filename)) for (const th of ce.loose) S.threadItem.set(String(th.id), k); }
    if (st.status === 'ready') {
      const rows = fileRows(f);
      if (!rows.length) { items.push({ key: 'n:' + f.filename, type: 'note', f, h: NOTE_H, text: f.status === 'renamed' ? 'Renamed without content changes.' : 'No content changes.' }); continue; }
      const maxLen = Math.min(st.maxLen, 3000);
      // inline: long lines scroll sideways; side-by-side: each pane wraps its own long lines (no sideways scroll)
      const w = ui.mode === 'split' ? 0 : 46 * 2 + 16 + maxLen * charW + 16;
      maxW = Math.max(maxW, w);
      const seen = new Set();
      const comp = S.composer && S.composer.path === f.filename ? S.composer : null;
      let compPlaced = false;
      rows.forEach((row, ri) => {
        const last = ri === rows.length - 1;
        items.push({ key: row.k === 'gap' ? 'g:' + f.filename + ':' + row.id : 'r:' + f.filename + ':' + (row.a ?? '') + ':' + (row.b ?? ''), type: row.k === 'gap' ? 'gap' : 'row', h: row.k === 'gap' ? GAP_H : rowHeight(f, row), f, row, last });
        if (comp && row.k !== 'gap' && !compPlaced && ((comp.side === 'R' && row.b != null && row.k !== 'del' && row.b + 1 === comp.line) || (comp.side === 'L' && row.a != null && row.k !== 'add' && row.a + 1 === comp.line))) {
          compPlaced = true; const k = 'cc:' + f.filename + ':' + comp.side + comp.line + ':' + comp.tab + ':' + (comp.err ? 1 : 0) + ':' + (comp.busy ? 1 : 0); S.composerKey = k;
          items.push({ key: k, type: 'cm', f, composer: true, threads: [], h: S.cmH.get(k) || 230 });
        }
        if (ce && row.k !== 'gap') {
          const ts = [];
          if (row.b != null && row.k !== 'del') for (const t of ce.R.get(row.b + 1) || []) if (!seen.has(t.root.id)) { seen.add(t.root.id); ts.push(t); }
          if (row.a != null && row.k !== 'add') for (const t of ce.L.get(row.a + 1) || []) if (!seen.has(t.root.id)) { seen.add(t.root.id); ts.push(t); }
          if (ts.length) { const k = 'c:' + f.filename + ':' + ts[0].root.id + ':' + ts.map(x => (threadOpen(x) ? 'o' : 'c') + x.replies.length + (S.terr.has(String(x.id)) ? 'e' : '') + (S.editing === String(x.id) ? 'x' : '')).join(''); items.push({ key: k, type: 'cm', f, threads: ts, h: S.cmH.get(k) || CM_H }); for (const th of ts) S.threadItem.set(String(th.id), k); }
        }
      });
    } else items.push({ key: 'n:' + f.filename, type: 'note', f, h: NOTE_H });
  }
  S.items = items;
  const tops = new Float64Array(items.length + 1);
  for (let i = 0; i < items.length; i++) tops[i + 1] = tops[i] + items[i].h;
  S.tops = tops; S.contentW = maxW;
  S.itemIndex = new Map(items.map((it, i) => [it.key, i]));
}

function firstVisible(y) {
  const t = S.tops; let lo = 0, hi = S.items.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (t[mid] <= y) lo = mid; else hi = mid - 1; }
  return lo;
}

/** Rebuild the item list. keepAnchor: keep the item at the top of the pane where it is (content above may have changed height). */
function relayout(keepAnchor) {
  const el = $('#diff'); if (!el || !S.fl) return;
  let anchor = null;
  if (keepAnchor && S.items.length) { const i = firstVisible(el.scrollTop); anchor = { key: S.items[i].key, off: S.tops[i] - el.scrollTop }; }
  buildItems();
  const sp = $('#spacer');
  sp.style.height = S.tops[S.items.length] + 'px';
  sp.style.minWidth = S.contentW ? Math.ceil(S.contentW) + 'px' : '';
  if (anchor && S.itemIndex.has(anchor.key)) el.scrollTop = S.tops[S.itemIndex.get(anchor.key)] - anchor.off;
  if (S.pin && S.view === 'all') {
    const i = S.itemIndex.get('h:' + S.pin), pf = S.fl.find(f => f.filename === S.pin);
    if (i !== undefined) { el.scrollTop = S.tops[i]; if (pf && pf.st.status !== 'idle' && pf.st.status !== 'loading' && Math.abs(el.scrollTop - S.tops[i]) < 2) S.pin = null; }
  }
  S.winKey = null;
  el.dataset.state = S.items.length ? 'ready' : 'empty';
  renderDiff();
  if (S.jump) tryJump();
}

let diffRaf = 0, forceRender = false;
function renderDiffSoon(force) { if (force) forceRender = true; if (!diffRaf) diffRaf = requestAnimationFrame(() => { diffRaf = 0; renderDiff(); }); }

function headHtml(f, stuck) {
  const st = f.st, b = STATUS[f.status] || STATUS.modified, i = f.filename.lastIndexOf('/');
  const name = f.filename.slice(i + 1), dir = f.filename.slice(0, i + 1);
  const rv = S.reviewed.has(f.filename), ce = S.cIndex && S.cIndex.get(f.filename);
  const blob = 'https://github.com/' + S.ref.owner + '/' + S.ref.repo + '/blob/' + (f.status === 'removed' ? S.fromSha : S.toSha) + '/' + f.filename.split('/').map(encodeURIComponent).join('/');
  return `<div class="fh ${st.collapsed ? 'collapsed' : ''}" data-path="${esc(f.filename)}" style="${stuck ? 'margin-top:0;' : 'margin-top:12px;'}"><span class="col" data-act="collapse" role="button" aria-label="${st.collapsed ? 'Expand' : 'Collapse'} file" title="Collapse / expand (c)">${st.collapsed ? '▸' : '▾'}</span>
    <span class="tb ${b.badge}" title="${b.label}">${b.badge}</span>
    <span class="fn"><b>${esc(name)}</b><small>${esc(f.status === 'renamed' ? (f.previous_filename + ' → ' + f.filename) : '/' + dir)}</small></span>
    <span class="a">+${f.additions}</span><span class="d">−${f.deletions}</span>
    ${ce ? `<span class="muted" title="Review comments">💬 ${ce.count}</span>` : ''}
    <span class="sp"></span>
    <label><input type="checkbox" data-act="review" ${rv ? 'checked' : ''}> Reviewed</label>
    <button data-act="full" title="Show the whole file with the changes marked">${st.full ? 'Changes only' : 'View'}</button>
    ${externalLink(blob, '↗')}</div>`;
}

function textHtml(f, side, idx, ranges, cls) {
  const st = f.st, lines = side === 'a' ? st.diff.a : st.diff.b, toks = (side === 'a' ? st.tokA : st.tokB);
  let t = toks && toks[idx];
  if (!t) t = [{ c: null, s: lines[idx] }];
  if (lines[idx].length > 3000) { t = [{ c: null, s: lines[idx].slice(0, 3000) + ' …' }]; ranges = null; }
  return lineHtml(t, ranges, cls);
}
function wordRanges(f, w) {
  if (!w) return null;
  const k = w[0] + ':' + w[1];
  const m = f.st.wd;
  if (!m.has(k)) m.set(k, wordDiff(f.st.diff.a[w[0]], f.st.diff.b[w[1]]));
  return m.get(k);
}

function itemHtml(it, i) {
  const f = it.f, top = S.tops[i];
  const wrap = (cls, inner, extra = '') => `<div class="it ${cls}" style="top:${top}px;height:${it.h}px" data-i="${i}" ${extra}>${inner}</div>`;
  switch (it.type) {
    case 'head': return wrap('h', headHtml(f));
    case 'gap': {
      const g = it.row;
      return wrap('g', `<div class="gap"><span class="in">⋯ ${g.count} unchanged line${g.count === 1 ? '' : 's'}
        ${g.down ? `<button data-act="gap" data-id="${g.id}" data-dir="down" title="Show 20 more lines below the change above">↓ 20</button>` : ''}${g.up ? `<button data-act="gap" data-id="${g.id}" data-dir="up" title="Show 20 more lines above the next change">↑ 20</button>` : ''}
        <button data-act="gap" data-id="${g.id}" data-dir="all">Show all</button></span></div>`);
    }
    case 'note': {
      const st = f.st;
      let inner;
      if (st.status === 'skipped') inner = `${st.reason === 'binary' ? 'Binary file' : st.reason === 'generated' ? 'Generated file' : 'Large file'} not loaded. <a data-act="load" role="button" tabindex="0">Load anyway</a>`;
      else if (st.status === 'error') inner = `Could not load this file: ${esc(st.error)} <a data-act="load" role="button" tabindex="0">Retry</a>`;
      else if (st.status === 'ready') inner = esc(it.text);
      else inner = 'Loading ' + esc(f.filename) + '…';
      return wrap('n', `<div class="note"><span class="in">${inner}</span></div>`);
    }
    case 'cm': return wrap('c', `<div class="cm">${it.outdated ? outdatedHtml(it) : (it.composer ? composerHtml(S.composer) : '') + it.threads.map(threadBox).join('')}</div>`, `data-m="${esc(it.key)}"`);
    default: {
      const r = it.row, last = it.last ? ' last' : '';
      if (ui.mode === 'split') {
        const wr = r.a != null && r.b != null && r.k === 'pair' ? wordRanges(f, [r.a, r.b]) : null;
        const changed = r.k === 'pair';
        const same = changed && r.a != null && r.b != null && f.st.diff.a[r.a] === f.st.diff.b[r.b];
        const half = (side, idx, cls) => {
          if (idx == null) return '<div class="half none"></div>';
          const sd = side === 'a' ? 'L' : 'R', ln = idx + 1;
          const target = sd === 'R' || (changed && !same);   // unchanged lines take comments on the new side only
          const attrs = target ? ` data-cl="${sd}:${ln}"` : '';
          const add = target ? addBtn(f, sd, ln) : '';
          return `<div class="half ${cls}${target && inSel(f, sd, ln) ? ' sel' : ''}"${attrs}>${add}<span class="ln">${ln}</span><span class="sg">${cls === 'add' ? '+' : cls === 'del' ? '−' : ''}</span><span class="tx">${textHtml(f, side, idx, wr && wr[side], 'wd')}</span></div>`;
        };
        return wrap('r', `<div class="row split${last}">${half('a', r.a, changed && !same ? 'del' : '')}${half('b', r.b, changed && !same ? 'add' : '')}</div>`);
      }
      const wr = r.w ? wordRanges(f, r.w) : null;
      const side = r.k === 'del' ? 'a' : 'b', idx = r.k === 'del' ? r.a : r.b;
      const sd = r.k === 'del' ? 'L' : 'R', ln = (r.k === 'del' ? r.a : r.b) + 1;
      const add = addBtn(f, sd, ln);
      return wrap('r', `<div class="row ${r.k === 'eq' ? '' : r.k}${last}${inSel(f, sd, ln) ? ' sel' : ''}" data-cl="${sd}:${ln}">${add}<span class="ln">${r.a != null ? r.a + 1 : ''}</span><span class="ln">${r.b != null ? r.b + 1 : ''}</span><span class="sg">${r.k === 'add' ? '+' : r.k === 'del' ? '−' : ''}</span><span class="tx">${textHtml(f, side, idx, wr && wr[side], 'wd')}</span></div>`);
    }
  }
}

function renderDiff() {
  const el = $('#diff'); if (!el || !S || !S.items) return;
  const y = el.scrollTop, vh = el.clientHeight || 600, n = S.items.length;
  if (!n) { $('#win').innerHTML = `<div class="empty">${S.fl ? (S.filter ? 'No files match the filter.' : 'No changed files.') : 'Loading…'}</div>`; $('#stick').innerHTML = ''; return; }
  const lo = Math.max(0, firstVisible(y - 400)), hiY = y + vh + 400;
  let hi = lo; while (hi < n && S.tops[hi] < hiY) hi++;
  const cur = S.items[firstVisible(y + 2)];
  // sticky copy of the header of the file in view
  const stick = $('#stick');
  const hi0 = cur ? S.itemIndex.get('h:' + cur.f.filename) : -1;
  const showStick = cur && hi0 >= 0 && S.tops[hi0] + 12 < y;
  const stickKey = showStick ? cur.f.filename + '|' + cur.f.st.collapsed + '|' + S.reviewed.has(cur.f.filename) + '|' + cur.f.st.full : '';
  if (stickKey !== S.stickKey || forceRender) { stick.innerHTML = showStick ? headHtml(cur.f, true) : ''; S.stickKey = stickKey; }
  if (cur && (!S.current || S.current.filename !== cur.f.filename)) { S.current = cur.f; renderTreeSoon(); }
  const key = lo + ':' + hi;
  if (key !== S.winKey || forceRender) {
    forceRender = false; S.winKey = key;
    let html = ''; const want = new Set();
    for (let i = lo; i < hi; i++) { html += itemHtml(S.items[i], i); if (S.items[i].f.st.status === 'idle') want.add(S.items[i].f); }
    const hadFocus = document.activeElement && document.activeElement.dataset && document.activeElement.dataset.fid;
    if (hadFocus) { S.focusId = hadFocus; S.caret = document.activeElement.selectionStart; }
    $('#win').innerHTML = html;
    restoreFocus();
    S.winFiles = new Set(S.items.slice(lo, hi).map(it => it.f));
    for (const f of want) queueLoad(f);
    // comment threads have no fixed height: measure them and lay out again
    let changed = false;
    $('#win').querySelectorAll('[data-m]').forEach(m => { const h = Math.ceil(m.firstElementChild.getBoundingClientRect().height) + 2, k = m.dataset.m; if (Math.abs((S.cmH.get(k) || CM_H) - h) > 1) { S.cmH.set(k, h); changed = true; } });
    if (changed) requestAnimationFrame(() => relayout(true));
  }
}

// ---------------------------------------------------------------- file loading
function queueLoad(f) { if (f.st.status !== 'idle' || S.loadQueue.includes(f)) return; S.loadQueue.push(f); pump(); }
function pump() {
  while (S.active < 4 && S.loadQueue.length) {
    const f = S.loadQueue.shift();
    if (f.st.status !== 'idle' || !S.winFiles.has(f)) continue; // scrolled away meanwhile
    S.active++;
    loadFile(f, false).finally(() => { S.active--; pump(); });
  }
}
async function loadFile(f, force) {
  const s = S, st = f.st, gen = s.gen;
  if (st.status === 'loading' || st.status === 'ready') return;
  const reason = skipReason(f);
  if (reason && !force) { st.status = 'skipped'; st.reason = reason; return relayoutLater(); }
  st.status = 'loading';
  try {
    const [A, B] = await Promise.all([
      f.status === 'added' ? '' : s.gh.fileText(s.ref, f.previous_filename || f.filename, s.fromSha),
      f.status === 'removed' ? '' : s.gh.fileText(s.ref, f.filename, s.toSha),
    ]);
    if (S !== s || s.gen !== gen) return;
    if (A === null && B === null) throw new Error('the file is not available at either commit');
    const a = A || '', b = B || '';
    if (!force && (/\0/.test(a.slice(0, 8000)) || /\0/.test(b.slice(0, 8000)))) { st.status = 'skipped'; st.reason = 'binary'; return relayoutLater(); }
    if (!force && a.length + b.length > 2_000_000) { st.status = 'skipped'; st.reason = 'large'; return relayoutLater(); }
    st.diff = diffFile(a, b);
    st.maxLen = 20;
    for (const l of st.diff.a) if (l.length > st.maxLen) st.maxLen = l.length;
    for (const l of st.diff.b) if (l.length > st.maxLen) st.maxLen = l.length;
    st.status = 'ready';
    st.rkey = null;
    relayoutLater();
    highlight(f);
  } catch (e) {
    if (S !== s) return;
    st.status = 'error'; st.error = e.message;
    if (e.kind === 'rate') showError(e);
    relayoutLater();
  }
}
let relayRaf = 0;
function relayoutLater() { if (!relayRaf) relayRaf = requestAnimationFrame(() => { relayRaf = 0; relayout(true); updateToolbar(); }); }
async function highlight(f) {
  try {
    const path = f.filename;
    hl ||= await import('./lib/highlight.js');
    const lang = hl.langFor(path);
    if (!lang || !f.st.diff) return;
    f.st.tokA = hl.tokenizeLines(lang, f.st.diff.a); f.st.tokB = hl.tokenizeLines(lang, f.st.diff.b);
    renderDiffSoon(true);
  } catch { /* highlighting is optional */ }
}

// ---------------------------------------------------------------- actions
function onDiffClick(e) {
  const t = e.target.closest('[data-act]'); if (!t) return;
  const path = t.closest('[data-path]') ? t.closest('[data-path]').dataset.path : null;
  const it = t.closest('.it') ? S.items[Number(t.closest('.it').dataset.i)] : null;
  const f = path ? S.fl.find(x => x.filename === path) : it && it.f;
  if (!f) return;
  const act = t.dataset.act;
  if (commentAction(act, t, f, e)) return;
  if (act === 'collapse') { f.st.collapsed = !f.st.collapsed; relayout(true); updateToolbar(); }
  else if (act === 'review') toggleReviewed(f);
  else if (act === 'full') { f.st.full = !f.st.full; f.st.expand = {}; if (f.st.status === 'idle') queueLoad(f); relayout(true); }
  else if (act === 'load') { f.st.status = 'idle'; loadFile(f, true); }
  else if (act === 'gap') {
    const id = t.dataset.id, ex = f.st.expand[id] || { up: 0, down: 0 }, dir = t.dataset.dir;
    f.st.expand = { ...f.st.expand, [id]: dir === 'all' ? { up: 1e9, down: 1e9 } : { up: ex.up + (dir === 'up' ? 20 : 0), down: ex.down + (dir === 'down' ? 20 : 0) } };
    relayout(true);
  }
}
function toggleReviewed(f) {
  const r = S.reviewed;
  r.has(f.filename) ? r.delete(f.filename) : r.add(f.filename);
  store.set('rev:' + S.key + '@' + S.headSha, [...r]);
  S.winKey = null; S.stickKey = null; renderDiff(); renderTree(); updateToolbar();
}

function scrollToFile(path, instant) {
  const el = $('#diff'); if (!el || !path) return;
  if (S.view === 'one') { S.selected = path; relayout(false); el.scrollTop = 0; }
  else {
    const i = S.itemIndex.get('h:' + path);
    if (i === undefined) { S.filter = ''; const fi = $('#filter'); if (fi) fi.value = ''; refreshTree(); relayout(false); return scrollToFile(path, instant); }
    el.scrollTop = S.tops[i];
    S.pin = path; setTimeout(() => { if (S && S.pin === path) S.pin = null; }, 6000);   // hold the file at the top while content above/below it is still loading
  }
  S.winKey = null; renderDiff();
}
function selectFile(path) {
  S.selected = path;
  S.current = S.fl.find(f => f.filename === path) || S.current;
  scrollToFile(path);
  renderTree(); updateToolbar(); syncHash();
}
function stepFile(d) {
  const list = viewFilesAll();
  const cur = S.current ? list.findIndex(f => f.filename === S.current.filename) : -1;
  const next = list[Math.max(0, Math.min(list.length - 1, cur + d))];
  if (next) selectFile(next.filename);
}
function viewFilesAll() { if (!S.order) return []; const q = S.filter.trim().toLowerCase(); return q ? S.order.filter(f => f.filename.toLowerCase().includes(q)) : S.order; }
function stepChange(d) {
  const el = $('#diff'), y = el.scrollTop;
  const anchors = [];
  S.items.forEach((it, i) => { if (it.type === 'row' && it.row.first) anchors.push(S.tops[i]); });
  const off = HEAD_H - 4 + 12; // keep the sticky file header clear of the line
  let target = null;
  if (d > 0) target = anchors.find(t => t - off > y + 2); else for (const t of anchors) if (t - off < y - 2) target = t;
  if (target === null) return stepFile(d);
  el.scrollTop = Math.max(0, target - off - 8);
}

document.addEventListener('keydown', e => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || $('#dlg').open) { if (e.key === 'Escape' && tag === 'INPUT') e.target.blur(); return; }
  if (e.key === 'Escape') { closePopovers(); document.body.classList.remove('drawer'); return; }
  if (e.key === '?') return helpDialog();
  if (!S || !S.fl || S.tab !== 'files') return;
  const k = e.key.toLowerCase();
  if (k === 'j') stepFile(1);
  else if (k === 'k') stepFile(-1);
  else if (k === 'n') stepChange(1);
  else if (k === 'p') stepChange(-1);
  else if (k === 'r' && S.current) toggleReviewed(S.current);
  else if (k === 'c') commentAtCursor();
  else if (k === 'x' && S.current) { S.current.st.collapsed = !S.current.st.collapsed; relayout(true); updateToolbar(); }
  else if (k === 'm') $('#cm-btn').click();
  else if (k === 's') setMode(ui.mode === 'split' ? 'inline' : 'split');
  else if (k === 'f') $('#full-btn').click();
  else if (k === 'a') toggleView();
  else if (k === 't') document.body.classList.toggle('drawer');
  else if (k === '/') { e.preventDefault(); $('#filter').focus(); }
  else return;
  if (k !== 't') e.preventDefault();
});

// ---------------------------------------------------------------- overview and commits tabs
function renderOverview() {
  const s = S, pr = s.pr;
  $('#page').outerHTML = `<div class="page"><div class="inner">
    <div class="card stats"><div><b>${s.commits.length}</b>commits</div><div><b>${pr.changed_files}</b>files</div><div><b style="color:var(--ok)">+${pr.additions}</b>added</div><div><b style="color:var(--bad)">−${pr.deletions}</b>removed</div><div><b>${pr.review_comments}</b>review comments</div></div>
    <div class="card desc"><b>Description</b>${pr.body ? mdLite(pr.body) : '<p class="muted">No description provided.</p>'}</div>
    <div class="card" id="convo"><b>Conversation</b><p class="muted">Loading…</p></div></div></div>`;
  s.gh.issueComments(s.ref).then(list => {
    if (S !== s || $('#convo') === null) return;
    $('#convo').innerHTML = '<b>Conversation</b>' + (list.length ? list.map(c => `<div class="commit" style="display:block"><div class="who muted"><b style="color:var(--text)">${esc(c.user ? c.user.login : 'ghost')}</b> · ${esc(ago(c.created_at))} ${externalLink(c.html_url, '↗')}</div>${mdLite(c.body)}</div>`).join('') : '<p class="muted">No comments.</p>');
  }).catch(showError);
}
function renderCommits() {
  const s = S;
  $('#page').outerHTML = `<div class="page"><div class="inner card">${s.commits.map((c, i) => `<div class="commit"><span class="muted">${i + 1}</span><span class="msg"><b>${esc(c.commit.message.split('\n')[0])}</b><br><span class="muted">${esc((c.author && c.author.login) || c.commit.author.name)} · ${esc(ago(c.commit.author.date))}</span></span><code>${shortSha(c.sha)}</code><a href="${toRoute(s.ref, { c: shortSha(c.sha) })}">View changes</a>${externalLink(c.html_url, 'GitHub ↗')}</div>`).join('')}</div></div>`;
}

if ('serviceWorker' in navigator && location.protocol.startsWith('http') && !/[?&]nosw/.test(location.search)) navigator.serviceWorker.register('sw.js', { scope: './' }).catch(() => {});
window.__prview = { get state() { return S; }, ui };
renderWho();
route();
