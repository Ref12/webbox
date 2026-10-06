import test from 'node:test';
import assert from 'node:assert/strict';
import { addCopyButton, copyText, COPY_SVG, CHECK_SVG } from '../../src/CsRepl.Wasm/wwwroot/copy.js';

// a tiny fake DOM: enough for the copy button
class El {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.classes = new Set(); this.innerHTML = ''; this.classList = { add: (c) => this.classes.add(c), remove: (c) => this.classes.delete(c) }; }
  set className(v) { this.classes = new Set(v.split(' ').filter(Boolean)); } get className() { return [...this.classes].join(' '); }
  setAttribute(k, v) { this.attrs[k] = v; } appendChild(c) { this.children.push(c); return c; } select() {} remove() { this.removed = true; }
}
const fakeDoc = (execOk = true) => ({ createElement: (t) => new El(t), body: new El('body'), execCommand: () => execOk });

test('the button has the same icon and class as the code blocks, and a title', () => {
  const box = new El('div'), doc = fakeDoc();
  const b = addCopyButton(box, 'x', { title: 'Copy output', doc, nav: {} });
  assert.equal(box.children[0], b); assert.equal(b.className, 'copy'); assert.equal(b.innerHTML, COPY_SVG);
  assert.equal(b.attrs['aria-label'], 'Copy output'); assert.equal(b.title, 'Copy output'); assert.equal(b.type, 'button');
});

test('clicking copies the plain text (a function is evaluated at click time), shows a check, then restores the icon', async () => {
  const written = []; const box = new El('div'); let text = 'first';
  const b = addCopyButton(box, () => text, { doc: fakeDoc(), nav: { clipboard: { writeText: async (t) => written.push(t) } }, onCopied: (v) => written.push('cb:' + v) });
  text = '<b>42</b>\nline2';
  await b.onclick();
  assert.deepEqual(written, ['<b>42</b>\nline2', 'cb:<b>42</b>\nline2']);
  assert.ok(b.classes.has('done')); assert.equal(b.innerHTML, CHECK_SVG);
  await new Promise((r) => setTimeout(r, 1300));
  assert.ok(!b.classes.has('done')); assert.equal(b.innerHTML, COPY_SVG);
});

test('without the async clipboard it falls back to execCommand; when both fail nothing is confirmed', async () => {
  const doc = fakeDoc(true), nav = { clipboard: { writeText: async () => { throw new Error('denied'); } } };
  assert.equal(await copyText('abc', doc, nav), true);
  assert.equal(doc.body.children[0].value, 'abc'); assert.ok(doc.body.children[0].removed);
  const box = new El('div'); const b = addCopyButton(box, 'abc', { doc: fakeDoc(false), nav });
  await b.onclick();
  assert.ok(!b.classes.has('done'));
});
