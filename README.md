# csharp-wasm

C# interactive (csi/RoslynPad-style REPL) running **entirely in the browser** on .NET 10 WebAssembly. Roslyn compiles each
submission in the page, the result is loaded with `Assembly.Load` and run in the same wasm runtime. No server logic.

![screenshot](docs/screenshot.png)

## Build, run, publish
```
dotnet test tests/CsRepl.Tests                       # 44 unit tests (completion, classification, resolver, NuGet...; needs network once for the ref-pack NuGet)
node --test tests/js/*.test.mjs                      # history navigation (stash/restore) and classification->token conversion
dotnet run tools/PrepareRefs.cs                      # ref pack -> wwwroot/ref: core.bin (9 assemblies), a/<name>.dll (167, on demand), manifest.json, types.json
dotnet run tools/PrepareLazy.cs                      # Microsoft.CodeAnalysis.Features & deps -> wwwroot/lazy (17 plain assemblies + manifest.json)
dotnet publish src/CsRepl.Wasm -c Release -o dist    # static site in dist/wwwroot (brotli/gzip precompressed)
node tools/serve.mjs dist/wwwroot 8080               # any static server works; this one serves .br/.gz
cd tools/e2e && npm install && node run.mjs ../../dist/wwwroot ../../docs ../../docs/metrics.json   # headless Chromium e2e + screenshots (needs internet: Monaco CDN, nuget.org)
```
Needs the .NET 10 SDK (no `wasm-tools` workload: interpreter only). `ref/` and `lazy/` are generated, not committed.

![screenshot](docs/screenshot.png) ![phone](docs/screenshot-phone.png)

