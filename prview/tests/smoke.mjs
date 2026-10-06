// Live smoke test against a real public PR (anonymous, uses a few of the 60 API requests per hour).
// node smoke.mjs [owner/repo#n]   (default: dotnet/runtime#135064: 6 files, 3 commits, review comments)
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { serve } from './serve.mjs';
const [repo, num] = (process.argv[2] || 'dotnet/runtime#135064').split('#');
const { srv, port } = await serve();
const br = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
const p = await (await br.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: 'block' })).newPage();
const errors = []; p.on('pageerror', e => errors.push(e.message));
await p.goto('http://localhost:' + port + '/prview/#/' + repo + '/pull/' + num);
await p.waitForSelector('.row', { timeout: 60000 });
const title = await p.locator('#prhead h1').innerText();
const count = await p.locator('#count').innerText();
const rate = await p.locator('#rate').innerText();
await p.click('#tree .tr[data-path$="LinkTask.cs"]');
await p.waitForSelector('.cm .thread', { timeout: 20000 });
await p.waitForTimeout(800);
await p.screenshot({ path: new URL('../docs/screenshots/live-smoke.png', import.meta.url).pathname });
console.log({ title, count, rate, rows: await p.locator('.row').count(), threads: await p.locator('.cm .thread').count(), errors });
assert.match(title, /ILLink/); assert.match(count, /6 changed files/); assert.deepEqual(errors, []);
await br.close(); srv.close();
console.log('live smoke ok');
