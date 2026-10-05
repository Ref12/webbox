# csharp-wasm

C# interactive (csi/RoslynPad-style REPL) running **entirely in the browser** on .NET 10 WebAssembly. Roslyn compiles each
submission in the page, the result is loaded with `Assembly.Load` and run in the same wasm runtime. No server logic.

![screenshot](docs/screenshot.png)

## Build, run, publish
```
dotnet test tests/CsRepl.Tests                       # unit tests (Windows + Linux; needs network once for the ref-pack NuGet)
dotnet run tools/PrepareRefs.cs                      # copies Microsoft.NETCore.App.Ref (net10.0) into src/CsRepl.Wasm/wwwroot/ref
dotnet publish src/CsRepl.Wasm -c Release -o dist    # static site in dist/wwwroot (brotli/gzip precompressed)
node tools/serve.mjs dist/wwwroot 8080               # any static server works; this one serves .br/.gz
cd tools/e2e && npm install && node run.mjs ../../dist/wwwroot ../../docs/screenshot.png ../../docs/metrics.json   # headless Chromium e2e
```
Needs the .NET 10 SDK (no `wasm-tools` workload: interpreter only, no native relink). `ref/` is generated, not committed.
The e2e uses `playwright-core` with a system Chromium (`CHROME_PATH` or /usr/bin/chromium).

## Design
* **Runtime: `Microsoft.NET.Sdk.WebAssembly` app + `[JSExport]`**, not Blazor. We need no component model, router or
  Blazor boot payload; a plain `index.html` + `main.js` calling 5 exported methods is smaller and simpler. Interpreter (no AOT), single thread.
* **`src/CsRepl.Core`** (plain net10.0, unit-testable): `ReplSession`, `ResultFormatter`, `ReferenceStore`.
* **`ReplSession`** drives `CSharpCompilation.CreateScriptCompilation(..., previousScriptCompilation)` itself: emit to a
  `MemoryStream`, `Assembly.Load(bytes)`, find the generated `<Factory>`, invoke it with the submission array, await the `Task<object>`.
  State (variables, methods, types, usings) carries over through the compilation chain + submission array. Console is redirected per submission.
  Exceptions: type + message (+ inner chain); a failed submission does not advance the session.
  *Why not `CSharpScript`:* `Script.GetReferencesForCompilation` always adds `typeof(object).Assembly`, which in the browser has no file
  location ("Can't create a metadata reference to an assembly without location"). Passing `returnType: typeof(object)` also fails (CS0400: it binds by
  System.Private.CoreLib identity, we compile against System.Runtime from the ref pack) - leave `returnType` null (value is still returned).
  A using-only submission emits nothing (Emit fails with no diagnostics); it is kept in the chain without running.
* **Reference assemblies:** loaded assemblies are Webcil, unreadable as metadata. `tools/PrepareRefs.cs` copies the 167 ref-pack DLLs to
  `ref/` + `manifest.txt`; `main.js` fetches them, stores them in the Cache API (`csrepl-refs-v1`, invalidated when the pack version line in the manifest changes) and passes bytes to
  `Interop.AddReference`. `ReferenceStore` validates each image (PE + assembly metadata) before accepting it.
* **UI:** Monaco 0.52.2 from jsDelivr (falls back to a textarea if the CDN fails) + transcript. Enter runs if `SyntaxFactory.IsCompleteSubmission`, else inserts a newline; Shift+Enter newline; Ctrl+Enter forces; Up/Down history.

## Measurements (GitHub Actions runner, 4 vCPU, headless Chromium, localhost, no throttling)
| | |
|---|---|
| Published site, uncompressed | 39.7 MB (framework 33.8 MB incl. Microsoft.CodeAnalysis.CSharp 6.8 MB, Microsoft.CodeAnalysis 3.0 MB, CoreLib 4.9 MB, dotnet.native 3.0 MB; ref assemblies 6.0 MB) |
| Brotli / gzip (precompressed files) | 12.2 MB / 15.4 MB (ref assemblies 2.4 MB of the brotli total) |
| Cold load to ready (runtime + refs + first compile) | ~3.1 s (runtime created 1.4 s, 167 refs fetched 0.37 s + parsed 0.14 s, first result 1.0 s) |
| Warm (Cache API populated, browser HTTP cache not disabled by server but `no-cache` set) | ~1.9 s (refs 0.06 s fetch from cache; first result 0.93 s) |
| First submission (`1`, includes JIT-cold Roslyn) | ~1.0 s |
| Trivial submission (`1 + 1`) | 28 ms |
| 50-line submission (50 `var` + Linq lambdas) | ~920 ms; same again ~1030 ms |
Numbers are from `docs/metrics.json` (one run; localhost so network time is understated). The "wireBytes" field there also counts Monaco from the CDN.
Not measured: real-network cold load, other browsers, memory.

## What was reused / learned from RoslynPad
Read: github.com/roslynpad/roslynpad (current main, via its CLAUDE.md and layout). Its current design is **desktop-only**: Avalonia + vendored
EditorFeatures + VS-MEF composition (`RoslynHost`), scripts built through `dotnet build` with an MSBuild task and executed in **a separate process** over JSON IPC
(`ExecutionHost`); it has no in-process script compiler anymore. None of that runs in the browser (MSBuild, processes, MEF, file system). What carries over as ideas:
the trailing-expression-is-a-value convention (they rewrite to `.Dump()`; we use the script return value), the `Dump`-style runtime helpers (not ported), and
Roslyn Features as the future source for completion/signature help (not done). **No RoslynPad code is copied.**
Prior art (Try .NET, SharpLab, BlazorRepl, DotNetLab) was *not* read in this session; from general knowledge only: BlazorRepl and DotNetLab also compile in-browser
by shipping reference assemblies as static files, and SharpLab uses a server. Treat that as unverified.

## Limits and next steps
* Completion/signature help: not implemented (would need Microsoft.CodeAnalysis.Features/Workspaces in wasm; larger download).
* A submission that throws is discarded entirely (csi keeps variables assigned before the throw).
* No `#r`, NuGet, `#load`; no cancellation of an infinite loop (single thread; would need a worker or wasm threads).
* Compile + run block the UI thread (50 lines ~1 s); move the runtime to a Web Worker.
* The 12 MB brotli payload is mostly Roslyn; trimming (`PublishTrimmed`), dropping unused ref assemblies and AOT are untried.
* Only Linux/Chromium was run here; the unit tests are written with Path APIs only but were not run on Windows in this session.
* Monaco comes from a CDN; vendor it for offline use. A harmless 404 (favicon) shows in the console.
