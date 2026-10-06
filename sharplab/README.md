# sharplab

A SharpLab-style C# playground running **entirely in the browser** on .NET 10 WebAssembly (Roslyn compiles in the page; no server logic, plain static files
under `/webbox/sharplab/`). Type C#, see the **syntax tree**, **IL**, **decompiled C# after lowering**, **run output** and **IL verification**; share the code and
options as a link; Debug/Release, language version and optimize toggles. The **JIT asm** tab explains what is possible in a browser and can fetch real JIT output from an endpoint.

![screenshot](docs/screenshot.png) ![syntax](docs/screenshot-syntax.png)

## Build, test, run
**No .NET workloads** (no `wasm-tools`, nothing machine-wide): the wasm app is a `Microsoft.NET.Sdk.WebAssembly` project, interpreter only, restored from the NuGet packs
(`microsoft.net.sdk.webassembly.pack`, `microsoft.netcore.app.runtime.mono.browser-wasm`, `microsoft.net.illink.tasks`), exactly like `csharp/`.
`dotnet publish` prints a hint recommending wasm-tools; it is only a hint. Nothing here needs native relinking or AOT (see Limits).
```
dotnet test tests/SharpLab.Tests            # 19 tests: compile, options, IL, decompile levels, run, verify, syntax tree (restores the ref-pack NuGet once)
node --test tests/js/*.test.mjs             # 12 tests: share-link codec, syntax-tree <-> editor offsets
dotnet run tools/PrepareRefs.cs             # ref pack -> src/SharpLab.Wasm/wwwroot/ref (core.bin, a/<name>.dll, manifest.json, types.json); generated, not committed
dotnet publish src/SharpLab.Wasm -c Release -o dist
node tools/stage.mjs dist/wwwroot _site/sharplab     # Pages staging: .br for big binaries (decoded in the page), content-hashed app files
cd tools/e2e && npm install && node run.mjs ../../_site ../../docs ../../docs/metrics.json   # headless Chromium e2e, served under /webbox/sharplab/ by tools/pages-sim.mjs
node measure.mjs ../../_site ../../docs/pages-measure.json                                    # throttled cold/warm loads (needs the same npm install)
node tools/serve.mjs dist/wwwroot 8080      # any static server works
(cd jit/endpoint && dotnet build -c Release JitRunner && node --test server.test.mjs)         # the JIT endpoint reference implementation
```
The C# tests use `Path` APIs and no shell; the JS tests use only Node built-ins (`CompressionStream`), so both are meant to run on Windows and Linux. **Only Linux was run here**
(e2e: Chromium on Linux; Monaco comes from the jsDelivr CDN, with a textarea fallback).

## What it does
* **Editor**: Monaco 0.52.2; Roslyn diagnostics from the real compilation (errors, warnings, info) as squiggles and a clickable problem list. The same compilation feeds all views, so what you see is what compiled.
* **Syntax** tab: expandable tree of nodes, tokens and trivia (each with its span), built lazily. **Linked both ways**: click a row to select its span in the editor; move the caret/selection in the editor and the smallest element covering it is expanded and highlighted (`syntaxpath.js`, unit-tested).
* **IL** tab: Roslyn emits the assembly (Debug/Release switch); `ICSharpCode.Decompiler`'s `ReflectionDisassembler` writes ildasm-style text.
* **C#** tab: the compiled assembly decompiled with **ICSharpCode.Decompiler 11.1**, so lowering is visible. A **Decompile** setting selects how high-level: 1 = nearly raw IL (loops, using, foreach... as the IL says), 2 = *lowered* (default: async state machines, closures/display classes, LINQ lambdas, record members are visible), 3 = full ILSpy output (await, query expressions, records). The levels are lists of `DecompilerSettings` switches (`DecompiledView.SettingsFor`).
* **Run** tab: loads the assembly in an `AssemblyLoadContext` and invokes the entry point (`Main`, top-level statements, `async Task Main`) with Console redirected; exceptions and the exit code are shown. Only on pressing Run (never automatically). A library (no entry point) says so. Limits: single thread, so an infinite loop freezes the tab; no stdin.
* **Verify** tab: **ILVerify runs in wasm** (the verifier behind `dotnet-ilverify`, referenced as `lib/ILVerify.dll`, MIT, taken from the `dotnet-ilverify` 10.0.12 tool package because the `ILVerification` library is not published on nuget.org). It resolves references from the loaded ref pack. ~8 ms for the sample. (One trap found on the way: ILVerify compares types by module instance, so the verified assembly and the one its resolver returns must be the same `PEReader`.)
* **Share link**: `#v1:<base64url(deflate-raw(JSON))>` (`share.js`; `CompressionStream`, only non-default options stored; the URL is updated as you type; the *Share link* button copies it). A 17-line program with options is ~200 characters. The format is pinned by a test.
* **Options**: Config Debug/Release (defines `DEBUG`/`RELEASE`/`TRACE`; switching also sets Optimize, which you may then flip separately), **Optimize** (Roslyn `OptimizationLevel`), **C# version** 7.3 to 14, preview, latest; Decompile level (C# tab).
* **JIT asm** tab: see the investigation below.

