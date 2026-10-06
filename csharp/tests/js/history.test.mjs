import test from 'node:test';
import assert from 'node:assert/strict';
import { History } from '../../src/CsRepl.Wasm/wwwroot/history.js';

const mk = (...c) => { const h = new History(); c.forEach((x) => h.add(x)); return h; };

test('Ctrl+Up walks back, newest first, and stops at the oldest', () => {
  const h = mk('a', 'b', 'c');
  assert.equal(h.prev(''), 'c'); assert.equal(h.prev('c'), 'b'); assert.equal(h.prev('b'), 'a');
  assert.equal(h.prev('a'), null);           // already oldest: no change
  assert.equal(h.prev('a'), null);
});

test('typed text is stashed by the first Ctrl+Up and restored exactly by Ctrl+Down past the newest', () => {
  const h = mk('one', 'two');
  const typed = 'var half = typ\n  ed;   ';          // multi-line, odd whitespace: must come back byte for byte
  assert.equal(h.prev(typed), 'two');
  assert.equal(h.prev('two'), 'one');
  assert.equal(h.next(), 'two');
  assert.equal(h.next(), typed);
  assert.equal(h.next(), null);               // no longer navigating
  assert.equal(h.navigating, false);
});

test('empty input is stashed too: Down past the newest gives an empty box', () => {
  const h = mk('x');
  assert.equal(h.prev(''), 'x'); assert.equal(h.next(), '');
});

test('Ctrl+Down when not navigating does nothing; empty history does nothing', () => {
  assert.equal(mk('x').next(), null); assert.equal(new History().prev('typed'), null);
});

test('stash is only taken at the start of a navigation, not overwritten by shown history entries', () => {
  const h = mk('a', 'b');
  h.prev('mine'); h.prev('b'); h.next(); assert.equal(h.next(), 'mine');
});

test('adding a submission ends navigation; blank and duplicate-of-last are not stored twice', () => {
  const h = mk('a', 'b'); h.prev('t'); h.add('c'); assert.equal(h.navigating, false);
  h.add('c'); h.add('   '); assert.deepEqual(h.items, ['a', 'b', 'c']);
  assert.equal(h.prev(''), 'c');
});
