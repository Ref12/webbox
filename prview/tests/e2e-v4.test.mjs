// v4: the phone layout: one compact bar over the file, everything else in the drawer. Desktop is checked to be unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { start, PR, ME } from './harness.mjs';

const SHOTS = new URL('../docs/screenshots/', import.meta.url).pathname;
fs.mkdirSync(SHOTS, { recursive: true });
const shot = (p, name) => p.screenshot({ path: SHOTS + name + '.png' });
const LINK = 'src/tools/illink/src/ILLink.Tasks/LinkTask.cs';
const PHONE = { view: null, viewport: { width: 390, height: 844 }, mobile: true };
const finish = async h => { assert.deepEqual(h.misses, [], 'unrecorded requests'); assert.deepEqual(h.errors, [], 'page errors'); await h.close(); };
async function open(h, hash = PR, sel = '#tree .tr[data-path]') {
  await h.page.goto(h.base + hash);
  await h.page.waitForSelector('#pbar', { timeout: 15000 });
  await h.page.waitForSelector(sel, { state: 'attached', timeout: 15000 });
}
const openDrawer = async p => { await p.evaluate(() => { document.body.classList.add('drawer'); document.querySelector('#dbottom').open = true; }); await p.waitForTimeout(300); };
const drawerOpen = p => p.evaluate(() => document.body.classList.contains('drawer') && document.querySelector('#drawer').getBoundingClientRect().right > 100);
const visible = p => p.evaluate(() => {
  const out = [];
  for (const id of ['#top', '#prhead', '#toolbar', '#pbar', '#diff']) { const e = document.querySelector(id); if (!e) continue; const r = e.getBoundingClientRect(), cs = getComputedStyle(e); out.push({ id, shown: cs.display !== 'none' && r.height > 0, top: r.top, h: r.height }); }
  return out;
});
function mockUser(h) { h.on('GET', /api\.github\.com\/user$/, () => ({ login: ME.login, name: ME.name, avatar_url: ME.avatar_url })); }

test('phone: only the compact bar sits above the diff; the diff starts within 56 px', async () => {
  const h = await start(PHONE); const p = h.page;
  await open(h, PR + '?f=' + LINK, '.row');
  const v = Object.fromEntries((await visible(p)).map(x => [x.id, x]));
  assert.ok(v['#pbar'].shown && v['#diff'].shown);
  for (const id of ['#top', '#prhead', '#toolbar']) assert.equal(v[id].shown, false, id + ' hidden on a phone');
  assert.ok(v['#diff'].top <= 56, 'diff starts at ' + v['#diff'].top);
  // above the diff: only menu, file name, prev, next
  const kids = await p.$$eval('#pbar > *', els => els.map(e => e.id));
  assert.deepEqual(kids, ['pbar-menu', 'pbar-name', 'pbar-prev', 'pbar-next']);
  assert.ok(await p.evaluate(() => { const hdr = document.querySelector('#main').firstElementChild; return hdr.id === 'pbar'; }));
  assert.ok(await p.locator('#pbar-menu svg.tree-icon').count() === 1);
  assert.equal(await p.locator('#filter').isVisible(), false);
  assert.equal(await p.locator('.tabs').isVisible(), false);
  assert.equal(await p.locator('#m-split').isVisible(), false);
  assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await shot(p, 'phone-compact-bar');
  await finish(h);
});

test('phone: the file name is truncated from the left so the file name stays visible', async () => {
  const h = await start(PHONE); const p = h.page;
  await open(h, PR + '?f=' + LINK, '.row');
  const r = await p.evaluate(() => { const n = document.querySelector('#pbar-name'); return { dir: getComputedStyle(n).direction, over: n.scrollWidth > n.clientWidth, text: n.textContent, title: n.title }; });
  assert.equal(r.dir, 'rtl'); assert.equal(r.text, LINK); assert.equal(r.title, LINK);
  // the end of the path is what shows: scrolled to the right edge
  assert.ok(await p.evaluate(() => { const n = document.querySelector('#pbar-name'), b = n.querySelector('bdi'), rb = b.getBoundingClientRect(), rn = n.getBoundingClientRect(); return rb.right <= rn.right + 1; }));
  await finish(h);
});

