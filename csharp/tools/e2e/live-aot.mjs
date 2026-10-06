// Live relink-vs-AOT measurement: node live-aot.mjs <base> [csharp|sharplab|all] [runs=1]
//   <base> e.g. https://webbox.ref12cf.workers.dev | https://ref12.github.io/webbox | http://localhost:8199/webbox (pages-sim, to try the script)
// For each app and build (relink = ?aot=0, AOT = ?aot=1, each in a fresh browser context, so a cold cache): download size (all requests of the
// page and its workers, bytes on the wire), first result, IntelliSense ready, warm compile (median of 5 distinct edits), CPU-bound snippet.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const base = process.argv[2].replace(/\/$/, ''), which = process.argv[3] || 'all', runs = Number(process.argv[4] || 1);
const exe = ['/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => fs.existsSync(p));
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const median = (a) => a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null;
async function open(url) {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 780 } });
  const page = await ctx.newPage(); const errors = []; let bytes = 0, files = 0; const enc = new Set();
  ctx.on('requestfinished', async (rq) => { try { const rs = await rq.response(); const sz = await rq.sizes(); bytes += sz.responseBodySize + sz.responseHeadersSize; files++; enc.add((await rs.allHeaders())['content-encoding'] || 'none'); } catch {} });
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text().slice(0, 160)); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message.slice(0, 160)));
  return { ctx, page, errors, mb: () => +(bytes / 1048576).toFixed(2), files: () => files, enc: () => [...enc].join('+'), url };
}
async function csharp(aot) {
  const t = await open(base + '/csharp/?aot=' + aot); const { page } = t; const r = { build: aot ? 'aot' : 'relink' };
  const t0 = Date.now();
  await page.goto(t.url);
  await page.waitForFunction(() => window.__metrics?.ready || window.__metrics?.error, null, { timeout: 300000 });
  const m = await page.evaluate(() => window.__metrics); if (m.error) throw new Error(m.error);
  r.runtimeIsAot = m.aot; r.firstResultMs = Date.now() - t0;
  await page.evaluate(() => window.__submit('1 + 2'));
  r.firstEvalOk = (await page.locator('.entry').last().innerText()).includes('3'); r.firstEvalMs = Date.now() - t0;
  r.wireAtFirstResultMB = t.mb();
  await page.waitForFunction(() => window.__metrics?.marks.intellisenseReady || window.__metrics?.intellisenseError, null, { timeout: 300000 });
  r.intellisenseReadyMs = Date.now() - t0; r.wireTotalMB = t.mb(); r.files = t.files(); r.enc = t.enc();
  // warm compile: distinct snippets (not cached), wall time of __submit
  const ws = [];
  for (let i = 0; i < 5; i++) { const a = Date.now(); await page.evaluate((i) => window.__submit('var w' + i + ' = Enumerable.Range(0, ' + (10 + i) + ').Select(x => x * ' + (i + 2) + ').Sum();\nw' + i), i); ws.push(Date.now() - a); }
  r.warmCompileMs = median(ws); r.warmCompileAll = ws;
  // CPU-bound: time inside the snippet (Stopwatch) and wall time of the submit
  const cpu = 'var sw = System.Diagnostics.Stopwatch.StartNew(); long s = 0; for (long i = 0; i < 100_000_000; i++) s += i ^ (i >> 3); "cpu " + sw.ElapsedMilliseconds + " ms, " + s';
  const a = Date.now(); await page.evaluate((c) => window.__submit(c), cpu); r.cpuWallMs = Date.now() - a;
  r.cpuText = (await page.locator('.entry').last().innerText()).replace(/\s+/g, ' ').slice(-60);
  r.cpuInSnippetMs = Number((r.cpuText.match(/cpu (\d+) ms/) || [])[1]) || null;
  r.errors = t.errors; await t.ctx.close(); return r;
}
async function sharplab(aot) {
  const t = await open(base + '/sharplab/?aot=' + aot); const { page } = t; const r = { build: aot ? 'aot' : 'relink' };
  const t0 = Date.now();
  await page.goto(t.url);
  await page.waitForFunction(() => window.__metrics?.marks?.firstView || window.__metrics?.error, null, { timeout: 300000 });
  const m = await page.evaluate(() => window.__metrics); if (m.error) throw new Error(m.error);
  r.firstResultMs = Date.now() - t0; r.wireAtFirstResultMB = t.mb(); r.firstViewMarkMs = m.marks.firstView; r.firstCompile = m.compiles[0] || null;
  await page.waitForFunction(() => window.__metrics?.marks?.intellisenseReady || window.__metrics?.intellisenseError, null, { timeout: 300000 });
  r.intellisenseReadyMs = Date.now() - t0; r.wireTotalMB = t.mb(); r.files = t.files(); r.enc = t.enc();
  // warm compile: five distinct sources; the app's own compile timer (ms) and wall time of refresh()
  const base0 = await page.evaluate(() => window.__metrics.compiles.length), ws = [];
  for (let i = 0; i < 5; i++) { const a = Date.now(); await page.evaluate((i) => window.__sharplab.setCode('public class C' + i + ' { public int M(int x) { return x * ' + (i + 2) + ' + ' + i + '; } }'), i); ws.push(Date.now() - a); }
  const cs = (await page.evaluate(() => window.__metrics.compiles)).slice(base0);
  r.warmCompileMs = median(ws); r.warmCompileAll = ws; r.warmCompileAppMs = median(cs.map((c) => c.ms));
  // CPU-bound: run a program (Run button), time inside it and wall time until the output appears
  const prog = 'using System;\nusing System.Diagnostics;\npublic class Program { public static void Main() { var sw = Stopwatch.StartNew(); long s = 0; for (long i = 0; i < 100000000; i++) s += i ^ (i >> 3); Console.WriteLine("cpu " + sw.ElapsedMilliseconds + " ms, " + s); } }';
  await page.evaluate((p) => window.__sharplab.setCode(p), prog);
  await page.click('[data-tab=run]');
  await page.waitForSelector('#runbtn:not([disabled])', { timeout: 60000 });
  const a = Date.now(); await page.click('#runbtn');
  await page.waitForFunction(() => /cpu \d+ ms/.test(document.getElementById('runout')?.innerText || ''), null, { timeout: 300000 });
  r.cpuWallMs = Date.now() - a; r.cpuText = (await page.locator('#runout').innerText()).replace(/\s+/g, ' ').slice(-60);
  r.cpuInSnippetMs = Number((r.cpuText.match(/cpu (\d+) ms/) || [])[1]) || null;
  r.errors = t.errors; await t.ctx.close(); return r;
}
const out = {};
for (const [name, f] of [['csharp', csharp], ['sharplab', sharplab]]) {
  if (which !== 'all' && which !== name) continue;
  out[name] = [];
  for (let k = 0; k < runs; k++) for (const aot of [0, 1]) out[name].push(await f(aot).catch((e) => ({ build: aot ? 'aot' : 'relink', failed: String(e.message).slice(0, 300) })));
}
console.log(JSON.stringify({ base, when: new Date().toISOString(), ...out }, null, 1)); await browser.close();
