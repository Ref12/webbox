import { chromium } from 'playwright-core';
import fs from 'node:fs';
import { serve } from './serve.mjs';

export const FIXTURE = new URL('./fixtures/dotnet-runtime-135064.json', import.meta.url).pathname;
export const PR = '#/dotnet/runtime/pull/135064';

/** Start server + browser; GitHub is answered from the recorded fixture, anything unrecorded is a failure. */
export async function start({ viewport = { width: 1600, height: 1000 }, fixture = FIXTURE, mobile = false } = {}) {
  const { srv, port } = await serve();
  const br = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
  const ctx = await br.newContext({ viewport, isMobile: mobile, hasTouch: mobile, serviceWorkers: 'block' });
  const rec = JSON.parse(fs.readFileSync(fixture, 'utf8'));
  const misses = [], seen = [];
  await ctx.route(/^https:\/\/(api\.github\.com|raw\.githubusercontent\.com)\//, route => {
    const url = route.request().url(); seen.push(url);
    const r = rec[url];
    if (!r) { misses.push(url); return route.fulfill({ status: 404, body: '{"message":"not recorded"}', headers: { 'access-control-allow-origin': '*' } }); }
    route.fulfill({ status: r.status, body: r.body, headers: { ...r.headers, 'access-control-allow-origin': '*', 'access-control-expose-headers': 'x-ratelimit-limit, x-ratelimit-remaining, x-ratelimit-reset' } });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => m.type() === 'error' && !/404/.test(m.text()) && errors.push(m.text()));
  const base = 'http://localhost:' + port + '/prview/';
  return { page, ctx, br, srv, misses, seen, errors, base, rec, close: async () => { await br.close(); srv.close(); } };
}
