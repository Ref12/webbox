import test from 'node:test';
import assert from 'node:assert/strict';
import { diffFile, layoutRows } from '../lib/diff.js';
import { itemKind, rulerMarks, placeMarks, jumpTop } from '../lib/ruler.js';

const lines = n => Array.from({ length: n }, (_, i) => 'line ' + i);
function make(mode, ctx, expand = {}) {
  const a = lines(100), b = lines(100);
  b[10] = 'changed 10';            // modified
  b.splice(40, 0, 'new 40');       // added
  b.splice(71, 1);                 // removed
  const d = diffFile(a.join('\n'), b.join('\n'));
  const rows = layoutRows(d.segs, { mode, ctx, expand });
  const items = rows.map(r => ({ type: r.k === 'gap' ? 'gap' : 'row', row: r, h: r.k === 'gap' ? 28 : 20 }));
  const tops = new Float64Array(items.length + 1);
  items.forEach((it, i) => { tops[i + 1] = tops[i] + it.h; });
  return { items, tops, total: tops[items.length] };
}

test('inline: add, del and modified are told apart, positions follow the layout', () => {
  const { items, tops, total } = make('inline', Infinity);
  const m = rulerMarks(items, tops);
  assert.deepEqual(m.map(x => x.kind), ['mod', 'add', 'del']);
  assert.equal(m[0].y, 10 * 20);                 // line 10, 20 px rows, one modified line (del+add rows merge)
  assert.equal(m[0].h, 40);
  const p = placeMarks(m, total, 400);
  assert.ok(Math.abs(p[0].top - 200 * 400 / total) < 1e-9);
  assert.ok(p[1].top > p[0].top && p[2].top > p[1].top);
});

test('split: pairs map to mod, one-sided pairs to add / del', () => {
  const { items } = make('split', Infinity);
  assert.deepEqual(items.map(itemKind).filter(Boolean), ['mod', 'add', 'del']);
});

test('collapsed context moves marks up but keeps them proportional', () => {
  const full = make('inline', Infinity), col = make('inline', 3);
  assert.ok(col.total < full.total);
  const a = rulerMarks(col.items, col.tops);
  assert.deepEqual(a.map(x => x.kind), ['mod', 'add', 'del']);
  const first = a[0], gap = col.items.findIndex(i => i.type === 'gap');
  assert.ok(first.y < col.tops[gap] || first.y > col.tops[gap]);
  for (const x of placeMarks(a, col.total, 300)) assert.ok(x.top >= 0 && x.top + x.h <= 300 + 1e-9);
});

test('selection, hits and comments get their own marks; tiny marks get a minimum height', () => {
  const { items, tops, total } = make('inline', Infinity);
  const cm = { type: 'cm', h: 100 };
  items.splice(5, 0, cm);
  const t = new Float64Array(items.length + 1); items.forEach((it, i) => { t[i + 1] = t[i] + it.h; });
  const m = rulerMarks(items, t, { sel: it => it.row.b === 20 || it.row.b === 21, hit: it => it.row.b === 30 });
  const by = k => m.filter(x => x.kind === k);
  assert.equal(by('cm').length, 1); assert.equal(by('cm')[0].y, t[5]);
  assert.equal(by('sel').length, 1); assert.equal(by('sel')[0].h, 40);
  assert.equal(by('hit').length, 1);
  const p = placeMarks(by('hit'), t[items.length], 100);
  assert.ok(p[0].h >= 3);
});

test('jumpTop clamps', () => {
  assert.equal(jumpTop(10, 600, 5000), 0);
  assert.equal(jumpTop(4990, 600, 5000), 4400);
  assert.equal(jumpTop(1000, 600, 5000), 800);
});
