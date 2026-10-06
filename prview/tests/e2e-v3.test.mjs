// v3: one file at a time is the default; the stacked view is a setting; file navigation; the tree icon; the signed-out comment hint.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { start, PR, ME } from './harness.mjs';

const SHOTS = new URL('../docs/screenshots/', import.meta.url).pathname;
fs.mkdirSync(SHOTS, { recursive: true });
const shot = (p, name) => p.screenshot({ path: SHOTS + name + '.png' });
const LINK = 'src/tools/illink/src/ILLink.Tasks/LinkTask.cs';

async function open(h, hash = PR) {
  await h.page.goto(h.base + hash);
  await h.page.waitForSelector('.fh', { timeout: 15000 });
  await h.page.waitForSelector('.row', { timeout: 15000 });
}
const finish = async h => { assert.deepEqual(h.misses, [], 'unrecorded requests'); assert.deepEqual(h.errors, [], 'page errors'); await h.close(); };
const heads = p => p.$$eval('#win .fh', els => els.map(e => e.closest('[data-path]') ? e.closest('[data-path]').dataset.path : e.textContent));
const selected = p => p.evaluate(() => window.__prview.state.selected);
const treePaths = p => p.$$eval('#tree .tr[data-path]', els => els.map(e => e.dataset.path));
function mockUser(h) { h.on('GET', /api\.github\.com\/user$/, () => ({ login: ME.login, name: ME.name, avatar_url: ME.avatar_url })); }

test('default: one file at a time (desktop), the first file, nothing stacked', async () => {
  const h = await start({ view: null }); const p = h.page;
  await open(h);
  assert.equal((await heads(p)).length, 1, 'one file header only');
  const first = (await treePaths(p))[0];
  assert.equal(await selected(p), first);
  assert.match(await p.locator('#view-btn').innerText(), /One file/);
  assert.doesNotMatch(await p.evaluate(() => location.hash), /v=all/);
  await shot(p, 'desktop-one-file');
  await finish(h);
});

test('default: one file at a time on the phone too', async () => {
  const h = await start({ view: null, viewport: { width: 390, height: 844 }, mobile: true }); const p = h.page;
  await open(h);
  assert.equal((await heads(p)).length, 1);
  await finish(h);
});

test('f= opens that file; v=all stacks; v=one wins over a stacked setting', async () => {
  const h = await start({ view: null }); const p = h.page;
  await open(h, PR + '?f=' + LINK);
  assert.equal(await selected(p), LINK);
  assert.equal((await heads(p)).length, 1);
  assert.match((await p.locator('#win').innerText()), /LinkTask/);
  await p.goto(h.base + PR + '?v=all'); await p.waitForSelector('.fh'); await p.waitForSelector('.row');
  await p.waitForFunction(() => window.__prview.state.view === 'all' && window.__prview.state.items.filter(i => i.type === 'head').length > 1);
  await h.close();
  const h2 = await start({ view: 'all' });
  await open(h2, PR + '?v=one');
  assert.equal((await heads(h2.page)).length, 1);
  await h2.close();
});

test('Settings: All files stacked is an option, remembered in localStorage and in the URL logic', async () => {
  const h = await start({ view: null }); const p = h.page;
  await open(h);
  await p.click('#settings-btn');
  assert.equal(await p.locator('#st-stack').isChecked(), false);
  await shot(p, 'settings');
  await p.check('#st-stack');
  await p.click('#st-close');
  await p.waitForFunction(() => document.querySelectorAll('#win .fh').length > 1);
  assert.equal(await p.evaluate(() => localStorage.getItem('prview.view')), '"all"');
  // remembered: reload without v= stays stacked
  await p.goto(h.base + PR); await p.reload(); await p.waitForSelector('.fh');
  await p.waitForFunction(() => document.querySelectorAll('#win .fh').length > 1);
  assert.doesNotMatch(await p.evaluate(() => location.hash), /v=/);
  // and back
  await p.click('#settings-btn'); await p.uncheck('#st-stack'); await p.click('#st-close');
  await p.waitForFunction(() => document.querySelectorAll('#win .fh').length === 1);
  assert.equal(await p.evaluate(() => localStorage.getItem('prview.view')), '"one"');
  await finish(h);
});