## Measurements (GitHub Actions runner, 4 vCPU, headless Chromium, `tools/pages-sim.mjs` = path prefix `/webbox`, `max-age=600`, gzip on the fly for text only; `docs/metrics.json`, `docs/pages-measure.json`)
"First useful view" = the editor with the sample compiled and the C# (lowered) view rendered. Monaco comes from a CDN (1.1 MB, not counted). Numbers vary about ±10 %.
| | shipped (.br decoded in page) | plain, Pages gzips wasm/dll | plain, no compression of wasm/dll |
|---|---|---|---|
| Bytes to first view | **11.4 MB** (framework 10.7 + refs 0.5 + decoder/app 0.2) | 14.2 MB | 36.6 MB |
| Cold, localhost, no throttling | **4.3 s** | 4.4 s | |
| Cold, 25 Mbit/s, 20 ms | **7.5 s** | 8.6 s | 16.0 s |
| Cold, 8 Mbit/s, 60 ms (phone) | **16.9 s** | 19.8 s | 43.3 s |
| Warm (Cache API populated), 25 Mbit/s | 2.7 s | 3.0 s | 4.8 s |
Localhost split (cold): editor 0.5 s, .NET runtime started 1.5-1.8 s, references 2.0 s, **first compile + decompile 2.2 s** (cold interpreter running Roslyn), then ~15-40 ms per later compile (Release, sample size; 90-230 ms for a 20-line program with records/async) and 2-440 ms per view (the first decompile is the slow one).
The payload is dominated by the interpreter-run Roslyn/ICSharpCode assemblies (no trimming, no AOT); that is the same 10 MB class as `csharp/`, minus its 4 MB of lazy IntelliSense assemblies, plus ICSharpCode.Decompiler (~1.9 MB) and ILVerify.

## JIT assembly: investigation (details: `jit/REPORT.md`, `jit/ENDPOINT.md`)
In the browser .NET is the Mono interpreter (or AOT to wasm), so there is no x64 JIT output. Spiked and measured:
* **(a) x86 emulation, real Linux x64 .NET with `DOTNET_JitDisasm`**: **container2wasm (QEMU-in-wasm, amd64) works** and printed correct x64 (`lea eax,[rdi+rsi]; ret`) in headless Chromium, but: download **69 MB (slim rootfs) to 88 MB (stock runtime image) brotli** + 11.5 MB emulator wasm, ~10 s to boot, **~50 s per compile** (a cold `dotnet` start is ~400x slower than native 0.13 s); the emulated CPU is "generic x64", no AVX. **v86** is 32-bit x86 only and .NET has no linux-x86 runtime: not viable. **CheerpX** (Leaning Technologies, commercial; free tier personal/FOSS/evaluation only, no self-hosting or redistribution; Small Business GBP 100/developer/month; Enterprise by quote) runs 32-bit x86 only today: not viable for x64.
* **(b) real machine on demand**: a ~100-line endpoint (`jit/endpoint/server.mjs` + `JitRunner`): POST the compiled assembly, get the `DOTNET_JitDisasm` text. **~0.14 s** per request natively. The reference implementation runs and is tested here (3 tests; the e2e drives the JIT tab against it: 211 ms round trip incl. the browser), but nothing is deployed: it is a design for a hexad sandbox to run (`ENDPOINT.md` has the contract, safety notes and how to start it with `start_process`).
* **Recommendation**: the endpoint is the primary JIT path; emulation is an offline curiosity (~1 min per compile, ~80 MB). The JIT tab states this, lists the options with the numbers above, and has a field for an endpoint URL (stored in `localStorage`; nothing is sent unless you press the button).
* Untried ideas that could change the picture: a long-lived in-VM host that calls `PrepareMethod` instead of restarting `dotnet` (JitRunner is that host, natively; under QEMU it might reach a few seconds per compile); an Alpine/busybox rootfs (smaller download); a 9p mount instead of base64-over-pty.

