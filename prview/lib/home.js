// The home view: lists of pull requests (For me / A repo / Recent). DOM + GitHub client; no app state of its own beyond what is on screen.
import { prQuery } from './github.js';
import { esc, ago } from './render.js';

const ME = [['review', 'Review requested'], ['authored', 'Authored by me'], ['assigned', 'Assigned to me'], ['mentioned', 'Mentioned']];
const STATES = [['open', 'Open'], ['closed', 'Closed'], ['merged', 'Merged'], ['all', 'All']];
const REVIEW = { APPROVED: ['Approved', 'ok'], CHANGES_REQUESTED: ['Changes requested', 'bad'], REVIEW_REQUIRED: ['Review required', 'muted'] };
const CHECKS = { SUCCESS: ['Checks passed', 'ok', '✓'], FAILURE: ['Checks failed', 'bad', '✕'], ERROR: ['Checks failed', 'bad', '✕'], PENDING: ['Checks running', 'warn', '●'], EXPECTED: ['Checks expected', 'warn', '●'] };

export function parseRepo(text) {
  const m = String(text || '').trim().match(/^(?:https?:\/\/(?:www\.)?github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/?#].*)?$/);
  return m ? m[1] + '/' + m[2] : null;
}

export function rowHtml(r, href) {
  const rev = r.review && REVIEW[r.review], chk = r.checks && CHECKS[r.checks];
  return `<a class="prrow" href="${esc(href)}" data-pr="${esc(r.owner + '/' + r.repo + '#' + r.number)}">
    ${r.avatar ? `<img class="av" src="${esc(r.avatar)}" alt="" width="28" height="28" loading="lazy" referrerpolicy="no-referrer">` : '<span class="av"></span>'}
    <span class="main"><b class="t">${esc(r.title)}</b>${r.draft ? ' <span class="pill muted">Draft</span>' : ''}<br>
      <span class="muted">${esc(r.owner + '/' + r.repo)} #${r.number} · ${esc(r.author)} · updated ${esc(r.updatedAt ? ago(r.updatedAt) : '')}</span></span>
    <span class="badges"><span class="badge ${esc(r.state)}">${esc(r.state[0].toUpperCase() + r.state.slice(1))}</span>
      ${rev ? `<span class="pill ${rev[1]}" title="Review state">${rev[0]}</span>` : ''}${chk ? `<span class="pill ${chk[1]}" title="${chk[0]}">${chk[2]} <span class="hide-phone">${chk[0]}</span></span>` : ''}</span></a>`;
}

/**
 * root: element to fill. ctx: { gh, signedIn, store, href(ref), signIn(), params, recent: [{ref,title,at}] }
 */
export function renderHome(root, ctx) {
  const { gh, signedIn, store, href, params = {} } = ctx;
  const st = { tab: params.tab || (signedIn ? 'me' : 'repo'), me: params.me || store.get('home.me', 'review'), repo: parseRepo(params.repo) || store.get('home.repo', ''), state: params.s || 'open', q: params.q || '', cursors: [null], total: null, loadId: 0 };
  if (st.tab === 'me' && !signedIn) st.tab = 'repo';
  root.innerHTML = `<div class="home">
    <nav class="tabs" id="home-tabs"><a data-tab="me" href="#/">For me</a><a data-tab="repo" href="#/">A repo</a><a data-tab="recent" href="#/">Recent</a></nav>
    <div id="home-ctl"></div><div id="home-list" aria-live="polite"></div><div id="home-pager"></div></div>`;
  const $ = s => root.querySelector(s);

  function controls() {
    const t = st.tab;
    $('#home-tabs').querySelectorAll('a').forEach(a => a.classList.toggle('on', a.dataset.tab === t));
    let h = '';
    if (t === 'me') h = signedIn ? `<div class="chips">${ME.map(([k, l]) => `<button data-me="${k}" class="${st.me === k ? 'on' : ''}">${l}</button>`).join('')}</div>` : '';
    if (t === 'repo') h = `<form id="repo-form" class="repoctl"><input id="repo-in" type="text" placeholder="owner/repo" value="${esc(st.repo)}" spellcheck="false" aria-label="Repository" autocomplete="off"><button class="on">Show</button></form>
      <div class="chips">${STATES.map(([k, l]) => `<button data-s="${k}" class="${st.state === k ? 'on' : ''}">${l}</button>`).join('')}<input id="pr-filter" type="search" placeholder="Filter by title…" value="${esc(st.q)}" aria-label="Filter pull requests" autocomplete="off"></div>`;
    $('#home-ctl').innerHTML = h;
  }
  const sync = () => { try { const q = new URLSearchParams({ tab: st.tab, ...(st.tab === 'me' ? { me: st.me } : st.tab === 'repo' ? { repo: st.repo, s: st.state, q: st.q } : {}) }); history.replaceState(null, '', '#/?' + q.toString().replace(/%2F/gi, '/')); } catch { /* no history */ } };

  async function load() {
    const id = ++st.loadId, list = $('#home-list'), pager = $('#home-pager');
    pager.innerHTML = '';
    if (st.tab === 'recent') {
      const rec = ctx.recent || [];
      list.innerHTML = rec.length ? rec.map(r => `<a class="prrow" href="${esc(href(r.ref))}" data-pr="${esc(r.ref.owner + '/' + r.ref.repo + '#' + r.ref.number)}"><span class="av"></span><span class="main"><b class="t">${esc(r.title || '')}</b><br><span class="muted">${esc(r.ref.owner + '/' + r.ref.repo)} #${r.ref.number}${r.at ? ' · opened in the viewer ' + esc(ago(r.at)) : ''}</span></span></a>`).join('') : '<p class="muted">Pull requests you open in the viewer are listed here (kept in this browser).</p>';
      return;
    }
    if (st.tab === 'me' && !signedIn) { list.innerHTML = '<div class="card"><b>Sign in to see your pull requests</b><p class="muted">Review requests, your own pull requests, assigned and mentioned ones.</p><button class="on" id="home-signin">Sign in with GitHub</button></div>'; return; }
    let q, opts = {};
    if (st.tab === 'repo') {
      if (!st.repo) { list.innerHTML = '<p class="muted">Enter <code>owner/repo</code> to list its pull requests. Public repositories work without signing in.</p>'; return; }
      q = prQuery({ kind: 'repo', repo: st.repo, state: st.state, text: st.q });
    } else q = prQuery({ kind: st.me, text: '' });
    list.innerHTML = '<p class="muted">Loading…</p>';
    const cursor = st.cursors[st.cursors.length - 1];
    try {
      let res;
      if (st.tab === 'repo' && !signedIn && !st.q && st.state === 'open') res = await gh.repoPrs({ owner: st.repo.split('/')[0], repo: st.repo.split('/')[1] }, 'open', { page: cursor ? Number(cursor) : 1 });
      else res = await gh.searchPrs(q, { cursor, ...opts });
      if (id !== st.loadId) return;
      st.total = res.total; st.next = res.next;
      list.innerHTML = res.rows.length ? res.rows.map(r => rowHtml(r, href({ owner: r.owner, repo: r.repo, number: r.number }))).join('') : '<p class="muted">No pull requests.</p>';
      const page = st.cursors.length;
      pager.innerHTML = (page > 1 || res.next) ? `<button id="pg-prev" ${page > 1 ? '' : 'disabled'}>← Newer</button><span class="muted">Page ${page}${res.total != null ? ' · ' + res.total + ' result' + (res.total === 1 ? '' : 's') : ''}</span><button id="pg-next" ${res.next ? '' : 'disabled'}>Older →</button>` : '';
    } catch (e) {
      if (id !== st.loadId) return;
      list.innerHTML = '<p class="muted">Could not load: ' + esc(e.message || e) + '</p>';
      if (ctx.onError) ctx.onError(e);
    }
  }
  const reset = () => { st.cursors = [null]; sync(); load(); };

  root.addEventListener('click', e => {
    const a = e.target.closest('#home-tabs a');
    if (a) { e.preventDefault(); st.tab = a.dataset.tab; if (st.tab === 'me' && !signedIn) { /* shows the sign-in card */ } controls(); reset(); return; }
    const me = e.target.closest('[data-me]'); if (me) { st.me = me.dataset.me; store.set('home.me', st.me); controls(); reset(); return; }
    const s = e.target.closest('[data-s]'); if (s) { st.state = s.dataset.s; controls(); reset(); return; }
    if (e.target.closest('#home-signin')) return ctx.signIn();
    if (e.target.id === 'pg-next' && st.next) { st.cursors.push(st.next); load(); }
    if (e.target.id === 'pg-prev' && st.cursors.length > 1) { st.cursors.pop(); load(); }
  });
  root.addEventListener('submit', e => {
    if (e.target.id !== 'repo-form') return;
    e.preventDefault();
    const r = parseRepo(root.querySelector('#repo-in').value);
    if (!r) { root.querySelector('#home-list').innerHTML = '<p class="muted">That does not look like owner/repo.</p>'; return; }
    st.repo = r; store.set('home.repo', r); controls(); reset();
  });
  let t = 0;
  root.addEventListener('input', e => {
    if (e.target.id !== 'pr-filter') return;
    clearTimeout(t); const v = e.target.value; t = setTimeout(() => { st.q = v; reset(); }, 350);
  });
  controls(); load();
  return st;
}