test('Settings has the one / all switch on the phone', async () => {
  const h = await start({ view: null, viewport: { width: 390, height: 844 }, mobile: true }); const p = h.page;
  await open(h);
  await p.click('#settings-btn');
  await p.check('#st-stack'); await p.click('#st-close');
  await p.waitForFunction(() => document.querySelectorAll('#win .fh').length > 1);
  await p.click('#settings-btn'); await p.uncheck('#st-stack'); await p.click('#st-close');
  await p.waitForFunction(() => document.querySelectorAll('#win .fh').length === 1);
  await finish(h);
});

test('next / previous file: j and k, the buttons, the position label', async () => {
  const h = await start({ view: null }); const p = h.page;
  await open(h);
  const paths = await treePaths(p);
  assert.equal(await p.locator('#file-pos').innerText(), '1 / ' + paths.length);
  assert.equal(await p.locator('#prev-file').isDisabled(), true);
  await p.keyboard.press('j');
  assert.equal(await selected(p), paths[1]);
  assert.equal((await heads(p)).length, 1);
  assert.equal(await p.locator('#file-pos').innerText(), '2 / ' + paths.length);
  await p.click('#next-file');
  assert.equal(await selected(p), paths[2]);
  await p.click('#prev-file');
  assert.equal(await selected(p), paths[1]);
  await p.keyboard.press('k');
  assert.equal(await selected(p), paths[0]);
  await p.keyboard.press('k');
  assert.equal(await selected(p), paths[0], 'stays on the first file');
  for (let i = 0; i < paths.length + 2; i++) await p.keyboard.press('j');
  assert.equal(await selected(p), paths[paths.length - 1]);
  assert.equal(await p.locator('#next-file').isDisabled(), true);
  assert.match(await p.evaluate(() => location.hash), /f=/);
  await finish(h);
});

test('phone: swipe changes the file; the drawer has the tree icon', async () => {
  const h = await start({ view: null, viewport: { width: 390, height: 844 }, mobile: true }); const p = h.page;
  await open(h);
  const paths = await treePaths(p);
  // the toggle is an inline SVG tree icon in currentColor, not the ☰ glyph
  const ic = await p.evaluate(() => { const b = document.querySelector('#menu'), s = b.querySelector('svg.tree-icon'); return { text: b.textContent.trim(), svg: !!s, stroke: s && getComputedStyle(s).stroke, color: getComputedStyle(b).color, w: s && s.getBoundingClientRect().width }; });
  assert.equal(ic.text, ''); assert.ok(ic.svg); assert.equal(ic.stroke, ic.color); assert.ok(ic.w >= 16 && ic.w <= 24);
  assert.ok((await p.locator('#menu').boundingBox()).width >= 24);
  // swipe left: next file
  await p.evaluate(() => {
    const el = document.querySelector('#diff');
    const mk = (type, x, y) => { const t = new Touch({ identifier: 1, target: el, clientX: x, clientY: y }); el.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === 'touchend' ? [] : [t], changedTouches: [t] })); };
    mk('touchstart', 300, 400); mk('touchend', 100, 410);
  });
  assert.equal(await selected(p), paths[1]);
  await p.evaluate(() => {
    const el = document.querySelector('#diff');
    const mk = (type, x, y) => { const t = new Touch({ identifier: 1, target: el, clientX: x, clientY: y }); el.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === 'touchend' ? [] : [t], changedTouches: [t] })); };
    mk('touchstart', 100, 400); mk('touchend', 300, 400);
  });
  assert.equal(await selected(p), paths[0]);
  // the drawer picks a file
  await p.click('#menu');
  await p.waitForFunction(() => document.querySelector('#tree').getBoundingClientRect().right > 100);
  await p.waitForTimeout(400);
  await shot(p, 'phone-tree');
  await p.click('#tree .tr[data-path$="LinkTask.cs"]');
  await p.waitForFunction(() => document.querySelector('#tree').getBoundingClientRect().right <= 0);
  assert.equal(await selected(p), LINK);
  assert.equal((await heads(p)).length, 1);
  await shot(p, 'phone-diff');
  await finish(h);
});

