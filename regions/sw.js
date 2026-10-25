// Regions offline cache: stale-while-revalidate for this folder only. Bump VERSION to roll out changes.
const VERSION = 'regions-v1';
const FILES = ['./', 'index.html', 'app.js', 'app.css', 'lib/schema.mjs', 'lib/rules.mjs', 'lib/logic.mjs', 'lib/validate.mjs', 'lib/play.mjs',
  'boards/5.json', 'boards/6.json', 'boards/7.json', 'boards/8.json', 'boards/9.json'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('regions-') && k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin) return;
  e.respondWith(caches.open(VERSION).then(async (c) => {
    const hit = await c.match(r, { ignoreSearch: true });
    const net = fetch(r).then((res) => { if (res.ok) c.put(r, res.clone()); return res; }).catch(() => hit);
    return hit || net;
  }));
});
