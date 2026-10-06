// Records the GitHub responses the viewer needs for one PR by running the real app against the live API.
// Doubles as the live smoke test: node record-fixture.mjs [owner/repo#n] [out.json]
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import { serve } from './serve.mjs';
const target = process.argv[2] || 'dotnet/runtime#135064';
const [repo, num] = target.split('#');
const outFile = process.argv[3] || new URL('./fixtures/' + repo.replace('/', '-') + '-' + num + '.json', import.meta.url).pathname;
const { srv, port } = await serve();
const br = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
const ctx = await br.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: 'block' });
const rec = {};
await ctx.route(/^https:\/\/(api\.github\.com|raw\.githubusercontent\.com)\//, async route => {
  const res = await route.fetch();
  const body = await res.text();
  const h = res.headers();
  rec[route.request().url()] = { status: res.status(), headers: Object.fromEntries(['content-type', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset'].filter(k => h[k]).map(k => [k, h[k]])), body };
  await route.fulfill({ response: res, body });
});
const page = await ctx.newPage();
page.on('console', m => m.type() === 'error' && console.log('console error:', m.text()));
const log = (...a) => console.log(...a);
await page.goto('http://localhost:' + port + '/prview/#/' + repo + '/pull/' + num);
await page.waitForSelector('.fh', { timeout: 60000 });
log('title:', await page.locator('#prhead h1').innerText());
// walk every file so each one is fetched
const n = await page.locator('#tree .tr[data-path]').count();
log('files in tree window:', n, ' count text:', await page.locator('#count').innerText());
for (let i = 0; i < 40; i++) { await page.keyboard.press('j'); await page.waitForTimeout(400); }
await page.waitForTimeout(1500);
// one commit view
await page.click('#picker-btn');
await page.locator('#picker .opt[data-i="1"]').click();
await page.waitForTimeout(3000);
for (let i = 0; i < 12; i++) { await page.keyboard.press('j'); await page.waitForTimeout(400); }
await page.waitForTimeout(1500);
log('requests recorded:', Object.keys(rec).length);
fs.mkdirSync(new URL('./fixtures/', import.meta.url).pathname, { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(rec));
log('wrote', outFile, (fs.statSync(outFile).size / 1024).toFixed(0) + ' KB');
await br.close(); srv.close();
