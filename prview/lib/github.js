// GitHub REST client for the viewer: anonymous or with a pasted token, rate limit aware.

export class GhError extends Error {
  constructor(kind, message, extra = {}) { super(message); this.kind = kind; Object.assign(this, extra); }
}

const API = 'https://api.github.com';
const RAW = 'https://raw.githubusercontent.com';

export class GitHub {
  constructor({ token = '', fetchImpl = (...a) => fetch(...a), onRate = () => {} } = {}) {
    this.token = token; this.fetch = fetchImpl; this.onRate = onRate;
    this.rate = null; this.requests = 0; this.cache = new Map();
  }

  headers(accept) {
    const h = { Accept: accept || 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (this.token) h.Authorization = 'Bearer ' + this.token;
    return h;
  }

  noteRate(res) {
    const rem = res.headers.get('x-ratelimit-remaining');
    if (rem === null) return;
    this.rate = { remaining: Number(rem), limit: Number(res.headers.get('x-ratelimit-limit')), reset: Number(res.headers.get('x-ratelimit-reset')) * 1000, authed: !!this.token };
    this.onRate(this.rate);
  }

  async request(url, accept, init = {}) {
    this.requests++;
    let res;
    try { res = await this.fetch(url, { ...init, headers: { ...this.headers(accept), ...(init.headers || {}) } }); }
    catch (e) { throw new GhError('net', 'Network error: ' + (e.message || e)); }
    this.noteRate(res);
    if (res.ok) return res;
    let msg = '';
    try { msg = (await res.clone().json()).message || ''; } catch { /* not json */ }
    const remaining = res.headers.get('x-ratelimit-remaining');
    if ((res.status === 403 || res.status === 429) && (remaining === '0' || /rate limit/i.test(msg))) {
      const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000 || 0;
      throw new GhError('rate', this.token ? 'GitHub API rate limit reached.' : 'GitHub API rate limit reached (60 requests per hour without a token).', { status: res.status, reset, authed: !!this.token });
    }
    if (res.status === 401) throw new GhError('auth', 'GitHub rejected the token (401). Sign in again or check the token in Settings.', { status: 401 });
    if (res.status === 403 && this.token && init.method && init.method !== 'GET') throw new GhError('forbidden', 'GitHub refused this change (403' + (msg ? ': ' + msg : '') + '). The sign-in needs the "repo" scope (or "public_repo" for public repositories) and write access.', { status: 403 });
    if (res.status === 422) {
      let detail = msg;
      try { const j = await res.clone().json(); if (j.errors && j.errors.length) detail += ' — ' + j.errors.map(e => typeof e === 'string' ? e : (e.message || e.code || JSON.stringify(e))).join('; '); } catch { /* no details */ }
      throw new GhError('invalid', 'GitHub could not use that: ' + (detail || '422'), { status: 422 });
    }
    if (res.status === 404) throw new GhError('notfound', this.token ? 'Not found. The token may lack access to this repository.' : 'Not found. For a private repository, add a token in Settings.', { status: 404 });
    throw new GhError('http', 'GitHub returned ' + res.status + (msg ? ': ' + msg : ''), { status: res.status });
  }

  async json(path, accept) { return (await this.request(path.startsWith('http') ? path : API + path, accept)).json(); }

  /** JSON request with a body (POST/PATCH/PUT/DELETE) to the REST API. */
  async send(method, path, body) {
    const res = await this.request(API + path, undefined, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return res.status === 204 ? null : res.json();
  }

  /** GraphQL (needs a token). Throws GhError on transport or GraphQL errors. */
  async graphql(query, variables = {}) {
    if (!this.token) throw new GhError('auth', 'Sign in to use this.');
    const res = await this.request(API + '/graphql', undefined, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }) });
    const j = await res.json();
    if (j.errors && j.errors.length && !j.data) throw new GhError('http', 'GitHub GraphQL: ' + j.errors.map(e => e.message).join('; '));
    if (j.errors && j.errors.length) j.data.__errors = j.errors;
    return j.data;
  }

  user() { return this.json('/user'); }

  cached(key, fn) { if (!this.cache.has(key)) this.cache.set(key, fn().catch(e => { this.cache.delete(key); throw e; })); return this.cache.get(key); }

  async paged(path, { max = 30, per = 100 } = {}) {
    const out = [];
    for (let page = 1; page <= max; page++) {
      const part = await this.json(path + (path.includes('?') ? '&' : '?') + 'per_page=' + per + '&page=' + page);
      out.push(...part);
      if (part.length < per) break;
    }
    return out;
  }

  repo(r) { return '/repos/' + r.owner + '/' + r.repo; }
  pr(r) { return this.cached('pr', () => this.json(this.repo(r) + '/pulls/' + r.number)); }
  prFiles(r) { return this.cached('files', () => this.paged(this.repo(r) + '/pulls/' + r.number + '/files', { max: 30 })); }
  prCommits(r) { return this.cached('commits', () => this.paged(this.repo(r) + '/pulls/' + r.number + '/commits', { max: 3 })); }
  prComments(r) { return this.cached('comments', () => this.paged(this.repo(r) + '/pulls/' + r.number + '/comments', { max: 10 })); }
  issueComments(r) { return this.cached('icomments', () => this.paged(this.repo(r) + '/issues/' + r.number + '/comments', { max: 3 })); }

  /** The commit a PR really branches from (what GitHub diffs against). */
  async mergeBase(r, base, head) {
    const c = await this.cached('mb:' + base + '...' + head, () => this.json(this.repo(r) + '/compare/' + base + '...' + head + '?per_page=1'));
    return c.merge_base_commit && c.merge_base_commit.sha;
  }

  /** Files changed between two commits (three-dot, like a PR). */
  compare(r, base, head) {
    return this.cached('cmp:' + base + '...' + head, async () => {
      const c = await this.json(this.repo(r) + '/compare/' + base + '...' + head + '?per_page=100');
      c.files = c.files || [];
      // compare returns at most 300 files per call over 100 per page; fetch the rest when there are more
      for (let page = 2; c.files.length >= (page - 1) * 100 && page <= 3; page++) {
        const more = await this.json(this.repo(r) + '/compare/' + base + '...' + head + '?per_page=100&page=' + page);
        if (!more.files || !more.files.length) break;
        c.files.push(...more.files);
      }
      return c;
    });
  }

  // ---- writing review comments (needs a token with the repo / public_repo scope)
  /** One line comment (or a multi-line one with startLine). side: 'RIGHT' | 'LEFT'. */
  postComment(r, { body, commitId, path, line, side = 'RIGHT', startLine, startSide }) {
    const b = { body, commit_id: commitId, path, line, side };
    if (startLine && startLine !== line) { b.start_line = startLine; b.start_side = startSide || side; }
    return this.send('POST', this.repo(r) + '/pulls/' + r.number + '/comments', b);
  }
  replyTo(r, commentId, body) { return this.send('POST', this.repo(r) + '/pulls/' + r.number + '/comments/' + commentId + '/replies', { body }); }
  /** A review with its comments in one request. event: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES'. */
  submitReview(r, { commitId, body, event, comments }) {
    const b = { commit_id: commitId, event, comments: comments.map(c => { const o = { path: c.path, body: c.body, line: c.line, side: c.side || 'RIGHT' }; if (c.startLine && c.startLine !== c.line) { o.start_line = c.startLine; o.start_side = c.startSide || o.side; } return o; }) };
    if (body) b.body = body;
    return this.send('POST', this.repo(r) + '/pulls/' + r.number + '/reviews', b);
  }
  /** Review threads (id, resolved state) keyed by the id of their first comment. Signed in only. */
  async reviewThreads(r) {
    const q = 'query($o:String!,$r:String!,$n:Int!,$after:String){repository(owner:$o,name:$r){pullRequest(number:$n){reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor}nodes{id isResolved isOutdated viewerCanResolve viewerCanUnresolve comments(first:1){nodes{databaseId}}}}}}}';
    const out = new Map();
    let after = null;
    for (let i = 0; i < 10; i++) {
      const d = await this.graphql(q, { o: r.owner, r: r.repo, n: r.number, after });
      const rt = d.repository.pullRequest.reviewThreads;
      for (const t of rt.nodes) { const c = t.comments.nodes[0]; if (c) out.set(c.databaseId, { id: t.id, resolved: t.isResolved, outdated: t.isOutdated, canResolve: t.viewerCanResolve, canUnresolve: t.viewerCanUnresolve }); }
      if (!rt.pageInfo.hasNextPage) break;
      after = rt.pageInfo.endCursor;
    }
    return out;
  }
  async setThreadResolved(threadId, resolved) {
    const m = resolved ? 'resolveReviewThread' : 'unresolveReviewThread';
    const d = await this.graphql('mutation($id:ID!){' + m + '(input:{threadId:$id}){thread{id isResolved}}}', { id: threadId });
    return d[m].thread;
  }

  // ---- lists of pull requests
  /** One page of PRs for a search string. Signed in: GraphQL (review decision and checks come along); otherwise the REST search API.
   *  Returns { rows, total, next } where next is a cursor/page for the following page or null. */
  async searchPrs(q, { per = 20, cursor = null } = {}) {
    if (this.token) {
      const gq = 'query($q:String!,$per:Int!,$after:String){search(query:$q,type:ISSUE,first:$per,after:$after){issueCount pageInfo{hasNextPage endCursor}nodes{... on PullRequest{number title url updatedAt isDraft state merged reviewDecision author{login avatarUrl} repository{nameWithOwner} commits(last:1){nodes{commit{statusCheckRollup{state}}}}}}}}';
      try {
        const d = await this.graphql(gq, { q: q + ' sort:updated-desc', per, after: cursor });
        const s = d.search;
        return { rows: s.nodes.filter(n => n && n.number).map(rowFromGraphql), total: s.issueCount, next: s.pageInfo.hasNextPage ? s.pageInfo.endCursor : null };
      } catch (e) { if (e.kind === 'rate' || e.kind === 'net') throw e; /* fall back to REST search below */ }
    }
    const page = cursor ? Number(cursor) : 1;
    const j = await this.json('/search/issues?q=' + encodeURIComponent(q) + '&sort=updated&order=desc&per_page=' + per + '&page=' + page);
    return { rows: j.items.filter(i => i.pull_request).map(rowFromRest), total: j.total_count, next: page * per < Math.min(j.total_count, 1000) ? String(page + 1) : null };
  }
  /** Same shape for the pulls list of one repository (no filter text), anonymous friendly. */
  async repoPrs(r, state, { per = 20, page = 1 } = {}) {
    const j = await this.json(this.repo(r) + '/pulls?state=' + (state === 'open' ? 'open' : 'closed') + '&sort=updated&direction=desc&per_page=' + per + '&page=' + page);
    return { rows: j.map(p => rowFromRest({ ...p, pull_request: { merged_at: p.merged_at }, repository_url: 'https://api.github.com/repos/' + r.owner + '/' + r.repo })), total: null, next: j.length === per ? String(page + 1) : null };
  }

  /** Text of a file at a commit, or null when it does not exist there. Public repos use raw.githubusercontent (no API quota). */
  fileText(r, path, sha) {
    return this.cached('file:' + sha + ':' + path, async () => {
      if (!this.token) {
        const url = RAW + '/' + r.owner + '/' + r.repo + '/' + sha + '/' + path.split('/').map(encodeURIComponent).join('/');
        this.requests++;
        let res;
        try { res = await this.fetch(url); } catch (e) { throw new GhError('net', 'Network error: ' + (e.message || e)); }
        if (res.status === 404) return null;
        if (!res.ok) throw new GhError('http', 'Could not load ' + path + ' (' + res.status + ')', { status: res.status });
        return res.text();
      }
      const url = API + this.repo(r) + '/contents/' + path.split('/').map(encodeURIComponent).join('/') + '?ref=' + sha;
      try { return await (await this.request(url, 'application/vnd.github.raw+json')).text(); }
      catch (e) { if (e.kind === 'notfound') return null; throw e; }
    });
  }
}

