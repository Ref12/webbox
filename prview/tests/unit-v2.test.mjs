// Unit tests for the v2 libraries: device flow, review threads, REST/GraphQL write calls, list queries, Markdown safety.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DeviceFlow, AuthError, loadSettings, saveSettings, getSession, setSession, clearSession, DEFAULT_PROXY, GRANT } from '../lib/auth.js';
import { buildThreads, indexThreads, parsePatch, lineInDiff, pendingThread, excerpt, lineRange } from '../lib/threads.js';
import { GitHub, GhError, prQuery, rowFromGraphql, rowFromRest } from '../lib/github.js';
import { mdLite } from '../lib/render.js';
import { parseRepo } from '../lib/home.js';

const mem = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), m }; };
const res = (status, json, headers = {}) => new Response(typeof json === 'string' ? json : JSON.stringify(json), { status, headers });

test('device flow: posts to <proxy>/github.com/..., polls, honours slow_down, returns the token', async () => {
  const calls = [], answers = [{ error: 'authorization_pending' }, { error: 'slow_down', interval: 9 }, { access_token: 'gho_x' }], sleeps = [];
  const f = async (url, init) => { calls.push({ url, init }); return url.endsWith('/device/code') ? res(200, { device_code: 'D', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 }) : res(200, answers.shift()); };
  const flow = new DeviceFlow({ clientId: 'cid', proxy: 'https://p.example/', scope: 'public_repo', fetchImpl: f, sleep: async ms => sleeps.push(ms) });
  const dev = await flow.start();
  assert.equal(dev.user_code, 'ABCD-1234');
  assert.equal(calls[0].url, 'https://p.example/github.com/login/device/code');
  assert.equal(calls[0].init.method, 'POST'); assert.equal(calls[0].init.headers.Accept, 'application/json');
  assert.equal(calls[0].init.body, 'client_id=cid&scope=public_repo');
  assert.equal(await flow.poll(dev), 'gho_x');
  assert.equal(calls[1].url, 'https://p.example/github.com/login/oauth/access_token');
  assert.equal(new URLSearchParams(calls[1].init.body).get('grant_type'), GRANT);
  assert.equal(new URLSearchParams(calls[1].init.body).get('device_code'), 'D');
  assert.deepEqual(sleeps, [5000, 5000, 9000]);
});
test('device flow: errors become readable AuthErrors', async () => {
  const mk = (status, body) => new DeviceFlow({ clientId: 'c', fetchImpl: async () => res(status, body), sleep: async () => {} });
  await assert.rejects(mk(200, { error: 'device_flow_disabled' }).start(), e => e instanceof AuthError && e.code === 'device_flow_disabled' && /Enable Device Flow/.test(e.message));
  await assert.rejects(mk(403, 'target host not allowed').start(), e => e.code === 'proxy' && /ALLOWED_HOSTS/.test(e.message));
  await assert.rejects(new DeviceFlow({ clientId: 'c', fetchImpl: async () => { throw new TypeError('Failed to fetch'); } }).start(), e => e.code === 'network' && /CORS proxy/.test(e.message));
  await assert.rejects(mk(200, { error: 'access_denied' }).poll({ device_code: 'd', interval: 1, expires_in: 900 }), e => e.code === 'access_denied');
  await assert.rejects(mk(200, { error: 'expired_token' }).poll({ device_code: 'd', interval: 1, expires_in: 900 }), e => e.code === 'expired_token');
  assert.throws(() => new DeviceFlow({}), e => e.code === 'no_client_id');
  let n = 0;
  await assert.rejects(new DeviceFlow({ clientId: 'c', fetchImpl: async () => res(200, { error: 'authorization_pending' }), sleep: async () => {} }).poll({ device_code: 'd', interval: 1 }, { isCancelled: () => n++ > 1 }), e => e.code === 'cancelled');
});
test('settings and session storage', () => {
  const s = mem();
  assert.deepEqual(loadSettings(s), { clientId: '', proxy: DEFAULT_PROXY, scope: 'repo' });
  saveSettings({ clientId: ' abc ', proxy: 'https://x.dev/', scope: 'public_repo' }, s);
  assert.deepEqual(loadSettings(s), { clientId: 'abc', proxy: 'https://x.dev', scope: 'public_repo' });
  assert.deepEqual(getSession(s), { token: '', user: null, kind: '' });
  setSession({ token: 't', user: { login: 'me', avatar_url: 'u' }, kind: 'oauth' }, s);
  assert.deepEqual(getSession(s), { token: 't', user: { login: 'me', name: '', avatar: 'u' }, kind: 'oauth' });
  clearSession(s); assert.equal(getSession(s).token, '');
  s.setItem('prview.token', 'old-pasted'); assert.equal(getSession(s).kind, 'paste', 'a v1 token counts as pasted');
});

