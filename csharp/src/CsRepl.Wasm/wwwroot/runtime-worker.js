// A .NET WebAssembly runtime in a dedicated worker. Two of them run side by side (see the page script):
//   role 'exec'     compiles and runs submissions (it is busy while user code runs; Stop terminates it)
//   role 'intelli'  Roslyn IntelliSense: completion, hover, signature help, diagnostics, colours (stays responsive while code runs)
// The page talks to them with the small message protocol (the protocol module).
import { serve, batcher } from './protocol.js';
import { createAssets } from './assets.js';
import { loadIntellisense } from './intelli-loader.js';
import { MANIFESTS, DOTNET } from './config.js';

const role = self.name.startsWith('intelli') ? 'intelli' : 'exec';
const emit = (event, data) => self.postMessage({ ...data, event });
let assets, exportsRef, threads = false, aot = false, currentOut = null;

async function boot(args) {
  threads = !!args.threads; aot = !!args.aot && !threads;
  assets = createAssets({ emit, threads, aot });
  const { dotnet } = await import(threads ? DOTNET.mt : aot ? DOTNET.aot : DOTNET.st);
  const t0 = performance.now();
  const rt = await dotnet.withDiagnosticTracing(false).withResourceLoader(assets.loadBootResource).create();
  for (const k of await caches.keys()) if (k.startsWith('csrepl-fw-') && k !== assets.fwCacheName) await caches.delete(k);
  rt.setModuleImports('host', { ...assets.hostModule, write: (text) => currentOut?.(text) });
  exportsRef = await rt.getAssemblyExports(rt.getConfig().mainAssemblyName);
  emit('mark', { name: 'runtimeCreated' });
  emit('mark', { name: 'exportsReady' });
  // reference assemblies: manifest (small) + the core bundle (one request); everything else on demand
  emit('status', { text: 'loading reference assemblies…' });
  const mf = await (await fetch(MANIFESTS.ref)).text();
  const man = JSON.parse(mf);
  assets.setRefVersion(man.version);
  assets.registerHashes('ref', man);
  for (const k of await caches.keys()) if (k.startsWith('csrepl-refs-') && k !== 'csrepl-refs-' + man.version) await caches.delete(k);
  const core = await assets.getBytes('ref/core.bin', 'csrepl-refs-' + man.version);
  emit('metrics', { patch: { ['coreBundle' + (role === 'exec' ? '' : 'Intelli')]: { bytes: core.bytes.length, from: core.from, ms: Math.round(core.ms) } } });
  if (!exportsRef.Interop.AddReferenceBundle(core.bytes)) throw new Error('reference bundle contained no usable assemblies');
  exportsRef.Interop.Configure(mf);
  emit('mark', { name: 'refsReady' });
  return man;
}
const I = () => exportsRef.Interop;
const wire = () => performance.getEntriesByType('resource').filter((r) => r.name.startsWith(self.location.origin)).reduce((s, r) => s + (r.encodedBodySize || 0), 0);

let booted;   // every op except init waits for the boot (the page may send requests while it is still running)
const handlers = {
  async init(args) {
    const man = await (booted = boot(args));
    if (role === 'exec') {
      emit('status', { text: 'warming up compiler…' });
      const tw = performance.now();
      const warm = JSON.parse(await I().Submit('1'));
      I().Reset();
      assets.markReady();
      emit('metrics', { patch: { firstResultMs: Math.round(performance.now() - tw), wireBytesAtFirstResult: wire(), threads, aot } });
      if (!warm.success) console.error('warm-up failed', warm);
      emit('metrics', { patch: { net: { ...assets.net } } });
      emit('mark', { name: 'firstResult' });
      return { assemblies: man.assemblies.map((a) => a.name.replace(/\.dll$/i, '')), threads, aot, cores: navigator.hardwareConcurrency, crossOriginIsolated: self.crossOriginIsolated };
    }
    return { threads };
  },

  // ---- exec ----
  async submit({ code, quiet }, ctx) {
    await booted;
    const start = assets.assets.length;
    const batch = quiet ? null : batcher((t) => ctx.out(t));
    currentOut = batch ? batch.write : null;
    const t = performance.now();
    let res;
    try { res = JSON.parse(await I().Submit(code)); } finally { batch?.flush(); currentOut = null; }
    return { res, ms: performance.now() - t, assets: assets.assets.slice(start), net: { ...assets.net } };
  },
  async isComplete({ code }) { await booted; return I().IsComplete(code); },

  // ---- shared ----
  async reset() { await booted; I().Reset(); return true; },

  // ---- intelli ----
  async loadIntellisense() {
    await booted;
    await loadIntellisense({ assets, I, emit });
    return true;
  },
  async intelli({ op, text, pos, extra }) { await booted; return await I().Intelli(op, text, pos ?? 0, extra ?? ''); },
  async track({ code }) { await booted; await I().Track(code); return true; },
};
serve(self, handlers);
