// Review threads: group REST comments into threads, merge GraphQL state (resolved, thread id) and local pending comments,
// index them per file and line, and know which lines of a file can take a new comment (those inside the diff hunks).

/** '@@ -a,b +c,d @@' hunks of a file's patch -> { L: [[from,to]], R: [[from,to]] } (1-based, inclusive), or null without a patch. */
export function parsePatch(patch) {
  if (!patch) return null;
  const L = [], R = [];
  for (const m of String(patch).matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    const a = +m[1], b = m[2] === undefined ? 1 : +m[2], c = +m[3], d = m[4] === undefined ? 1 : +m[4];
    if (b) L.push([a, a + b - 1]);
    if (d) R.push([c, c + d - 1]);
  }
  return { L, R };
}
/** Can GitHub attach a comment to this line? Unknown patch (null) allows everything and lets the API decide. */
export function lineInDiff(hunks, side, line) {
  if (!hunks) return true;
  return (side === 'LEFT' ? hunks.L : hunks.R).some(([a, b]) => line >= a && line <= b);
}

/** REST review comments (+ optional Map root comment id -> {id, resolved, outdated, canResolve, canUnresolve}) -> threads, oldest first. */
export function buildThreads(comments, gql) {
  const roots = new Map();
  for (const c of comments || []) if (!c.in_reply_to_id) roots.set(c.id, { id: c.id, root: c, replies: [] });
  for (const c of comments || []) if (c.in_reply_to_id && roots.has(c.in_reply_to_id)) roots.get(c.in_reply_to_id).replies.push(c);
  const out = [];
  for (const t of roots.values()) {
    const c = t.root, g = gql && gql.get(c.id);
    t.replies.sort((x, y) => (x.created_at < y.created_at ? -1 : 1));
    out.push({
      ...t, path: c.path, line: c.line || null, startLine: c.start_line || null, side: c.side || 'RIGHT', startSide: c.start_side || c.side || 'RIGHT',
      outdated: !c.line || !!(g && g.outdated), resolved: !!(g && g.resolved), gid: g ? g.id : null, canResolve: !!(g && (g.resolved ? g.canUnresolve : g.canResolve)),
      pending: false, originalLine: c.original_line || null,
    });
  }
  return out.sort((a, b) => (a.root.created_at < b.root.created_at ? -1 : 1));
}

/** A pending (not yet submitted) comment as a thread-shaped object. p: {id, path, line, side, startLine, startSide, body, user, at} */
export function pendingThread(p) {
  const root = { id: p.id, body: p.body, user: p.user || null, created_at: p.at, path: p.path, html_url: '' };
  return { id: p.id, root, replies: [], path: p.path, line: p.line, startLine: p.startLine || null, side: p.side, startSide: p.startSide || p.side, outdated: false, resolved: false, gid: null, canResolve: false, pending: true, originalLine: null };
}

/** Per path: { R: Map(line -> threads), L: Map(line -> threads), loose: threads without a line in the diff, count }. */
export function indexThreads(threads) {
  const idx = new Map();
  for (const t of threads) {
    let e = idx.get(t.path);
    if (!e) idx.set(t.path, e = { R: new Map(), L: new Map(), loose: [], count: 0 });
    e.count += 1 + t.replies.length;
    if (t.line && !t.outdated) {
      const m = t.side === 'LEFT' ? e.L : e.R;
      if (!m.has(t.line)) m.set(t.line, []);
      m.get(t.line).push(t);
    } else e.loose.push(t);
  }
  return idx;
}

/** Text shown for a thread in lists: first non-empty line, cut. */
export function excerpt(body, n = 90) {
  const l = String(body || '').split(/\r?\n/).map(s => s.trim()).find(s => s && !/^```/.test(s)) || '';
  return l.length > n ? l.slice(0, n - 1) + '…' : l;
}

/** The selection a click or drag makes: both ends on one side, ordered. -> { line, startLine|null } */
export function lineRange(a, b) { const lo = Math.min(a, b), hi = Math.max(a, b); return { line: hi, startLine: lo === hi ? null : lo }; }
