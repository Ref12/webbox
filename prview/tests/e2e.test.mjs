// End to end in headless Chromium against the recorded fixture (no live API). node --test e2e.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { start, PR } from './harness.mjs';

const SHOTS = new URL('../docs/screenshots/', import.meta.url).pathname;
fs.mkdirSync(SHOTS, { recursive: true });
const shot = (p, name) => p.screenshot({ path: SHOTS + name + '.png' });

async function open(h, hash = PR) {
  await h.page.goto(h.base + hash);
  await h.page.waitForSelector('.fh', { timeout: 15000 });
  await h.page.waitForSelector('.row', { timeout: 15000 });
}
const paths = p => p.$$eval('#tree .tr[data-path]', els => els.map(e => e.dataset.path));
const finish = async h => { assert.deepEqual(h.misses, [], 'unrecorded requests'); assert.deepEqual(h.errors, [], 'page errors'); await h.close(); };

test('opens a PR: header, tree with badges and counts, stacked diffs', async () => {
  const h = await start(); const p = h.page;
  await open(h);
  assert.match(await p.locator('#prhead h1').innerText(), /ILLink task output ownership/);
  assert.equal((await paths(p)).length, 6);
  assert.match(await p.locator('#count').innerText(), /6 changed files · 0 reviewed/);
  assert.ok(await p.locator('#tree .tb.M').count() >= 5);
  assert.match(await p.locator('#tree').innerText(), /\+8\s+−2/);
  // folders with a single child folder are shown as one path
  assert.match(await p.locator('#tree').innerText(), /docs\/tools\/illink/);
  assert.ok(await p.locator('.row.add').count() > 0 && await p.locator('.row.del').count() > 0);
  assert.ok(await p.locator('.row mark.wd').count() > 0, 'word level marks');
  await p.waitForTimeout(500);
  assert.ok(await p.locator('.t-kw, .t-ky').count() > 0, 'syntax highlighting arrived lazily');
  await shot(p, 'desktop-inline');
  await finish(h);
});

test('select a file in the tree', async () => {
  const h = await start(); const p = h.page;
  await open(h);
  const all = await paths(p), target = all.find(x => x.endsWith('Mock.cs'));
  await p.click('#tree .tr[data-path$="Mock.cs"]');
  await p.waitForSelector('.fh[data-path$="Mock.cs"] >> visible=true');
  const top = await p.evaluate(() => { const d = document.querySelector('#diff').getBoundingClientRect(); const e = [...document.querySelectorAll('#diff .fh, #stick .fh')].find(x => x.dataset.path.endsWith('Mock.cs')); return e.getBoundingClientRect().top - d.top; });
  const room = await p.evaluate(() => { const d = document.querySelector('#diff'); return d.scrollHeight - d.clientHeight - d.scrollTop; });
  assert.ok((top >= -2 && top < 80) || (room < 2 && top > 0), 'file header at the top (or the pane is scrolled to its end), got ' + top);
  assert.ok(await p.locator('#tree .tr.sel[data-path$="Mock.cs"]').count() === 1);
  assert.match(await p.evaluate(() => location.hash), /f=.*Mock\.cs/);
  assert.ok(target);
  await finish(h);
});

test('inline and side-by-side', async () => {
  const h = await start(); const p = h.page;
  await open(h);
  assert.equal(await p.locator('.row.split').count(), 0);
  await p.click('#m-split');
  await p.waitForSelector('.row.split');
  assert.ok(await p.locator('.half.add').count() > 0 && await p.locator('.half.del').count() > 0);
  assert.ok(await p.locator('.half.none').count() > 0, 'empty side is hatched');
  const box = await p.evaluate(() => { const r = [...document.querySelectorAll('.row.split .half.add')][0].getBoundingClientRect(); return [r.left, r.right, innerWidth]; });
  assert.ok(box[0] > 0 && box[1] <= box[2] + 1, 'both halves are inside the viewport: ' + box);
  assert.match(await p.evaluate(() => location.hash), /m=split/);
  await shot(p, 'desktop-side-by-side');
  await p.keyboard.press('s');
  await p.waitForFunction(() => !document.querySelector('.row.split'));
  assert.equal(await p.evaluate(() => localStorage.getItem('prview.mode')), '"inline"');
  await finish(h);
});

test('expand collapsed context', async () => {
  const h = await start(); const p = h.page;
  await open(h);
  const fh = p.locator('#win .fh').first();
  const path = await fh.getAttribute('data-path');
  const rowsOf = () => p.locator('#win .it.r').count();
  const gaps = () => p.locator('#win .gap').count();
  const g0 = await gaps(), h0 = await p.evaluate(() => document.querySelector('#spacer').offsetHeight);
  assert.ok(g0 > 0);
  const first = p.locator('#win .gap').first();
  assert.match(await first.innerText(), /29 unchanged lines/);
  await first.locator('[data-dir=up]').click();
  await p.waitForFunction(() => /9 unchanged lines/.test(document.querySelector('#win .gap').innerText));
  await p.locator('#win .gap').first().locator('[data-dir=all]').click();
  await p.waitForFunction(g => document.querySelectorAll('#win .gap').length < g, g0);
  assert.ok(await p.evaluate(() => document.querySelector('#spacer').offsetHeight) > h0 + 20 * 20, 'more rows after expanding');
  assert.ok(await rowsOf() > 0);
  // View = whole file for this one file
  await p.locator('#win .fh').first().locator('[data-act=full]').click();
  await p.waitForFunction(() => document.querySelector('#win .fh [data-act=full]').innerText === 'Changes only');
  assert.ok(await p.evaluate(() => document.querySelector('#spacer').offsetHeight) > 1500);
  await shot(p, 'desktop-expanded');
  assert.ok(path);
  await finish(h);
});

