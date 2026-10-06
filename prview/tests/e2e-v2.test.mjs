// v2: restored v1 fixes, device-flow sign-in (mocked proxy), PR lists, inline comments that post (mocked POSTs). No live calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { start, PR, PROXY, ME } from './harness.mjs';

const SHOTS = new URL('../docs/screenshots/', import.meta.url).pathname;
fs.mkdirSync(SHOTS, { recursive: true });
const shot = (p, name) => p.screenshot({ path: SHOTS + name + '.png' });
const HEAD = '6724b85cb70f0366cb7e41a9dd45f28df4f58c2d';
const LINK = 'src/tools/illink/src/ILLink.Tasks/LinkTask.cs';
const LIVE_ROOT = 4167554232, TARGETS_ROOT = 4168145947, OUTDATED_ROOT = 4186668554;

async function open(h, hash = PR, sel = '.row') {
  await h.page.goto(h.base + hash);
  await h.page.waitForSelector('.fh', { timeout: 15000 });
  await h.page.waitForSelector(sel, { timeout: 15000 });
}
const finish = async h => { assert.deepEqual(h.misses, [], 'unrecorded requests'); assert.deepEqual(h.errors, [], 'page errors'); await h.close(); };

/** The mocks a signed-in session needs: /user, review threads, and the writes. */
function mockGitHub(h, { threads = null } = {}) {
  let nextId = 9000;
  const gqlThreads = threads || [
    { id: 'PRRT_live', isResolved: false, isOutdated: false, viewerCanResolve: true, viewerCanUnresolve: true, comments: { nodes: [{ databaseId: LIVE_ROOT }] } },
    { id: 'PRRT_targets', isResolved: true, isOutdated: false, viewerCanResolve: true, viewerCanUnresolve: true, comments: { nodes: [{ databaseId: TARGETS_ROOT }] } },
    { id: 'PRRT_old', isResolved: false, isOutdated: true, viewerCanResolve: true, viewerCanUnresolve: true, comments: { nodes: [{ databaseId: OUTDATED_ROOT }] } },
  ];
  h.on('GET', /api\.github\.com\/user$/, () => ({ login: ME.login, name: ME.name, avatar_url: ME.avatar_url }));
  h.on('POST', /api\.github\.com\/graphql/, req => {
    const q = req.json().query;
    if (q.includes('reviewThreads')) return { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: gqlThreads } } } } };
    if (q.includes('resolveReviewThread') || q.includes('unresolveReviewThread')) { const res = !q.includes('unresolveReviewThread'); return { data: { [res ? 'resolveReviewThread' : 'unresolveReviewThread']: { thread: { id: req.json().variables.id, isResolved: res } } } }; }
    return { errors: [{ message: 'unmocked graphql' }] };
  });
  const make = (body, extra) => ({ id: ++nextId, body, user: { login: ME.login, avatar_url: ME.avatar_url }, created_at: new Date().toISOString(), html_url: 'https://github.com/dotnet/runtime/pull/135064#discussion_r' + nextId, side: 'RIGHT', commit_id: HEAD, ...extra });
  h.on('POST', /pulls\/135064\/comments(?: |$)/, req => { const b = req.json(); return { status: 201, json: make(b.body, { path: b.path, line: b.line, side: b.side, start_line: b.start_line || null, start_side: b.start_side || null, original_line: b.line }) }; });
  h.on('POST', /pulls\/135064\/comments\/(\d+)\/replies/, req => { const b = req.json(); return { status: 201, json: make(b.body, { in_reply_to_id: Number(req.url.match(/comments\/(\d+)\/replies/)[1]), path: LINK, line: 273, original_line: 273 }) }; });
  h.on('POST', /pulls\/135064\/reviews/, req => ({ id: 77, state: 'COMMENTED', body: req.json().body }));
}
const signedOut = async h => { assert.equal(await h.page.locator('#who-btn').count(), 0); };

async function loadLinkTask(p) {
  await p.click('#tree .tr[data-path$="LinkTask.cs"]');
  await p.waitForSelector('.fh[data-path$="LinkTask.cs"]');
  await p.waitForFunction(() => document.querySelector('#win .thread'), null, { timeout: 8000 });
}
/** Hover the first commentable line in view and return its data-cl. */
async function firstAddable(p) {
  await p.waitForFunction(() => document.querySelector('#win .row .addc, #win .half .addc'), null, { timeout: 8000 });
  return p.evaluate(() => { const b = document.querySelector('#win .row .addc, #win .half .addc'); return b.closest('[data-cl]').dataset.cl; });
}

