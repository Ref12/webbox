// A .NET WebAssembly runtime in a dedicated worker. Two of them run side by side (started by the page script), so the page never runs .NET itself:
//   role 'exec'     compile, views (syntax, IL, decompiled C#, verify) and Run: busy for as long as a compile or program takes, typing is unaffected
//   role 'intelli'  Roslyn IntelliSense (completion, hover, signature help, diagnostics, colours), configured with the options bar like the compile
// Both boot the same app (the same files, already in the Cache API for the second one). The message protocol is shared with csharp/ (protocol.js).
import { serve } from './protocol.js';
import { createAssets } from './assets.js';
import { loadIntellisense } from './intelli-loader.js';
import { MANIFESTS, DOTNET, BROTLI } from './config.js';

const role = self.name.startsWith('intelli') ? 'intelli' : 'exec';
const emit = (event, data) => self.postMessage({ ...data, event });
let assets, exportsRef, aot = false;

async function boot(args) {
  aot = !!args.aot;
  assets = createAssets({ emit, aot, prefix: 'sharplab', brotli: BROTLI && !args.nobr });
  const { dotnet } = await import(aot ? DOTNET.aot : DOTNET.st);
  const rt = await dotnet.withDiagnosticTracing(false).withResourceLoader(assets.loadBootResource).create();
  for (const k of await caches.keys()) if (k.startsWith('sharplab-fw-') && k !== assets.fwCacheName) await caches.delete(k);
  rt.setModuleImports('host', assets.hostModule);
  emit('mark', { name: 'runtimeCreated' });
  exportsRef = await rt.getAssemblyExports(rt.getConfig().mainAssemblyName);
  emit('mark', { name: 'exportsReady' });
  emit('status', { text: 'loading reference assemblies…' });
  const mf = await (await fetch(MANIFESTS.ref)).text();
  const man = JSON.parse(mf);
  assets.setRefVersion(man.version);
  assets.registerHashes('ref', man);
  for (const k of await caches.keys()) if (k.startsWith('sharplab-refs-') && k !== 'sharplab-refs-' + man.version) await caches.delete(k);
  const core = await assets.getBytes('ref/core.bin', 'sharplab-refs-' + man.version);
  emit('metrics', { patch: { ['coreBundle' + (role === 'exec' ? '' : 'Intelli')]: { bytes: core.bytes.length, from: core.from, ms: Math.round(core.ms) } } });
  if (!exportsRef.Interop.AddReferenceBundle(core.bytes)) throw new Error('reference bundle contained no usable assemblies');
  exportsRef.Interop.Configure(mf);
  emit('mark', { name: 'refsReady' });
}
const I = () => exportsRef.Interop;
const wire = () => performance.getEntriesByType('resource').filter((r) => r.name.startsWith(self.location.origin)).reduce((s, r) => s + (r.encodedBodySize || 0), 0);

let booted;   // every op except init waits for the boot (the page may send requests while it is still running)
const handlers = {
  async init(args) {
    await (booted = boot(args));
    assets.markReady();
    emit('metrics', { patch: { ['net' + (role === 'exec' ? '' : 'Intelli')]: { ...assets.net }, ['wireBytesAtBoot' + (role === 'exec' ? '' : 'Intelli')]: wire() } });
    return { role, aot };
  },

  // ---- exec ----
  async compile({ code, settings }) {
    await booted;
    const start = assets.assets.length;
    const res = JSON.parse(await I().Compile(code, settings));
    return { res, assets: assets.assets.slice(start), wire: wire() };
  },
  async syntax({ code, settings }) { await booted; return I().Syntax(code, settings); },
  async il() { await booted; return I().Il(); },
  async decompile({ level }) { await booted; return I().Decompile(level); },
  async verify() { await booted; return I().Verify(); },
  async layout() { await booted; return I().Layout(); },
  async run() { await booted; return await I().Run(); },
  async assemblyBase64() { await booted; return I().AssemblyBase64(); },

  // ---- intelli ----
  async loadIntellisense() {
    await booted;
    await loadIntellisense({ assets, I, emit, prefix: 'sharplab', probe: () => I().Intelli('Complete', 'System.Console.Wri', 18, '', '') });
    return true;
  },
  async intelli({ op, text, pos, extra, settings }) { await booted; return await I().Intelli(op, text, pos ?? 0, extra ?? '', settings ?? ''); },
};
serve(self, handlers);
