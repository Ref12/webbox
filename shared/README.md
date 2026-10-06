# shared/ — what csharp/ and sharplab/ build from together

Roslyn IntelliSense in the browser, written once. The C# REPL (`csharp/`) had it first; SharpLab (`sharplab/`) now uses the same code.

| Piece | What | Used by |
|---|---|---|
| `Intellisense/` (`WebBox.Intellisense`) | `IntelliService`: an `AdhocWorkspace` with Roslyn's MEF host (no persistent storage), completion (+ descriptions, commit characters, keyword snippets), quick info, signature help, diagnostics, classification. `IntelliOptions`: document kind (**script** chain of submissions = REPL, **regular** one file = SharpLab), language version, Release/Debug (preprocessor symbols), optimize, exe/dll, unsafe, usings. `Bridge`: string-in/string-out entry points. Loaded **lazily** (it pulls in Roslyn Features/Workspaces, 14.5 MB raw / 4.2 MB brotli). | both, in the `intelli` worker |
| `IntelliHost/` (`WebBox.IntelliHost`) | the thin part a Wasm app references: hands the lazily fetched assemblies to the runtime (`AssemblyLoadContext.Resolving`), starts the workspace, calls `Bridge` by reflection. No Roslyn dependency, so the boot payload does not grow. | both Wasm apps |
| `js/protocol.js` | the worker message protocol (`RuntimeClient`, `serve`, `batcher`) | both |
| `js/assets.js` | retrying fetch, Cache API, in-worker brotli (Pages), the `fetchAsset`/`takeAsset` host module; `prefix` names the app's caches, BUILD/BROTLI come from the app's own `config.js` | both |
| `js/intelli-loader.js` | fetch the lazy assemblies (4 in parallel, Cache API first), start IntelliSense, time a first completion | both |
| `js/roslyn-monaco.js` | Monaco providers over `call(op, text, pos, extra)`: completion (kinds, `resolveCompletionItem` = the description, snippets), signature help, hover, semantic tokens, diagnostics -> markers (debounced) | both (the REPL adds `#r` completion and commands through hooks) |
| `js/classify.js` | Roslyn classification -> token types, VS Dark colours, Monaco semantic tokens | both |
| `tools/PrepareLazy.cs` | publishes `Intellisense/` and writes an app's `wwwroot/lazy` (+ manifest, .br/.gz) | both (each app's `tools/PrepareLazy.cs` calls it) |

How the JS gets into an app: each Wasm csproj has `<Content Include="../../../shared/js/*.js" Link="wwwroot/%(Filename)%(Extension)" />`, so the files are published and staged (fingerprinted by `tools/stage.mjs`) next to the app's own scripts. No copy is committed.

## Tests
* `dotnet test shared/tests/WebBox.Intellisense.Tests` — regular documents, options (C# version, Debug/Release `#if DEBUG`, exe/dll, default usings), describe, hover/signature/classification, project reuse while typing, script mode after `Configure`.
* `node --test shared/tests/js/*.mjs` — protocol, classification, and the Monaco providers against a fake Monaco.
* The REPL's own tests (`csharp/tests`) still cover script-mode behaviour of the same `IntelliService`.
* End to end: `sharplab/tools/e2e/intellisense.mjs` (SharpLab on both host simulations) and `csharp/tools/e2e/run.mjs` (REPL).

## Not shared (and why)
* `SharpLab.Core` keeps its own copy of "console app or library?" (`Compiler.LooksLikeProgram`, 8 lines; `IntelliOptions.ResolveOutput` has the same rule): `SharpLab.Core` cannot reference the Roslyn-Features project without putting 14 MB into the boot payload.
* The reference-assembly bookkeeping (`RefCatalog`, `ReferenceStore`, ...) was already copied between the two apps before this work; moving it here is the next step, not needed for IntelliSense.
