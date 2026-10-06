// ?threads=1 on the Cloudflare-like server. .NET 10's threaded runtime does not start inside a Worker (see README), so the page must fall back to the normal runtime and still work.
//   node threads.mjs <_cf_site>
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const site = path.resolve(process.argv[2] ?? '../../../_cf_site'), port = 8131;
const server = spawn(process.execPath, [path.resolve('..', 'cf-sim.mjs'), site, String(port)], { stdio: 'inherit' });
await new Promise((r) => setTimeout(r, 800));
const exe = process.env.CHROME_PATH || ['/usr/bin/chromium', '/usr/bin/google-chrome'].find((p) => fs.existsSync(p));
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const page = await (await browser.newContext()).newPage();
page.on('console', (m) => { if (/rror|xception/.test(m.text())) console.log('[browser]', m.text().slice(0, 300)); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
let bytes = 0; page.on('response', async (r) => { try { bytes += Number((await r.allHeaders())['content-length'] || 0); } catch {} });
const t0 = Date.now();
await page.goto('http://localhost:' + port + '/csharp/?threads=1');
await page.waitForFunction(() => window.__metrics?.ready || window.__metrics?.error, null, { timeout: 200000 });
const m = await page.evaluate(() => window.__metrics);
console.log('ready after', Date.now() - t0, 'ms; MB on the wire so far', (bytes / 1048576).toFixed(1), JSON.stringify({ err: m.error, threads: m.threads, cores: m.cores, isolated: m.crossOriginIsolated, firstResultMs: m.firstResultMs }));
assert.equal(m.error, undefined, m.error);
assert.equal(m.crossOriginIsolated, true);
assert.ok(m.threadsFailed, 'the threaded runtime is reported as failed');
await page.evaluate(() => window.__submit('Enumerable.Range(1, 4).Sum()'));
assert.equal((await page.locator('.entry').last().locator('.val').innerText()).trim(), '10', 'REPL works after the fallback');
console.log('threads=1 fell back:', m.threadsFailed, '| REPL works | ready after', Date.now() - t0, 'ms');
await browser.close(); server.kill();
console.log('THREADS FALLBACK OK');
