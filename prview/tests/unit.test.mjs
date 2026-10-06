import test from 'node:test';
import assert from 'node:assert/strict';
import { diffBlocks, diffFile, splitLines, layoutRows, wordDiff } from '../lib/diff.js';
import { buildTree, flattenTree, orderedFiles } from '../lib/tree.js';
import { parsePrRef, parseRoute, toRoute } from '../lib/url.js';

// Apply blocks to rebuild b from a: the property every diff must satisfy.
const rebuild = (a, b, blocks) => { const out = []; let i = 0; for (const k of blocks) { while (i < k.a0) out.push(a[i++]); for (let j = k.b0; j < k.b1; j++) out.push(b[j]); i = k.a1; } while (i < a.length) out.push(a[i++]); return out; };

test('splitLines handles CRLF and trailing newline', () => {
  assert.deepEqual(splitLines('a\r\nb\n'), ['a', 'b']);
  assert.deepEqual(splitLines(''), []);
  assert.deepEqual(splitLines('a\n\n'), ['a', '']);
});

test('diffBlocks basics', () => {
  assert.deepEqual(diffBlocks(['a', 'b'], ['a', 'b']), []);
  assert.deepEqual(diffBlocks([], ['x']), [{ a0: 0, a1: 0, b0: 0, b1: 1 }]);
  assert.deepEqual(diffBlocks(['a', 'b', 'c'], ['a', 'X', 'c']), [{ a0: 1, a1: 2, b0: 1, b1: 2 }]);
  assert.deepEqual(diffBlocks('abcdef'.split(''), 'abdeXf'.split('')), [{ a0: 2, a1: 3, b0: 2, b1: 2 }, { a0: 5, a1: 5, b0: 4, b1: 5 }]);
});

test('diffBlocks reconstructs b from a on random inputs (and is minimal-ish)', () => {
  let seed = 7; const rnd = n => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
  for (let t = 0; t < 300; t++) {
    const a = Array.from({ length: rnd(40) }, () => 'l' + rnd(6));
    const b = Array.from({ length: rnd(40) }, () => 'l' + rnd(6));
    const blocks = diffBlocks(a, b);
    assert.deepEqual(rebuild(a, b, blocks), b);
    for (let i = 1; i < blocks.length; i++) assert.ok(blocks[i].a0 >= blocks[i - 1].a1 && blocks[i].b0 >= blocks[i - 1].b1);
  }
});

test('diffBlocks falls back to a replace when too different', () => {
  const a = Array.from({ length: 50 }, (_, i) => 'a' + i), b = Array.from({ length: 50 }, (_, i) => 'b' + i);
  assert.deepEqual(diffBlocks(a, b, 5), [{ a0: 0, a1: 50, b0: 0, b1: 50 }]);
});

test('diffFile counts and layout: collapsed context, gaps, expansion', () => {
  const a = Array.from({ length: 30 }, (_, i) => 'line' + i), b = a.slice(); b[15] = 'CHANGED';
  const d = diffFile(a.join('\n') + '\n', b.join('\n') + '\n');
  assert.equal(d.add, 1); assert.equal(d.del, 1);
  const rows = layoutRows(d.segs, { mode: 'inline', ctx: 3 });
  assert.deepEqual(rows.map(r => r.k), ['gap', 'eq', 'eq', 'eq', 'del', 'add', 'eq', 'eq', 'eq', 'gap']);
  assert.equal(rows[0].count, 12); assert.equal(rows[0].up, true); assert.equal(rows[0].down, false);
  assert.equal(rows[9].count, 11); assert.equal(rows[9].down, true);
  assert.equal(rows.filter(r => r.first).length, 1);
  const more = layoutRows(d.segs, { ctx: 3, expand: { 0: { up: 5, down: 0 }, 2: { up: 0, down: 100 } } });
  assert.equal(more[0].count, 7); assert.equal(more.filter(r => r.k === 'gap').length, 1);
  const full = layoutRows(d.segs, { ctx: Infinity });
  assert.equal(full.length, 31); assert.ok(!full.some(r => r.k === 'gap'));
  const split = layoutRows(d.segs, { mode: 'split', ctx: 3 });
  assert.deepEqual(split.filter(r => r.k === 'pair').map(r => [r.a, r.b]), [[15, 15]]);
});

test('layoutRows: pairs unequal blocks and shows nothing for identical files', () => {
  const d = diffFile('a\nb\nc\n', 'a\nX\nY\nZ\nc\n');
  const rows = layoutRows(d.segs, { mode: 'split', ctx: 3 });
  assert.deepEqual(rows.filter(r => r.k === 'pair').map(r => [r.a, r.b]), [[1, 1], [null, 2], [null, 3]]);
  assert.equal(layoutRows(diffFile('same\n', 'same\n').segs).length, 0);
});

test('wordDiff marks changed words', () => {
  const w = wordDiff('const total = price * 2;', 'const total = price * rate;');
  assert.deepEqual(w.a, [[22, 23]]); assert.deepEqual(w.b, [[22, 26]]);
  assert.equal(wordDiff('x'.repeat(2000), 'y'), null);
  assert.equal(wordDiff('abcdef', 'uvwxyz'), null);
});

const f = (filename, status = 'modified', additions = 1, deletions = 0) => ({ filename, status, additions, deletions });

