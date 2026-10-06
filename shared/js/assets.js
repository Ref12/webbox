// Everything the runtime workers need to get bytes: a retrying fetch, the Cache API, optional in-worker Brotli (GitHub Pages only), and the
// JS side of Interop.FetchAsset / TakeAsset. No DOM: runs in a worker.
// Shared by csharp/ and sharplab/: it imports the BUILD and BROTLI settings from the app's own ./config.js; `prefix` names the app's Cache API entries.
import { BUILD, BROTLI, BROTLI_ONLY } from './config.js';

export function createAssets({ emit, threads = false, aot = false, prefix = 'csrepl', brotli = BROTLI }) {
  const hashes = {};   // site path -> content hash (from the manifests): a changed file is a new URL
  const withHash = (p) => (hashes[p] ? p + '?h=' + hashes[p] : p);
  const net = { started: 0, done: 0, bytes: 0, retries: 0 };
  const assets = [];   // { path, bytes, from, ms } for files fetched on demand
  let refVersion = 'v0', ready = false;
  const fileName = (u) => decodeURIComponent(String(u?.url ?? u).split('?')[0].split('/').pop() || String(u));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // resilient fetch: 3 tries with backoff for every same-origin GET (also the .NET runtime's own downloads)
  const nativeFetch = self.fetch.bind(self);
  self.fetch = async function (input, init) {
    const url = String(input?.url ?? input);
    const method = (init?.method || input?.method || 'GET').toUpperCase();
    if (method !== 'GET' || (/^https?:/.test(url) && !url.startsWith(self.location.origin))) return nativeFetch(input, init);
    net.started++;
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const resp = await nativeFetch(input, init);
        if (resp.ok || (resp.status < 500 && resp.status !== 408 && resp.status !== 429)) {
          net.done++; net.bytes += Number(resp.headers.get('content-length') || 0);
          if (!ready) emit('status', { text: 'downloading… ' + net.done + '/' + net.started + ' files, ' + (net.bytes / 1048576).toFixed(1) + ' MB' });
          return resp;
        }
        lastErr = new Error('HTTP ' + resp.status);
      } catch (e) { lastErr = e; }
      net.retries++;
      emit('status', { text: 'retrying ' + fileName(input) + ' (' + attempt + '/3)…' });
      await sleep(400 * 3 ** (attempt - 1));
    }
    const err = new Error('Could not download ' + fileName(input) + ': ' + lastErr.message + ' (after 3 tries). Check your connection and reload.');
    err.fileName = fileName(input);
    throw err;
  };

  async function cacheOpen(name) { try { return await caches.open(name); } catch { return null; } }
  // GitHub Pages only: binaries are shipped as <file>.br and decoded here; the plain file is the fallback.
  const PACKED = /\.(wasm|dll|bin|pdb)(\?|$)/;
  const usePacked = (key) => brotli && PACKED.test(key) && (!BROTLI_ONLY || BROTLI_ONLY.some((p) => new URL(key, self.location.href).pathname.endsWith('/' + p)));
  async function fetchPacked(key) {
    if (usePacked(key)) {
      try {
        const u = new URL(key); u.pathname += '.br';
        const resp = await fetch(u.href);
        if (resp.ok) {
          const packed = new Uint8Array(await resp.arrayBuffer());
          const { brotliDecode } = await import('./br.js');
          return { bytes: await brotliDecode(packed), wire: packed.length, status: 200 };
        }
      } catch (e) { console.warn('brotli path failed for ' + fileName(key) + ', using the plain file:', e.message); }
    }
    const resp = await fetch(key);
    if (!resp.ok) return { bytes: null, status: resp.status };
    const bytes = new Uint8Array(await resp.arrayBuffer());
    return { bytes, wire: Number(resp.headers.get('content-length') || 0) || bytes.length, status: 200 };
  }
  async function getBytes(url, cacheName, { cacheIt = true } = {}) {
    const key = new URL(withHash(url), self.location.href).href;
    const cache = cacheIt ? await cacheOpen(cacheName) : null;
    const t = performance.now();
    if (cache) {
      const hit = await cache.match(key);
      if (hit) return { bytes: new Uint8Array(await hit.arrayBuffer()), from: 'cache', ms: performance.now() - t };
    }
    let last;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const got = await fetchPacked(key);
        if (got.status === 404) return { bytes: null, from: 'network', ms: performance.now() - t };
        if (!got.bytes) throw new Error('HTTP ' + got.status);
        if (cache) { try { await cache.put(key, new Response(got.bytes)); } catch (e) { console.warn('cache put failed', e); } }
        return { bytes: got.bytes, from: 'network', ms: performance.now() - t, wire: got.wire };
      } catch (e) { last = e; await sleep(400 * 3 ** (attempt - 1)); }
    }
    throw new Error('Could not download ' + fileName(url) + ': ' + last.message);
  }
  function registerHashes(kind, m) {
    if (kind === 'ref') {
      if (m.coreHash) hashes['ref/core.bin'] = m.coreHash;
      if (m.typesHash) hashes['ref/types.json'] = m.typesHash;
      for (const a of m.assemblies || []) if (a.h) hashes['ref/a/' + a.name] = a.h;
    } else for (const x of m.files || []) if (x.h) hashes['lazy/' + x.name] = x.h;
  }
  // The runtime's own downloads: Cache API first. Only on GitHub Pages is the .wasm taken from <file>.br; elsewhere the runtime's default (the server compresses).
  const fwCacheName = prefix + '-fw-' + BUILD + (threads ? '-mt' : aot ? '-aot' : '');
  function loadBootResource(type, name, defaultUri) {
    if (!/\.wasm$/.test(name) || !usePacked(defaultUri)) return undefined;
    return (async () => {
      const key = new URL(defaultUri, self.location.href).href;
      const cache = await cacheOpen(fwCacheName);
      let bytes;
      const hit = cache && (await cache.match(key));
      if (hit) bytes = new Uint8Array(await hit.arrayBuffer());
      else {
        const got = await fetchPacked(key);
        if (!got.bytes) throw new Error('Could not download ' + name + ': HTTP ' + got.status + ' (after 3 tries). Check your connection and reload.');
        bytes = got.bytes;
        if (cache) cache.put(key, new Response(bytes)).catch((e) => console.warn('cache put failed', e));
      }
      return new Response(bytes, { headers: { 'content-type': 'application/wasm' } });
    })();
  }
  const taken = new Map();
  const hostModule = {
    async fetchAsset(path) {
      const volatile = /index\.json$|manifest\.json$/.test(path);
      const r = await getBytes(path, /^https?:/.test(path) ? prefix + '-nuget-v1' : prefix + '-refs-' + refVersion, { cacheIt: !volatile });
      taken.set(path, r.bytes ?? new Uint8Array(0));
      if (r.bytes && !volatile) assets.push({ path, bytes: r.bytes.length, from: r.from, ms: Math.round(r.ms) });
    },
    takeAsset(path) { const b = taken.get(path) ?? new Uint8Array(0); taken.delete(path); return b; },
  };
  return {
    net, assets, hashes, hostModule, getBytes, registerHashes, loadBootResource, fileName, fwCacheName,
    setRefVersion(v) { refVersion = v; }, get refVersion() { return refVersion; }, markReady() { ready = true; },
  };
}
