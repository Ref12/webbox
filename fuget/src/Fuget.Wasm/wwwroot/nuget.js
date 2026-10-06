// nuget.org from the browser: search/autocomplete (azuresearch), versions + .nupkg (flat container). All of these send
// Access-Control-Allow-Origin: * (checked in the README), so no proxy is needed. Downloads are kept in the Cache API;
// metadata (search, version lists) in a second cache with a time-to-live.

export const FLAT = 'https://api.nuget.org/v3-flatcontainer/';
export const SEARCH = 'https://azuresearch-usnc.nuget.org/query';
export const AUTOCOMPLETE = 'https://azuresearch-usnc.nuget.org/autocomplete';
export const PKG_CACHE = 'fuget-pkgs-v1';
export const META_CACHE = 'fuget-meta-v1';
export const META_TTL_MS = 10 * 60 * 1000;

export const log = [];   // { url, bytes, from: 'cache'|'network', ms } for the status line and the e2e metrics

async function open(name) { try { return await caches.open(name); } catch { return null; } }

/**
 * GET with Cache API first. ttl (ms) makes the entry expire (metadata); no ttl = immutable (packages, assemblies).
 * 404 resolves to { bytes: null }. Network errors and 5xx/408/429 are retried 3 times with backoff.
 */
export async function getBytes(url, { cacheName = PKG_CACHE, ttl = 0, fetchFn = fetch } = {}) {
  const t = performance.now();
  const cache = await open(cacheName);
  if (cache) {
    const hit = await cache.match(url);
    if (hit && (!ttl || Date.now() - Number(hit.headers.get('x-fuget-time') || 0) < ttl)) {
      const bytes = new Uint8Array(await hit.arrayBuffer());
      log.push({ url, bytes: bytes.length, from: 'cache', ms: Math.round(performance.now() - t) });
      return { bytes, from: 'cache' };
    }
  }
  let last;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const resp = await fetchFn(url);
      if (resp.status === 404) return { bytes: null, from: 'network' };
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const bytes = new Uint8Array(await resp.arrayBuffer());
      if (cache) { try { await cache.put(url, new Response(bytes, { headers: { 'x-fuget-time': String(Date.now()) } })); } catch (e) { console.warn('cache put failed', e); } }
      log.push({ url, bytes: bytes.length, from: 'network', ms: Math.round(performance.now() - t) });
      return { bytes, from: 'network' };
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 300 * 3 ** (attempt - 1)));
    }
  }
  throw new Error('Could not download ' + url.split('/').slice(-1)[0] + ': ' + last.message);
}

async function json(url) {
  const { bytes } = await getBytes(url, { cacheName: META_CACHE, ttl: META_TTL_MS });
  return bytes ? JSON.parse(new TextDecoder().decode(bytes)) : null;
}

export async function autocomplete(q, take = 8) {
  const r = await json(`${AUTOCOMPLETE}?q=${encodeURIComponent(q)}&take=${take}&prerelease=false&semVerLevel=2.0.0`);
  return r?.data ?? [];
}

export async function search(q, take = 24) {
  const r = await json(`${SEARCH}?q=${encodeURIComponent(q)}&take=${take}&prerelease=false&semVerLevel=2.0.0`);
  return r?.data ?? [];
}

/** All versions, oldest first (flat container order). */
export async function versions(id) {
  const r = await json(`${FLAT}${id.toLowerCase()}/index.json`);
  return r?.versions ?? [];
}

export const latestStable = (vs) => [...vs].reverse().find((v) => !v.includes('-')) ?? vs[vs.length - 1] ?? '';
export const nupkgUrl = (id, v) => `${FLAT}${id.toLowerCase()}/${v.toLowerCase()}/${id.toLowerCase()}.${v.toLowerCase()}.nupkg`;
