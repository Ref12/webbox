# JIT asm spike: real x64 .NET + DOTNET_JitDisasm in the browser

## Verdict
**Technically works, but only as a niche/fallback.** container2wasm (c2w) running QEMU-TCG-in-wasm with real linux/amd64 .NET 10 produced correct JitDisasm output in headless Chromium. Costs: ~69 MB brotli download (slim) / 88 MB (stock runtime image), ~10 s to boot, **~50 s per compile** (cold dotnet start under TCG). Not interactive-grade. **Recommendation: do not make the emulator the default JIT-asm path; use a remote endpoint (option b, native ~0.13 s/run) as primary.** Keep c2w as an optional offline mode only if a ~1 min latency is acceptable. v86 and CheerpX cannot run x64 .NET.

## Options
| Option | Runs x64 .NET? | Download (brotli) | TTFO | Per compile | License | Verdict |
|---|---|---|---|---|---|---|
| native baseline (this runner) | yes | - | - | 0.13 s | - | reference |
| c2w amd64, QEMU-wasm TCG, stock runtime:10.0 rootfs | **yes (measured)** | data 88.2 MB (raw 277) + wasm 11.5 MB (raw 41) + js 63 KB | 42.5 s (page load to disasm, one-shot CMD, 3 s poll) | n/a (one-shot image) | c2w Apache-2.0, QEMU GPL-2 | works, heavy |
| c2w amd64, slim rootfs (CoreLib+Console+few libs, runtime-deps base, doc/man/locale stripped) | **yes (measured)** | data 69.1 MB (raw 219) + wasm 11.5 MB | 10.4 s to shell prompt (snapshot restore), first output ~+50 s | **48-56 s** per run (6 runs, upload negligible) | same | works, heavy; best c2w |
| v86 | **no**: 32-bit x86 only, no long mode; .NET has no linux-x86 runtime build | - | - | - | BSD-2 | not viable (https://github.com/copy/v86) |
| CheerpX | **no**: docs say 32-bit x86 only; 64-bit is future work (https://cheerpx.io/docs/overview , https://labs.leaningtech.com/blog/cx-10) | - | - | - | Free for personal/FOSS/evals, one-person cos; Small Business GBP 100/dev/month (up to 10 devs, self-hosting + redistribution allowed); self-host and redistribution NOT allowed in free tier; Enterprise by quote (https://cheerpx.io/licensing) | not viable |

## What was measured and how
- Build (reproducible): `measure/Dockerfile`, `measure/Dockerfile.slim`; `docker build -t jitbox:slim -f Dockerfile.slim .` then
  `git clone -b v0.8.4 https://github.com/container2wasm/container2wasm src; ./c2w --assets ./src --to-js --target-stage=js-qemu-amd64 jitbox:slim out/`
  (note: stock c2w v0.8.4 fails without `--assets`: it git-clones a tag from the old ktock/ repo that no longer exists; trailing slash on output dir required). First build ~17 min (compiles QEMU to wasm in docker), rebuild with cache ~30 s.
- Runtime: `measure/serve.mjs` (static server with COOP/COEP, required for SharedArrayBuffer/pthreads), `measure/index.html` (c2w's emscripten + xterm-pty loader, network disabled), `measure/run-browser.mjs` (one-shot TTFO), `measure/run-interactive.mjs` (boot to shell, then compile several dlls). Needs `npm i xterm@5.3.0 xterm-pty playwright-core` next to them; uses /usr/bin/chromium.
- Env baked in: DOTNET_TieredCompilation=0, TieredPGO=0, ReadyToRun=0, DOTNET_JitStdOutFile=/dev/stdout; DOTNET_JitDisasm=<Method> set per run. Output was correct x64 (`lea eax,[rdi+rsi]; ret`). Note: the emulated CPU reports "generic X64" (no VEX/EVEX), so disasm differs from a real modern CPU (native showed VEX+EVEX) - a fidelity caveat; QEMU CPU model flags could be tuned.
- Caveats: assets from localhost so real-network download time is extra (69-100 MB; cacheable, c2w data is one blob so no incremental fetch). Chromium headless on 4 vCPU; a desktop browser may be faster, mobile much slower. Memory: VM is 128 MB + wasm heap.
- Slim rootfs effect: data 277->219 MB raw (88->69 MB brotli). The .NET part is only 39 MB; the remaining ~110 MB is the Ubuntu runtime-deps base, so a busybox/musl (alpine .NET) rootfs would likely shrink further - not tried (alpine needs musl runtime; not tested).
- Passing assemblies: tried base64 over the pty (chunked printf >> file, 1000 chars/line because of 4096-byte tty line limit, then base64 -d). Works; 6 KB dll upload cost is negligible vs the ~50 s dotnet start. Not tried: 9p/virtio-fs mount (c2w mounts /pack via -virtfs; would be the cleaner path for big inputs).
- Per-compile is dominated by cold `dotnet` startup (hostfxr, coreclr init, JIT of startup path, all under TCG), 400x native. Untested idea to cut it: a long-lived in-VM host process that loads assemblies via AssemblyLoadContext and calls RuntimeHelpers.PrepareMethod for the requested method, reading requests from stdin (avoids runtime restart; JIT itself would still be slow-ish under TCG). Could bring per-compile to a few seconds; unverified.
- Not built: the bonus upload page (assets are 70-90 MB, cannot be committed; harness page in measure/index.html is the basis).