test('phone: opening a PR starts with the drawer open on the file list, no file open', async () => {
  const h = await start(PHONE); const p = h.page;
  await open(h);
  await p.waitForTimeout(400);
  assert.equal(await drawerOpen(p), true);
  assert.ok((await p.locator('#tree .tr[data-path]').count()) >= 6);
  assert.match(await p.locator('#drawer').innerText(), /ILLink task output ownership/);
  assert.equal(await p.evaluate(() => /f=/.test(location.hash)), false, 'no file in the URL until one is chosen');
  await shot(p, 'phone-drawer-files');
  await finish(h);
});

test('phone: f= opens that file directly with the drawer closed', async () => {
  const h = await start(PHONE); const p = h.page;
  await open(h, PR + '?f=' + LINK, '.row');
  assert.equal(await p.evaluate(() => document.body.classList.contains('drawer')), false);
  assert.equal(await p.evaluate(() => window.__prview.state.selected), LINK);
  assert.equal(await p.locator('#pbar-name').innerText(), LINK);
  await finish(h);
});

test('phone: choosing a file closes the drawer and shows it; prev / next in the bar', async () => {
  const h = await start(PHONE); const p = h.page;
  await open(h);
  await p.waitForTimeout(300);
  const paths = await p.$$eval('#tree .tr[data-path]', els => els.map(e => e.dataset.path));
  await p.click('#tree .tr[data-path="' + paths[2] + '"]');
  await p.waitForFunction(() => document.querySelector('#drawer').getBoundingClientRect().right <= 0);
  assert.equal(await p.evaluate(() => window.__prview.state.selected), paths[2]);
  await p.waitForSelector('.row');
  assert.equal(await p.locator('#pbar-name').innerText(), paths[2]);
  await p.click('#pbar-next');
  assert.equal(await p.evaluate(() => window.__prview.state.selected), paths[3]);
  await p.click('#pbar-prev'); await p.click('#pbar-prev');
  assert.equal(await p.evaluate(() => window.__prview.state.selected), paths[1]);
  await p.click('#pbar-menu');
  await p.waitForFunction(() => document.querySelector('#drawer').getBoundingClientRect().right > 100);
  await p.keyboard.press('Escape');
  await p.waitForFunction(() => document.querySelector('#drawer').getBoundingClientRect().right <= 0);
  await finish(h);
});

test('phone: everything that moved is reachable in the drawer', async () => {
  const h = await start({ ...PHONE, signedIn: true }); const p = h.page; mockUser(h);
  h.on('POST', /api\.github\.com\/graphql/, () => ({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } } }));
  await open(h);
  await p.waitForTimeout(300);
  const d = p.locator('#drawer');
  // compact PR header: title, number, state, author, base <- head
  const head = await p.locator('#dtop .dpr').innerText();
  assert.match(head, /ILLink task output ownership/); assert.match(head, /#135064/); assert.match(head, /Open|Merged|Closed|Draft/i); assert.match(head, /main/);
  // details expand to the description (safe Markdown)
  assert.equal(await p.locator('#d-details .desc').isVisible(), false);
  await p.click('#d-details summary');
  assert.equal(await p.locator('#d-details .desc').isVisible(), true);
  assert.equal(await p.locator('#d-details .desc script, #d-details .desc img').count(), 0);
  // tabs
  assert.equal(await p.locator('.dtabs a').count(), 3);
  // filter
  await p.fill('#dfilter', 'LinkTask');
  await p.waitForFunction(() => document.querySelectorAll('#tree .tr[data-path]').length === 1);
  assert.match(await p.locator('#d-count').innerText(), /files/);
  await p.fill('#dfilter', '');
  await p.waitForFunction(() => document.querySelectorAll('#tree .tr[data-path]').length >= 6);
  // view options, GitHub link, settings, token / sign out
  await p.click('#dbottom summary');
  for (const sel of ['#d-inline', '#d-split', '#d-stack', '#d-full', '#d-picker', '#d-cm', '#d-settings', '#d-out']) assert.equal(await p.locator(sel).isVisible(), true, sel);
  assert.equal(await p.locator('#dbottom a[href^="https://github.com/dotnet/runtime/pull/"]').count(), 1);
  await shot(p, 'phone-drawer-options');
  // side-by-side from the drawer; inline is the phone default
  assert.equal(await p.evaluate(() => window.__prview.state && document.querySelector('#d-inline').classList.contains('on')), true);
  await p.click('#d-split');
  assert.equal(await p.evaluate(() => localStorage.getItem('prview.mode-phone')), '"split"');
  await p.click('#d-inline');
  // stacked from the drawer
  await p.check('#d-stack');
  await p.waitForFunction(() => window.__prview.state.view === 'all');
  assert.equal(await p.evaluate(() => document.body.classList.contains('drawer')), false);
  await openDrawer(p);
  await p.uncheck('#d-stack');
  await p.waitForFunction(() => window.__prview.state.view === 'one');
  // settings dialog from the drawer
  await openDrawer(p);
  await p.click('#d-settings'); await p.waitForSelector('#dlg #st-stack'); await p.click('#st-close');
  // comments panel from the drawer
  await openDrawer(p);
  await p.click('#d-cm');
  await p.waitForSelector('#cpanel:not([hidden])');
  const b = await p.locator('#cpanel').boundingBox(); assert.ok(b.x >= 0 && b.x + b.width <= 391);
  await h.close();
});