test('tree icon: inline SVG, currentColor, light and dark', async () => {
  for (const scheme of ['light', 'dark']) {
    const h = await start({ view: null, viewport: { width: 390, height: 844 }, mobile: true }); const p = h.page;
    await p.emulateMedia({ colorScheme: scheme });
    await open(h);
    const r = await p.evaluate(() => { const b = document.querySelector('#menu'), s = b.querySelector('svg'); const html = s.outerHTML; return { color: getComputedStyle(b).color, stroke: getComputedStyle(s).stroke, bg: getComputedStyle(document.body).backgroundColor, html }; });
    assert.equal(r.stroke, r.color, scheme + ': follows currentColor');
    assert.match(r.html, /stroke="currentColor"/);
    assert.notEqual(r.color, r.bg, scheme + ': visible against the page');
    await p.locator('#menu').screenshot({ path: SHOTS + 'tree-icon-' + scheme + '.png' });
    await h.close();
  }
});

test('comments panel jumps to the file and line in one-file mode', async () => {
  const h = await start({ view: null }); const p = h.page;
  await open(h);
  const first = await selected(p);
  await p.click('#cm-btn');
  await p.waitForSelector('#cpanel .pt');
  const target = await p.evaluate(() => { const s = window.__prview.state; const t = s.cAll.find(t => !t.outdated && t.line && t.path !== s.selected) || s.cAll.find(t => !t.outdated && t.line); return { id: String(t.id), path: t.path, line: t.line }; });
  await p.click('#cpanel [data-jump="' + target.id + '"]');
  await p.waitForSelector('#win [data-tid="' + target.id + '"]', { timeout: 8000 });
  assert.equal(await selected(p), target.path);
  assert.equal((await heads(p)).length, 1);
  if (target.path !== first) assert.notEqual(first, await selected(p));
  await shot(p, 'comments-jump-one-file');
  await finish(h);
});

test('signed out: the + is a dimmed hint that opens the token dialog; replies say so too', async () => {
  const h = await start({ view: null }); const p = h.page;
  await open(h, PR + '?f=' + LINK);
  await p.waitForSelector('#win .addc.hint', { state: 'attached', timeout: 10000 });
  const hint = p.locator('#win .addc.hint').first();
  assert.equal(await hint.getAttribute('title'), 'Add a GitHub token to comment');
  assert.equal(await p.locator('#win .addc:not(.hint)').count(), 0);
  const op = await hint.evaluate(e => getComputedStyle(e).opacity);
  assert.ok(Number(op) > 0 && Number(op) < 0.6, 'dimmed but present: ' + op);
  const row = p.locator('#win [data-cl]:has(.addc.hint)').first();
  await row.hover();
  await shot(p, 'comment-hint-signed-out');
  await hint.click();
  await p.waitForSelector('#dlg #tok');
  assert.match(await p.locator('#dlg').innerText(), /Add a GitHub token/);
  await p.click('#si-cancel');
  // threads: a sign-in prompt instead of the reply box
  await p.evaluate(() => { const s = window.__prview.state; s.view = 'one'; });
  await finish(h);
});

test('signed out: thread reply hint opens the token dialog', async () => {
  const h = await start({ view: null }); const p = h.page;
  await open(h);
  await p.click('#cm-btn'); await p.waitForSelector('#cpanel .pt');
  await p.click('#cpanel .pt >> nth=0');
  await p.waitForSelector('#win .hint-reply', { timeout: 8000 });
  assert.equal(await p.locator('#win textarea').count(), 0);
  await p.locator('#win .hint-reply').first().click();
  await p.waitForSelector('#dlg #tok');
  await finish(h);
});

test('signed in: the real + stays, no hint', async () => {
  const h = await start({ view: null, signedIn: true }); const p = h.page; mockUser(h);
  h.on('POST', /api\.github\.com\/graphql/, () => ({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } } }));
  await open(h, PR + '?f=' + LINK);
  await p.waitForSelector('#win .addc', { state: 'attached', timeout: 10000 });
  assert.equal(await p.locator('#win .addc.hint').count(), 0);
  await h.close();
});
