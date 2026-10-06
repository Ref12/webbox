# (b) JIT asm from a real machine on demand: endpoint design

Status: **designed, with a working reference implementation, not deployed.** `endpoint/server.mjs` + `endpoint/JitRunner` run on any machine with the
.NET 10 runtime and Node 22 (measured: **~0.14 s** per request on a GitHub Actions runner, native x64). The page's JIT tab already speaks this contract
(`jit.js`); you paste the endpoint URL and press *Get JIT asm*. Nothing is sent anywhere otherwise.

## Contract
```
POST /jit            Content-Type: application/json
  { "assembly": "<base64 of the compiled .dll>",    // required, <= 2 MB, must be a PE file
    "method":   "*",                                 // DOTNET_JitDisasm filter: "*", "Main", "Type:Method", "Ns.Type:*" ...  (default "*")
    "optimize": true,                                // true: DOTNET_TieredCompilation=0 (full opts); false: DOTNET_JITMinOpts=1
    "arch":     "x64" }                              // must match the machine ("x64" or "arm64"); an arm64 machine gives the ARM listing
200 text/plain       the JIT's listing, one "; Assembly listing for method A:Sum(int[]):int (FullOpts)" block per method of YOUR assembly
400 bad request | 413 too large | 429 busy | 500 JIT/runner failure (body = message) | timeouts after 15 s
GET /health          { ok, runner, arch }
```
CORS: `Access-Control-Allow-Origin` is `*` by default; set `ALLOW_ORIGIN=https://ref12labs.github.io` to pin it to the Pages site. No cookies, no state.

## How it works
1. The server writes the bytes to a temp dir and starts `dotnet JitRunner.dll <dll> <types.txt>` with `DOTNET_JitDisasm`, `DOTNET_TieredCompilation=0`,
   `DOTNET_TieredPGO=0`, `DOTNET_ReadyToRun=0` (so framework callees are not skipped) in the environment.
2. JitRunner loads the assembly into an AssemblyLoadContext and calls `RuntimeHelpers.PrepareMethod` on every non-abstract, non-open-generic method and constructor.
   That makes the JIT compile each method **without executing any user code** (no `Main`, no static constructors, no module initializers), so the output cannot depend
   on what the program does and the program cannot print or loop. Open generics have no code until instantiated: they are skipped (a limitation, same as SharpLab's).
3. The JIT writes the listing to the process's stdout. It also lists the runtime's own methods it compiled during startup and reflection; the server keeps only
   the blocks whose method belongs to a type of the user's assembly (`filterListings`, unit-tested).
4. The response is the filtered text. The page shows it as is.

## Running it in a hexad sandbox (what the user asked for)
A sandbox needs only: `dotnet` 10 and `node`. From a clone of this repo:
```
cd sharplab/jit/endpoint && dotnet build -c Release JitRunner && node server.mjs 8787      # start_process in hexad; the port is then reachable from the shared browser as http://sharplab-wasm.localhost:8787/jit
```
For the Pages site (https) the browser also needs the endpoint on https and CORS: put it behind the tunnel/proxy hexad provides, or any HTTPS reverse proxy
(`ALLOW_ORIGIN` set). A page on https cannot call plain `http://` endpoints except `localhost` (mixed content), so a local or tunnelled one is needed.

## Safety notes
- The endpoint never runs user code (see 2) but it does load untrusted assemblies and run the JIT on them: run it unprivileged, in a container/sandbox with no secrets,
  with a read-only file system apart from the temp dir. Limits in the reference: 2 MB body, 15 s timeout (SIGKILL), 2 concurrent requests, 4 MB of output, method filter
  restricted to `[A-Za-z0-9_.*:<>\`+- ]`, no shell involved (argv array).
- Rate-limit and authenticate (a bearer token header is the obvious extension) before exposing it publicly. Not built: it is a reference.

## Fidelity
The listing is for the *machine's* CPU: instruction-set extensions (AVX2/AVX-512, ARM64 features) follow the hardware, and Tier-0/OSR/PGO are not reproduced
(full opts or MinOpts only). `DOTNET_JitDisasm` also needs a runtime of the same major version as the target the code was compiled against for the same codegen (the endpoint's .NET 10).
