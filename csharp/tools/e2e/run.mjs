// Headless-browser end-to-end check of the published site.
// Usage: node run.mjs <stagedSite> [screenshotDir] [metrics.json]   (stagedSite = the folder that contains csharp/, i.e. _site; served under /webbox/ like GitHub Pages)
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const site = path.resolve(process.argv[2] ?? '../../_site');
const shotDir = path.resolve(process.argv[3] ?? '../../docs');
const metricsOut = process.argv[4] ?? '../../docs/metrics.json';
const port = 8123;
const server = spawn(process.execPath, [path.resolve('..', 'pages-sim.mjs'), site, String(port), '/webbox', '--gzip=' + (process.env.GZIP || 'text')], { stdio: 'inherit' });
const BASE = 'http://localhost:' + port + '/webbox/csharp/';
await new Promise((r) => setTimeout(r, 800));
const exe = process.env.CHROME_PATH || ['/usr/bin/chromium', '/usr/bin/google-chrome'].find((p) => fs.existsSync(p));
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1100, height: 780 }, permissions: ['clipboard-read', 'clipboard-write'] });
const page = await ctx.newPage();
page.on('console', (m) => { const t = m.text(); if (!/Failed to load resource/.test(t)) console.log('[browser]', t.slice(0, 300)); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
const wire = { framework: 0, ref: 0, lazy: 0, other: 0, cdn: 0 };
page.on('response', async (r) => {
  try {
    const n = Number((await r.allHeaders())['content-length'] || 0); const u = r.url();
    if (!u.startsWith('http://localhost')) wire.cdn += n;
    else if (u.includes('/_framework/')) wire.framework += n; else if (u.includes('/ref/')) wire.ref += n; else if (u.includes('/lazy/')) wire.lazy += n; else wire.other += n;
  } catch {}
});

// flaky network: the first requests for core.bin and one runtime file fail with 504; the app must retry and still load
let failed = 0;
await page.route(/core\.bin|System\.Linq\.[^/]*\.wasm$/, (route) => (failed++ < 2 ? route.fulfill({ status: 504, body: 'gateway timeout' }) : route.continue()));
const notFound = []; page.on('response', (r) => { if (r.status() === 404) notFound.push(r.url()); });
const t0 = Date.now();
await page.goto(BASE);
await page.waitForFunction(() => window.__metrics?.ready || window.__metrics?.error, null, { timeout: 240000 });
const wireAtFirstResult = { ...wire };
let m = await page.evaluate(() => window.__metrics);
assert.equal(m.error, undefined, 'load error: ' + m.error);
assert.ok(m.net.retries >= 1 && failed >= 2, 'retry path exercised: ' + JSON.stringify(m.net));
console.log('usable (first result) after', m.marks.firstResult, 'ms; IntelliSense not yet ready:', await page.evaluate(() => document.getElementById('intelli').textContent));
// the REPL works before IntelliSense is ready
await page.evaluate(() => window.__submit('1 + 2'));
assert.ok((await page.locator('.entry').last().innerText()).includes('3'), 'REPL usable before IntelliSense');
await page.waitForFunction(() => window.__metrics?.marks.intellisenseReady || window.__metrics?.intellisenseError, null, { timeout: 300000 });
m = await page.evaluate(() => window.__metrics);
assert.equal(m.intellisenseError, undefined, m.intellisenseError);
assert.equal(await page.locator('#intelli').innerText(), 'IntelliSense: ready');
console.log('IntelliSense ready at', m.marks.intellisenseReady, 'ms; first completion', m.firstCompletionMs, 'ms; lazy', JSON.stringify(m.lazy));
// the entry typed before IntelliSense was ready is re-coloured by Roslyn once it is
await page.waitForFunction(() => document.querySelector('.entry .code .t-number'), null, { timeout: 20000 });
await page.evaluate(() => window.__submit('Reset-marker-noop;')).catch(() => {});

// ---------- typing, completion, accept ----------
const monacoInput = page.locator('#editor .monaco-editor textarea, #editor .monaco-editor .inputarea').first();
await page.click('#editor .monaco-editor .view-lines');
const getInput = () => page.evaluate(() => window.monaco.editor.getEditors()[0].getValue());
await page.evaluate(() => window.monaco.editor.getEditors()[0].setValue(''));
await page.keyboard.type('Console.WriteL');
await page.waitForSelector('.suggest-widget.visible', { timeout: 20000 });
const sugg = await page.locator('.suggest-widget .monaco-list-row').allInnerTexts();
console.log('suggestions:', sugg.slice(0, 6).join(' | '));
assert.ok(sugg.some((s) => s.includes('WriteLine')), 'WriteLine suggested');
assert.ok(!sugg.some((s) => s.startsWith('Beep')) && sugg.length <= 3, 'list is filtered by what was typed');
await page.keyboard.press('Tab');                       // accept
assert.equal(await getInput(), 'Console.WriteLine');
await page.keyboard.type('("hi from the editor")');   // '(' is also a commit char; typing continues
const afterType = await getInput();
assert.ok(afterType.startsWith('Console.WriteLine('), afterType);
// signature help while inside the call
await page.evaluate(() => window.monaco.editor.getEditors()[0].setValue(''));
await page.keyboard.type('Math.Max(1, ');
await page.waitForSelector('.parameter-hints-widget.visible', { timeout: 20000 });
const sig = await page.locator('.parameter-hints-widget').innerText();
console.log('signature help:', sig.replace(/\n/g, ' ').slice(0, 120));
assert.ok(sig.includes('Max('), 'signature help shows Math.Max overloads');
await page.keyboard.press('Escape');
// diagnostics squiggle
await page.evaluate(() => window.monaco.editor.getEditors()[0].setValue(''));
await page.keyboard.type('int bad = "text";');
await page.waitForSelector('.squiggly-error', { timeout: 20000 });
// hover (quick info) on a previous variable
await page.evaluate(() => window.__submit('var answer = 42;'));
await page.evaluate(() => window.monaco.editor.getEditors()[0].setValue('answer + 1'));
await page.waitForTimeout(600);
const box = await page.locator('#editor .view-line').first().boundingBox();
await page.mouse.move(box.x + 25, box.y + 8);
await page.waitForSelector('.monaco-hover:not(.hidden) .hover-contents', { timeout: 20000 });
const hover = await page.locator('.monaco-hover .hover-contents').first().innerText();
console.log('hover:', hover.replace(/\n/g, ' ').slice(0, 100));
assert.ok(hover.includes('answer') && hover.includes('int'), 'quick info');
await page.mouse.move(5, 5);
// semantic colouring inside the editor: 'Console' as a type (teal)
await page.evaluate(() => window.monaco.editor.getEditors()[0].setValue('var s = "txt"; Console.WriteLine(s.Length + 42);'));
await page.waitForTimeout(1500);
const colours = await page.evaluate(() => {
  const out = {}; for (const sp of document.querySelectorAll('#editor .view-line span span')) out[sp.textContent.trim()] = getComputedStyle(sp).color; return out;
});
console.log('editor colours:', JSON.stringify(colours));
assert.equal(colours['Console'], 'rgb(78, 201, 176)', 'type colour from Roslyn semantic tokens');
assert.equal(colours['var'], 'rgb(86, 156, 214)', 'keyword colour');

// ---------- run, history ----------
await page.evaluate(() => window.monaco.editor.getEditors()[0].setValue(''));
await page.keyboard.type('Console.WriteLine("hello classified");');
await page.keyboard.press('Enter');
await page.waitForFunction(() => document.querySelectorAll('.entry').length >= 4 && document.querySelector('.entry:last-child .out'), null, { timeout: 60000 });
const last = page.locator('.entry').last();
assert.ok((await last.locator('.out').innerText()).includes('hello classified'), 'output block');
const hist = await last.locator('.code span').evaluateAll((els) => Object.fromEntries(els.map((e) => [e.textContent, e.className + '|' + getComputedStyle(e).color])));
console.log('history colours:', JSON.stringify(hist));
assert.ok(hist['Console'].startsWith('t-class|rgb(78, 201, 176)'), 'history coloured by Roslyn: type');
assert.ok(hist['WriteLine'].startsWith('t-method'), 'history: method');
assert.ok(hist['"hello classified"'].startsWith('t-string|rgb(214, 157, 133)'), 'history: string');
await page.evaluate(() => window.__submit('var n = 7;'));
// Ctrl+Up / Ctrl+Down with stash
await page.click('#editor .monaco-editor .view-lines');
await page.evaluate(() => window.monaco.editor.getEditors()[0].setValue(''));
await page.keyboard.type('half = typed');
await page.keyboard.press('Control+ArrowUp'); assert.equal(await getInput(), 'var n = 7;');
await page.keyboard.press('Control+ArrowUp'); assert.equal(await getInput(), 'Console.WriteLine("hello classified");');
await page.keyboard.press('Control+ArrowDown'); assert.equal(await getInput(), 'var n = 7;');
await page.keyboard.press('Control+ArrowDown'); assert.equal(await getInput(), 'half = typed', 'typed text restored exactly');
// plain Up/Down move the cursor in multi-line input
await page.evaluate(() => window.monaco.editor.getEditors()[0].setValue('line one\nline two'));
await page.keyboard.press('ArrowUp');
assert.equal((await page.evaluate(() => window.monaco.editor.getEditors()[0].getPosition().lineNumber)), 1, 'Up moves the cursor');
assert.equal(await getInput(), 'line one\nline two', 'plain Up did not touch the text / history');
await page.evaluate(() => window.monaco.editor.getEditors()[0].setValue(''));

// ---------- copy icon ----------
const copy = page.locator('.entry').nth(await page.locator('.entry').count() - 2).locator('.code .copy');
await copy.click();
assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'Console.WriteLine("hello classified");');
assert.ok(await copy.evaluate((b) => b.classList.contains('done')), 'copy confirmation');

// ---------- assemblies on demand + NuGet ----------
await page.evaluate(() => window.__submit('using System.Text.RegularExpressions;\nRegex.IsMatch("abc", "b")'));
let txt = await page.locator('.entry').last().innerText(); console.log('regex:', txt.replace(/\n/g, ' | '));
assert.ok(/true/i.test(txt), 'regex result');
assert.ok((await page.evaluate(() => window.__metrics.assets.map((a) => a.path))).includes('ref/a/System.Text.RegularExpressions.dll'), 'on-demand reference assembly fetched (and logged)');
await page.evaluate(() => window.__submit('new System.Net.Http.HttpClient().GetType().Name'));
txt = await page.locator('.entry').last().innerText(); console.log('http:', txt.replace(/\n/g, ' | '));
assert.ok(txt.includes('HttpClient'), 'type name -> assembly on demand');
await page.evaluate(() => window.__submit('#r "nuget: Humanizer.Core, 2.14.1"\nusing Humanizer;\n"on demand assemblies".Pascalize()'));
txt = await page.locator('.entry').last().innerText(); console.log('nuget:', txt.replace(/\n/g, ' | '));
assert.ok(txt.includes('OnDemandAssemblies') && txt.includes('nuget Humanizer.Core 2.14.1'), 'NuGet package resolved, loaded and reported');
await page.evaluate(() => window.__submit('#r "nuget: Newtonsoft.Json"\nNewtonsoft.Json.JsonConvert.SerializeObject(new { a = 1, b = new[] { 1, 2 } })'));
txt = await page.locator('.entry').last().innerText(); console.log('newtonsoft:', txt.replace(/\n/g, ' | '));
assert.ok(txt.includes('{\\"a\\":1,\\"b\\":[1,2]}') || txt.includes('{"a":1,"b":[1,2]}'), 'Newtonsoft.Json latest version');
const cacheNames = await page.evaluate(async () => { const r = {}; for (const k of await caches.keys()) r[k] = (await (await caches.open(k)).keys()).length; return r; });
console.log('caches:', JSON.stringify(cacheNames));
assert.ok(Object.keys(cacheNames).some((k) => k.startsWith('csrepl-nuget')), 'nuget packages cached');

// ---------- completion latency (warm) ----------
const lat = [];
for (const t of ['Console.Wri', 'answer.', 'new List<int>().Ad', 'Enumerable.Ra']) lat.push(await page.evaluate(async (t) => { const s = performance.now(); await window.__intelli('Complete', t, t.length, ''); return Math.round(performance.now() - s); }, t));
console.log('completion latency (ms, warm):', lat.join(', '));

// ---------- several dependent submissions ----------
await page.evaluate(() => window.__submit('var a = 5;'));
await page.evaluate(() => window.__submit('int Sq(int x) => x * x;'));
await page.evaluate(() => window.__submit('var b = Sq(a) + 1;'));
await page.evaluate(() => window.__submit('b * 2'));
assert.ok((await page.locator('.entry').last().locator('.val').innerText()).trim() === '52', 'dependent submissions share state');

// ---------- #r completion: nuget: , packages and versions from nuget.org ----------
const rows = () => page.locator('.suggest-widget .monaco-list-row').allInnerTexts();
await page.evaluate(() => window.monaco.editor.getEditors()[0].setValue(''));
await page.click('#editor .monaco-editor .view-lines');
await page.keyboard.type('#r "');
await page.waitForSelector('.suggest-widget.visible', { timeout: 20000 });
let rr = await rows(); console.log('#r " ->', rr.slice(0, 4).join(' | '));
assert.ok(rr[0].startsWith('nuget:'), '#r " offers nuget: first');
assert.ok(rr.some((r) => r.startsWith('System.Net.Http')), 'and framework assemblies');
await page.keyboard.press('Tab');
assert.equal(await getInput(), '#r "nuget: "');
await page.keyboard.type('Newtonsoft.J');
await page.waitForFunction(() => [...document.querySelectorAll('.suggest-widget .monaco-list-row')].some((r) => r.innerText.startsWith('Newtonsoft.Json')), null, { timeout: 20000 });
rr = await rows(); console.log('packages ->', rr.slice(0, 3).join(' | '));
await page.keyboard.press('Tab');
assert.equal(await getInput(), '#r "nuget: Newtonsoft.Json, "', 'package inserted with ", "');
await page.waitForFunction(() => [...document.querySelectorAll('.suggest-widget .monaco-list-row')].some((r) => /^\d+\.\d+/.test(r.innerText)), null, { timeout: 20000 });
rr = await rows(); console.log('versions ->', rr.slice(0, 3).join(' | '));
await page.keyboard.press('Tab');
assert.match(await getInput(), /^#r "nuget: Newtonsoft\.Json, \d+\.\d+\.\d+"$/, 'newest version inserted');
await page.waitForTimeout(1500);
const dcol = await page.evaluate(() => { const o = {}; for (const sp of document.querySelectorAll('#editor .view-line span span')) o[sp.textContent.trim()] = getComputedStyle(sp).color; return o; });
console.log('directive colours:', JSON.stringify(dcol));
assert.equal(dcol['#r'], 'rgb(155, 155, 155)', '#r coloured as a preprocessor directive in the input');
await page.keyboard.press('Control+Enter');
await page.waitForFunction(() => /nuget Newtonsoft\.Json/.test(document.querySelector('.entry:last-child')?.innerText || ''), null, { timeout: 60000 });
const dh = await page.locator('.entry').last().locator('.code span').evaluateAll((els) => els.map((e) => e.className + ':' + e.textContent.slice(0, 4)));
console.log('directive in history:', dh.join(' '));
assert.ok(dh.some((x) => x.startsWith('t-preproc:#r')), '#r coloured in the history too');

// ---------- commands, copy buttons on output boxes ----------
await page.evaluate(() => window.__submit('#help'));
let ent = page.locator('.entry').last();
assert.ok((await ent.locator('.out').innerText()).includes('#reset'), '#help lists the commands');
assert.ok(await ent.locator('.code .t-preproc').count() >= 1, '#help is coloured as a directive');
await ent.locator('.out .copy').click();
assert.equal(await page.evaluate(() => navigator.clipboard.readText()), await ent.locator('.out').evaluate((e) => e.firstChild.textContent), 'output copy button copies the plain text');
await page.evaluate(() => window.__submit('var kept = 123;'));
await page.evaluate(() => window.__submit('kept + 1'));
await page.locator('.entry').last().locator('.val .copy').click();
assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '124', 'return value copy');
await page.evaluate(() => window.__submit('Console.WriteLine("line1\\nline2"); throw new InvalidOperationException("boom");'));
ent = page.locator('.entry').last();
await ent.locator('.out .copy').click();
assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'line1\nline2');
await ent.locator('.err .copy').last().click();
assert.ok((await page.evaluate(() => navigator.clipboard.readText())).includes('boom'), 'error copy');
await page.evaluate(() => window.__submit('#clear'));
assert.equal(await page.locator('.entry').count(), 0, '#clear empties the transcript');
assert.ok((await page.locator('#transcript .note').innerText()).includes('#reset'), '#clear points at #reset');
await page.evaluate(() => window.__submit('kept'));
assert.equal((await page.locator('.entry').last().locator('.val').innerText()).trim(), '123', 'state survives #clear');
await page.evaluate(() => window.__submit('clear'));
assert.equal(await page.locator('.entry').count(), 0, 'bare clear works too');
await page.route('https://scripts.test/hello.csx', (route) => route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'text/plain' }, body: 'var loaded = 40 + 2;\nloaded' }));
await page.evaluate(() => window.__submit('#load "https://scripts.test/hello.csx"'));
await page.waitForFunction(() => document.querySelectorAll('.entry').length >= 2, null, { timeout: 30000 });
assert.ok((await page.locator('#transcript').innerText()).includes('42'), '#load runs the fetched script');
await page.evaluate(() => window.__submit('#reset'));
await page.evaluate(() => window.__submit('kept'));
assert.ok((await page.locator('.entry').last().locator('.err').first().innerText()).includes('kept'), '#reset forgot the variables');
await page.evaluate(() => window.__submit('#nope'));
assert.ok((await page.locator('.entry').last().locator('.err').count()) >= 1, 'unknown # line is a C# error, not a command');