/** One list row, whichever API it came from. state: open | closed | merged; review / checks may be null. */
export function rowFromGraphql(n) {
  const [owner, repo] = n.repository.nameWithOwner.split('/');
  const roll = n.commits && n.commits.nodes[0] && n.commits.nodes[0].commit.statusCheckRollup;
  return { owner, repo, number: n.number, title: n.title, author: n.author ? n.author.login : 'ghost', avatar: n.author ? n.author.avatarUrl : '', updatedAt: n.updatedAt, draft: !!n.isDraft,
    state: n.merged ? 'merged' : n.state === 'CLOSED' ? 'closed' : 'open', review: n.reviewDecision || null, checks: roll ? roll.state : null };
}
export function rowFromRest(i) {
  const m = String(i.repository_url || '').match(/repos\/([^/]+)\/([^/]+)$/) || [];
  return { owner: m[1], repo: m[2], number: i.number, title: i.title, author: i.user ? i.user.login : 'ghost', avatar: i.user ? i.user.avatar_url : '', updatedAt: i.updated_at, draft: !!i.draft,
    state: i.pull_request && i.pull_request.merged_at ? 'merged' : i.state === 'closed' ? 'closed' : 'open', review: null, checks: null };
}
/** The search string for a home view. kind: me:<review|authored|assigned|mentioned> or repo. */
export function prQuery({ kind, repo, state = 'open', text = '' }) {
  const t = String(text || '').trim();
  const words = t ? ' ' + t + ' in:title' : '';
  if (kind === 'repo') {
    const st = state === 'open' ? 'is:open' : state === 'merged' ? 'is:merged' : state === 'closed' ? 'is:closed is:unmerged' : '';
    return ('repo:' + repo + ' is:pr ' + st + words).replace(/\s+/g, ' ').trim();
  }
  const f = { review: 'review-requested:@me', authored: 'author:@me', assigned: 'assignee:@me', mentioned: 'mentions:@me' }[kind] || 'review-requested:@me';
  return ('is:pr is:open archived:false ' + f + words).replace(/\s+/g, ' ').trim();
}

const BINARY = /\.(png|jpe?g|gif|webp|bmp|ico|icns|tiff?|psd|pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|war|nupkg|dll|exe|so|dylib|a|lib|o|obj|class|pdb|wasm|bin|dat|woff2?|ttf|otf|eot|mp[34]|mov|avi|webm|ogg|wav|flac|sqlite|db|pfx|snk|snupkg)$/i;
const GENERATED = [/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|Gemfile\.lock|poetry\.lock|composer\.lock|packages\.lock\.json|go\.sum)$/, /\.min\.(js|css)$/, /\.(designer|g|g\.i)\.cs$/i, /(^|\/)(dist|vendor|node_modules|__snapshots__)\//, /\.(pb\.go|snap|map)$/, /\.generated\./i, /\.lock$/];

/** Why a file is not loaded by default: 'binary' | 'generated' | 'large' | null. */
export function skipReason(file) {
  if (BINARY.test(file.filename)) return 'binary';
  if (GENERATED.some(re => re.test(file.filename))) return 'generated';
  if ((file.additions || 0) + (file.deletions || 0) > 6000) return 'large';
  if (file.status !== 'added' && file.status !== 'removed' && file.status !== 'renamed' && !file.patch && file.changes > 0) return 'large';
  return null;
}
