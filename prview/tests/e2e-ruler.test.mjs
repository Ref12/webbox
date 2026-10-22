// Overview ruler + full-file default, in headless Chromium against the recorded fixture. node --test e2e-ruler.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { start, PR } from './harness.mjs';

const SHOTS = new URL('../docs/', import.meta.url).pathname + 'ruler/';
fs.mkdirSync(SHOTS, { recursive: true });
const LINK = 'src/tools/illink/src/ILLink.Tasks/LinkTask.cs';
async function open(h, hash) {
  await h.page.goto(h.base + hash);
  await h.page.waitForSelector('.fh', { timeout: 15000 });
  await h.page.waitForSelector('#ruler .rk', { timeout: 15000 });
}
const marks = p => p.$$eval('#ruler .rk', els => els.map(e => ({ k: e.className.replace('rk ', ''), top: parseFloat(e.style.top), h: parseFloat(e.style.height), y: Number(e.dataset.y) })));

for (const [name, vp, mobile, mode] of [['desktop-inline', { width: 1400, height: 900 }, false, ''], ['desktop-split', { width: 1400, height: 900 }, false, '&m=split'], ['phone-inline', { width: 375, height: 812 }, true, ''], ['phone-split', { width: 375, height: 812 }, true, '&m=split']]) {
  test('ruler: ' + name, async () => {
    const h = await start({ viewport: vp, mobile, view: null }); const p = h.page;
    await open(h, PR + '?f=' + LINK + mode);
    // default is full file, one file: no collapsed gaps
    assert.equal(await p.locator('#win .gap').count(), 0, 'full file by default');
    assert.equal(await p.locator('#win .fh').count() <= 2, true, 'one file at a time');
    await p.waitForSelector('#win .cm .thread', { timeout: 5000 }).catch(() => {});
    const ms = await marks(p);
    const kinds = new Set(ms.map(m => m.k));
    assert.ok(ms.filter(m => ['add', 'del', 'mod'].includes(m.k)).length >= 2, 'several change segments');
    assert.ok(kinds.has('cm'), 'a comment mark');
    const H = await p.evaluate(() => document.querySelector('#ruler').clientHeight), total = await p.evaluate(() => document.querySelector('#spacer').offsetHeight);
    for (const m of ms) { assert.ok(m.top >= 0 && m.top + m.h <= H + 1); assert.ok(Math.abs(m.top - m.y / total * H) < 3 || m.top + m.h >= H - 1, 'proportional'); }
    // clicking the last change mark scrolls there
    const last = p.locator('#ruler .rk.add, #ruler .rk.del, #ruler .rk.mod').last();
    const y = Number(await last.getAttribute('data-y'));
    await last.click();
    await p.waitForFunction(() => document.querySelector('#diff').scrollTop > 0);
    const st = await p.evaluate(() => document.querySelector('#diff').scrollTop), vh = await p.evaluate(() => document.querySelector('#diff').clientHeight);
    assert.ok(y >= st && y <= st + vh, 'the marked lines are in view');
    // search hit and selection marks
    if (!mobile) {
      await p.fill('#find', 'e');
      await p.waitForSelector('#ruler .rk.hit');
      assert.ok((await marks(p)).some(m => m.k === 'hit'));
      await p.fill('#find', 'ToolTask');   // a narrower search for the screenshot: a few hits, the other marks stay readable
      await p.waitForFunction(() => document.querySelectorAll('#ruler .rk.hit').length >= 1);
    }
    await p.evaluate(() => { document.querySelector('#diff').scrollTop = 0; });
    await p.waitForTimeout(300);
    await p.screenshot({ path: SHOTS + name + '.png' });
    assert.deepEqual(h.errors, []);
    await h.close();
  });
}

test('ruler: stays right when lines are collapsed (changes only) and expanded again', async () => {
  const h = await start({ view: null }); const p = h.page;
  await open(h, PR + '?f=' + LINK);
  const total = () => p.evaluate(() => document.querySelector('#spacer').offsetHeight);
  const full = await total();
  await p.click('#full-btn');                       // changes only
  await p.waitForSelector('#win .gap');
  assert.ok(await total() < full);
  const ms = await marks(p), H = await p.evaluate(() => document.querySelector('#ruler').clientHeight), t = await total();
  for (const m of ms) assert.ok(m.top + m.h <= H + 1 && Math.abs(m.top - m.y / t * H) < 3 || m.top + m.h >= H - 1);
  await p.click('#full-btn');
  await p.waitForFunction(() => !document.querySelector('#win .gap'));
  assert.ok(Math.abs(await total() - full) < full * 0.03, 'back to the full height (comment boxes are re-measured)');
  await h.close();
});

test('default is full-file diffs; x=0 and the button switch to changes only', async () => {
  const h = await start({ view: null }); const p = h.page;
  await open(h, PR + '?f=' + LINK);
  assert.equal((await p.locator('#full-btn').innerText()).trim(), 'Full files');
  await h.close();
  const h2 = await start({ view: null });
  await open(h2, PR + '?f=' + LINK + '&x=0');
  assert.equal((await h2.page.locator('#full-btn').innerText()).trim(), 'Changes only');
  await h2.close();
});
