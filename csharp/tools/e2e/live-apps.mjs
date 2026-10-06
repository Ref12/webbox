// node live-apps.mjs <base>  : fuget opens Newtonsoft.Json 13.0.3, SharpLab compiles the sample and shows IL
import { chromium } from 'playwright-core'; import fs from 'node:fs';
const base = process.argv[2].replace(/\/$/, '');
const browser = await chromium.launch({ executablePath: ['/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => fs.existsSync(p)), args: ['--no-sandbox'] });
const res = {};
async function app(name, f) {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } }); const page = await ctx.newPage();
  const errors = [], bad = []; let bytes = 0; const encs = new Set();
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 160))); page.on('pageerror', (e) => errors.push('pageerror ' + e.message.slice(0, 160)));
  ctx.on('response', (r) => { if (r.status() >= 400) bad.push(r.status() + ' ' + r.url().slice(0, 130)); });
  ctx.on('requestfinished', async (rq) => { try { const rs = await rq.response(); encs.add((await rs.allHeaders())['content-encoding'] || 'none'); bytes += (await rq.sizes()).responseBodySize; } catch {} });
  const t = Date.now();
  try { res[name] = await f(page, t); } catch (e) { res[name] = { failed: String(e.message).slice(0, 300) }; }
  Object.assign(res[name], { errors: errors.filter((e) => !/Failed to load resource/.test(e)), bad, wireMB: +(bytes / 1048576).toFixed(1), enc: [...encs].join('+'), totalMs: Date.now() - t });
  if (process.env.SHOTS) await page.screenshot({ path: process.env.SHOTS + '/' + name + '-' + base.replace(/\W+/g, '_') + '.png' });
  await ctx.close();
}
await app('fuget', async (page, t) => {
  await page.goto(base + '/fuget/#/Newtonsoft.Json/13.0.3/lib/net6.0/Newtonsoft.Json/Newtonsoft.Json.Linq.JObject');
  await page.waitForFunction(() => /JObject/.test(document.querySelector('#panel')?.innerText || '') && !/Loading/.test(document.querySelector('#panel')?.innerText || ''), null, { timeout: 120000 });
  const txt = await page.locator('#panel').innerText();
  return { opened: true, ms: Date.now() - t, status: await page.locator('#status').innerText(), sample: txt.slice(0, 90).replace(/\n+/g, ' | ') };
});
await app('sharplab', async (page, t) => {
  await page.goto(base + '/sharplab/');
  await page.waitForFunction(() => /compiled in/.test(document.querySelector('#status')?.innerText || '') , null, { timeout: 120000 });
  const status = await page.locator('#status').innerText();
  await page.click('[data-tab=il]'); await page.waitForTimeout(1500);
  const il = await page.locator('#right').innerText();
  return { compiled: status, ms: Date.now() - t, ilShown: /\.method|IL_0000|ldstr|call /.test(il), ilSample: il.slice(0, 120).replace(/\n+/g, ' | ') };
});
console.log(JSON.stringify(res, null, 1)); await browser.close();
