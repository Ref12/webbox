import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenType, paint, toHtml, toSemanticTokens, TYPES } from '../../src/CsRepl.Wasm/wwwroot/classify.js';

test('Roslyn names map to token types', () => {
  assert.equal(tokenType('class name'), 'class'); assert.equal(tokenType('method name'), 'method');
  assert.equal(tokenType('keyword - control'), 'keywordControl'); assert.equal(tokenType('xml doc comment - text'), 'xmlDoc');
  assert.equal(tokenType('identifier'), null); assert.equal(tokenType('static symbol'), null);
});

test('nested spans: the inner one wins', () => {
  const p = paint(10, [{ start: 0, length: 10, type: 'string' }, { start: 3, length: 2, type: 'string - escape character' }]);
  assert.equal(p[0], 'string'); assert.equal(p[3], 'stringEscape'); assert.equal(p[5], 'string');
});

test('html is escaped and coloured', () => {
  const t = 'a<b';
  assert.equal(toHtml(t, [{ start: 0, length: 1, type: 'class name' }]), '<span class="t-class">a</span>&lt;b');
});

test('semantic tokens are relative and split at line ends', () => {
  const text = 'var x = "a\nb";\nx';
  const spans = [{ start: 0, length: 3, type: 'keyword' }, { start: 8, length: 5, type: 'string' }, { start: 15, length: 1, type: 'local name' }];
  const d = Array.from(toSemanticTokens(text, spans));
  const k = TYPES.indexOf('keyword'), s = TYPES.indexOf('string'), l = TYPES.indexOf('local');
  // exact check, token by token
  assert.deepEqual(d.slice(0, 5), [0, 0, 3, k, 0]);
  assert.deepEqual(d.slice(5, 10), [0, 8, 2, s, 0]);      // '"a' on line 0
  assert.deepEqual(d.slice(10, 15), [1, 0, 2, s, 0]);     // 'b"' on line 1, absolute start 0
  assert.deepEqual(d.slice(15, 20), [1, 0, 1, l, 0]);     // 'x' on line 2
});
