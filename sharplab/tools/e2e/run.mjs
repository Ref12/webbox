// Headless-Chromium end-to-end check of the published site, served under a Pages-like path (/webbox/sharplab/).
// Usage: node run.mjs <publishedWwwroot> [docsDir] [metrics.json]
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const site = path.resolve(process.argv[2] ?? '../../dist/wwwroot');
const docs = path.resolve(process.argv[3] ?? '../../docs');
const metricsOut = path.resolve(process.argv[4] ?? '../../docs/metrics.json');
const PREFIX = '/webbox/sharplab/';
const exe = process.env.CHROME_PATH || ['/usr/bin/chromium', '/usr/bin/google-chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const metrics = {};
const servers = [];
process.on('exit', () => servers.forEach((s) => s.kill()));

async function serve(port, encodings) {
  const s = spawn(process.execPath, [path.resolve('..', 'serve.mjs'), site, String(port), PREFIX], { stdio: 'inherit', env: { ...process.env, SERVE_ENCODINGS: encodings } });
  servers.push(s);
  await new Promise((r) => setTimeout(r, 800));
  return s;
}
function track(page) {
  const wire = { framework: 0, ref: 0, app: 0, cdn: 0, files: 0 };
  page.on('response', async (r) => {
    try {
      const u = r.url(); const n = Number((await r.allHeaders())['content-length'] || 0);
      if (!u.startsWith('http://localhost')) wire.cdn += n;
      else { wire.files++; if (u.includes('/_framework/')) wire.framework += n; else if (u.includes('/ref/')) wire.ref += n; else wire.app += n; }
    } catch {}
  });
  page.on('console', (m) => { const t = m.text(); if (!/Failed to load resource|favicon/.test(t)) console.log('[browser]', t.slice(0, 300)); });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  return wire;
}
async function load(ctx, port, hash = '') {
  const page = await ctx.newPage();
  const wire = track(page);
  const t = Date.now();
  await page.goto('http://localhost:' + port + PREFIX + hash);
  await page.waitForFunction(() => window.__metrics?.marks?.firstView || window.__metrics?.error, null, { timeout: 300000 });
  const m = await page.evaluate(() => window.__metrics);
  assert.equal(m.error, undefined, 'load error: ' + m.error);
  return { page, wire, m, wallMs: Date.now() - t };
}

// ---------- 1. Pages-like server (gzip only), cold then warm ----------
let server = await serve(8124, 'gzip');
let ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, permissions: ['clipboard-read', 'clipboard-write'] });
const cold = await load(ctx, 8124);
metrics.pagesLike_gzip = { cold: { firstViewMs: cold.m.marks.firstView, marks: cold.m.marks, wireBytes: cold.wire, wireBytesEncodedBody: cold.m.wireBytesAtFirstView, compiles: cold.m.compiles, coreBundle: cold.m.coreBundle } };
console.log('Pages-like (gzip) cold: first view', cold.m.marks.firstView, 'ms; wire', JSON.stringify(cold.wire));
await cold.page.close();
const warm = await load(ctx, 8124);
metrics.pagesLike_gzip.warm = { firstViewMs: warm.m.marks.firstView, marks: warm.m.marks, coreBundle: warm.m.coreBundle };
console.log('warm: first view', warm.m.marks.firstView, 'ms');
await warm.page.close();
await ctx.close(); server.kill();

// ---------- 2. brotli-capable server, cold ----------
server = await serve(8125, 'br,gzip');
ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, permissions: ['clipboard-read', 'clipboard-write'] });
const br = await load(ctx, 8125);
metrics.brotli = { cold: { firstViewMs: br.m.marks.firstView, marks: br.m.marks, wireBytes: br.wire } };
console.log('brotli cold: first view', br.m.marks.firstView, 'ms; wire', JSON.stringify(br.wire));
const { page } = br;

// ---------- 3. features ----------
const ed = () => page.evaluate(() => window.__sharplab.ed.get());
const tab = async (t) => { await page.click('#tabs button[data-tab=' + t + ']'); await page.waitForTimeout(150); };
const outText = (id) => page.evaluate((i) => { const h = document.getElementById(i); const m = window.monaco?.editor.getEditors().find((e) => h.contains(e.getDomNode())); return m ? m.getValue() : h.innerText; }, id);

