// IntelliSense end-to-end check on both deployment layouts, headless Chromium against local simulations of the hosts:
//   pages       pages-sim.mjs, site under /webbox/ (GitHub Pages: no Content-Encoding for precompressed files, .br decoded in the worker)
//   cloudflare  csharp/tools/cf-sim.mjs, site at / (Worker static assets: the edge compresses)
// Usage: node intellisense.mjs <stagedSite> [metrics.json]     (the folder that contains sharplab/, see tools/stage.mjs)
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const site = path.resolve(process.argv[2] ?? '../../_site');
const metricsOut = process.argv[3] ? path.resolve(process.argv[3]) : null;
const exe = process.env.CHROME_PATH || ['/usr/bin/chromium', '/usr/bin/google-chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const servers = [];
process.on('exit', () => servers.forEach((s) => s.kill()));
const start = async (args) => { const s = spawn(process.execPath, args, { stdio: 'ignore' }); servers.push(s); await new Promise((r) => setTimeout(r, 800)); return s; };
const HOSTS = {
  pages: { port: 8141, prefix: '/webbox/sharplab/', launch: () => start([path.resolve('..', 'pages-sim.mjs'), site, '8141', '/webbox', '--gzip=text']) },
  cloudflare: { port: 8142, prefix: '/sharplab/', launch: () => start([path.resolve('../../../csharp/tools/cf-sim.mjs'), site, '8142']) },
};
const result = {};

for (const [name, host] of Object.entries(HOSTS).filter(([n]) => !process.env.HOSTS || process.env.HOSTS.split(',').includes(n))) {
  await host.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const wire = { lazy: 0, framework: 0, ref: 0, app: 0, files: 0 };
  ctx.on('response', async (r) => {
    try {
      const u = r.url(); if (!u.startsWith('http://localhost')) return;
      const n = Number((await r.allHeaders())['content-length'] || 0);
      wire.files++;
      if (u.includes('/lazy/')) wire.lazy += n; else if (u.includes('/_framework/')) wire.framework += n; else if (u.includes('/ref/')) wire.ref += n; else wire.app += n;
    } catch { /* aborted */ }
  });
  const page = await ctx.newPage();
  page.on('requestfailed', (r) => console.log('[requestfailed]', r.url(), r.failure()?.errorText));
  const errors = []; let step = 'load';
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|favicon/.test(m.text())) errors.push(m.text() + ' @ ' + JSON.stringify(m.location()) + ' [step: ' + step + ']'); });
  const t0 = Date.now();
  await page.goto('http://localhost:' + host.port + host.prefix);
  await page.waitForFunction(() => window.__metrics?.marks?.firstView || window.__metrics?.error, null, { timeout: 300000 });
  const firstViewMs = Date.now() - t0;
  await page.waitForFunction(() => window.__sharplab?.intelliReady() || window.__metrics?.intellisenseError, null, { timeout: 120000 }).catch(async (e) => {
    console.log('[stuck]', JSON.stringify(await page.evaluate(() => ({ marks: window.__metrics.marks, status: document.getElementById('status').textContent, badge: document.getElementById('intelli').textContent, m: window.__metrics.intellisenseError }))));
    throw e;
  });
  const readyMs = Date.now() - t0;
  const m = await page.evaluate(() => window.__metrics);
  assert.equal(m.error, undefined, 'load error ' + m.error);
  assert.equal(m.intellisenseError, undefined, 'IntelliSense failed: ' + m.intellisenseError);
  console.log(name + ': first view ' + firstViewMs + ' ms, IntelliSense ready ' + readyMs + ' ms, first completion ' + m.firstCompletionMs + ' ms, lazy', JSON.stringify(m.lazy));

  const setCode = (code) => page.evaluate((c) => window.__sharplab.setCode(c), code);
  const cursorAfter = (needle, extra = 0) => page.evaluate(([n, e]) => { const { editor, model } = window.__sharplab.ed; const i = model.getValue().indexOf(n) + n.length + e; editor.setPosition(model.getPositionAt(i)); editor.focus(); }, [needle, extra]);
  const trigger = (id) => page.evaluate((i) => window.__sharplab.ed.editor.trigger('e2e', i, {}), id);

  step = 'completion';
  // ---- completion after "Console." lists WriteLine (through the real Monaco suggest widget), with a description ----
  await setCode('using System;\nclass P\n{\n    static void Main()\n    {\n        Console.\n    }\n}\n');
  await cursorAfter('Console.');
  const tc = Date.now();
  await trigger('editor.action.triggerSuggest');
  await page.waitForSelector('.suggest-widget.visible .monaco-list-row', { timeout: 20000 });
  const completionMs = Date.now() - tc;   // the list is virtualised (alphabetical): narrow it by typing
  await page.keyboard.type('WriteL');
  await page.waitForFunction(() => /WriteLine/.test(document.querySelector('.suggest-widget .monaco-list-row.focused')?.innerText || ''), null, { timeout: 10000 });
  const direct = await page.evaluate(() => window.__sharplab.call('Complete', 'using System;\nclass P { void M() { Console.Wri } }', 46, ''));
  const wl = direct.items.find((i) => i.label === 'WriteLine');
  assert.equal(wl.kind, 'Method'); assert.ok(wl.commit.length >= 0);
  const desc = await page.evaluate(() => window.__sharplab.call('Describe', 'using System;\nclass P { void M() { Console.Wri } }', 46, 'WriteLine'));
  assert.match(String(desc), /WriteLine/, 'description of WriteLine');
  await page.keyboard.press('Escape');
  console.log(name + ': completion after "Console." OK (' + completionMs + ' ms incl. widget), description: ' + String(desc).split('\n')[0]);

  step = 'signature';
  // ---- signature help inside WriteLine( ----
  await setCode('using System;\nclass P { static void Main() { Console.WriteLine( } }\n');
  await cursorAfter('Console.WriteLine(');
  await trigger('editor.action.triggerParameterHints');
  await page.waitForFunction(() => /WriteLine/.test(document.querySelector('.parameter-hints-widget')?.innerText || ''), null, { timeout: 20000 });
  const sig = await page.evaluate(() => document.querySelector('.parameter-hints-widget').innerText);
  console.log(name + ': signature help OK: ' + sig.split('\n').filter(Boolean).slice(0, 2).join(' | '));

  step = 'hover';
  // ---- hover on a type: quick info with docs ----
  await setCode('using System;\nclass P { static void Main() { Console.WriteLine(1); } }\n');
  await cursorAfter('Conso', 1);
  await trigger('editor.action.showHover');
  await page.waitForFunction(() => /class System\.Console|class Console/.test(document.querySelector('.monaco-hover')?.innerText || ''), null, { timeout: 20000 });
  const hover = await page.evaluate(() => document.querySelector('.monaco-hover').innerText);
  assert.match(hover, /Console/);
  console.log(name + ': hover OK: ' + hover.split('\n').filter(Boolean).slice(0, 2).join(' | '));
  await page.keyboard.press('Escape');

  // ---- semantic classification ----
  const spans = await page.evaluate(() => window.__sharplab.call('Classify', 'using System;\nclass P { static void Main() { Console.WriteLine(1); } }\n', 0, ''));
  assert.ok(spans.some((s) => s.type === 'class name') && spans.some((s) => s.type === 'method name'), 'semantic spans');

  step = 'options';
  // ---- options feed the workspace: Release/Debug (#if DEBUG) and the C# version (squiggles) ----
  const dbgCode = 'using System;\nclass P\n{\n    static void Main()\n    {\n#if DEBUG\n        Console.\n#endif\n    }\n}\n';
  const dbgPos = dbgCode.indexOf('Console.') + 8;
  await page.selectOption('#cfg', 'release');
  await setCode(dbgCode);
  const rel = await page.evaluate((p) => window.__sharplab.call('Complete', window.__sharplab.state.code, p, '.'), dbgPos);
  await page.selectOption('#cfg', 'debug');
  const dbg = await page.evaluate((p) => window.__sharplab.call('Complete', window.__sharplab.state.code, p, '.'), dbgPos);
  assert.ok(!rel || !rel.items.some((i) => i.label === 'WriteLine'), 'Release: #if DEBUG code is inactive, no members');
  assert.ok(dbg && dbg.items.some((i) => i.label === 'WriteLine'), 'Debug: members of Console');
  console.log(name + ': Release -> no completions inside #if DEBUG; Debug -> ' + dbg.items.length + ' items');
  await page.selectOption('#cfg', 'release');

  const fs9 = 'namespace N;\nclass C { }\n';
  await setCode(fs9);
  const markers = () => page.evaluate(() => window.monaco.editor.getModelMarkers({}).map((x) => x.code));
  await page.selectOption('#lang', 'latest');
  await page.waitForFunction(() => window.monaco.editor.getModelMarkers({}).length === 0, null, { timeout: 20000 });
  await page.selectOption('#lang', '9');
  await page.waitForFunction(() => window.monaco.editor.getModelMarkers({}).some((x) => x.code === 'CS8773'), null, { timeout: 20000 });
  const intelliDiag = await page.evaluate(() => window.__sharplab.call('Diagnostics', window.__sharplab.state.code, 0, ''));
  assert.ok(intelliDiag.some((d) => d.id === 'CS8773'), 'IntelliSense diagnostics follow the C# version');
  console.log(name + ': C# 9 -> CS8773 squiggle (' + (await markers()).join(',') + '); latest -> none');
  await page.selectOption('#lang', 'latest');

  step = 'busy';
  // ---- responsiveness: a long Run in the exec worker does not block typing, completion or the main thread ----
  await setCode('using System;\nusing System.Diagnostics;\nclass P { static void Main() { var sw = Stopwatch.StartNew(); while (sw.ElapsedMilliseconds < 5000) { } Console.WriteLine("done"); } }\n');
  await page.click('#tabs button[data-tab=run]');
  await page.waitForFunction(() => !document.getElementById('runbtn').disabled, null, { timeout: 30000 });
  await page.click('#runbtn');
  await page.waitForTimeout(500);
  const busy = await page.evaluate(async () => {
    const ticks = []; let n = 0; const stop = performance.now() + 1500;
    await new Promise((res) => { const f = () => { n++; if (performance.now() < stop) requestAnimationFrame(f); else res(); }; requestAnimationFrame(f); });
    const t = performance.now();
    const r = await window.__sharplab.call('Complete', 'using System;\nclass P { void M() { Console.Wri } }', 46, '');
    return { frames: n, completionMs: Math.round(performance.now() - t), items: r?.items.length, running: document.getElementById('runbtn').disabled };
  });
  assert.ok(busy.running, 'the program is still running');
  assert.ok(busy.frames > 20, 'main thread kept rendering during Run: ' + busy.frames + ' frames in 1.5 s');
  assert.ok(busy.items > 0 && busy.completionMs < 3000, 'completion answered during Run: ' + JSON.stringify(busy));
  console.log(name + ': during a 5 s Run: ' + busy.frames + ' frames/1.5 s, completion ' + busy.completionMs + ' ms');
  await page.waitForFunction(() => !document.getElementById('runbtn').disabled, null, { timeout: 30000 });

  assert.deepEqual(errors, [], 'console errors: ' + errors.join(' | '));
  result[name] = { firstViewMs, intellisenseReadyMs: readyMs, firstCompletionMs: m.firstCompletionMs, lazy: m.lazy, wire, marks: m.marks, completionWidgetMs: completionMs, busy,
    coreBundle: m.coreBundle, coreBundleIntelli: m.coreBundleIntelli, latency: m.latency };
  await ctx.close();
}
if (metricsOut) fs.writeFileSync(metricsOut, JSON.stringify(result, null, 1));
console.log('IntelliSense e2e passed on: ' + Object.keys(result).join(', '));
await browser.close();
process.exit(0);
