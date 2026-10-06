// Parsing what people paste: github.com PR URLs, owner/repo#n, and the app's own #/owner/repo/pull/n routes.

const NAME = '[A-Za-z0-9_.-]+';

export function parsePrRef(input) {
  if (!input) return null;
  let s = String(input).trim();
  let m = s.match(new RegExp('^(?:https?://)?(?:www\\.)?github\\.com/(' + NAME + ')/(' + NAME + ')/pull/(\\d+)(?:[/?#].*)?$', 'i'));
  if (!m) m = s.match(new RegExp('^(' + NAME + ')/(' + NAME + ')#(\\d+)$'));
  if (!m) m = s.match(new RegExp('^/?(' + NAME + ')/(' + NAME + ')/pull/(\\d+)/?$'));
  if (!m) { // a pasted link to the viewer itself
    const h = s.indexOf('#');
    if (h >= 0) return parseRoute(s.slice(h)).ref;
    return null;
  }
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}

/** '#/o/r/pull/5?f=src/a.cs&c=abc..def&m=split' -> {ref, params} */
export function parseRoute(hash) {
  const h = String(hash || '').replace(/^#/, '');
  const [path, query = ''] = h.split('?');
  const m = path.match(new RegExp('^/(' + NAME + ')/(' + NAME + ')/pull/(\\d+)(?:/(\\w+))?/?$'));
  const params = {};
  for (const [k, v] of new URLSearchParams(query)) params[k] = v;
  if (!m) return { ref: null, params };
  return { ref: { owner: m[1], repo: m[2], number: Number(m[3]) }, tab: m[4] || 'files', params };
}

export function toRoute(ref, params = {}, tab) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, v);
  const qs = q.toString();
  return '#/' + ref.owner + '/' + ref.repo + '/pull/' + ref.number + (tab && tab !== 'files' ? '/' + tab : '') + (qs ? '?' + qs.replace(/%2F/gi, '/') : '');
}

export function githubUrl(ref) { return 'https://github.com/' + ref.owner + '/' + ref.repo + '/pull/' + ref.number; }
