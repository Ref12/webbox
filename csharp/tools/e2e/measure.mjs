// Cold-load measurement under a Pages-like server and throttled network, for the three ways of delivering the binaries.
// Usage: node measure.mjs <stagedSite> [out.json]
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
const site = path.resolve(process.argv[2] ?? '../../_site');
const exe = process.env.CHROME_PATH || ['/usr/bin/chromium', '/usr/bin/google-chrome'].find((p) => fs.existsSync(p));
const profiles = { 'cable 25 Mbit/s, 20 ms': { down: 25e6 / 8, latency: 20 }, 'mobile 8 Mbit/s, 60 ms': { down: 8e6 / 8, latency: 60 } };
const modes = [
  { name: 'A  .br decoded in the page (shipped)', gzip: 'text', query: '' },
  { name: 'B  plain files, Pages gzips them (if it does)', gzip: 'all', query: '?nobr=1' },
  { name: 'C  plain files, no compression of wasm/dll/bin', gzip: 'text', query: '?nobr=1' },
];
const results = [];
let port = 8300;
for (const mode of modes) {
  const p = port++;
  const server = spawn(process.execPath, [path.resolve('..', 'pages-sim.mjs'), site, String(p), '/webbox', '--gzip=' + mode.gzip], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 600));
  const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
  for (const [pname, prof] of Object.entries(profiles)) {
    const ctx = await browser.newContext({ viewport: { width: 1100, height: 780 } });
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: prof.latency, downloadThroughput: prof.down, uploadThroughput: prof.down });
    const urls = new Map(); let wire = 0, first = 0, total = 0;
    cdp.on('Network.requestWillBeSent', (e) => urls.set(e.requestId, e.request.url));
    cdp.on('Network.loadingFinished', (e) => { const u = urls.get(e.requestId) || ''; if (!u.startsWith('http://localhost')) return; total += e.encodedDataLength; if (!window_ready) wire += e.encodedDataLength; });
    let window_ready = false;
    const t0 = Date.now();
    await page.goto('http://localhost:' + p + '/webbox/csharp/' + mode.query);
    await page.waitForFunction(() => window.__metrics?.ready || window.__metrics?.error, null, { timeout: 600000 });
    const m1 = await page.evaluate(() => window.__metrics);
    window_ready = true; first = m1.marks.firstResult;
    await page.waitForFunction(() => window.__metrics?.marks.intellisenseReady || window.__metrics?.intellisenseError, null, { timeout: 600000 });
    const m2 = await page.evaluate(() => window.__metrics);
    const row = { mode: mode.name, profile: pname, error: m1.error || m2.intellisenseError, firstResultMs: first, intellisenseReadyMs: m2.marks.intellisenseReady, mbToFirstResult: +(wire / 1048576).toFixed(2), mbTotal: +(total / 1048576).toFixed(2) };
    console.log(JSON.stringify(row));
    results.push(row);
    // warm reload (caches populated)
    const t1 = Date.now(); let w2 = 0; cdp.removeAllListeners?.('Network.loadingFinished');
    await page.goto('http://localhost:' + p + '/webbox/csharp/' + mode.query);
    await page.waitForFunction(() => window.__metrics?.ready, null, { timeout: 600000 });
    row.warmFirstResultMs = await page.evaluate(() => window.__metrics.marks.firstResult);
    await ctx.close();
  }
  await browser.close(); server.kill();
}
fs.writeFileSync(path.resolve(process.argv[3] ?? 'measure.json'), JSON.stringify(results, null, 1));