test('mark reviewed, persisted per PR and head sha', async () => {
  const h = await start(); const p = h.page;
  await open(h);
  await p.locator('#win .fh [data-act=review]').first().check();
  assert.match(await p.locator('#count').innerText(), /1 reviewed/);
  assert.equal(await p.locator('#tree .tr.done').count(), 1);
  const keys = await p.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('prview.rev:')));
  assert.equal(keys.length, 1); assert.match(keys[0], /dotnet\/runtime#135064@[0-9a-f]{40}$/);
  await p.reload(); await p.waitForSelector('.fh');
  assert.match(await p.locator('#count').innerText(), /1 reviewed/);
  assert.equal(await p.locator('#win .fh [data-act=review]:checked').count(), 1);
  await p.keyboard.press('r'); // r toggles the current file
  assert.match(await p.locator('#count').innerText(), /0 reviewed/);
  await finish(h);
});

test('keyboard: j/k files, n/p changes, x collapse, / filter, ? help', async () => {
  const h = await start(); const p = h.page;
  await open(h);
  const cur = () => p.evaluate(() => window.__prview.state.current.filename);
  const first = await cur();
  await p.keyboard.press('j'); const second = await cur(); assert.notEqual(first, second);
  await p.keyboard.press('k'); assert.equal(await cur(), first);
  const y0 = await p.evaluate(() => document.querySelector('#diff').scrollTop);
  await p.keyboard.press('n'); await p.waitForTimeout(150);
  const y1 = await p.evaluate(() => document.querySelector('#diff').scrollTop);
  assert.ok(y1 > y0, 'n moves to the next change');
  await p.keyboard.press('p'); await p.waitForTimeout(150);
  assert.ok(await p.evaluate(() => document.querySelector('#diff').scrollTop) < y1);
  await p.keyboard.press('x');
  await p.waitForFunction(() => document.querySelector('#win .fh.collapsed'));
  await p.keyboard.press('x');
  await p.keyboard.press('/'); await p.keyboard.type('mock');
  await p.waitForFunction(() => document.querySelectorAll('#tree .tr[data-path]').length === 1);
  assert.equal(await p.locator('#win .fh').count(), 1);
  assert.match(await p.locator('#count').innerText(), /6 changed files/);
  await p.fill('#filter', '');
  await p.keyboard.press('Escape'); // leaves the input
  await p.keyboard.press('?');
  assert.match(await p.locator('#dlg').innerText(), /next \/ previous change/);
  await finish(h);
});

test('commit picker: one commit, then back to all changes', async () => {
  const h = await start(); const p = h.page;
  await open(h);
  assert.equal((await p.locator('#picker-btn').innerText()).trim(), 'All changes ▾');
  await p.click('#picker-btn');
  assert.equal(await p.locator('#picker .opt').count(), 4); // all + 3 commits
  await shot(p, 'desktop-commit-picker');
  await p.locator('#picker .opt[data-i="1"]').click();
  await p.waitForFunction(() => /Commit 2 of 3/.test(document.querySelector('#picker-btn').innerText) && !/…/.test(document.querySelector('#picker-btn').innerText));
  await p.waitForSelector('.row');
  assert.match(await p.evaluate(() => location.hash), /c=[0-9a-f]{7}/);
  const n = (await paths(p)).length; assert.ok(n >= 1 && n <= 6);
  await p.locator('#picker .opt[data-i="all"]').click();
  await p.waitForFunction(() => /^All changes/.test(document.querySelector('#picker-btn').innerText));
  await p.waitForFunction(() => document.querySelectorAll('#tree .tr[data-path]').length === 6);
  await finish(h);
});

test('review comments appear at their lines (read only)', async () => {
  const h = await start(); const p = h.page;
  await open(h);
  await p.click('#tree .tr[data-path$="LinkTask.cs"]');
  await p.waitForSelector('.cm .thread', { timeout: 5000 });
  assert.ok(await p.locator('.cm .thread').count() >= 2, 'a live thread and the outdated one');
  assert.match(await p.locator('.cm').first().innerText(), /\w/);
  await shot(p, 'desktop-comments');
  assert.equal(await p.locator('textarea').count(), 0, 'no posting yet');
  assert.ok(await p.locator('.fh >> text=💬').count() >= 1);
  await finish(h);
});

