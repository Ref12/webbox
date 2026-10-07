// Headless-Chromium end-to-end check of the published site, served under a Pages-like path (/webbox/sharplab/).
// Usage: node run.mjs <stagedSite> [docsDir] [metrics.json]
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const site = path.resolve(process.argv[2] ?? '../../_site');   // the staged site: the folder that contains sharplab/ (tools/stage.mjs)
const docs = path.resolve(process.argv[3] ?? '../../docs');
const metricsOut = path.resolve(process.argv[4] ?? '../../docs/metrics.json');
const PREFIX = '/webbox/sharplab/';
const exe = process.env.CHROME_PATH || ['/usr/bin/chromium', '/usr/bin/google-chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const metrics = {};
const servers = [];
process.on('exit', () => servers.forEach((s) => s.kill()));

async function serve(port, gzip) {
  // pages-sim: like GitHub Pages: path prefix, max-age=600, no Content-Encoding for precompressed files, gzip on the fly (text only, or everything with gzip=all)
  const s = spawn(process.execPath, [path.resolve('..', 'pages-sim.mjs'), site, String(port), '/webbox', '--gzip=' + gzip], { stdio: 'ignore' });
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
async function load(ctx, port, hash = '', query = '') {
  const page = await ctx.newPage();
  const wire = track(page);
  const t = Date.now();
  await page.goto('http://localhost:' + port + PREFIX + (process.env.AOT ? (query ? query + '&aot=1' : '?aot=1') : query) + hash);
  await page.waitForFunction(() => window.__metrics?.marks?.firstView || window.__metrics?.error, null, { timeout: 300000 });
  const m = await page.evaluate(() => window.__metrics);
  assert.equal(m.error, undefined, 'load error: ' + m.error);
  return { page, wire, m, wallMs: Date.now() - t };
}

// ---------- 1. baseline: plain files (?nobr=1), Pages gzipping everything on the fly (the best case if Pages does compress .wasm/.dll) ----------
let server = await serve(8124, 'all');
let ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, permissions: ['clipboard-read', 'clipboard-write'] });
const plain = await load(ctx, 8124, '', '?nobr=1');
metrics.plain_gzipAll = { cold: { firstViewMs: plain.m.marks.firstView, marks: plain.m.marks, wireBytes: plain.wire } };
console.log('plain files, gzip all: first view', plain.m.marks.firstView, 'ms; wire', JSON.stringify(plain.wire));
await ctx.close(); server.kill();

// ---------- 2. as shipped: .br files decoded in the page, Pages gzips text only; cold, then warm ----------
server = await serve(8125, 'text');
ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, permissions: ['clipboard-read', 'clipboard-write'] });
const br = await load(ctx, 8125);
metrics.shipped = { cold: { firstViewMs: br.m.marks.firstView, marks: br.m.marks, wireBytes: br.wire, wireBytesEncodedBody: br.m.wireBytesAtFirstView, coreBundle: br.m.coreBundle, compiles: br.m.compiles } };
console.log('shipped (.br decoded in page) cold: first view', br.m.marks.firstView, 'ms; wire', JSON.stringify(br.wire));
const warm = await load(ctx, 8125);
metrics.shipped.warm = { firstViewMs: warm.m.marks.firstView, marks: warm.m.marks, coreBundle: warm.m.coreBundle };
console.log('warm: first view', warm.m.marks.firstView, 'ms');
await warm.page.close();
const { page } = br;

// ---------- 3. features ----------
const ed = () => page.evaluate(() => window.__sharplab.ed.get());
const settle = () => page.evaluate(() => window.__sharplab.rendering);   // views are drawn by the exec worker: wait for the one in progress
const tab = async (t) => { await page.click('#tabs button[data-tab=' + t + ']'); await settle(); await page.waitForTimeout(150); };
const outText = (id) => page.evaluate((i) => { const h = document.getElementById(i); const m = window.monaco?.editor.getEditors().find((e) => h.contains(e.getDomNode())); return m ? m.getValue() : h.innerText; }, id);

// default sample: lowered C# shows the closure class
await tab('cs');
let cs = await outText('out-cs');
assert.match(cs, /DisplayClass/, 'level 2 shows the closure display class');
await page.selectOption('#level', '3');
await settle(); await page.waitForTimeout(300);
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
await settle(); await page.waitForTimeout(1200);
const ilDebug = await outText('out-il');
assert.notEqual(ilDebug, ilRelease, 'Debug IL differs from Release IL');
assert.match(ilDebug, /nop/, 'debug IL has nops');
await page.selectOption('#cfg', 'release');
await settle(); await page.waitForTimeout(1200);
await page.evaluate(() => { const c = document.getElementById('opt'); c.checked = false; c.dispatchEvent(new Event('change')); });
await settle(); await page.waitForTimeout(1200);
assert.match(await outText('out-il'), /nop/, 'optimize off alone also gives debug-style IL');
await page.evaluate(() => { const c = document.getElementById('opt'); c.checked = true; c.dispatchEvent(new Event('change')); });
await settle(); await page.waitForTimeout(800);

// Syntax tree, both ways
await tab('syntax');
await page.waitForSelector('#tree .row');
const rows = await page.locator('#tree .row').count();
assert.ok(rows >= 1);
await page.evaluate(() => window.__sharplab.setCode('// c\nclass A { int F() => 1; }\n'));
await page.waitForFunction(() => document.querySelector('#tree .row[data-kind=CompilationUnit]'));
// tree -> editor: open all along a path by revealing the 'class' keyword
await page.evaluate(() => window.__sharplab.ed.setSel(6, 11));
await settle(); await page.waitForTimeout(300);
assert.equal(await page.locator('#tree .row.sel').getAttribute('data-kind'), 'ClassKeyword', 'editor selection -> tree');
await page.locator('#tree .row[data-kind=IdentifierToken]').first().click();
assert.deepEqual(await page.evaluate(() => window.__sharplab.ed.getSel()), { start: 11, end: 12 }, 'tree click -> editor selection');
await page.evaluate(() => window.__sharplab.ed.setSel(2, 2));
await settle(); await page.waitForTimeout(300);
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

