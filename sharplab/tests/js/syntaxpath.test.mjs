import test from 'node:test';
import assert from 'node:assert/strict';
import { findPath, nodeAt, selectionOf, label, walk } from '../../src/SharpLab.Wasm/wwwroot/syntaxpath.js';

// "// hi\nclass A { }"  (hand-built the way SyntaxTreeModel emits it)
const tok = (k, v, s, e, fs, fe, c) => ({ k, t: 'token', v, s, e, fs, fe, ...(c ? { c } : {}) });
const tree = {
  k: 'CompilationUnit', t: 'node', s: 6, e: 17, fs: 0, fe: 17, c: [
    { k: 'ClassDeclaration', t: 'node', s: 6, e: 17, fs: 0, fe: 17, c: [
      tok('ClassKeyword', 'class', 6, 11, 0, 12, [
        { k: 'SingleLineCommentTrivia', t: 'trivia', l: 'lead', v: '// hi', s: 0, e: 5, fs: 0, fe: 5 },
        { k: 'EndOfLineTrivia', t: 'trivia', l: 'lead', v: '\n', s: 5, e: 6, fs: 5, fe: 6 },
        { k: 'WhitespaceTrivia', t: 'trivia', l: 'trail', v: ' ', s: 11, e: 12, fs: 11, fe: 12 }]),
      tok('IdentifierToken', 'A', 12, 13, 12, 14),
      tok('OpenBraceToken', '{', 14, 15, 14, 16),
      tok('CloseBraceToken', '}', 16, 17, 16, 17)] },
    tok('EndOfFileToken', '', 17, 17, 17, 17)] };

const at = (o, e) => nodeAt(tree, findPath(tree, o, e));

test('caret in a token selects the token', () => {
  assert.equal(at(8).k, 'ClassKeyword');
  assert.equal(at(12).k, 'IdentifierToken');
  assert.equal(at(16).k, 'CloseBraceToken');
});
test('caret in trivia selects the trivia', () => {
  assert.equal(at(2).k, 'SingleLineCommentTrivia');
  assert.equal(at(5).k, 'EndOfLineTrivia');
  assert.equal(at(11).k, 'WhitespaceTrivia');
});
test('a selection covering several tokens selects the smallest element containing it', () => {
  assert.equal(at(6, 13).k, 'ClassDeclaration');
  assert.equal(at(12, 13).k, 'IdentifierToken');
});
test('caret at the end of the text belongs to the end-of-file token', () => {
  assert.equal(at(17).k, 'EndOfFileToken');
});
test('selection ranges and labels', () => {
  assert.deepEqual(selectionOf(at(12)), { start: 12, end: 13 });
  assert.equal(label(at(12)), 'IdentifierToken "A"');
  assert.equal(label(tree), 'CompilationUnit');
  assert.equal([...walk(tree)].length, 10);
});
