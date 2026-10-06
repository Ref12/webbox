// Measures first-load wire bytes and time to first result of a published site (used for the before/after comparison).
import { chromium } from 'playwright-core';
const url = process.argv[2];
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
const page = await (await browser.newContext()).newPage();
let wire = 0; page.on('response', async (r) => { try { if (r.url().startsWith('http://localhost')) wire += Number((await r.allHeaders())['content-length'] || 0); } catch {} });
await page.goto(url);
await page.waitForFunction(() => window.__metrics?.ready || window.__metrics?.error, null, { timeout: 240000 });
const m = await page.evaluate(() => window.__metrics);
const enc = await page.evaluate(() => performance.getEntriesByType('resource').filter((r) => r.name.startsWith(location.origin)).reduce((s, r) => s + (r.encodedBodySize || 0), 0));
console.log(JSON.stringify({ wireBytes: enc, firstResultMark: m.marks.firstResult, marks: m.marks, firstResultMs: m.firstResultMs, error: m.error }));
await browser.close();
