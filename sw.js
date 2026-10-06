// webbox launcher service worker. Handles ONLY the launcher shell (root page, manifest, icons); everything else
// (/csharp/, /fuget/, /sharplab/, /hexad/, other apps and their own service workers) is not intercepted, so their
// caching and csharp's COOP/COEP headers are untouched. Bump VERSION to roll out changes.
const VERSION = 'webbox-shell-v1';
const SHELL = ['./', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png'];
const base = new URL('./', self.location).pathname;
const shellPaths = new Set(SHELL.map((u) => new URL(u, self.location).pathname).concat([base + 'index.html']));

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('webbox-shell-') && k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin || !shellPaths.has(u.pathname) || u.search) return;   // everything else: browser default
  const isHtml = r.mode === 'navigate' || u.pathname === base || u.pathname.endsWith('/index.html');
  e.respondWith(isHtml
    ? fetch(r).then((res) => { if (res.ok) { const c = res.clone(); caches.open(VERSION).then((ca) => ca.put(base, c)); } return res; })
        .catch(() => caches.match(base))
    : caches.match(r).then((hit) => hit || fetch(r).then((res) => { if (res.ok) { const c = res.clone(); caches.open(VERSION).then((ca) => ca.put(r, c)); } return res; })));
});