// Layout tab: measured (page runtime) and modelled (CoreCLR) tables; clicking a field / type name selects it in the editor; the share link keeps the choice
{
  const src = 'struct MyStruct { public bool flag; public long big; }\nclass Holder { public byte b; public string name; }\n';
  await page.evaluate((c) => window.__sharplab.setCode(c), src);
  await page.waitForFunction(() => window.__sharplab.last?.success);
  await tab('layout');
  await page.waitForFunction(() => document.querySelectorAll('#layoutout .lcard').length >= 2, null, { timeout: 30000 });
  const text = await page.locator('#layoutout').innerText();
  assert.match(text, /ObjectLayoutInspector/); assert.match(text, /MyStruct/); assert.match(text, /padding/);
  const cell = (n) => page.locator('#layoutout .lcard').first().locator('tr.field', { hasText: n });
  assert.match(await page.locator('#layoutout .lcard').first().innerText(), /16 bytes/);   // bool+long: 16 on Mono wasm32 and CoreCLR x64 alike
  await cell('big').click();
  assert.deepEqual(await page.evaluate(() => { const s = window.__sharplab.ed.getSel(); return window.__sharplab.state.code.slice(s.start, s.end); }), 'big', 'field row selects its name in the editor');
  await page.locator('#layoutout .lcard').nth(1).locator('.tn').click();
  assert.equal(await page.evaluate(() => { const s = window.__sharplab.ed.getSel(); return window.__sharplab.state.code.slice(s.start, s.end); }), 'Holder', 'type name selects the type');
  const clsText = await page.locator('#layoutout .lcard').nth(1).innerText();
  assert.match(clsText, /object header/);
  await page.screenshot({ path: path.join(docs, 'layout-measured.png') });
  await page.click('#layoutout .lmode button:nth-child(2)');
  await page.waitForFunction(() => /CoreCLR/.test(document.querySelector('#layoutout .lmode button.on').textContent));
  assert.match(await page.locator('#layoutout .lcard').nth(1).innerText(), /24 bytes|32 bytes/);
  await page.evaluate(() => { window.__lastShare = undefined; });
  await page.click('#share');
  await page.waitForFunction(() => window.__lastShare);
  const lurl = await page.evaluate(() => window.__lastShare);
  const lp = await load(ctx, 8125, lurl.slice(lurl.indexOf('#')));
  assert.equal(await lp.page.evaluate(() => window.__sharplab.state.tab), 'layout', 'share link keeps the Layout tab');
  await lp.page.close();

  await page.screenshot({ path: path.join(docs, 'layout-modelled.png') });
  await page.click('#layoutout .lmode button:nth-child(1)');
}

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
await settle(); await page.waitForTimeout(800);
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
// the tab can talk to a JIT endpoint (jit/endpoint/server.mjs, when its runner is built: dotnet build -c Release jit/endpoint/JitRunner)
const endpointDir = path.resolve('../../jit/endpoint');
if (fs.existsSync(path.join(endpointDir, 'JitRunner/bin/Release/net10.0/JitRunner.dll'))) {
  const ep = spawn(process.execPath, ['server.mjs', '8787'], { cwd: endpointDir, stdio: 'ignore' }); servers.push(ep);
  await new Promise((r) => setTimeout(r, 800));
  await page.evaluate(() => window.__sharplab.setCode('public class Calc { public static int Add(int a, int b) => a + b; }'));
  await page.waitForFunction(() => window.__sharplab.last?.success);
  await tab('jit');
  await page.fill('#jit-url', 'http://localhost:8787/jit'); await page.fill('#jit-method', 'Add');
  const tj = Date.now();
  await page.click('#jit-go');
  await page.waitForFunction(() => /Assembly listing for method Calc:Add/.test(document.getElementById('jit-out').textContent), null, { timeout: 30000 });
  metrics.jitEndpointMs = Date.now() - tj;
  assert.match(await page.locator('#jit-out').innerText(), /lea\s+eax, \[rdi\+rsi\]|add\s/);
  ep.kill();
} else console.log('JIT endpoint check skipped (JitRunner not built)');

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
await settle(); await page.waitForTimeout(1000);
const compiles = await page.evaluate(() => window.__metrics.compiles);
metrics.compileMsLast5 = compiles.slice(-5);
metrics.viewMs = await page.evaluate(() => window.__metrics.views);
fs.mkdirSync(docs, { recursive: true });
await page.screenshot({ path: path.join(docs, 'screenshot.png') });
await tab('syntax'); await page.evaluate(() => window.__sharplab.ed.setSel(150, 150)); await settle(); await page.waitForTimeout(500);
await page.screenshot({ path: path.join(docs, 'screenshot-syntax.png') });
fs.writeFileSync(metricsOut, JSON.stringify(metrics, null, 2));
console.log('E2E OK', JSON.stringify({ plainGzipAllFirstView: metrics.plain_gzipAll.cold.firstViewMs, shippedCold: metrics.shipped.cold.firstViewMs, shippedWarm: metrics.shipped.warm.firstViewMs }));
await browser.close(); server.kill();
process.exit(0);