test('patch hunks decide where a comment can go', () => {
  const h = parsePatch('@@ -10,3 +10,4 @@ x\n a\n-b\n+c\n+d\n e\n@@ -40 +41,2 @@\n+z');
  assert.deepEqual(h, { L: [[10, 12], [40, 40]], R: [[10, 13], [41, 42]] });
  assert.ok(lineInDiff(h, 'RIGHT', 13) && !lineInDiff(h, 'RIGHT', 14) && lineInDiff(h, 'LEFT', 40) && !lineInDiff(h, 'LEFT', 13));
  assert.equal(parsePatch(undefined), null); assert.ok(lineInDiff(null, 'RIGHT', 5));
  assert.deepEqual(lineRange(9, 4), { line: 9, startLine: 4 }); assert.deepEqual(lineRange(4, 4), { line: 4, startLine: null });
});
test('threads: replies grouped, GraphQL state merged, outdated and pending handled', () => {
  const c = (id, extra) => ({ id, body: 'b' + id, path: 'a.cs', side: 'RIGHT', line: 5, created_at: '2026-01-0' + id + 'T00:00:00Z', user: { login: 'u' }, ...extra });
  const comments = [c(1), c(2, { in_reply_to_id: 1 }), c(3, { line: null, original_line: 4 }), c(4, { side: 'LEFT', line: 7, start_line: 6 })];
  const gql = new Map([[1, { id: 'T1', resolved: true, outdated: false, canResolve: true, canUnresolve: true }]]);
  const th = buildThreads(comments, gql);
  assert.equal(th.length, 3);
  assert.equal(th[0].replies.length, 1); assert.ok(th[0].resolved && th[0].gid === 'T1' && th[0].canResolve);
  assert.ok(th[1].outdated && th[1].line === null && th[1].originalLine === 4);
  assert.equal(th[2].startLine, 6);
  const idx = indexThreads([...th, pendingThread({ id: 'p1', path: 'a.cs', line: 9, side: 'RIGHT', body: 'x', at: 'now' })]);
  const e = idx.get('a.cs');
  assert.equal(e.R.get(5).length, 1); assert.equal(e.L.get(7).length, 1); assert.equal(e.R.get(9)[0].pending, true); assert.equal(e.loose.length, 1); assert.equal(e.count, 5);
  assert.equal(excerpt('\n```ts\nhello world\n```', 8), 'hello w…');
});