test('phone: signed out shows "Add a GitHub token" in the drawer; Overview and Commits render with the drawer switch', async () => {
  const h = await start(PHONE); const p = h.page; mockUser(h);
  h.on('GET', /\/issues\/135064\/comments/, () => []);
  await open(h);
  await p.click('#dbottom summary');
  await p.click('#d-in'); await p.waitForSelector('#dlg #tok'); await p.click('#si-cancel');
  await p.click('#pbar-menu').catch(() => {});
  await p.waitForTimeout(250);
  await p.click('.dtabs a[data-dtab=overview]');
  await p.waitForSelector('.page .stats');
  assert.equal(await p.locator('#drawer').isVisible(), true);
  assert.equal(await p.locator('#pbar-name').innerText(), 'Overview');
  { const y = (await p.locator('.page').boundingBox()).y; assert.ok(y <= 56, 'page at ' + y); }
  await shot(p, 'phone-overview');
  await p.click('#pbar-menu'); await p.waitForTimeout(250);
  await p.click('.dtabs a[data-dtab=commits]');
  await p.waitForSelector('.commit');
  await p.click('#pbar-menu'); await p.waitForTimeout(250);
  await p.click('.dtabs a[data-dtab=files]');
  await p.waitForSelector('#tree .tr[data-path]', { state: 'attached' });
  await finish(h);
});

test('phone: the comments panel and the composer still fit; side-by-side defaults to inline', async () => {
  const h = await start({ ...PHONE, signedIn: true }); const p = h.page; mockUser(h);
  h.on('POST', /api\.github\.com\/graphql/, () => ({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } } }));
  await p.addInitScript(() => { if (!sessionStorage.getItem('__m')) { sessionStorage.setItem('__m', '1'); localStorage.setItem('prview.mode', '"split"'); } });
  await open(h, PR + '?f=' + LINK, '.row');
  assert.equal(await p.evaluate(() => document.querySelector('.row.split') === null), true, 'desktop split choice does not leak to the phone');
  await finish(h);
});

test('desktop is unchanged: top bar, PR header, tabs and toolbar stay; no compact bar, no drawer', async () => {
  const h = await start({ view: null }); const p = h.page;
  await p.goto(h.base + PR); await p.waitForSelector('.row');
  const v = Object.fromEntries((await visible(p)).map(x => [x.id, x]));
  for (const id of ['#top', '#prhead', '#toolbar', '#diff']) assert.equal(v[id].shown, true, id);
  assert.equal(v['#pbar'].shown, false);
  assert.equal(await p.locator('.tabs').isVisible(), true);
  assert.equal(await p.locator('#tree').isVisible(), true);
  assert.equal(await p.locator('#dbottom').isVisible(), false);
  assert.equal(await p.locator('#filter').isVisible(), true);
  await finish(h);
});