// ------------------------------------------------------------------ item 0: the three restored v1 fixes
test('route(): c= and f= from the URL apply to the open PR without reloading it', async () => {
  const h = await start(); const p = h.page;
  await open(h);
  await p.evaluate(() => { window.__marker = 'same page'; window.__st = window.__prview.state; });
  const sha = await p.evaluate(() => window.__prview.state.commits[1].sha.slice(0, 7));
  const before = h.seen.length;
  await p.evaluate(s => { location.hash = '#/dotnet/runtime/pull/135064?c=' + s; }, sha);
  await p.waitForFunction(() => /Commit 2 of 3/.test(document.querySelector('#picker-btn').innerText) && !/…/.test(document.querySelector('#picker-btn').innerText));
  assert.equal(await p.evaluate(() => window.__marker), 'same page', 'no reload');
  assert.ok(await p.evaluate(() => window.__st === window.__prview.state), 'same PR state object');
  assert.ok(!h.seen.slice(before).some(u => /\/pulls\/135064(\?|\/files|\/commits)/.test(u)), 'the PR itself is not fetched again');
  // f= selects a file of that selection
  const file = await p.evaluate(() => window.__prview.state.order[window.__prview.state.order.length - 1].filename);
  await p.evaluate(f => { location.hash = '#/dotnet/runtime/pull/135064?c=' + window.__prview.state.cparam + '&f=' + f; }, file);
  await p.waitForFunction(f => window.__prview.state.selected === f, file);
  assert.ok(await p.locator('#tree .tr.sel').count() === 1);
  // back to everything: c= removed
  await p.evaluate(() => { location.hash = '#/dotnet/runtime/pull/135064'; });
  await p.waitForFunction(() => /^All changes/.test(document.querySelector('#picker-btn').innerText) && document.querySelectorAll('#tree .tr[data-path]').length === 6);
  assert.equal(await p.evaluate(() => window.__marker), 'same page');
  await finish(h);
});

test('merge base: the compare call decides what a range diff starts from', async () => {
  const h = await start(); const p = h.page;
  await open(h);
  const mbUrl = Object.keys(h.rec).find(u => /\/compare\/ffc818ff[0-9a-f]+\.\.\.6724b85[0-9a-f]+\?per_page=1$/.test(u));
  assert.ok(h.seen.includes(mbUrl), 'merge base requested');
  const want = JSON.parse(h.rec[mbUrl].body).merge_base_commit.sha;
  const st = await p.evaluate(() => ({ mb: window.__prview.state.mergeBase, from: window.__prview.state.fromSha, to: window.__prview.state.toSha, base: window.__prview.state.pr.base.sha }));
  assert.equal(st.mb, want); assert.equal(st.from, want); assert.equal(st.to, HEAD);
  // the first commit's range starts at that commit's parent, the whole PR at the merge base
  await p.evaluate(() => { location.hash = '#/dotnet/runtime/pull/135064?c=' + window.__prview.state.commits[1].sha.slice(0, 7); });
  await p.waitForFunction(() => window.__prview.state.range && window.__prview.state.rangeReady && !window.__prview.state.busy);
  assert.equal(await p.evaluate(() => window.__prview.state.fromSha), await p.evaluate(() => window.__prview.state.commits[1].parents[0].sha));
  await finish(h);
});

test('side-by-side: a long line wraps inside its pane (no clipping); inline scrolls', async () => {
  const h = await start(); const p = h.page;
  await open(h, PR + '?f=docs/tools/illink/illink-tasks.md&m=split');
  await p.waitForSelector('.row.split');
  const info = () => p.evaluate(() => {
    const d = document.querySelector('#diff');
    const rows = [...document.querySelectorAll('#win .row.split')].map(r => ({ r, tx: [...r.querySelectorAll('.tx')] }));
    const long = rows.filter(x => x.tx.some(t => t.textContent.length > 300)).map(x => ({ h: x.r.getBoundingClientRect().height, clipped: x.tx.some(t => t.scrollWidth > t.clientWidth + 1 || t.scrollHeight > t.clientHeight + 1), chars: Math.max(...x.tx.map(t => t.textContent.length)) }));
    return { long, hscroll: d.scrollWidth > d.clientWidth + 1 };
  });
  await p.waitForFunction(() => [...document.querySelectorAll('#win .row.split .tx')].some(t => t.textContent.length > 300), null, { timeout: 8000 });
  let r = await info();
  assert.ok(r.long.length >= 1, 'a long changed line is on screen');
  assert.ok(r.long.every(x => x.h > 40), 'long line rows grow: ' + JSON.stringify(r.long));
  assert.ok(r.long.every(x => !x.clipped), 'nothing clipped: ' + JSON.stringify(r.long));
  assert.equal(r.hscroll, false, 'no sideways scrolling in side-by-side');
  await shot(p, 'desktop-side-by-side-wrap');
  await p.click('#m-inline');
  await p.waitForSelector('.row:not(.split)');
  await p.waitForFunction(() => document.querySelector('#diff').scrollWidth > document.querySelector('#diff').clientWidth + 100);
  await finish(h);
});