test('overview and commits tabs', async () => {
  const h = await start(); const p = h.page;
  await open(h);
  await p.click('.tabs a[data-tab=commits]');
  await p.waitForSelector('.commit');
  assert.equal(await p.locator('.commit').count(), 3);
  await p.click('.tabs a[data-tab=overview]');
  await p.waitForSelector('.stats');
  assert.match(await p.locator('.stats').innerText(), /3\s+commits/);
  await p.click('.tabs a[data-tab=commits]');
  await p.locator('.commit a:text("View changes")').first().click();
  await p.waitForSelector('#toolbar');
  await p.waitForFunction(() => /Commit 1 of 3/.test(document.querySelector('#picker-btn').innerText));
  assert.deepEqual(h.errors, []);
  await h.close();
});

test('external links open in a new tab', async () => {
  const h = await start(); const p = h.page;
  await open(h);
  const bad = await p.$$eval('a[href^="http"]', as => as.filter(a => a.target !== '_blank' || !/noopener/.test(a.rel)).map(a => a.href));
  assert.deepEqual(bad, []);
  assert.ok(await p.locator('a[href^="http"][target=_blank]').count() > 3);
  await finish(h);
});

test('binary and generated files are skipped with a load-anyway link', async () => {
  const h = await start(); const p = h.page;
  // add two fake files to the recorded PR file list
  const key = Object.keys(h.rec).find(u => /pulls\/135064\/files/.test(u));
  const list = JSON.parse(h.rec[key].body);
  const head = (JSON.parse(h.rec[Object.keys(h.rec).find(u => /pulls\/135064$/.test(u))].body)).head.sha;
  list.push({ filename: 'eng/package-lock.json', status: 'added', additions: 2, deletions: 0, changes: 2 }, { filename: 'eng/logo.png', status: 'added', additions: 0, deletions: 0, changes: 0 });
  h.rec[key].body = JSON.stringify(list);
  h.rec['https://raw.githubusercontent.com/dotnet/runtime/' + head + '/eng/package-lock.json'] = { status: 200, headers: { 'content-type': 'text/plain' }, body: '{\n  "lock": true\n}\n' };
  await open(h);
  await p.click('#tree .tr[data-path$="package-lock.json"]');
  await p.waitForSelector('.note:has-text("Generated file not loaded")');
  await p.click('.it:has-text("Generated file not loaded") a:text("Load anyway")');
  await p.waitForSelector('.row.add:has-text("lock")');
  await p.click('#tree .tr[data-path$="logo.png"]');
  await p.waitForSelector('.note:has-text("Binary file not loaded")');
  assert.deepEqual(h.misses, []);
  await h.close();
});

test('rate limit is explained', async () => {
  const h = await start(); const p = h.page;
  await h.ctx.route(/api\.github\.com/, r => r.fulfill({ status: 403, headers: { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'x-ratelimit-remaining, x-ratelimit-reset, x-ratelimit-limit', 'x-ratelimit-remaining': '0', 'x-ratelimit-limit': '60', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 1800) }, body: '{"message":"API rate limit exceeded for 1.2.3.4."}' }));
  await p.goto(h.base + PR);
  await p.waitForSelector('#banner:not([hidden])');
  const t = await p.locator('#banner').innerText();
  assert.match(t, /Rate limit reached/); assert.match(t, /60 requests per hour/); assert.match(t, /Sign in/);
  await shot(p, 'rate-limit');
  await p.click('#banner [data-act=signin]');
  await p.waitForSelector('#si-paste');
  await p.click('#si-paste');
  await p.locator('#dlg summary', { hasText: 'Paste a token' }).click();
  await p.fill('#tok', 'ghp_test_token');
  await p.click('#st-save');
  await p.waitForFunction(() => localStorage.getItem('prview.token') === 'ghp_test_token');
  await h.close();
});

test('landing: paste a PR URL', async () => {
  const h = await start(); const p = h.page;
  await p.goto(h.base);
  await p.fill('#land-in', 'not a url'); await p.keyboard.press('Enter');
  assert.match(await p.locator('#land-err').innerText(), /does not look like/);
  await shot(p, 'landing');
  await p.fill('#land-in', 'https://github.com/dotnet/runtime/pull/135064/files'); await p.keyboard.press('Enter');
  await p.waitForSelector('.fh');
  assert.match(await p.evaluate(() => location.hash), /^#\/dotnet\/runtime\/pull\/135064/);
  await finish(h);
});

test('phone: the tree is a drawer', async () => {
  const h = await start({ viewport: { width: 390, height: 844 }, mobile: true }); const p = h.page;
  await open(h);
  const left = () => p.evaluate(() => document.querySelector('#tree').getBoundingClientRect().right);
  assert.ok(await left() <= 0, 'tree hidden');
  await shot(p, 'phone-diff');
  await p.click('#menu');
  await p.waitForFunction(() => document.querySelector('#tree').getBoundingClientRect().right > 100);
  await p.waitForTimeout(400); // slide-in transition
  await shot(p, 'phone-tree');
  await p.click('#tree .tr[data-path$="LinkTask.cs"]');
  await p.waitForFunction(() => document.querySelector('#tree').getBoundingClientRect().right <= 0);
  assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no page-level horizontal scroll');
  await finish(h);
});
