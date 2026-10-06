// Headless-Chromium end-to-end check of the published site, with metrics and screenshots.
// Usage: node run.mjs <publishedWwwroot> [screenshotDir] [metrics.json]     (needs internet: nuget.org, Monaco CDN)
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const site = path.resolve(process.argv[2] ?? '../../dist/wwwroot');
const shotDir = path.resolve(process.argv[3] ?? '../../docs');
const metricsOut = path.resolve(process.argv[4] ?? '../../docs/metrics.json');
const port = 8124;
const server = spawn(process.execPath, [path.resolve('..', 'serve.mjs'), site, String(port)], { stdio: 'inherit' });
await new Promise((r) => setTimeout(r, 800));
const exe = process.env.CHROME_PATH || ['/usr/bin/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium-browser'].find((p) => fs.existsSync(p));
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { const t = m.text(); if (m.type() === 'error' && !/Failed to load resource/.test(t)) errors.push(t); if (/\[fuget\]/.test(t)) console.log(t); });
page.on('pageerror', (e) => { errors.push(e.message); console.log('[pageerror]', e.message); });
const wire = { framework: 0, refs: 0, site: 0, nuget: 0, cdn: 0 };
page.on('response', async (r) => {
  try {
    const n = Number((await r.allHeaders())['content-length'] || 0); const u = r.url();
    if (u.startsWith('http://localhost')) { if (u.includes('/_framework/')) wire.framework += n; else if (u.includes('/ref/')) wire.refs += n; else wire.site += n; }
    else if (u.includes('nuget.org')) wire.nuget += n; else wire.cdn += n;
  } catch {}
});

const base = 'http://localhost:' + port + '/';
const LINK = '#/Newtonsoft.Json/13.0.3/lib/net6.0/Newtonsoft.Json/Newtonsoft.Json.Linq.JObject';
const fail = (m) => { throw new Error(m); };
const metrics = { link: LINK };
const shot = (name) => page.screenshot({ path: path.join(shotDir, name) });

// ---------- 1. cold start straight on a deep link ----------
const t0 = Date.now();
await page.goto(base + LINK);
await page.waitForFunction(() => window.__ready || window.__metrics?.error || window.__metrics?.lastError, null, { timeout: 240000 });
const cold = await page.evaluate(() => window.__metrics);
assert.equal(cold.error, undefined, 'runtime error: ' + cold.error);
assert.equal(cold.lastError, undefined, 'view error: ' + cold.lastError);
metrics.cold = { marks: cold.marks, wallMs: Date.now() - t0, wire: { ...wire }, assets: cold.assets.map((a) => ({ url: a.url.split('/').slice(-1)[0], bytes: a.bytes, from: a.from, ms: a.ms })) };
console.log('cold first view at', cold.marks.firstView, 'ms; marks', JSON.stringify(cold.marks), 'wire', JSON.stringify(wire));
assert.match(await page.locator('.typepage h2').innerText(), /JObject/);
assert.ok(await page.locator('.member').count() > 30, 'JObject members listed');
assert.ok((await page.locator('#tree').innerText()).includes('Newtonsoft.Json.Linq'), 'tree shows the namespace');
assert.match(await page.locator('.typepage pre.sig').first().innerText(), /class JObject : JContainer/);
assert.ok(await page.locator('.dsec', { hasText: 'Summary' }).count() > 0 || (await page.locator('.msum').count()) > 0, 'docs rendered');
assert.equal(page.url().endsWith(LINK), true, 'deep link kept: ' + page.url());
await shot('screenshot.png');

// ---------- 2. members, docs, obsolete ----------
await page.locator('.member .msig', { hasText: 'Parse(string json)' }).first().click();
await page.waitForSelector('.member.open .mbody .dsec', { timeout: 20000 });
assert.ok((await page.locator('.member.open .mbody').first().innerText()).includes('Decompile this member'));
const memberUrl = page.url();
assert.match(decodeURIComponent(memberUrl), /\?m=M:Newtonsoft\.Json\.Linq\.JObject\.Parse/, 'member in URL');

// ---------- 3. decompiled source (ILSpy decompiler in wasm) ----------
await page.locator('.member.open a.btn', { hasText: 'Decompile this member' }).click();
await page.waitForSelector('pre.decomp', { timeout: 240000 });
const dcode = await page.locator('pre.decomp').innerText();
assert.match(dcode, /public (new )?static JObject Parse\(string json\)/);
metrics.decompileMember = (await page.evaluate(() => window.__metrics.decompile)).at(-1);
await page.getByRole('link', { name: 'Show whole type' }).click();
await page.waitForFunction(() => document.querySelector('pre.decomp')?.innerText.includes('class JObject'), null, { timeout: 240000 });
metrics.decompileType = (await page.evaluate(() => window.__metrics.decompile)).at(-1);
console.log('decompile member', JSON.stringify(metrics.decompileMember), 'type', JSON.stringify(metrics.decompileType));
assert.deepEqual(metrics.decompileType.missing, [], 'all references resolved');
const mono = await page.waitForFunction(() => window.__metrics.monacoColored, null, { timeout: 30000 }).then(() => true).catch(() => false);
metrics.monacoColoured = mono;
console.log('Monaco colourisation:', mono);
await shot('screenshot-decompiled.png');