## What the editor does (all computed by Roslyn in the browser)
* **IntelliSense** (`src/CsRepl.Intellisense`, `IntelliService`): an `AdhocWorkspace` (MEF host from Workspaces/Features/CSharp.Features) holds the session as a chain of *submission projects*, each referencing the previous one;
  the text being typed is a scratch submission at the end of the chain. Completion = `CompletionService` (Roslyn filtering data, `InsertionText`; Monaco filters/ranks, commit characters `. ( [ ; ,`),
  plus keyword/statement snippets (`for`, `foreach`, `while`, `if`, `try`, `switch`, `class`, `using`, `cw`; Roslyn's snippet service is VS-only, so these are ours). Hover = `QuickInfoService`.
  Squiggles = compilation diagnostics. **Signature help is not `SignatureHelpService`** (internal to Features): it is built from the semantic model (overload set, active parameter, best-fitting overload preselected).
* **Classification**: `Classifier.GetClassifiedSpansAsync` -> Monaco semantic tokens in the input, and the same spans rendered as HTML in the history (`classify.js`), with Visual Studio dark colours (types teal, methods/locals light, keywords blue, control keywords purple, strings orange, numbers green).
  Before IntelliSense is ready, history shows Monaco's grammar colours; when ready, every past submission is re-classified *in its own context* (`ClassifyCommitted`).
* **History**: Ctrl+Up/Down (`history.js`, unit-tested). The first Ctrl+Up stashes the typed text; Ctrl+Down past the newest entry restores it exactly. Plain Up/Down move the cursor.
* **Look**: no prompt; code blocks (lighter, rounded, copy icon top-right) vs output (dark), return value (blue tint) and error (red tint) blocks; the input box grows with its content; phone layout (screenshot-phone.png).
* **Assemblies on demand**: start with a 9-assembly core (System.Runtime, Console, Linq, Collections, Threading, Threading.Tasks, Memory, Runtime.Extensions, Runtime.InteropServices; 1.2 MB, 270 KB brotli). Others (`ref/a/<name>.dll`, each its own Cache API entry, 167 available) are fetched for
  a `using` namespace, `#r "System.Net.Http"`, a type/namespace name the compiler cannot find (`types.json` index, fetched on first miss), or a CS0012 "assembly not referenced"; the compile is then retried. Loads are listed under the submission (file, size, cache/network).
* **NuGet**: `#r "nuget: Id, Version"` (version optional = latest stable). `NuGetResolver` downloads the .nupkg from `api.nuget.org/v3-flatcontainer` (CORS is open), picks the best `lib/<tfm>` (net10.0 ... netstandard1.0, `runtimes/browser/lib` first), reads the nuspec dependency group for that framework, follows it (skipping packages the framework provides), caches nupkgs in the Cache API, adds the DLLs as references and loads them into the runtime. E2E loads Humanizer.Core and Newtonsoft.Json (latest) for real.
* **Lazy app assemblies**: Microsoft.CodeAnalysis.Features, .CSharp.Features, Workspaces, Elfie, Humanizer, System.Composition.* etc. (14.5 MB raw, 4.2 MB brotli) are *not* in the .NET boot payload. After the first paint `main.js` fetches them (Cache API, 4 in parallel) and hands the bytes to `Interop.AddLazyAssembly`; an `AssemblyLoadContext.Default.Resolving` handler loads them by name, then `StartIntellisense` loads `CsRepl.Intellisense.dll`.
  The Wasm project does not reference it (calls go by reflection through `Bridge`, JSON strings). .NET's built-in lazy loading (`BlazorWebAssemblyLazyLoad`) is Blazor-SDK only, so this hand-rolled variant is used.

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
* **Reference assemblies:** loaded assemblies are Webcil, unreadable as metadata. `tools/PrepareRefs.cs` packs the 167 ref-pack DLLs into **one file**,
  `ref/refs.bin` (header: names + lengths, then the bytes; see `ReferenceBundle`), with precompressed `.br`/`.gz`, plus a tiny `manifest.txt` (ref-pack version + size for the progress bar).
  `main.js` fetches it in one request with a percentage, stores it as **one Cache API entry** keyed by the ref-pack version (`csrepl-refs-v2`; older entries are dropped) and passes it to
  `Interop.AddReferenceBundle`. `ReferenceStore` validates each image (PE + assembly metadata). Earlier versions fetched 167 files in parallel, which failed on a slow phone link (HTTP 408/504).
* **Resilience:** `window.fetch` is wrapped so every same-origin startup GET (runtime files too) retries 3 times with backoff on network errors, 408, 429 and 5xx; the status line shows
  "retrying <file> (n/3)" and, if it still fails, the page shows "Could not download <file> ... after 3 tries". The e2e injects 504s on refs.bin and a runtime file to check this.
* **UI:** Monaco 0.52.2 from jsDelivr (falls back to a textarea if the CDN fails) + transcript. Enter runs if `SyntaxFactory.IsCompleteSubmission`, else inserts a newline; Shift+Enter newline; Ctrl+Enter forces; Up/Down history.

## Measurements (GitHub Actions runner, 4 vCPU, headless Chromium, localhost, no throttling; `docs/metrics.json`, `tools/e2e/before.mjs`)
| | before (dd2c3dd) | now |
|---|---|---|
| First load, bytes on the wire to first result (brotli, same origin, no Monaco CDN) | 10.92 MB | **10.09 MB** (framework 9.81 + core refs 0.27) |
| Time to first result (cold) | ~2.73 s | **~2.4 s** (3 runs each: 2.71-2.75 / 2.38-2.44) |
| Time to first result (warm, caches populated) | ~1.7 s | ~2.0 s in the e2e run (reload within the same browser context) |
| IntelliSense: extra download (lazy, after first paint) | n/a | 4.23 MB br (14.5 MB raw), 0.3 s on localhost, 0 on warm start (17/17 from Cache API) |
| IntelliSense ready (cold / warm) | n/a | **~5.0 s / ~3.9 s** after navigation (of which assembly start-up + MEF composition ~1.0 s / 0.8 s) |
| First completion (JIT-cold Roslyn Features) | n/a | ~0.9 s |
| Completion latency, warm (`Console.Wri`, `answer.`, `new List<int>().Ad`, `Enumerable.Ra`) | n/a | 106-354 ms (one run: 136, 218, 350, 141) |
| Diagnostics after typing (cold-ish) | n/a | ~0.8 s first, then similar to completion |
The REPL is usable (first result) ~2.5 s before IntelliSense is ready; typing is not blocked, it just has no IntelliSense yet (status badge in the header). Localhost understates real network time. Numbers vary +-10 % run to run. Interpreter (no AOT): everything Roslyn does runs on the UI thread, so a completion request briefly blocks input.

## What was reused / learned from RoslynPad
Read: github.com/roslynpad/roslynpad (current main, via its CLAUDE.md and layout). Its current design is **desktop-only**: Avalonia + vendored
EditorFeatures + VS-MEF composition (`RoslynHost`), scripts built through `dotnet build` with an MSBuild task and executed in **a separate process** over JSON IPC
(`ExecutionHost`); it has no in-process script compiler anymore. None of that runs in the browser (MSBuild, processes, MEF, file system). What carries over as ideas:
the trailing-expression-is-a-value convention (they rewrite to `.Dump()`; we use the script return value), the `Dump`-style runtime helpers (not ported), and
Roslyn Features as the future source for completion/signature help (not done). **No RoslynPad code is copied.**
Prior art (Try .NET, SharpLab, BlazorRepl, DotNetLab) was *not* read in this session; from general knowledge only: BlazorRepl and DotNetLab also compile in-browser
by shipping reference assemblies as static files, and SharpLab uses a server. Treat that as unverified.

## Limits and next steps
* **RoslynPad: no code was copied.** The approach (an `AdhocWorkspace` over Roslyn Features/Workspaces, submission projects chained for the REPL) is the one RoslynPad.Roslyn and Roslyn's own interactive window use, written fresh here; I did not read or vendor RoslynPad's source this session. (RoslynPad is MIT; vendoring is possible later, e.g. its internal-API wrappers for signature help.)
* Signature help is our own semantic-model implementation (no documentation for parameters, no generic-method type argument help). Completion does not show item descriptions (no `GetDescriptionAsync` yet) and not extension methods/types from namespaces that are not imported.
* After completion the item is inserted as text (`Change` exists in the service but is not used by the editor), so items that need extra edits are plain.
* A browser console error "Process_PlatformNotSupported" from `DefaultPersistentStorageConfiguration` (Roslyn Workspaces) appears during some completion requests; requests still succeed, the failing part is a background cache.
* Unresolved names only load assemblies when the code is submitted (and `using`/`#r` lines while typing); typing a type from an unloaded assembly without `using` shows an error squiggle until you add the `using`.
* NuGet: simple managed packages only; no native assets, no analyzers/source generators, no `#r "nuget"` version ranges beyond the lower bound, framework-reference packages (e.g. ASP.NET) cannot work. A package needing a runtime assembly the wasm app trimmed or lacks fails at run time with the .NET error.
* A submission that throws is discarded entirely (csi keeps variables assigned before the throw). No `#load`; no cancellation of an infinite loop (single thread; would need a worker).
* Compile + run + IntelliSense block the UI thread; moving the runtime to a Web Worker would fix both. The 10 MB framework payload is mostly Roslyn; trimming and AOT are untried.
* Only Linux/Chromium was run here. Monaco comes from a CDN (the page falls back to a plain textarea without IntelliSense).
