// The IntelliSense half of a runtime worker, shared by csharp/ and sharplab/: fetch the lazy assemblies (Roslyn Features, Workspaces, ... as plain PE files,
// Cache API first, 4 in parallel), hand them to the .NET side, start the workspace and time a first completion. No DOM: runs in a worker.
// I() returns the app's Interop exports (AddLazyAssembly, StartIntellisense, Intelli); the manifest URL comes from the app's ./config.js;
// probe() asks for a first completion (the app knows its Intelli signature).
import { MANIFESTS } from './config.js';

export async function loadIntellisense({ assets, I, emit, prefix = 'csrepl', probe = () => I().Intelli('Complete', 'Console.Wri', 11, '') }) {
  emit('badge', { text: 'IntelliSense: loading…', cls: 'loading' });
  const tl = performance.now();
  const man = await (await fetch(MANIFESTS.lazy)).json();
  assets.registerHashes('lazy', man);
  const cacheName = prefix + '-lazy-' + man.version;
  for (const k of await caches.keys()) if (k.startsWith(prefix + '-lazy-') && k !== cacheName) await caches.delete(k);
  const total = man.files.reduce((s, f) => s + f.size, 0); let got = 0, fromCache = 0, wireBytes = 0;
  const queue = [...man.files];
  const worker = async () => {
    for (let f; (f = queue.shift());) {
      const r = await assets.getBytes('lazy/' + f.name, cacheName);
      if (!r.bytes) throw new Error('missing lazy/' + f.name);
      got += r.bytes.length; if (r.from === 'cache') fromCache++; else wireBytes += r.wire || f.br;
      I().AddLazyAssembly(f.name, r.bytes);
      emit('badge', { text: 'IntelliSense: ' + (got / 1048576).toFixed(1) + '/' + (total / 1048576).toFixed(1) + ' MB', cls: 'loading' });
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  const lazy = { files: man.files.length, rawBytes: total, wireBytesBr: wireBytes, fromCache, downloadMs: Math.round(performance.now() - tl) };
  emit('badge', { text: 'IntelliSense: starting…', cls: 'loading' });
  await new Promise((r) => setTimeout(r, 30));
  const ts = performance.now();
  I().StartIntellisense(man.entry);
  lazy.startMs = Math.round(performance.now() - ts);
  const tc = performance.now();
  await probe();   // a first completion: warms up the Roslyn services and is the time to first completion
  emit('metrics', { patch: { lazy, firstCompletionMs: Math.round(performance.now() - tc), net2: { ...assets.net } } });
  return lazy;
}
