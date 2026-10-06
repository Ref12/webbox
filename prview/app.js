// PR viewer: GitHub pull requests in an Azure DevOps style layout. No build step; ES modules only.
import { GitHub, GhError, skipReason } from './lib/github.js';
import { diffFile, layoutRows, wordDiff } from './lib/diff.js';
import { buildTree, flattenTree, orderedFiles, STATUS } from './lib/tree.js';
import { parsePrRef, parseRoute, toRoute, githubUrl } from './lib/url.js';
import { esc, lineHtml, mdLite, ago, shortSha, externalLink } from './lib/render.js';

const $ = s => document.querySelector(s);
const store = {
  get(k, d) { try { const v = localStorage.getItem('prview.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('prview.' + k, JSON.stringify(v)); } catch { /* storage full or blocked */ } },
};
const getToken = () => localStorage.getItem('prview.token') || '';

const HEAD_H = 60, ROW_H = 20, GAP_H = 28, NOTE_H = 56, TREE_ROW = 26, CM_H = 120;
const PHONE = () => matchMedia('(max-width: 800px)').matches;

let S = null;                 // the open pull request (null on the landing page)
let hl = null;                // lazily imported highlighter
let charW = 7.6;
const ui = { mode: store.get('mode', 'inline'), full: false };

// ---------------------------------------------------------------- banner, rate, dialogs
function banner(html) { const b = $('#banner'); b.innerHTML = html || ''; b.hidden = !html; }
function showError(e) {
  if (e instanceof GhError && e.kind === 'rate') {
    const when = e.reset ? ' It resets at ' + new Date(e.reset).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + '.' : '';
    banner('<b>Rate limit reached.</b> ' + esc(e.message) + when + (e.authed ? '' : ' A token raises the limit to 5,000 requests per hour. <button data-act="settings">Add a token</button>'));
  } else banner(esc(e.message || String(e)) + (e.kind === 'notfound' || e.kind === 'auth' ? ' <button data-act="settings">Settings</button>' : ''));
}
function showRate(r) {
  const el = $('#rate');
  el.textContent = 'API ' + r.remaining + '/' + r.limit;
  el.title = (r.authed ? 'Using your token. ' : 'Anonymous: 60 requests per hour per IP. ') + 'Resets ' + new Date(r.reset).toLocaleTimeString();
  el.style.color = r.remaining < 8 ? 'var(--bad)' : '';
}
function openDialog(html) { const d = $('#dlg'); d.innerHTML = html; if (!d.open) d.showModal(); return d; }
function settingsDialog() {
  const d = openDialog(`<h2>Settings</h2>
    <p>Public repositories work without a token, but GitHub allows only <b>60 API requests per hour</b> without one. A token raises that to 5,000 and unlocks private repositories.</p>
    <label>GitHub token (fine-grained: <i>Pull requests: read</i> and <i>Contents: read</i>)<br><input id="tok" type="password" autocomplete="off" placeholder="github_pat_…" value="${esc(getToken())}"></label>
    <p class="muted">The token is kept only in this browser's localStorage and is sent only to api.github.com. ${externalLink('https://github.com/settings/personal-access-tokens/new', 'Create a token')}</p>
    <div class="row2"><button id="tok-clear">Remove token</button><button id="tok-close">Cancel</button><button id="tok-save" class="on">Save</button></div>`);
  d.querySelector('#tok-save').onclick = () => { localStorage.setItem('prview.token', d.querySelector('#tok').value.trim()); d.close(); location.reload(); };
  d.querySelector('#tok-clear').onclick = () => { localStorage.removeItem('prview.token'); d.close(); location.reload(); };
  d.querySelector('#tok-close').onclick = () => d.close();
}
function helpDialog() {
  const d = openDialog(`<h2>Keyboard</h2><table>
    <tr><td><kbd>j</kbd> / <kbd>k</kbd></td><td>next / previous file</td></tr>
    <tr><td><kbd>n</kbd> / <kbd>p</kbd></td><td>next / previous change</td></tr>
    <tr><td><kbd>r</kbd></td><td>mark the current file reviewed</td></tr>
    <tr><td><kbd>c</kbd></td><td>collapse / expand the current file</td></tr>
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
  const p = { f: S.view === 'one' ? S.selected : S.selected && S.selected !== S.order[0]?.filename ? S.selected : '', c: S.cparam || '', m: ui.mode === 'split' ? 'split' : '', v: S.view === 'one' ? 'one' : '', x: ui.full ? '1' : '' };
  const h = toRoute(S.ref, p, S.tab);
  if (h !== location.hash) { S.hashSet = h; history.replaceState(null, '', h); }
}

async function route() {
  const { ref, tab, params } = parseRoute(location.hash);
  if (!ref) { S = null; return landing(); }
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

function landing() {
  document.title = 'PR viewer';
  banner('');
  const recent = store.get('recent', []);
  $('#main').innerHTML = `<div class="landing"><h1>Pull request viewer</h1>
    <p>Review a GitHub pull request the way Azure DevOps shows it: a file tree with change badges, full-file diffs with expandable context, inline or side-by-side, reviewed checkboxes and a commit picker.</p>
    <form id="land-form"><input id="land-in" type="text" placeholder="https://github.com/owner/repo/pull/123" spellcheck="false" autofocus aria-label="GitHub pull request URL"><button class="on">Open</button></form>
    <div id="land-err" class="muted"></div>
    <p>Try <a href="#/dotnet/runtime/pull/135064">dotnet/runtime#135064</a>. Public repositories need no sign-in; add a token in ⚙ Settings for private ones or for more than 60 requests per hour.</p>
    ${recent.length ? '<div class="card recent"><b>Recent</b>' + recent.map(r => `<a href="${toRoute(r.ref)}">${esc(r.ref.owner + '/' + r.ref.repo + '#' + r.ref.number)} <span class="muted">${esc(r.title || '')}</span></a>`).join('') + '</div>' : ''}
    <p class="muted">Keys: <kbd>j</kbd>/<kbd>k</kbd> files, <kbd>n</kbd>/<kbd>p</kbd> changes, <kbd>r</kbd> reviewed, <kbd>s</kbd> side-by-side, <kbd>?</kbd> all.</p></div>`;
  $('#land-form').onsubmit = e => { e.preventDefault(); goto($('#land-in').value, '#land-err'); };
}
function goto(text, errSel) {
  const ref = parsePrRef(text);
  if (!ref) { const e = $(errSel); if (e) e.textContent = 'That does not look like a GitHub pull request URL (https://github.com/owner/repo/pull/123).'; return; }
  location.hash = toRoute(ref);
}
$('#goto').onsubmit = e => { e.preventDefault(); const v = $('#goto-in').value; goto(v, '#land-err'); $('#goto-in').value = ''; $('#goto-in').blur(); };
$('#settings-btn').onclick = settingsDialog;
$('#menu').onclick = () => document.body.classList.toggle('drawer');
document.addEventListener('click', e => { const b = e.target.closest('#banner [data-act=settings]'); if (b) settingsDialog(); });

// ---------------------------------------------------------------- loading a pull request
async function openPr(ref, tab, params) {
  banner('');
  $('#main').innerHTML = '<div class="empty">Loading ' + esc(ref.owner + '/' + ref.repo + '#' + ref.number) + '…</div>';
  const gh = new GitHub({ token: getToken(), onRate: showRate });
  const s = S = {
    ref, key: ref.owner + '/' + ref.repo + '#' + ref.number, gh, tab, view: params.v === 'one' ? 'one' : 'all', filter: '', collapsedDirs: new Set(),
    items: [], tops: new Float64Array(0), cmH: new Map(), gen: 0, loadQueue: [], active: 0, winFiles: new Set(), selected: params.f || null, current: null, treeRows: [], comments: null,
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
    recent.unshift({ ref, title: pr.title }); store.set('recent', recent.slice(0, 8));
    s.reviewed = new Set(store.get('rev:' + s.key + '@' + s.headSha, []));
    gh.mergeBase(ref, pr.base.sha, pr.head.sha).then(sha => { if (sha) s.mergeBase = sha; }).catch(() => {}).then(() => { if (S === s) { s.mbReady = true; if (s.gen === 0) applyRange(params.c || '', true); } });
    gh.prComments(ref).then(c => { s.comments = c; if (S === s) { buildCommentIndex(); if (s.rangeReady) relayout(); } }).catch(e => { s.comments = []; showError(e); });
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

// ---------------------------------------------------------------- review comments (read only)
function buildCommentIndex() {
  const s = S;
  s.cIndex = new Map();
  if (!s.comments || !s.fl) return;
  const live = s.fromSha === s.mergeBase && s.toSha === s.headSha; // positions refer to the PR head
  s.commentsShown = live;
  const roots = new Map();
  for (const c of s.comments) if (!c.in_reply_to_id) roots.set(c.id, { root: c, replies: [] });
  for (const c of s.comments) if (c.in_reply_to_id && roots.has(c.in_reply_to_id)) roots.get(c.in_reply_to_id).replies.push(c);
  for (const t of roots.values()) {
    const c = t.root;
    let e = s.cIndex.get(c.path);
    if (!e) s.cIndex.set(c.path, e = { R: new Map(), L: new Map(), loose: [], count: 0 });
    e.count += 1 + t.replies.length;
    if (!live) continue;
    if (c.line && !c.outdated) {
      const m = c.side === 'LEFT' ? e.L : e.R;
      if (!m.has(c.line)) m.set(c.line, []);
      m.get(c.line).push(t);
    } else e.loose.push(t);
  }
}
function threadHtml(t) {
  return '<div class="thread">' + [t.root, ...t.replies].map(c => `<div class="c"><div class="who"><b>${esc(c.user ? c.user.login : 'ghost')}</b> · ${esc(ago(c.created_at))} ${externalLink(c.html_url, '↗')}${c.outdated ? ' <span class="outdated">outdated</span>' : ''}</div>${mdLite(c.body)}</div>`).join('') + '</div>';
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
      <button id="view-btn" class="hide-phone" title="All files stacked or one file at a time (a)"></button>
      <button id="coll-btn" class="hide-phone" title="Collapse or expand every file"></button>
      <span class="seg hide-phone"><button id="prev-chg" title="Previous change (p)">↑</button><button id="next-chg" title="Next change (n)">↓</button></span>
      <button id="help-btn" class="icon hide-phone" title="Keyboard (?)">?</button></div>
    <div id="body"><aside id="tree" aria-label="Changed files"><div id="tspacer" style="position:relative"></div></aside><div id="scrim"></div>
      <section id="diff" aria-label="Changes"><div id="stick"></div><div id="spacer"><div id="win"></div></div></section></div>`;
  wireFiles();
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
  $('#coll-btn').onclick = () => { const all = S.fl.every(f => f.st.collapsed); S.fl.forEach(f => (f.st.collapsed = !all)); relayout(true); updateToolbar(); };
  $('#next-chg').onclick = () => stepChange(1);
  $('#prev-chg').onclick = () => stepChange(-1);
  $('#help-btn').onclick = helpDialog;
  $('#scrim').onclick = () => document.body.classList.remove('drawer');
  $('#diff').addEventListener('scroll', renderDiffSoon, { passive: true });
  $('#tree').addEventListener('scroll', renderTreeSoon, { passive: true });
  $('#tree').addEventListener('click', onTreeClick);
  $('#diff').addEventListener('click', onDiffClick);
  $('#stick').addEventListener('click', onDiffClick);
  new ResizeObserver(() => { const d = $('#diff'); if (d) { d.style.setProperty('--vw', d.clientWidth + 'px'); renderDiffSoon(true); renderTreeSoon(); } }).observe($('#diff'));
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
  const files = s.fl || [];
  const done = files.filter(f => s.reviewed.has(f.filename)).length;
  $('#count').textContent = files.length + ' changed file' + (files.length === 1 ? '' : 's') + ' · ' + done + ' reviewed' + (s.commentsShown ? '' : s.comments && s.comments.length ? ' · comments are shown in All changes' : '');
  $('#coll-btn').textContent = files.length && files.every(f => f.st.collapsed) ? 'Expand all' : 'Collapse all';
}

function measureChar() {
  const m = document.createElement('span');
  m.style.cssText = 'position:absolute;visibility:hidden;font:12.5px ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;white-space:pre';
  m.textContent = 'x'.repeat(100); document.body.appendChild(m);
  charW = m.getBoundingClientRect().width / 100 || 7.6; m.remove();
}

function setMode(m) { ui.mode = m; store.set('mode', m); relayout(true); updateToolbar(); syncHash(); }
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
function outsideClose(e) { if (!e.target.closest('#picker') && !e.target.closest('#picker-btn')) closePopovers(); }
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
  const key = ui.mode + '|' + (ui.full || st.full) + '|' + JSON.stringify(st.expand) + '|' + (ce ? 1 : 0);
  if (st.rkey === key) return st.rows;
  const pin = ce ? { a: new Set([...ce.L.keys()].map(n => n - 1)), b: new Set([...ce.R.keys()].map(n => n - 1)) } : null;
  st.rows = layoutRows(st.diff.segs, { mode: ui.mode, ctx: ui.full || st.full ? Infinity : 3, expand: st.expand, pin });
  st.rkey = key;
  return st.rows;
}

function buildItems() {
  const items = [], files = viewFiles();
  let maxW = 0;
  for (const f of files) {
    const st = f.st;
    items.push({ key: 'h:' + f.filename, type: 'head', h: HEAD_H, f });
    if (st.collapsed) continue;
    const ce = fileComments(f);
    if (ce && ce.loose.length) items.push({ key: 'cl:' + f.filename, type: 'cm', f, threads: ce.loose, label: 'Comments on earlier versions of this file', h: S.cmH.get('cl:' + f.filename) || CM_H });
    if (st.status === 'ready') {
      const rows = fileRows(f);
      if (!rows.length) { items.push({ key: 'n:' + f.filename, type: 'note', f, h: NOTE_H, text: f.status === 'renamed' ? 'Renamed without content changes.' : 'No content changes.' }); continue; }
      const maxLen = Math.min(st.maxLen, 400);
      const w = ui.mode === 'split' ? 2 * (46 + 16 + maxLen * charW + 16) : 46 * 2 + 16 + maxLen * charW + 16;
      maxW = Math.max(maxW, w);
      const seen = new Set();
      rows.forEach((row, ri) => {
        const last = ri === rows.length - 1;
        items.push({ key: row.k === 'gap' ? 'g:' + f.filename + ':' + row.id : 'r:' + f.filename + ':' + (row.a ?? '') + ':' + (row.b ?? ''), type: row.k === 'gap' ? 'gap' : 'row', h: row.k === 'gap' ? GAP_H : ROW_H, f, row, last });
        if (ce && row.k !== 'gap') {
          const ts = [];
          if (row.b != null && row.k !== 'del') for (const t of ce.R.get(row.b + 1) || []) if (!seen.has(t.root.id)) { seen.add(t.root.id); ts.push(t); }
          if (row.a != null && row.k !== 'add') for (const t of ce.L.get(row.a + 1) || []) if (!seen.has(t.root.id)) { seen.add(t.root.id); ts.push(t); }
          if (ts.length) { const k = 'c:' + f.filename + ':' + ts[0].root.id; items.push({ key: k, type: 'cm', f, threads: ts, h: S.cmH.get(k) || CM_H }); }
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
  S.winKey = null;
  el.dataset.state = S.items.length ? 'ready' : 'empty';
  renderDiff();
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
    case 'cm': return wrap('c', `<div class="cm">${it.label ? `<div class="thread"><div class="c muted">${esc(it.label)}</div></div>` : ''}${it.threads.map(threadHtml).join('')}</div>`, `data-m="${esc(it.key)}"`);
    default: {
      const r = it.row, last = it.last ? ' last' : '';
      if (ui.mode === 'split') {
        const wr = r.a != null && r.b != null && r.k === 'pair' ? wordRanges(f, [r.a, r.b]) : null;
        const half = (side, idx, cls) => idx == null ? '<div class="half none"></div>' :
          `<div class="half ${cls}"><span class="ln">${idx + 1}</span><span class="sg">${cls === 'add' ? '+' : cls === 'del' ? '−' : ''}</span><span class="tx">${textHtml(f, side, idx, wr && wr[side], 'wd')}</span></div>`;
        const changed = r.k === 'pair';
        const same = changed && r.a != null && r.b != null && f.st.diff.a[r.a] === f.st.diff.b[r.b];
        return wrap('r', `<div class="row split${last}">${half('a', r.a, changed && !same ? 'del' : '')}${half('b', r.b, changed && !same ? 'add' : '')}</div>`);
      }
      const wr = r.w ? wordRanges(f, r.w) : null;
      const side = r.k === 'del' ? 'a' : 'b', idx = r.k === 'del' ? r.a : r.b;
      return wrap('r', `<div class="row ${r.k === 'eq' ? '' : r.k}${last}"><span class="ln">${r.a != null ? r.a + 1 : ''}</span><span class="ln">${r.b != null ? r.b + 1 : ''}</span><span class="sg">${r.k === 'add' ? '+' : r.k === 'del' ? '−' : ''}</span><span class="tx">${textHtml(f, side, idx, wr && wr[side], 'wd')}</span></div>`);
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
    $('#win').innerHTML = html;
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
  }
  S.winKey = null; renderDiff();
}
function selectFile(path) {
  S.selected = path;
  S.current = S.fl.find(f => f.filename === path) || S.current;
  scrollToFile(path);
  renderTree(); syncHash();
}
function stepFile(d) {
  const list = viewFilesAll();
  const cur = S.current ? list.findIndex(f => f.filename === S.current.filename) : -1;
  const next = list[Math.max(0, Math.min(list.length - 1, cur + d))];
  if (next) selectFile(next.filename);
}
function viewFilesAll() { const q = S.filter.trim().toLowerCase(); return q ? S.order.filter(f => f.filename.toLowerCase().includes(q)) : S.order; }
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
  else if (k === 'c' && S.current) { S.current.st.collapsed = !S.current.st.collapsed; relayout(true); updateToolbar(); }
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
route();
