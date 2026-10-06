import { chromium } from 'playwright-core';
import fs from 'node:fs';
import { serve } from './serve.mjs';

export const FIXTURE = new URL('./fixtures/dotnet-runtime-135064.json', import.meta.url).pathname;
export const PR = '#/dotnet/runtime/pull/135064';
export const PROXY = 'https://cors-proxy.ref12cf.workers.dev';
export const ME = { login: 'octo-reviewer', name: 'Octo Reviewer', avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4' };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const CORS = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'x-ratelimit-limit, x-ratelimit-remaining, x-ratelimit-reset' };

/**
 * Start server + browser. GitHub is answered from the recorded fixture; anything unrecorded and unmocked is a failure.
 * signedIn: true puts a (fake) token and user in localStorage. h.on(method, regex, fn) adds a mock: fn({url, method, body, json}) returns
 * a JSON value, or {status, json|body, headers}. h.calls lists every non-GET and every mocked request.
 */
export async function start({ viewport = { width: 1600, height: 1000 }, fixture = FIXTURE, mobile = false, signedIn = false, settings = null } = {}) {
  const { srv, port } = await serve();
  const br = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
  const ctx = await br.newContext({ viewport, isMobile: mobile, hasTouch: mobile, serviceWorkers: 'block', permissions: ['clipboard-read', 'clipboard-write'] });
  if (signedIn || settings) await ctx.addInitScript(({ signedIn, settings, ME }) => {
    if (sessionStorage.getItem('__seeded')) return; sessionStorage.setItem('__seeded', '1');
    if (signedIn) { localStorage.setItem('prview.token', 'gho_faketoken'); localStorage.setItem('prview.auth', 'oauth'); localStorage.setItem('prview.user', JSON.stringify({ login: ME.login, name: ME.name, avatar: ME.avatar_url })); }
    if (settings) localStorage.setItem('prview.settings', JSON.stringify(settings));
  }, { signedIn, settings, ME });
  setTimeout(() => { br.close().catch(() => {}); srv.close(); }, 150000).unref();   // safety net: a failed test must not leave Chromium keeping the runner alive
  const rec = JSON.parse(fs.readFileSync(fixture, 'utf8'));
  const misses = [], seen = [], calls = [], mocks = [];
  const on = (method, re, fn) => mocks.unshift({ method, re, fn });
  await ctx.route(/^https:\/\/(api\.github\.com|raw\.githubusercontent\.com|avatars\.githubusercontent\.com|cors-proxy\.ref12cf\.workers\.dev|proxy\.test)\//, async route => {
    const rq = route.request(), url = rq.url(), method = rq.method();
    seen.push(url);
    if (/avatars\.githubusercontent/.test(url)) return route.fulfill({ status: 200, body: PNG, contentType: 'image/png', headers: CORS });
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: { ...CORS, 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE' } });
    const m = mocks.find(k => k.method === method && k.re.test(url + (method === 'POST' ? ' ' + (rq.postData() || '') : '')));
    if (m) {
      const body = rq.postData() || '';
      const req = { url, method, body, json: () => { try { return JSON.parse(body); } catch { return null; } } };
      calls.push({ method, url, body: req.json() || body });
      let r = await m.fn(req);
      if (r === undefined || r === null || typeof r !== 'object' || !('status' in r)) r = { status: 200, json: r };
      return route.fulfill({ status: r.status, body: r.body !== undefined ? r.body : JSON.stringify(r.json), headers: { ...CORS, 'content-type': 'application/json', 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4990', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3000), ...(r.headers || {}) } });
    }
    if (method !== 'GET') { misses.push(method + ' ' + url); return route.fulfill({ status: 404, body: '{"message":"not mocked"}', headers: CORS }); }
    // a signed-in page reads files through the contents API; serve those from the recorded raw files
    const cm = url.match(/^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)\?ref=([0-9a-f]+)$/);
    const key = cm ? 'https://raw.githubusercontent.com/' + cm[1] + '/' + cm[2] + '/' + cm[4] + '/' + cm[3] : url;
    const r = rec[key];
    if (!r) { if (!cm) misses.push(url); return route.fulfill({ status: 404, body: '{"message":"not recorded"}', headers: CORS }); }
    route.fulfill({ status: r.status, body: r.body, headers: { ...r.headers, ...CORS } });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => m.type() === 'error' && !/404|422|not mocked|not recorded/.test(m.text()) && errors.push(m.text()));
  const base = 'http://localhost:' + port + '/prview/';
  return { page, ctx, br, srv, misses, seen, calls, errors, base, rec, on, close: async () => { await br.close(); srv.close(); } };
}
