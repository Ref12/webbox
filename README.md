# webbox

Public web tools that run entirely in the browser, mostly on .NET WebAssembly. The workflow in `.github/workflows/pages.yml` builds them
(no `dotnet workload` needed; see `build/NoWorkloadWasm.props`) and publishes them on every push to `main`, to
GitHub Pages at https://ref12.github.io/webbox/ and to the Cloudflare Worker at https://webbox.ref12cf.workers.dev/.
The site root is an installable app (PWA) that launches the tools.

| App | Folder | What it is |
| --- | --- | --- |
| SharpLab | `/sharplab/` (built: `sharplab/`, see its README) | A SharpLab-style C# playground running entirely in the browser on .NET WebAssembly: syntax tree linked to the editor, IL, decompiled C# at three lowering levels, Run, ILVerify, share links in the URL fragment, Debug/Release, language version and optimize options, and a JIT tab that explains what is (not) possible and can call a JIT endpoint. Built by the workflow (no workloads) like `csharp/`. |
| C# interactive | `/csharp/` (source: `csharp/`) | A C# REPL with Roslyn IntelliSense that compiles and runs in the browser on .NET 10 WebAssembly; `#r "nuget: Pkg, ver"`, `#help`, `#clear`, `#reset`, `#load "url"`. **Not published as is:** the workflow builds it (`dotnet publish` + `csharp/tools/stage.mjs`) and puts the result at `_site/csharp/`. See `csharp/README.md` for the design, the Pages delivery (brotli decoded in the page, content-hashed names) and the tests. |
| fuget | `/fuget/` (built: `fuget/`) | A fuget.org-style NuGet package browser in the browser: search, the API with XML docs, decompiled source (ICSharpCode.Decompiler) and the API diff between two versions, with deep links. Built by the workflow like `csharp/`. |
| PR viewer | `/prview/` | Azure DevOps-style viewer for GitHub pull requests: file tree with A/M/D/R badges and a filter, full-file diffs computed in the browser (inline or side by side, expandable context, word-level marks), review threads inline with posting (single comments, batched reviews, replies, resolve), PR lists (for me / a repo / recent), reviewed checkboxes, commit/range picker, keyboard navigation. Public repos anonymously; **Sign in with a pasted GitHub token** (fine-grained: Pull requests read/write, Contents read) for private repos, commenting and 5,000 requests/hour. Details in `prview/README.md`. |
| ILSpy | `/ilspy/` (built from [ljcollins25/ILSpy](https://github.com/ljcollins25/ILSpy/tree/browser) `browser`, pinned in the workflow) | Kirill Osenkov's ILSpy.Browser: the ILSpy decompiler (Avalonia) on .NET WebAssembly. Open or drop an assembly, browse types, read decompiled C#. Built workload-free by `ILSpy.Browser/build-static.sh`. |
| Roslyn Quoter | `/quoter/` (built from [ljcollins25/RoslynQuoter](https://github.com/ljcollins25/RoslynQuoter/tree/browser) `browser`, pinned in the workflow) | A browser-only RoslynQuoter: C# in, the Roslyn `SyntaxFactory` calls that build it out, with Quoter.Web's options, a round-trip check and share links. Roslyn trimmed to about 2.4 MiB. |
| MSBuild binlog viewer (preview) | `/binlog/` (built from [ljcollins25/MSBuildStructuredLog](https://github.com/ljcollins25/MSBuildStructuredLog/tree/wasm) `wasm`, pinned in the workflow) | Kirill Osenkov's MSBuild Structured Log Viewer (Avalonia) in the browser: open a .binlog by file, drag-and-drop or `?url=`; tree, search, node details, embedded source files and find in files. Logs over about 50 MB don't fit in browser memory yet (paged loading is planned). |

Line endings are left alone (`.gitattributes` has `* -text`).