test('buildTree compresses single-child folders, sorts folders first, sums counts', () => {
  const t = buildTree([f('README.md'), f('src/a/b/c.txt'), f('src/a/b/d.txt', 'added', 5, 2), f('src/z.js'), f('lib/x/y/only.js')]);
  assert.deepEqual(t.children.map(c => c.name), ['lib/x/y', 'src', 'README.md']);
  const src = t.children[1];
  assert.deepEqual(src.children.map(c => c.name), ['a/b', 'z.js']);
  assert.equal(src.add, 7); assert.equal(src.del, 2); assert.equal(src.files, 3);
  assert.deepEqual(orderedFiles(t).map(x => x.filename), ['lib/x/y/only.js', 'src/a/b/c.txt', 'src/a/b/d.txt', 'src/z.js', 'README.md']);
});

test('flattenTree honours collapsed folders and the filter', () => {
  const t = buildTree([f('src/a/one.cs'), f('src/a/two.cs'), f('src/b.cs'), f('docs/x.md')]);
  assert.deepEqual(flattenTree(t).map(r => r.node.name + '@' + r.depth), ['docs@0', 'x.md@1', 'src@0', 'a@1', 'one.cs@2', 'two.cs@2', 'b.cs@1']);
  assert.deepEqual(flattenTree(t, { collapsed: new Set(['src']) }).map(r => r.node.name), ['docs', 'x.md', 'src']);
  assert.deepEqual(flattenTree(t, { collapsed: new Set(['src']), filter: 'TWO' }).map(r => r.node.name), ['src', 'a', 'two.cs']);
  assert.deepEqual(flattenTree(t, { filter: 'nothing' }), []);
});

test('parsePrRef accepts the usual spellings', () => {
  const want = { owner: 'dotnet', repo: 'runtime', number: 123 };
  for (const s of ['https://github.com/dotnet/runtime/pull/123', 'http://www.github.com/dotnet/runtime/pull/123/files', 'github.com/dotnet/runtime/pull/123/commits/abc?x=1#diff', ' dotnet/runtime#123 ', 'dotnet/runtime/pull/123', '/dotnet/runtime/pull/123/', 'https://webbox.example/prview/#/dotnet/runtime/pull/123?f=a'])
    assert.deepEqual(parsePrRef(s), want, s);
  for (const s of ['', null, 'https://github.com/dotnet/runtime/issues/1', 'https://gitlab.com/a/b/pull/1', 'dotnet/runtime', 'pull/5']) assert.equal(parsePrRef(s), null, String(s));
  assert.deepEqual(parsePrRef('my-org/my.repo_x#7'), { owner: 'my-org', repo: 'my.repo_x', number: 7 });
});

test('routes round-trip', () => {
  const ref = { owner: 'a', repo: 'b', number: 5 };
  assert.equal(toRoute(ref), '#/a/b/pull/5');
  assert.equal(toRoute(ref, { f: 'src/x.cs', m: 'split' }), '#/a/b/pull/5?f=src/x.cs&m=split');
  assert.equal(toRoute(ref, {}, 'commits'), '#/a/b/pull/5/commits');
  const r = parseRoute('#/a/b/pull/5/commits?f=src/x.cs&c=abc..def');
  assert.deepEqual(r.ref, ref); assert.equal(r.tab, 'commits'); assert.deepEqual(r.params, { f: 'src/x.cs', c: 'abc..def' });
  assert.equal(parseRoute('#/nope').ref, null);
});

import { tokenizeLines, langFor } from '../lib/highlight.js';
import { lineHtml, mdLite } from '../lib/render.js';

test('highlighter: languages, block comments across lines, strings', () => {
  assert.equal(langFor('src/A.cs'), 'c'); assert.equal(langFor('x/app.csproj'), 'html'); assert.equal(langFor('a.unknown'), null); assert.equal(tokenizeLines(null, ['x']), null);
  const t = tokenizeLines('c', ['int x = 5; // note', '/* a', 'b */ return "s";']);
  assert.deepEqual(t[0].map(x => x.c), ['kw', null, 'nu', null, 'cm'].slice(0, 5).map((c, i) => t[0][i].c));
  assert.ok(t[0].some(x => x.c === 'kw' && x.s === 'int') && t[0].some(x => x.c === 'nu') && t[0].some(x => x.c === 'cm' && x.s === '// note'));
  assert.deepEqual(t[1], [{ c: 'cm', s: '/* a' }]);
  assert.ok(t[2][0].c === 'cm' && t[2].some(x => x.c === 'st' && x.s === '"s"'));
  assert.equal(t.map(l => l.map(x => x.s).join('')).join('\n'), 'int x = 5; // note\n/* a\nb */ return "s";');
});

test('lineHtml puts word marks inside tokens and escapes', () => {
  const html = lineHtml([{ c: 'kw', s: 'if' }, { c: null, s: ' (a < b)' }], [[1, 5]]);
  assert.equal(html, '<span class="t-kw">i<mark class="wd">f</mark></span><mark class="wd"> (a</mark> &lt; b)');
});

test('mdLite escapes html and keeps links safe', () => {
  const h = mdLite('<script>x</script> **b** `c` [t](https://e.com/a?b=1&c=2)\n```suggestion\nx < y\n```');
  assert.ok(!h.includes('<script>')); assert.ok(h.includes('<b>b</b>') && h.includes('<code>c</code>'));
  assert.ok(h.includes('target="_blank"') && h.includes('rel="noopener noreferrer"') && h.includes('x &lt; y'));
});