// ---------- screenshots ----------
await page.evaluate(() => window.monaco.editor.getEditors()[0].setValue('var squares = Enumerable.Range(1, 5).Select(i => i * i);\n'));
await page.click('#editor .monaco-editor .view-lines');
await page.keyboard.press('Control+End');
await page.keyboard.type('Console.Wri');
await page.waitForSelector('.suggest-widget.visible', { timeout: 20000 });
await page.waitForTimeout(500);
fs.mkdirSync(shotDir, { recursive: true });
await page.screenshot({ path: path.join(shotDir, 'screenshot.png') });
await page.keyboard.press('Escape');
const phone = await browser.newContext({ viewport: { width: 390, height: 780 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const p2 = await phone.newPage();
await p2.goto(BASE);
await p2.waitForFunction(() => window.__metrics?.marks.intellisenseReady || window.__metrics?.error, null, { timeout: 300000 });
await p2.evaluate(() => window.__submit('var greeting = "hello phone";\nConsole.WriteLine(greeting.ToUpper());\ngreeting.Length'));
await p2.waitForTimeout(800);
await p2.screenshot({ path: path.join(shotDir, 'screenshot-phone.png') });

// ---------- warm reload: caches populated ----------
const warmWire = { ...wire }; for (const k of Object.keys(wire)) wire[k] = 0;
const tw = Date.now();
await page.goto(BASE);
await page.waitForFunction(() => window.__metrics?.marks.intellisenseReady || window.__metrics?.error, null, { timeout: 300000 });
const warm = await page.evaluate(() => window.__metrics);
const out = { cold: { marks: m.marks, firstResultMs: m.firstResultMs, firstCompletionMs: m.firstCompletionMs, lazy: m.lazy, coreBundle: m.coreBundle, wireBytesAtFirstResult: wireAtFirstResult, wireBytesTotalAfterIntelliSense: warmWire },
  warm: { marks: warm.marks, lazy: warm.lazy, coreBundle: warm.coreBundle, firstCompletionMs: warm.firstCompletionMs, wireBytes: { ...wire } },
  completionLatencyMsWarm: lat, completionMsInEditor: m.completion, latency: m.latency, assets: m.assets };
fs.writeFileSync(path.resolve(metricsOut), JSON.stringify(out, null, 1));
console.log('metrics written', metricsOut);
await browser.close(); server.kill();
assert.deepEqual(notFound.filter((u) => !/favicon/.test(u)), [], 'no 404s');
console.log('E2E OK');
