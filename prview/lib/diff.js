// Line diff (Myers), word diff and the row layout used by the viewer. Pure functions, no DOM.

export function splitLines(text) {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Changed regions between two arrays: [{a0,a1,b0,b1}] (half open). Everything between regions is equal. */
export function diffBlocks(a, b, maxD = 1500) {
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length, eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const n = ea - s, m = eb - s;
  if (n === 0 && m === 0) return [];
  if (n === 0 || m === 0) return [{ a0: s, a1: ea, b0: s, b1: eb }];
  const ids = new Map();
  const id = x => { let v = ids.get(x); if (v === undefined) { v = ids.size; ids.set(x, v); } return v; };
  const A = new Int32Array(n), B = new Int32Array(m);
  for (let i = 0; i < n; i++) A[i] = id(a[s + i]);
  for (let j = 0; j < m; j++) B[j] = id(b[s + j]);
  const dmax = Math.min(n + m, maxD), off = dmax + 1;
  let v = new Int32Array(2 * dmax + 3);
  const trace = [];
  let found = -1;
  for (let d = 0; d <= dmax && found < 0; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && A[x] === B[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
  }
  if (found < 0) return [{ a0: s, a1: ea, b0: s, b1: eb }]; // too different: one big replace
  const delA = new Uint8Array(n), addB = new Uint8Array(m);
  let x = n, y = m;
  for (let d = found; d > 0; d--) {
    const vp = trace[d], k = x - y;
    const pk = (k === -d || (k !== d && vp[off + k - 1] < vp[off + k + 1])) ? k + 1 : k - 1;
    const px = vp[off + pk], py = px - pk;
    if (pk === k + 1) addB[py] = 1; else delA[px] = 1; // the snake before (x,y) is equal lines
    x = px; y = py;
  }
  const blocks = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if ((i < n && delA[i]) || (j < m && addB[j])) {
      const i0 = i, j0 = j;
      while (i < n && delA[i]) i++;
      while (j < m && addB[j]) j++;
      blocks.push({ a0: s + i0, a1: s + i, b0: s + j0, b1: s + j });
    } else { i++; j++; }
  }
  return blocks;
}

export function diffFile(aText, bText) {
  const a = splitLines(aText), b = splitLines(bText);
  const blocks = diffBlocks(a, b);
  let add = 0, del = 0;
  for (const k of blocks) { del += k.a1 - k.a0; add += k.b1 - k.b0; }
  return { a, b, blocks, add, del, segs: segments(a.length, b.length, blocks) };
}

export function segments(aLen, bLen, blocks) {
  const segs = [];
  let i = 0, j = 0;
  for (const k of blocks) {
    if (k.a0 > i) segs.push({ t: 'eq', a: i, b: j, n: k.a0 - i });
    segs.push({ t: 'chg', a0: k.a0, a1: k.a1, b0: k.b0, b1: k.b1 });
    i = k.a1; j = k.b1;
  }
  if (i < aLen) segs.push({ t: 'eq', a: i, b: j, n: aLen - i });
  return segs;
}

/**
 * Rows to draw. mode 'inline' | 'split'. ctx: unchanged lines kept around changes (Infinity = whole file).
 * expand: { [segIndex]: {up, down} } extra lines revealed in a collapsed run.
 * Rows: {k:'eq',a,b} {k:'del',a} {k:'add',b} {k:'pair',a,b} (a or b may be null) {k:'gap',id,count,up,down,a,b}.
 * The first row of every changed block carries first:true (used for next/previous change).
 */
export function layoutRows(segs, { mode = 'inline', ctx = 3, expand = {}, pin = null } = {}) {
  const rows = [];
  if (!segs.some(s => s.t === 'chg')) return rows;
  segs.forEach((s, si) => {
    if (s.t === 'eq') {
      const isFirst = si === 0, isLast = si === segs.length - 1;
      const ex = expand[si] || { up: 0, down: 0 };
      let h = isFirst ? 0 : ctx, t = isLast ? 0 : ctx;
      if (ctx !== Infinity) { h += ex.down; t += ex.up; }
      const count = s.n - h - t;
      // a run holding a pinned line (one with a review comment) is shown whole
      const pinned = pin && count > 1 && ((() => { for (const b of pin.b) if (b >= s.b && b < s.b + s.n) return true; for (const a of pin.a) if (a >= s.a && a < s.a + s.n) return true; return false; })());
      if (ctx === Infinity || count <= 1 || pinned) {
        for (let i = 0; i < s.n; i++) rows.push({ k: 'eq', a: s.a + i, b: s.b + i });
      } else {
        for (let i = 0; i < h; i++) rows.push({ k: 'eq', a: s.a + i, b: s.b + i });
        rows.push({ k: 'gap', id: si, count, up: !isLast, down: !isFirst, a: s.a + h, b: s.b + h });
        for (let i = s.n - t; i < s.n; i++) rows.push({ k: 'eq', a: s.a + i, b: s.b + i });
      }
    } else {
      const nd = s.a1 - s.a0, na = s.b1 - s.b0;
      const start = rows.length;
      if (mode === 'split') {
        for (let i = 0; i < Math.max(nd, na); i++) rows.push({ k: 'pair', a: i < nd ? s.a0 + i : null, b: i < na ? s.b0 + i : null });
      } else {
        const np = Math.min(nd, na); // del i and add i are shown as a changed line: word level diff between them
        for (let i = 0; i < nd; i++) rows.push({ k: 'del', a: s.a0 + i, w: i < np ? [s.a0 + i, s.b0 + i] : null });
        for (let i = 0; i < na; i++) rows.push({ k: 'add', b: s.b0 + i, w: i < np ? [s.a0 + i, s.b0 + i] : null });
      }
      rows[start].first = true;
    }
  });
  return rows;
}

const TOKEN = /[A-Za-z0-9_]+|\s+|[^\sA-Za-z0-9_]/g;

/** Word level changes between two lines: {a:[[start,end]], b:[[start,end]]} as character ranges, or null when not worth it. */
export function wordDiff(x, y) {
  if (x.length > 1000 || y.length > 1000) return null;
  const tx = x.match(TOKEN) || [], ty = y.match(TOKEN) || [];
  if (tx.length > 400 || ty.length > 400) return null;
  const blocks = diffBlocks(tx, ty, 300);
  const pos = t => { const p = [0]; for (const s of t) p.push(p[p.length - 1] + s.length); return p; };
  const px = pos(tx), py = pos(ty);
  const ra = [], rb = [];
  let same = 0;
  for (const k of blocks) {
    if (k.a1 > k.a0) ra.push([px[k.a0], px[k.a1]]);
    if (k.b1 > k.b0) rb.push([py[k.b0], py[k.b1]]);
  }
  for (const [s, e] of ra) same += e - s;
  // lines that share almost nothing read better as whole-line changes
  if (x.length && y.length && same > x.length * 0.8 && ra.length && rb.length && x.trim() !== '' && y.trim() !== '') {
    const sameB = rb.reduce((n, [s, e]) => n + e - s, 0);
    if (sameB > y.length * 0.8) return null;
  }
  return { a: ra, b: rb };
}
