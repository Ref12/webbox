// Overview ruler: where the changes, comments, selection and search hits are, as marks along the scrollbar.
// Pure functions over the layout (items + cumulative tops), so positions stay right when lines are collapsed or expanded
// and in both inline and side-by-side layouts.

/** What a layout item is for the ruler: 'add' | 'del' | 'mod' | 'cm' | null (unchanged, gap, header, note). */
export function itemKind(it) {
  if (it.type === 'cm') return it.outdated || !it.composer ? 'cm' : null;
  if (it.type !== 'row') return null;
  const r = it.row;
  if (r.k === 'pair') return r.a != null && r.b != null ? 'mod' : r.a != null ? 'del' : 'add';
  if (r.k === 'add' || r.k === 'del') return r.w ? 'mod' : r.k;   // a line with a word diff against its pair is a modification
  return null;
}

/**
 * Marks in content pixels: [{ kind, y, h, i }] with kind add|del|mod|cm|sel|hit, i the first item of the run.
 * Consecutive items of one kind merge. opts.sel(it) / opts.hit(it) say whether a row is selected / a search hit.
 */
export function rulerMarks(items, tops, opts = {}) {
  const out = [], open = {};
  const feed = (kind, i, it) => {
    const o = open[kind];
    if (kind && o && o.end === i) { o.m.h = tops[i] + it.h - o.m.y; o.end = i + 1; return; }
    if (!kind) return;
    const m = { kind, y: tops[i], h: it.h, i };
    out.push(m); open[kind] = { m, end: i + 1 };
  };
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    feed(itemKind(it), i, it);
    if (opts.sel && it.type === 'row' && opts.sel(it)) feed('sel', i, it);
    if (opts.hit && it.type === 'row' && opts.hit(it)) feed('hit', i, it);
  }
  return out;
}

/** Marks to pixels on a track of trackH px for content of total px: [{ kind, top, h, y, i }], at least minH tall; same-kind marks that touch merge. */
export function placeMarks(marks, total, trackH, minH = 3) {
  if (!total || !trackH) return [];
  const k = trackH / total, out = [], last = {};
  for (const m of marks) {
    let top = m.y * k, h = Math.max(minH, m.h * k);
    top = Math.min(top, Math.max(0, trackH - h));
    const p = last[m.kind];
    if (p && top <= p.top + p.h + 1) { p.h = Math.max(p.h, top + h - p.top); continue; }
    const q = { kind: m.kind, top, h, y: m.y, i: m.i };
    out.push(q); last[m.kind] = q;
  }
  return out;
}

/** Scroll position that brings content y to about a third of the way down a pane of height vh. */
export function jumpTop(y, vh, total) { return Math.max(0, Math.min(total - vh, y - vh / 3)); }