// default sample: lowered C# shows the closure class
await tab('cs');
let cs = await outText('out-cs');
assert.match(cs, /DisplayClass/, 'level 2 shows the closure display class');
await page.selectOption('#level', '3');
await page.waitForTimeout(300);
cs = await outText('out-cs');
assert.doesNotMatch(cs, /DisplayClass/, 'level 3 hides it');
assert.match(cs, /where n > limit/, 'level 3 shows the query expression');
await page.selectOption('#level', '2');

// IL + Debug/Release
await tab('il');
const ilRelease = await outText('out-il');
assert.match(ilRelease, /\.method public hidebysig static/); assert.match(ilRelease, /ldc\.i4/);
await page.selectOption('#cfg', 'debug');
await page.waitForFunction(() => window.__sharplab.state.configuration === 'debug' && !document.getElementById('opt').checked);
await page.waitForTimeout(1200);
const ilDebug = await outText('out-il');
assert.notEqual(ilDebug, ilRelease, 'Debug IL differs from Release IL');
assert.match(ilDebug, /nop/, 'debug IL has nops');
await page.selectOption('#cfg', 'release');
await page.waitForTimeout(1200);
await page.evaluate(() => { const c = document.getElementById('opt'); c.checked = false; c.dispatchEvent(new Event('change')); });
await page.waitForTimeout(1200);
assert.match(await outText('out-il'), /nop/, 'optimize off alone also gives debug-style IL');
await page.evaluate(() => { const c = document.getElementById('opt'); c.checked = true; c.dispatchEvent(new Event('change')); });
await page.waitForTimeout(800);

// Syntax tree, both ways
await tab('syntax');
await page.waitForSelector('#tree .row');
const rows = await page.locator('#tree .row').count();
assert.ok(rows >= 1);
await page.evaluate(() => window.__sharplab.setCode('// c\nclass A { int F() => 1; }\n'));
await page.waitForFunction(() => document.querySelector('#tree .row[data-kind=CompilationUnit]'));
// tree -> editor: open all along a path by revealing the 'class' keyword
await page.evaluate(() => window.__sharplab.ed.setSel(6, 11));
await page.waitForTimeout(300);
assert.equal(await page.locator('#tree .row.sel').getAttribute('data-kind'), 'ClassKeyword', 'editor selection -> tree');
await page.locator('#tree .row[data-kind=IdentifierToken]').first().click();
assert.deepEqual(await page.evaluate(() => window.__sharplab.ed.getSel()), { start: 11, end: 12 }, 'tree click -> editor selection');
await page.evaluate(() => window.__sharplab.ed.setSel(2, 2));
await page.waitForTimeout(300);
assert.equal(await page.locator('#tree .row.sel').getAttribute('data-kind'), 'SingleLineCommentTrivia', 'caret in a comment selects trivia');

// Run + Verify
await page.evaluate(() => window.__sharplab.setCode('using System;\nusing System.Linq;\nclass P { static void Main() { Console.WriteLine(string.Join(",", Enumerable.Range(1, 4).Select(x => x * x))); } }\n'));
await page.waitForFunction(() => window.__sharplab.last?.success);
await tab('run');
await page.click('#runbtn');
await page.waitForFunction(() => document.getElementById('runout').innerText.includes('1,4,9,16'), null, { timeout: 30000 });
await tab('verify');
await page.waitForFunction(() => document.getElementById('verifyout').innerText.includes('All methods verified'), null, { timeout: 30000 });
metrics.verify = await page.evaluate(() => document.getElementById('verifyout').innerText);

