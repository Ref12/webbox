// Live check of a deployed host.  node live.mjs <baseUrl e.g. https://webbox.ref12cf.workers.dev | https://ref12labs.github.io/webbox> <csharp|fuget|sharplab|hexad|all>
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const base = process.argv[2].replace(/\/$/, ''), which = process.argv[3] || 'all';
const exe = ['/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => fs.existsSync(p));
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const out = {};
async function open(name) {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 780 } });
  const page = await ctx.newPage();
  const reqs = new Map(), errors = [], bad = [];
  // context-level: also sees the requests of the dedicated workers (the .NET runtimes)
  ctx.on('requestfinished', async (rq) => { try { const rs = await rq.response(); const h = await rs.allHeaders(); const sz = await rq.sizes();
    reqs.set(rq, { url: rq.url(), status: rs.status(), enc: h['content-encoding'] || '', type: (h['content-type'] || '').split(';')[0], len: sz.responseBodySize + sz.responseHeadersSize, raw: Number(h['content-length'] || 0) }); } catch {} });
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message.slice(0, 200)));
  ctx.on('response', (r) => { if (r.status() >= 400) bad.push(r.status() + ' ' + r.url().slice(0, 120)); });
  const wire = (re) => { const l = [...reqs.values()].filter((r) => re.test(r.url)); return { files: l.length, mb: +(l.reduce((s, r) => s + r.len, 0) / 1048576).toFixed(2), enc: [...new Set(l.map((r) => r.enc || 'none'))].join('+'), types: [...new Set(l.map((r) => r.type))].join(',') }; };
  return { page, ctx, reqs, errors, bad, wire, name };
}
async function csharp() {
  const t = await open('csharp'); const { page } = t; const res = {};
  const t0 = Date.now();
  await page.goto(base + '/csharp/');
  await page.waitForFunction(() => window.__metrics?.ready || window.__metrics?.error, null, { timeout: 240000 });
  let m = await page.evaluate(() => window.__metrics);
  if (m.error) throw new Error(m.error);
  res.firstResultMs = Date.now() - t0;
  await page.waitForTimeout(300); res.wireAtFirstResult = t.wire(/./).mb;
  await page.evaluate(() => window.__submit('1 + 2'));
  res.firstEval = (await page.locator('.entry').last().innerText()).includes('3');
  await page.waitForFunction(() => window.__metrics?.marks.intellisenseReady || window.__metrics?.intellisenseError, null, { timeout: 300000 });
  m = await page.evaluate(() => window.__metrics);
  res.intellisenseMs = Date.now() - t0; res.intellisenseError = m.intellisenseError;
  res.isolated = m.crossOriginIsolated;
  const comp = await page.evaluate(async () => { const a = performance.now(); const r = await window.__intelli('Complete', 'Console.Wri', 11, ''); return { ms: Math.round(performance.now() - a), n: r?.items?.length ?? r?.length ?? 0 }; });
  res.completion = comp;
  res.wireTotal = t.wire(/./).mb;
  res.wasm = t.wire(/\.wasm(\?|$)/); res.dll = t.wire(/\.dll(\?|$)/); res.bin = t.wire(/\.(bin|br)(\?|$)/); res.js = t.wire(/\.js(\?|$)/);
  res.dat = t.wire(/\.dat(\?|$)/);
  // Stop
  await page.evaluate(() => window.__submit('var kept = 7;'));
  await page.evaluate(() => { window.__long = window.__submit('while (true) { }'); });
  await page.waitForSelector('#stop:not([hidden])', { timeout: 20000 });
  await page.waitForTimeout(500);
  const ts = Date.now();
  await page.click('#stop');
  await page.waitForFunction(() => document.querySelector('#stop').hidden && !document.querySelector('#run').disabled, null, { timeout: 120000 });
  res.stopMs = Date.now() - ts;
  await page.evaluate(() => window.__submit('kept * 6'));
  res.recovered = (await page.locator('.entry').last().locator('.val').innerText()).trim() === '42';
  // NuGet
  const tn = Date.now();
  await page.evaluate(() => window.__submit('#r "nuget: Humanizer.Core, 2.14.1"\nusing Humanizer;\n"on demand".Pascalize()'));
  res.nuget = (await page.locator('.entry').last().innerText()).includes('OnDemand'); res.nugetMs = Date.now() - tn;
  // reload warm
  const tw = Date.now(); await page.reload();
  await page.waitForFunction(() => window.__metrics?.ready || window.__metrics?.error, null, { timeout: 240000 });
  res.warmFirstResultMs = Date.now() - tw;
  res.errors = t.errors.filter((e) => !/Failed to load resource/.test(e)); res.bad = t.bad;
  const sample = [...t.reqs.values()].find((r) => /\.wasm/.test(r.url) && /System\.Private\.CoreLib|System\.Linq/.test(r.url)) || [...t.reqs.values()].find((r) => /\.wasm/.test(r.url));
  res.sampleSet = [...t.reqs.values()].filter((r) => /\\.wasm/.test(r.url)).sort((a, b) => b.len - a.len).slice(0, 3).map((r) => ({ f: r.url.split('/').pop().slice(0, 40), enc: r.enc || 'none', type: r.type, wireKB: Math.round(r.len / 1024) }));
  res.sample = sample && { url: sample.url.split('/').pop(), enc: sample.enc, type: sample.type, wireKB: Math.round(sample.len / 1024) };
  return res;
}
async function fuget() {
  const t = await open('fuget'); const { page } = t; const res = {};
  const t0 = Date.now();
  await page.goto(base + '/fuget/', { waitUntil: 'load' });
  await page.waitForTimeout(3000);
  res.title = await page.title(); res.loadMs = Date.now() - t0;
  res.body = (await page.locator('body').innerText()).slice(0, 200).replace(/\n+/g, ' | ');
  return { res, t };
}
async function generic(path) { const t = await open(path); const t0 = Date.now(); const resp = await t.page.goto(base + path, { waitUntil: 'load' }); await t.page.waitForTimeout(3000); return { t, status: resp.status(), loadMs: Date.now() - t0, title: await t.page.title(), body: (await t.page.locator('body').innerText()).slice(0, 200).replace(/\n+/g, ' | ') }; }
const result = {};
if (which === 'csharp' || which === 'all') result.csharp = await csharp().catch((e) => ({ failed: String(e.message).slice(0, 300) }));
if (which === 'hexad' || which === 'all') { const g = await generic('/hexad/'); result.hexad = { status: g.status, loadMs: g.loadMs, title: g.title, body: g.body, errors: g.t.errors, bad: g.t.bad }; }
if (which === 'generic') { const g = await generic(process.argv[4]); result.page = { status: g.status, loadMs: g.loadMs, title: g.title, body: g.body, errors: g.t.errors, bad: g.t.bad }; }
console.log(JSON.stringify(result, null, 1));
await browser.close();
