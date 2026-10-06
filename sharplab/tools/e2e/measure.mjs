// Cold-load measurement under a Pages-like server and throttled network, for the three ways of delivering the binaries (adapted from csharp/tools/e2e/measure.mjs).
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
let port = 8400;
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
for (const mode of modes) {
  const p = port++;
  const server = spawn(process.execPath, [path.resolve('..', 'pages-sim.mjs'), site, String(p), '/webbox', '--gzip=' + mode.gzip], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 600));
  for (const [pname, prof] of Object.entries(profiles)) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 } });
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: prof.latency, downloadThroughput: prof.down, uploadThroughput: prof.down });
    const urls = new Map(); let wire = 0, ready = false;
    cdp.on('Network.requestWillBeSent', (e) => urls.set(e.requestId, e.request.url));
    cdp.on('Network.loadingFinished', (e) => { const u = urls.get(e.requestId) || ''; if (u.startsWith('http://localhost') && !ready) wire += e.encodedDataLength; });
    await page.goto('http://localhost:' + p + '/webbox/sharplab/' + mode.query);
    await page.waitForFunction(() => window.__metrics?.marks?.firstView || window.__metrics?.error, null, { timeout: 600000 });
    ready = true;
    const m = await page.evaluate(() => window.__metrics);
    const row = { mode: mode.name, profile: pname, error: m.error, firstViewMs: m.marks.firstView, mbToFirstView: +(wire / 1048576).toFixed(2) };
    await page.goto('http://localhost:' + p + '/webbox/sharplab/' + mode.query);   // warm: caches populated
    await page.waitForFunction(() => window.__metrics?.marks?.firstView, null, { timeout: 600000 });
    row.warmFirstViewMs = await page.evaluate(() => window.__metrics.marks.firstView);
    console.log(JSON.stringify(row)); results.push(row);
    await ctx.close();
  }
  server.kill();
}
await browser.close();
fs.writeFileSync(path.resolve(process.argv[3] ?? '../../docs/pages-measure.json'), JSON.stringify(results, null, 1));