// ------------------------------------------------------------------ 1. sign in
test('sign in: first-run screen explains the OAuth App, then the device flow runs through the proxy', async () => {
  const h = await start(); const p = h.page;
  let polls = 0;
  h.on('POST', /cors-proxy\.ref12cf\.workers\.dev\/github\.com\/login\/device\/code/, () => ({ device_code: 'DEV123', user_code: 'WDJB-MJHT', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 1 }));
  h.on('POST', /cors-proxy\.ref12cf\.workers\.dev\/github\.com\/login\/oauth\/access_token/, () => (++polls < 2 ? { error: 'authorization_pending' } : { access_token: 'gho_devicetoken', token_type: 'bearer', scope: 'public_repo' }));
  mockGitHub(h);
  await p.goto(h.base);
  assert.equal(await p.locator('#signin-btn').innerText(), 'Sign in');
  await p.click('#signin-btn');
  await p.waitForSelector('#si-cid');
  const txt = await p.locator('#dlg').innerText();
  for (const s of [/Settings → Developer settings → OAuth Apps → New OAuth App/, /Enable Device Flow/, /Client ID/, /public_repo/, /Application name/, /callback/i]) assert.match(txt, s);
  await shot(p, 'signin-first-run');
  await p.fill('#si-cid', 'x'); await p.click('#si-go');
  assert.match(await p.locator('#si-msg').innerText(), /Client ID/);
  await p.fill('#si-cid', 'Ov23liTestClientId01');
  await p.check('input[name=scope][value=public_repo]');
  await p.click('#si-go');
  await p.waitForSelector('#si-code');
  assert.equal(await p.locator('#si-code').innerText(), 'WDJB-MJHT');
  assert.match(await p.locator('#dlg').innerText(), /github\.com\/login\/device/);
  await shot(p, 'signin-device-code');
  const first = h.calls.find(c => /device\/code/.test(c.url));
  assert.match(first.body, /client_id=Ov23liTestClientId01/); assert.match(first.body, /scope=public_repo/);
  await p.waitForSelector('#who-login', { timeout: 15000 });
  assert.equal(await p.locator('#who-login').innerText(), ME.login);
  assert.equal(await p.locator('#who .av').count(), 1);
  const ls = await p.evaluate(() => ({ t: localStorage.getItem('prview.token'), k: localStorage.getItem('prview.auth') }));
  assert.deepEqual(ls, { t: 'gho_devicetoken', k: 'oauth' });
  const tokenCall = h.calls.filter(c => /access_token/.test(c.url));
  assert.ok(tokenCall.length >= 2); assert.match(tokenCall[0].body, /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code/); assert.match(tokenCall[0].body, /device_code=DEV123/);
  // sign out
  await p.click('#who-btn'); await p.click('#signout');
  await p.waitForSelector('#signin-btn');
  assert.equal(await p.evaluate(() => localStorage.getItem('prview.token')), null);
  await finish(h);
});

test('sign in: device flow disabled / proxy refusal are explained', async () => {
  const h = await start({ settings: { clientId: 'Ov23liTestClientId01', scope: 'repo' } }); const p = h.page;
  h.on('POST', /device\/code/, () => ({ error: 'device_flow_disabled', error_description: 'x' }));
  await p.goto(h.base);
  await p.click('#signin-btn');
  await p.click('#si-go');
  await p.waitForSelector('#si-cid');
  assert.match(await p.locator('#dlg').innerText(), /Enable Device Flow/);
  await h.close();
  const h2 = await start({ settings: { clientId: 'Ov23liTestClientId01', scope: 'repo' } });
  h2.on('POST', /device\/code/, () => ({ status: 403, body: 'target host not allowed' }));
  await h2.page.goto(h2.base);
  await h2.page.click('#signin-btn'); await h2.page.click('#si-go');
  await h2.page.waitForSelector('#si-retry');
  assert.match(await h2.page.locator('#dlg').innerText(), /ALLOWED_HOSTS/);
  await h2.close();
});

test('sign in: a pasted token still works (fallback) and shows the signed-in state', async () => {
  const h = await start(); const p = h.page;
  mockGitHub(h);
  await p.goto(h.base);
  await p.click('#settings-btn');
  await p.locator('#dlg summary', { hasText: 'Paste a token' }).click();
  await p.fill('#tok', 'ghp_pasted');
  await p.click('#st-save');
  await p.waitForSelector('#who-login');
  assert.equal(await p.evaluate(() => localStorage.getItem('prview.auth')), 'paste');
  assert.equal(await p.locator('#who-login').innerText(), ME.login);
  await finish(h);
});

// ------------------------------------------------------------------ 2. lists of PRs
const gqlRow = (n, title, o = {}) => ({ number: n, title, url: '', updatedAt: new Date(Date.now() - 3600e3).toISOString(), isDraft: !!o.draft, state: o.state || 'OPEN', merged: !!o.merged, reviewDecision: o.review || null, author: { login: o.author || 'alice', avatarUrl: ME.avatar_url }, repository: { nameWithOwner: o.repo || 'dotnet/runtime' }, commits: { nodes: [{ commit: { statusCheckRollup: o.checks ? { state: o.checks } : null } }] } });