test('GitHub client: comment, reply, review and GraphQL requests have the right shape', async () => {
  const log = [];
  const f = async (url, init = {}) => {
    log.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null, auth: init.headers && init.headers.Authorization });
    if (url.endsWith('/graphql')) return res(200, { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [{ id: 'T', isResolved: false, isOutdated: true, viewerCanResolve: true, viewerCanUnresolve: false, comments: { nodes: [{ databaseId: 11 }] } }] } } }, resolveReviewThread: { thread: { id: 'T', isResolved: true } } } });
    return res(201, { id: 1 });
  };
  const gh = new GitHub({ token: 'tok', fetchImpl: f }), r = { owner: 'o', repo: 'r', number: 5 };
  await gh.postComment(r, { body: 'hi', commitId: 'abc', path: 'a/b.cs', line: 9, side: 'RIGHT', startLine: 7 });
  assert.deepEqual(log[0], { url: 'https://api.github.com/repos/o/r/pulls/5/comments', method: 'POST', body: { body: 'hi', commit_id: 'abc', path: 'a/b.cs', line: 9, side: 'RIGHT', start_line: 7, start_side: 'RIGHT' }, auth: 'Bearer tok' });
  await gh.postComment(r, { body: 'one', commitId: 'abc', path: 'p', line: 3, side: 'LEFT', startLine: 3 });
  assert.ok(!('start_line' in log[1].body) && log[1].body.side === 'LEFT');
  await gh.replyTo(r, 77, 'yes');
  assert.deepEqual([log[2].url, log[2].body], ['https://api.github.com/repos/o/r/pulls/5/comments/77/replies', { body: 'yes' }]);
  await gh.submitReview(r, { commitId: 'abc', body: 'sum', event: 'REQUEST_CHANGES', comments: [{ path: 'p', body: 'c', line: 4, side: 'RIGHT', startLine: 2, startSide: 'RIGHT' }, { path: 'q', body: 'd', line: 1, side: 'LEFT' }] });
  assert.deepEqual(log[3].body, { commit_id: 'abc', event: 'REQUEST_CHANGES', body: 'sum', comments: [{ path: 'p', body: 'c', line: 4, side: 'RIGHT', start_line: 2, start_side: 'RIGHT' }, { path: 'q', body: 'd', line: 1, side: 'LEFT' }] });
  const t = await gh.reviewThreads(r);
  assert.deepEqual(t.get(11), { id: 'T', resolved: false, outdated: true, canResolve: true, canUnresolve: false });
  await gh.setThreadResolved('T', true);
  const last = log.at(-1); assert.match(last.body.query, /resolveReviewThread/); assert.deepEqual(last.body.variables, { id: 'T' });
  await assert.rejects(new GitHub({ fetchImpl: f }).graphql('{x}'), e => e.kind === 'auth');
});
test('GitHub client: write failures are explained (403 scope, 422 detail, 401)', async () => {
  const mk = (status, body) => new GitHub({ token: 't', fetchImpl: async () => res(status, body) });
  await assert.rejects(mk(403, { message: 'Resource not accessible by integration' }).send('POST', '/x', {}), e => e.kind === 'forbidden' && /scope/.test(e.message));
  await assert.rejects(mk(422, { message: 'Validation Failed', errors: [{ message: 'line must be part of the diff' }] }).send('POST', '/x', {}), e => e.kind === 'invalid' && /part of the diff/.test(e.message));
  await assert.rejects(mk(401, { message: 'Bad credentials' }).json('/user'), e => e.kind === 'auth');
});
test('PR lists: queries, GraphQL and REST rows, paging cursors', async () => {
  assert.equal(prQuery({ kind: 'review' }), 'is:pr is:open archived:false review-requested:@me');
  assert.equal(prQuery({ kind: 'authored' }), 'is:pr is:open archived:false author:@me');
  assert.equal(prQuery({ kind: 'repo', repo: 'o/r', state: 'merged', text: ' fix ' }), 'repo:o/r is:pr is:merged fix in:title');
  assert.equal(prQuery({ kind: 'repo', repo: 'o/r', state: 'closed' }), 'repo:o/r is:pr is:closed is:unmerged');
  assert.equal(prQuery({ kind: 'repo', repo: 'o/r', state: 'all' }), 'repo:o/r is:pr');
  const row = rowFromGraphql({ number: 3, title: 'T', updatedAt: 'x', isDraft: true, state: 'CLOSED', merged: true, reviewDecision: 'APPROVED', author: { login: 'a', avatarUrl: 'u' }, repository: { nameWithOwner: 'o/r' }, commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] } });
  assert.deepEqual([row.owner, row.repo, row.state, row.review, row.checks, row.draft], ['o', 'r', 'merged', 'APPROVED', 'FAILURE', true]);
  assert.equal(rowFromRest({ number: 1, title: 't', state: 'closed', pull_request: { merged_at: null }, repository_url: 'https://api.github.com/repos/o/r', user: { login: 'x' } }).state, 'closed');
  const urls = [];
  const gh = new GitHub({ fetchImpl: async u => { urls.push(u); return res(200, { total_count: 45, items: [{ number: 1, title: 't', state: 'open', pull_request: {}, repository_url: 'https://api.github.com/repos/o/r', user: { login: 'x' } }] }); } });
  const p1 = await gh.searchPrs('repo:o/r is:pr', { per: 20 });
  assert.equal(p1.next, '2'); assert.match(urls[0], /search\/issues\?q=repo%3Ao%2Fr%20is%3Apr&sort=updated&order=desc&per_page=20&page=1/);
  assert.equal((await gh.searchPrs('q', { per: 20, cursor: '3' })).next, null);
  assert.equal(parseRepo('https://github.com/dotnet/runtime/pulls'), 'dotnet/runtime'); assert.equal(parseRepo('a/b'), 'a/b'); assert.equal(parseRepo('nope'), null);
});

test('Markdown: raw HTML and unsafe links never become elements', () => {
  const html = mdLite('<img src=x onerror=alert(1)> <script>x()</script> [a](javascript:alert(1)) [b](https://ok.example/p?q=1&r=2) `<b>` **<i>x</i>** > not quote\n\n> quoted <u>\n\n```suggestion\n<b>new</b>\n```');
  assert.ok(!/<img|<script|<u>|<i>x|href="javascript/i.test(html), html);
  assert.match(html, /&lt;img/); assert.match(html, /href="https:\/\/ok\.example\/p\?q=1&amp;r=2" target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /<blockquote>quoted &lt;u&gt;<\/blockquote>/); assert.match(html, /<pre class="suggestion"><i>Suggested change<\/i>\n&lt;b&gt;new&lt;\/b&gt;<\/pre>/);
});