## What came from where
Copied from `csharp/` (the REPL; copy for now, a shared library can be extracted later):
* `src/SharpLab.Core/ReferenceBundle.cs`, `ReferenceStore.cs` (+ keeps the raw images for the decompiler and verifier), `RefCatalog.cs` (`RefCatalog`, `RefResolver`, `Directives`): reference-assembly bookkeeping and on-demand loading.
* `tools/PrepareRefs.cs` (ref pack -> `core.bin` + on-demand `a/*.dll`), `tools/serve.mjs`, `tools/e2e/` (playwright harness pattern, `measure.mjs`).
* `src/SharpLab.Wasm`: the csproj, the `fetchAsset`/`takeAsset` JS interop, `main.js` pieces (retrying fetch, Cache API asset loader, Monaco loader with textarea fallback).
* From the **csharp-repl** branch (the Pages work in progress, see below): `tools/stage.mjs`, `tools/pages-sim.mjs`, `br.js` and `vendor/brotli_dec_wasm*` (+ licenses), and the `loadBootResource`/`getBytes`/hash code in `main.js`.
New here: everything else (`Compiler`, `SyntaxTreeModel`, `Views` (IL/C#), `Runner`, `Verifier`, `Playground`, the whole UI, `share.js`, `syntaxpath.js`, `jit.js`, the tests, `jit/`). Not reused: the REPL session (`ReplSession`), NuGet resolver, and IntelliSense (Roslyn Features/Workspaces, 14 MB lazy): this app has diagnostics and no completion/hover.

## Pages workflow (coordination with the csharp-repl session)
`.github/workflows/pages.yml` on this branch is **the csharp-repl branch's version (hexad/s-20261006-030552-6986) plus the SharpLab bits**: a "Build SharpLab" step (restore the ref pack through the test project, `PrepareRefs.cs`, `dotnet publish`; no workloads), `--exclude '/sharplab'` in the rsync, and `node sharplab/tools/stage.mjs sharplab/dist/wwwroot _site/sharplab`. The setup-dotnet/setup-node steps are theirs and shared. Merge note: the workflow also references `csharp/tools/stage.mjs` etc., which exist on their branch, not on this one; after merging both, the file needs no changes. `index.html` and the root `README.md` each got one SharpLab line (a trivial conflict with whatever they add there). Nothing was pushed to webbox main.

## Limits
* No IntelliSense (completion, hover, signature help); no NuGet references (`#r`); references are the .NET 10 ref pack, loaded on demand by `using`/errors.
* Everything runs on the UI thread (interpreter): a big program or an infinite loop in Run blocks the tab; no cancellation. The first compile after load takes ~2 s while the interpreter warms up.
* The decompile levels are our own grouping of ILSpy settings; level 2 hides records/lambdas/async/LINQ-query sugar but not statement sugar. ICSharpCode.Decompiler targets its own idea of C#; output for exotic constructs can differ from SharpLab's.
* ILVerify against the ref pack (not the implementation assemblies) can only check what the ref assemblies declare; `unsafe` code is reported as unverifiable, as ILVerify does.
* Not trimmed, no AOT, no threads: native relinking/AOT would shrink the payload and speed Roslyn up, but they need the wasm-tools workload's packs; carry on without them until the no-workload AOT setup (another session) lands.
* Run uses non-collectible `AssemblyLoadContext`s on wasm (collectible ones are not supported): each Run leaks its small assembly until reload.
* The syntax tree is capped at 60 000 elements; very large inputs are slow to render.