test('home: For me (review requested, authored, assigned, mentioned) with review state and checks', async () => {
  const h = await start({ signedIn: true }); const p = h.page;
  mockGitHub(h);
  const seenQ = [];
  h.on('POST', /graphql .*search\(/, req => {
    const { variables } = req.json(); seenQ.push(variables.q);
    if (/review-requested/.test(variables.q)) return { data: { search: { issueCount: 2, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [gqlRow(101, 'Fix the linker task', { review: 'APPROVED', checks: 'SUCCESS', author: 'sbomer' }), gqlRow(102, 'WIP: draft change', { draft: true, review: 'REVIEW_REQUIRED', checks: 'FAILURE', repo: 'dotnet/sdk' })] } } };
    return { data: { search: { issueCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [gqlRow(7, 'Mine: ' + variables.q.split(' ').find(x => x.includes('@me')), { checks: 'PENDING' })] } } };
  });
  await p.goto(h.base);
  await p.waitForSelector('.prrow');
  assert.equal(await p.locator('#home-tabs a.on').innerText(), 'For me');
  assert.equal(await p.locator('.prrow').count(), 2);
  const t = await p.locator('#home-list').innerText();
  for (const s of [/Fix the linker task/, /#101/, /dotnet\/runtime/, /sbomer/, /Approved/, /Checks passed/, /Draft/, /Review required/, /Checks failed/, /dotnet\/sdk/, /updated 1 hour ago/]) assert.match(t, s);
  assert.equal(await p.locator('.prrow').first().getAttribute('href'), '#/dotnet/runtime/pull/101');
  await shot(p, 'home-for-me');
  for (const [label, frag] of [['Authored by me', 'author:@me'], ['Assigned to me', 'assignee:@me'], ['Mentioned', 'mentions:@me']]) {
    await p.click('.chips >> text=' + label);
    await p.waitForFunction(f => document.querySelector('.prrow .t') && document.querySelector('.prrow .t').textContent.includes(f), frag);
  }
  assert.ok(seenQ[0].includes('is:pr is:open') && seenQ[0].includes('review-requested:@me'));
  assert.ok(seenQ.some(q => q.includes('author:@me')) && seenQ.some(q => q.includes('assignee:@me')) && seenQ.some(q => q.includes('mentions:@me')));
  await finish(h);
});

test('home: a repo (open / closed / merged, filter box, paging) signed in', async () => {
  const h = await start({ signedIn: true }); const p = h.page;
  mockGitHub(h);
  const calls = [];
  h.on('POST', /graphql .*search\(/, req => {
    const { variables } = req.json(); calls.push(variables);
    const page2 = variables.after === 'CUR1';
    return { data: { search: { issueCount: 3, pageInfo: { hasNextPage: !page2, endCursor: page2 ? null : 'CUR1' }, nodes: page2 ? [gqlRow(3, 'Third, merged', { state: 'MERGED', merged: true })] : [gqlRow(1, 'First'), gqlRow(2, 'Second', { state: 'CLOSED' })] } } };
  });
  await p.goto(h.base + '#/?tab=repo&repo=dotnet/runtime');
  await p.waitForSelector('.prrow');
  assert.ok(calls[0].q.startsWith('repo:dotnet/runtime is:pr is:open'), calls[0].q);
  await p.click('#home-ctl >> text=Merged');
  await p.waitForFunction(() => /Third|First/.test(document.querySelector('#home-list').innerText) && document.querySelectorAll('.prrow').length >= 1);
  assert.ok(calls.some(c => /is:merged/.test(c.q)));
  await p.click('#home-ctl >> text=Closed');
  await p.waitForTimeout(100);
  assert.ok(calls.some(c => /is:closed is:unmerged/.test(c.q)));
  await p.click('#home-ctl >> text=All');
  await p.waitForSelector('.prrow');
  await p.fill('#pr-filter', 'linker');
  await p.waitForFunction(() => true); await p.waitForTimeout(600);
  assert.ok(calls.some(c => /linker in:title/.test(c.q) && !/is:open|is:merged|is:closed/.test(c.q)), JSON.stringify(calls.map(c => c.q)));
  await p.fill('#pr-filter', '');
  await p.waitForTimeout(600);
  // paging
  await p.waitForSelector('#pg-next:not([disabled])');
  assert.match(await p.locator('#home-pager').innerText(), /Page 1 · 3 results/);
  await p.click('#pg-next');
  await p.waitForFunction(() => /Third, merged/.test(document.querySelector('#home-list').innerText));
  assert.equal(calls.at(-1).after, 'CUR1');
  assert.match(await p.locator('#home-list').innerText(), /Merged/);
  await shot(p, 'home-repo');
  await p.click('#pg-prev');
  await p.waitForFunction(() => /First/.test(document.querySelector('#home-list').innerText));
  await finish(h);
});

test('home: signed out, a public repo list still works; For me asks to sign in; Recent keeps opened PRs', async () => {
  const h = await start(); const p = h.page;
  const rest = [];
  h.on('GET', /api\.github\.com\/repos\/dotnet\/runtime\/pulls\?state=open/, req => { rest.push(req.url); return [{ number: 55, title: 'Anonymous list row', user: { login: 'bob', avatar_url: ME.avatar_url }, updated_at: new Date().toISOString(), state: 'open', draft: false, merged_at: null }]; });
  h.on('GET', /api\.github\.com\/search\/issues/, req => { rest.push(req.url); return { total_count: 1, items: [{ number: 56, title: 'Merged thing', user: { login: 'carol', avatar_url: ME.avatar_url }, updated_at: new Date().toISOString(), state: 'closed', pull_request: { merged_at: '2026-10-01T00:00:00Z' }, repository_url: 'https://api.github.com/repos/dotnet/runtime' }] }; });
  await p.goto(h.base);
  assert.equal(await p.locator('#home-tabs a.on').innerText(), 'A repo', 'default tab when signed out');
  await p.fill('#repo-in', 'https://github.com/dotnet/runtime'); await p.keyboard.press('Enter');
  await p.waitForSelector('.prrow');
  assert.match(await p.locator('#home-list').innerText(), /Anonymous list row/);
  assert.match(rest[0], /state=open/);
  await p.click('#home-ctl >> text=Merged');
  await p.waitForFunction(() => /Merged thing/.test(document.querySelector('#home-list').innerText));
  assert.match(decodeURIComponent(rest.at(-1)), /repo:dotnet\/runtime is:pr is:merged/);
  assert.match(await p.locator('.prrow .badge').first().innerText(), /Merged/);
  await p.click('#home-tabs >> text=For me');
  assert.match(await p.locator('#home-list').innerText(), /Sign in to see your pull requests/);
  await shot(p, 'home-signed-out');
  // Recent
  await p.goto(h.base + PR); await p.waitForSelector('.fh');
  await p.click('#brand');
  await p.click('#home-tabs >> text=Recent');
  assert.match(await p.locator('#home-list').innerText(), /ILLink task output ownership/);
  assert.equal(await p.locator('.prrow').first().getAttribute('href'), PR);
  await finish(h);
});

// ------------------------------------------------------------------ 3. comments
test('threads render inline in every view mode: inline / side-by-side x all files / one file (also signed out)', async () => {
  for (const [qs, label] of [['', 'inline all'], ['&m=split', 'split all'], ['&v=one', 'inline one'], ['&v=one&m=split', 'split one'], ['&x=1', 'inline full files']]) {
    const h = await start(); const p = h.page;
    await open(h, PR + '?f=' + LINK + qs, '.row');
    await p.waitForSelector('.fh[data-path$="LinkTask.cs"]');
    await p.waitForFunction(() => document.querySelectorAll('#win .thread').length >= 1, null, { timeout: 8000 });
    // the multi-line live thread sits under line 273 ...
    const where = await p.evaluate(() => { const t = [...document.querySelectorAll('#win .thread')].find(x => /lines 269–273/.test(x.innerText)); if (!t) return null; const it = t.closest('.it'); const prev = it.previousElementSibling; return prev && prev.textContent.length > 0 ? prev.querySelector('[data-cl]')?.dataset.cl || prev.querySelector('.half[data-cl]')?.dataset.cl : null; });
    assert.ok(where === null ? false : /^[RL]:/.test(where), label + ': thread box follows its line, got ' + where);
    assert.match(await p.locator('#win .thread').first().innerText(), /Active|Resolved/);
    await finish(h);
  }
});

test('threads: collapsible boxes, outdated list per file, sanitized Markdown', async () => {
  const h = await start(); const p = h.page;
  await open(h, PR + '?f=' + LINK);
  await p.waitForSelector('#win .thread');
  const ol = p.locator('#win .olist button');
  assert.match(await ol.first().innerText(), /Outdated comments \(1\)/);
  await ol.first().click();
  await p.waitForFunction(() => [...document.querySelectorAll('#win .thread')].some(t => /was line 62/.test(t.innerText)));
  await shot(p, 'comments-inline-threads');
  const box = p.locator('#win .thread:not(.old)').first();
  await box.locator('.tcol').click();
  await p.waitForSelector('#win .thread.collapsed');
  await p.locator('#win .thread.collapsed .tcol').first().click();
  await p.waitForFunction(() => !document.querySelector('#win .thread.collapsed'));
  // sanitized: raw HTML in somebody's comment never becomes elements
  await p.evaluate(() => { const s = window.__prview.state; s.comments.push({ id: 5551, in_reply_to_id: 4167554232, body: '<img src=x onerror="window.__xss=1"> <script>window.__xss=2<\/script> **bold** [ok](https://example.com/x) [bad](javascript:alert(1))', user: { login: 'mallory' }, created_at: new Date().toISOString(), path: s.comments[0].path }); });
  await p.evaluate(() => window.dispatchEvent(new Event('resize')));
  await p.keyboard.press('Escape');
  await p.evaluate(() => { const s = window.__prview.state; s.threads = null; });
  await finish(h);
});

test('comments panel lists every thread; jump-to scrolls to the box; filters', async () => {
  const h = await start({ signedIn: true }); const p = h.page; mockGitHub(h);
  await open(h);
  await p.waitForFunction(() => window.__prview.state.threads.length === 3 && window.__prview.state.threads.some(t => t.gid));
  await p.click('#cm-btn');
  await p.waitForSelector('#cpanel .pt');
  assert.equal(await p.locator('#cpanel .pt').count(), 3);
  const t = await p.locator('#cpanel').innerText();
  assert.match(t, /LinkTask\.cs|ILLink\.Tasks\/LinkTask\.cs/); assert.match(t, /Copilot/); assert.match(t, /jtschuster/);
  await p.click('#cpanel [data-pf=resolved]');
  assert.equal(await p.locator('#cpanel .pt').count(), 1);
  await p.click('#cpanel [data-pf=outdated]');
  assert.equal(await p.locator('#cpanel .pt').count(), 1);
  await p.click('#cpanel .pt');
  await p.waitForFunction(() => [...document.querySelectorAll('#win .thread')].some(t => /was line 62/.test(t.innerText)), null, { timeout: 8000 });
  await p.click('#cpanel [data-pf=all]');
  await p.locator('#cpanel .pt', { hasText: 'Copilot' }).click();
  await p.waitForSelector('#win .thread.flash', { timeout: 8000 });
  assert.match(await p.locator('#win .thread.flash').innerText(), /lines 269–273/);
  await shot(p, 'comments-panel');
  await finish(h);
});

test('add a line comment: hover +, composer with Markdown preview, post, see it inline', async () => {
  const h = await start({ signedIn: true }); const p = h.page; mockGitHub(h);
  await open(h);
  await loadLinkTask(p);
  const cl = await firstAddable(p);
  const row = p.locator('#win [data-cl="' + cl + '"]').first();
  await row.hover();
  const plus = row.locator('.addc');
  assert.equal(await plus.evaluate(e => getComputedStyle(e).opacity), '1', 'the + shows on hover');
  await shot(p, 'comment-hover-plus');
  await plus.click();
  await p.waitForSelector('#win .composer textarea');
  assert.ok(await p.evaluate(() => document.activeElement.dataset.fid === 'c'), 'composer is focused');
  await p.fill('#win .composer textarea', 'Looks **risky**: <img src=x onerror="window.__xss=1"> and `code`');
  await p.click('#win .composer [data-tab=preview]');
  const prev = await p.locator('#win .composer .preview').innerHTML();
  assert.match(prev, /<b>risky<\/b>/); assert.match(prev, /<code>code<\/code>/); assert.ok(!/<img/i.test(prev) && /&lt;img/.test(prev), 'raw HTML is shown as text');
  await shot(p, 'comment-composer-preview');
  await p.click('#win .composer [data-tab=write]');
  assert.match(await p.inputValue('#win .composer textarea'), /Looks \*\*risky\*\*/);
  await p.click('#win .composer [data-act=cpost]');
  await p.waitForFunction(() => [...document.querySelectorAll('#win .thread')].some(t => /Looks/.test(t.innerText) && !t.classList.contains('composer')));
  const post = h.calls.find(c => c.method === 'POST' && /pulls\/135064\/comments$/.test(c.url));
  assert.equal(post.body.commit_id, HEAD); assert.equal(post.body.path, LINK);
  assert.equal(post.body.side, cl[0] === 'L' ? 'LEFT' : 'RIGHT'); assert.equal(post.body.line, Number(cl.slice(2)));
  assert.match(post.body.body, /risky/); assert.equal(post.body.start_line, undefined);
  assert.equal(await p.evaluate(() => window.__xss), undefined);
  assert.equal(await p.locator('#win .composer').count(), 0);
  await shot(p, 'comment-posted-inline');
  await finish(h);
});

test('multi-line comment by shift-click and by drag; side-by-side too; start_line / line sent', async () => {
  const h = await start({ signedIn: true }); const p = h.page; mockGitHub(h);
  await open(h, PR + '?f=' + LINK + '&x=1');
  await p.waitForSelector('#win .row');
  await p.waitForFunction(() => document.querySelectorAll('#win .row .addc').length >= 4, null, { timeout: 8000 });
  // consecutive commentable RIGHT lines
  const lines = await p.evaluate(() => [...document.querySelectorAll('#win .row[data-cl^="R:"]')].filter(r => r.querySelector('.addc')).map(r => Number(r.dataset.cl.slice(2))));
  const run = lines.findIndex((n, i) => lines[i + 2] === n + 2 && lines[i + 1] === n + 1);
  assert.ok(run >= 0); const a = lines[run];
  const rowOf = n => p.locator('#win .row[data-cl="R:' + n + '"]');
  await rowOf(a).hover(); await rowOf(a).locator('.addc').click();
  await p.waitForSelector('#win .composer');
  await rowOf(a + 2).hover(); await rowOf(a + 2).locator('.addc').click({ modifiers: ['Shift'] });
  await p.waitForFunction(n => /lines/.test(document.querySelector('#win .composer .th').innerText) && document.querySelectorAll('#win .row.sel').length === 3, a);
  assert.match(await p.locator('#win .composer .th').innerText(), new RegExp('lines ' + a + '–' + (a + 2)));
  await shot(p, 'comment-multiline-shift');
  await p.fill('#win .composer textarea', 'range by shift');
  await p.keyboard.press('Control+Enter');
  await p.waitForFunction(() => h => true);
  await p.waitForFunction(() => [...document.querySelectorAll('#win .thread')].some(t => /range by shift/.test(t.innerText)));
  let post = h.calls.filter(c => /pulls\/135064\/comments$/.test(c.url)).at(-1);
  assert.equal(post.body.start_line, a); assert.equal(post.body.line, a + 2); assert.equal(post.body.start_side, 'RIGHT');
  // by drag
  const b = lines[lines.findIndex((n, i) => n > a + 4 && lines[i + 1] === n + 1)];
  await rowOf(b).hover();
  const box1 = await rowOf(b).locator('.addc').boundingBox();
  await p.mouse.move(box1.x + 5, box1.y + 5); await p.mouse.down();
  const r2 = await rowOf(b + 1).boundingBox();
  await p.mouse.move(r2.x + 300, r2.y + 8, { steps: 5 }); await p.mouse.up();
  await p.waitForSelector('#win .composer');
  assert.match(await p.locator('#win .composer .th').innerText(), new RegExp('lines ' + b + '–' + (b + 1)));
  await p.fill('#win .composer textarea', 'range by drag'); await p.click('#win .composer [data-act=cpost]');
  await p.waitForFunction(() => [...document.querySelectorAll('#win .thread')].some(t => /range by drag/.test(t.innerText)));
  post = h.calls.filter(c => /pulls\/135064\/comments$/.test(c.url)).at(-1);
  assert.equal(post.body.start_line, b); assert.equal(post.body.line, b + 1);
  // side-by-side: same affordance
  await p.click('#m-split'); await p.waitForSelector('.row.split');
  await p.waitForSelector('#win .half .addc', { state: 'attached' });
  const sb = await p.evaluate(() => document.querySelector('#win .half[data-cl^="R:"] .addc').closest('[data-cl]').dataset.cl);
  await p.locator('#win .half[data-cl="' + sb + '"]').first().hover();
  await p.locator('#win .half[data-cl="' + sb + '"] .addc').first().click();
  await p.waitForSelector('#win .composer');
  await p.keyboard.press('Escape');
  await p.waitForFunction(() => !document.querySelector('#win .composer'));
  await finish(h);
});

test('reply to a thread, resolve and unresolve it', async () => {
  const h = await start({ signedIn: true }); const p = h.page; mockGitHub(h);
  await open(h, PR + '?f=' + LINK);
  await p.waitForFunction(() => window.__prview.state.threads.some(t => t.gid));
  await p.waitForSelector('#win .thread');
  const live = p.locator('#win .thread', { hasText: 'lines 269–273' });
  await live.locator('textarea').fill('Thanks, **fixed** in the next push');
  await live.locator('[data-act=reply]').click();
  await p.waitForFunction(() => [...document.querySelectorAll('#win .thread')].some(t => /Thanks, /.test(t.innerText)));
  const rep = h.calls.find(c => /comments\/4167554232\/replies/.test(c.url));
  assert.equal(rep.body.body, 'Thanks, **fixed** in the next push');
  assert.match(await p.locator('#win .thread', { hasText: 'lines 269–273' }).innerText(), /octo-reviewer/);
  await shot(p, 'comment-reply');
  await p.locator('#win .thread', { hasText: 'lines 269–273' }).locator('[data-act=resolve]').click();
  await p.waitForSelector('#win .thread.resolved.collapsed');
  const m = h.calls.filter(c => /graphql/.test(c.url) && /resolveReviewThread/.test(JSON.stringify(c.body)) && !/unresolve/.test(JSON.stringify(c.body)));
  assert.equal(m.length, 1); assert.equal(m[0].body.variables.id, 'PRRT_live');
  await shot(p, 'comment-resolved');
  await p.locator('#win .thread.resolved.collapsed .tcol').first().click();
  await p.locator('#win .thread.resolved [data-act=resolve]').first().click();
  await p.waitForFunction(() => !document.querySelector('#win .thread.resolved'));
  assert.ok(h.calls.some(c => /graphql/.test(c.url) && /unresolveReviewThread/.test(JSON.stringify(c.body))));
  await finish(h);
});

test('batched review: pending comments, then Finish review with Request changes', async () => {
  const h = await start({ signedIn: true }); const p = h.page; mockGitHub(h);
  await open(h);
  await loadLinkTask(p);
  const cl = await firstAddable(p);
  await p.locator('#win [data-cl="' + cl + '"]').first().hover();
  await p.locator('#win [data-cl="' + cl + '"] .addc').first().click();
  await p.fill('#win .composer textarea', 'pending one');
  await p.click('#win .composer [data-act=cpend]');
  await p.waitForSelector('#win .thread.pending');
  assert.equal(h.calls.filter(c => /pulls\/135064\/comments$/.test(c.url)).length, 0, 'nothing posted yet');
  assert.equal(await p.locator('#rv-btn').innerText(), 'Finish review (1)');
  assert.match(await p.locator('#win .thread.pending').innerText(), /Pending/);
  // pending ones survive a reload (localStorage)
  await p.reload(); await p.waitForSelector('#rv-btn');
  assert.equal(await p.locator('#rv-btn').innerText(), 'Finish review (1)');
  await p.click('#rv-btn');
  await p.waitForSelector('#rv-body');
  await shot(p, 'review-finish-dialog');
  await p.fill('#rv-body', 'Please look at the comments');
  await p.check('input[name=rv][value=REQUEST_CHANGES]');
  await p.click('#rv-go');
  await p.waitForFunction(() => /Review submitted/.test(document.querySelector('#banner').innerText));
  const rv = h.calls.find(c => /pulls\/135064\/reviews/.test(c.url));
  assert.equal(rv.body.event, 'REQUEST_CHANGES'); assert.equal(rv.body.body, 'Please look at the comments'); assert.equal(rv.body.commit_id, HEAD);
  assert.equal(rv.body.comments.length, 1); assert.equal(rv.body.comments[0].body, 'pending one'); assert.equal(rv.body.comments[0].path, LINK);
  assert.equal(await p.locator('#rv-btn').innerText(), 'Review');
  await finish(h);
});

test('keyboard c opens a comment on the line under the pointer; signed out it asks to sign in', async () => {
  const h = await start({ signedIn: true }); const p = h.page; mockGitHub(h);
  await open(h);
  await loadLinkTask(p);
  const cl = await firstAddable(p);
  await p.locator('#win [data-cl="' + cl + '"]').first().hover();
  await p.keyboard.press('c');
  await p.waitForSelector('#win .composer textarea');
  assert.match(await p.locator('#win .composer .th').innerText(), new RegExp('line ' + cl.slice(2)));
  assert.ok(await p.evaluate(() => document.activeElement.tagName === 'TEXTAREA'));
  await p.keyboard.type('typed via c'); await p.keyboard.press('Escape');
  await p.waitForFunction(() => !document.querySelector('#win .composer'));
  // c with nothing hovered: the first changed line in view
  await p.mouse.move(5, 5); await p.evaluate(() => { window.__prview.state.hoverCl = null; });
  await p.keyboard.press('c'); await p.waitForSelector('#win .composer');
  await finish(h);
  const o = await start(); await open(o);
  assert.equal(await o.page.locator('#win .addc').count(), 0, 'signed out: no + affordance');
  await o.page.keyboard.press('c');
  await o.page.waitForSelector('#si-cid');
  await o.close();
});

test('write errors are shown in the box and keep the text', async () => {
  const h = await start({ signedIn: true }); const p = h.page; mockGitHub(h);
  h.on('POST', /pulls\/135064\/comments(?: |$)/, () => ({ status: 422, json: { message: 'Validation Failed', errors: [{ message: 'pull_request_review_thread.line must be part of the diff' }] } }));
  await open(h);
  await loadLinkTask(p);
  const cl = await firstAddable(p);
  await p.locator('#win [data-cl="' + cl + '"]').first().hover(); await p.locator('#win [data-cl="' + cl + '"] .addc').first().click();
  await p.fill('#win .composer textarea', 'will fail'); await p.click('#win .composer [data-act=cpost]');
  await p.waitForFunction(() => /must be part of the diff/.test(document.querySelector('#win .composer').innerText));
  assert.equal(await p.inputValue('#win .composer textarea'), 'will fail');
  await finish(h);
});

test('phone: comments panel and composer fit the screen', async () => {
  const h = await start({ viewport: { width: 390, height: 844 }, mobile: true, signedIn: true }); const p = h.page; mockGitHub(h);
  await open(h, PR + '?f=' + LINK);
  await p.waitForSelector('#win .thread');
  await p.waitForFunction(() => window.__prview.state.threads.length === 3);
  await shot(p, 'phone-threads');
  await p.evaluate(() => document.querySelector('#cm-btn').click());
  await p.waitForSelector('#cpanel .pt');
  const b = await p.locator('#cpanel').boundingBox(); assert.ok(b.x >= 0 && b.x + b.width <= 391);
  await shot(p, 'phone-comments-panel');
  assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await finish(h);
});
