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

  async request(url, accept) {
    this.requests++;
    let res;
    try { res = await this.fetch(url, { headers: this.headers(accept) }); }
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
    if (res.status === 401) throw new GhError('auth', 'GitHub rejected the token (401). Check it in Settings.', { status: 401 });
    if (res.status === 404) throw new GhError('notfound', this.token ? 'Not found. The token may lack access to this repository.' : 'Not found. For a private repository, add a token in Settings.', { status: 404 });
    throw new GhError('http', 'GitHub returned ' + res.status + (msg ? ': ' + msg : ''), { status: res.status });
  }

  async json(path, accept) { return (await this.request(path.startsWith('http') ? path : API + path, accept)).json(); }

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