// ---------- 4. API diff ----------
await page.getByRole('link', { name: 'Diff', exact: true }).click();
await page.waitForSelector('.dsum', { timeout: 240000 });
await page.locator('.diffbar select').selectOption('12.0.3');   // 13.0.2 -> 13.0.3 has no API changes; 12.0.3 -> 13.0.3 does
await page.waitForSelector('.dtype', { timeout: 240000 });
const dsum = await page.locator('.dsum').innerText();
assert.ok(await page.locator('.dtype').count() > 0, 'diff lists types: ' + dsum);
metrics.diff = (await page.evaluate(() => window.__metrics.diff)).at(-1);
console.log('diff', JSON.stringify(metrics.diff), dsum.replace(/\n/g, ' '));
await shot('screenshot-diff.png');

// ---------- 5. dependencies (a package that has some) ----------
await page.goto(base + '#/Serilog.Sinks.Console/6.0.0/lib/net8.0/Serilog.Sinks.Console?tab=deps');
await page.waitForSelector('.dgroup', { timeout: 120000 });
assert.ok((await page.locator('.dgroup a').count()) > 0, 'dependency links');
assert.ok(await page.locator('.dgroup.mine').count() > 0, 'applicable group highlighted');
await shot('screenshot-deps.png');
// decompile against the package's own dependency (Serilog), not just the reference pack
await page.goto(base + '#/Serilog.Sinks.Console/6.0.0/lib/net8.0/Serilog.Sinks.Console/Serilog.ConsoleLoggerConfigurationExtensions?tab=decompiled');
await page.waitForSelector('pre.decomp', { timeout: 240000 });
const dc2 = (await page.evaluate(() => window.__metrics.decompile)).at(-1);
metrics.decompileDependency = dc2;
console.log('decompile with dependency', JSON.stringify(dc2));

// ---------- 6. search ----------
await page.goto(base + '#/');
await page.fill('#q', 'humanizer');
await page.waitForSelector('#suggest a', { timeout: 30000 });
assert.ok((await page.locator('#suggest a').allInnerTexts()).some((t) => /humanizer/i.test(t)), 'autocomplete from nuget.org');
await page.keyboard.press('Enter');
await page.waitForSelector('.card', { timeout: 30000 });
assert.ok(await page.locator('.card').count() > 3, 'search results');
await page.locator('.card').first().click();
await page.waitForSelector('.card-info', { timeout: 120000 });

// ---------- 7. warm start (Cache API populated) ----------
await page.goto('about:blank');
const t1 = Date.now();
await page.goto(base + LINK);
await page.waitForFunction(() => window.__ready, null, { timeout: 240000 });
const warm = await page.evaluate(() => window.__metrics);
metrics.warm = { marks: warm.marks, wallMs: Date.now() - t1, assets: warm.assets.map((a) => ({ url: a.url.split('/').slice(-1)[0], from: a.from, ms: a.ms })) };
console.log('warm first view at', warm.marks.firstView, 'ms; nupkg from', warm.assets.find((a) => a.url.endsWith('.nupkg'))?.from);
assert.equal(warm.assets.find((a) => a.url.endsWith('.nupkg'))?.from, 'cache', 'nupkg served from the Cache API when warm');

// ---------- 8. phone ----------
const phone = await browser.newContext({ viewport: { width: 390, height: 780 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const pp = await phone.newPage();
await pp.goto(base + LINK);
await pp.waitForFunction(() => window.__ready, null, { timeout: 240000 });
assert.equal(await pp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, 'no horizontal overflow on a phone');
await pp.screenshot({ path: path.join(shotDir, 'screenshot-phone.png') });
await pp.locator('#menu').click();
await pp.waitForSelector('body.tree-open #tree');
await pp.screenshot({ path: path.join(shotDir, 'screenshot-phone-tree.png') });
await pp.close();

metrics.errors = errors;
metrics.wireTotal = wire;
fs.writeFileSync(metricsOut, JSON.stringify(metrics, null, 2));
assert.deepEqual(errors, [], 'no console errors');
console.log('E2E OK');
await browser.close(); server.kill();
process.exit(0);