// diagnostics: a language-version error shows up as a Monaco marker and in the problem list
await page.evaluate(() => window.__sharplab.setCode('record R(int A);\nclass P { static void Main() { int x = "s"; } }\n'));
await page.waitForFunction(() => document.getElementById('problems').innerText.includes('CS0029'));
const markers = await page.evaluate(() => window.monaco ? window.monaco.editor.getModelMarkers({}).filter((m) => m.owner === 'roslyn').map((m) => m.code) : []);
if (br.m.editor === 'monaco') assert.ok(markers.includes('CS0029'), 'squiggle for CS0029: ' + markers);
await page.selectOption('#lang', '8');
await page.waitForFunction(() => document.getElementById('problems').innerText.includes('CS8773') || document.getElementById('problems').innerText.includes('CS8400'), null, { timeout: 15000 });
await page.selectOption('#lang', 'latest');

// on-demand reference assembly (System.Net.Http is not in the core bundle)
await page.evaluate(() => window.__sharplab.setCode('using System.Net.Http;\nclass A { HttpClient C = new HttpClient(); }\n'));
await page.waitForFunction(() => window.__sharplab.last?.success, null, { timeout: 30000 });
assert.ok((await page.evaluate(() => window.__metrics.assets)).some((a) => a.path.includes('System.Net.Http.dll')), 'System.Net.Http.dll fetched on demand');

// ---------- 4. share link ----------
const shareCode = 'using System;\nclass Shared { static void Main() { Console.WriteLine("shared ✓"); } }\n';
await page.evaluate((c) => window.__sharplab.setCode(c), shareCode);
await page.selectOption('#lang', '12'); await tab('cs'); await page.selectOption('#level', '3'); await tab('il');
await page.waitForTimeout(800);
await page.evaluate(() => { window.__lastShare = undefined; });
await page.click('#share');
await page.waitForFunction(() => window.__lastShare);
const url = await page.evaluate(() => window.__lastShare);
assert.ok(url.includes('#v1:'), url);
metrics.shareLinkLength = url.length;
const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => url);
assert.equal(clip, url);
const p2 = await load(ctx, 8125, url.slice(url.indexOf('#')));
const st = await p2.page.evaluate(() => ({ ...window.__sharplab.state }));
assert.equal(st.code, shareCode); assert.equal(st.langVersion, '12'); assert.equal(st.level, 3); assert.equal(st.tab, 'il');
assert.match(await p2.page.evaluate(() => { const h = document.getElementById('out-il'); const m = window.monaco?.editor.getEditors().find((e) => h.contains(e.getDomNode())); return m ? m.getValue() : h.innerText; }), /Shared/);
await p2.page.close();

// JIT tab explains the situation
await tab('jit');
const jit = await page.locator('#jit').innerText();
assert.match(jit, /interpreter/i); assert.match(jit, /DOTNET_JitDisasm/);

// ---------- 5. timings + screenshot ----------
await page.evaluate(() => window.__sharplab.setCode(`using System;
using System.Linq;
using System.Threading.Tasks;

public record Person(string Name, int Age);

public class Demo
{
    public static async Task Main()
    {
        var people = new[] { new Person("Ada", 36), new Person("Linus", 28) };
        int limit = 30;
        var names = people.Where(p => p.Age > limit).Select(p => p.Name);
        await Task.Delay(1);
        Console.WriteLine(string.Join(", ", names));
    }
}
`));
await page.waitForFunction(() => window.__sharplab.last?.success);
await tab('cs');
await page.selectOption('#level', '2');
await page.waitForTimeout(1000);
const compiles = await page.evaluate(() => window.__metrics.compiles);
metrics.compileMsLast5 = compiles.slice(-5);
metrics.viewMs = await page.evaluate(() => window.__metrics.views);
fs.mkdirSync(docs, { recursive: true });
await page.screenshot({ path: path.join(docs, 'screenshot.png') });
await tab('syntax'); await page.evaluate(() => window.__sharplab.ed.setSel(150, 150)); await page.waitForTimeout(500);
await page.screenshot({ path: path.join(docs, 'screenshot-syntax.png') });
fs.writeFileSync(metricsOut, JSON.stringify(metrics, null, 2));
console.log('E2E OK', JSON.stringify({ coldGzipFirstView: metrics.pagesLike_gzip.cold.firstViewMs, warm: metrics.pagesLike_gzip.warm.firstViewMs, brotliFirstView: metrics.brotli.cold.firstViewMs }));
await browser.close(); server.kill();
process.exit(0);
