// JIT asm tab. In the browser .NET runs on the Mono interpreter, so there is no x64/ARM JIT output to show. This tab explains the options
// (details and numbers: jit/REPORT.md) and can fetch real output from a JIT endpoint if you run one (design: jit/ENDPOINT.md).
const KEY = 'sharplab.jit.endpoint';

export function renderJit(host, ctx) {
  if (host.dataset.ready) return;
  host.dataset.ready = '1';
  host.innerHTML = `
<h3>JIT assembly is not available in the page itself</h3>
<p>SharpLab on the server shows the machine code the CLR's JIT produced. Here the whole .NET runtime is WebAssembly running the <b>Mono interpreter</b>
(no AOT, no JIT): methods are executed from IL, so no x64 or ARM64 code exists to display. The IL, lowered C#, Run and Verify tabs are real; this one cannot be, locally.</p>
<h3>What can give real JIT output (measured: jit/REPORT.md)</h3>
<table>
<tr><th>Option</th><th>Real x64 output?</th><th>Cost</th><th>Verdict</th></tr>
<tr><td><b>Real machine on demand</b> (below)</td><td>yes, exact (the machine's CPU)</td><td>~0.14 s per request on a native runner; no download</td><td><b>recommended</b>; needs a server you run (<code>jit/ENDPOINT.md</code>)</td></tr>
<tr><td>x86 emulation: container2wasm + QEMU, real linux/amd64 .NET 10</td><td>yes (emulated "generic x64", no AVX)</td><td>69&ndash;88 MB download (brotli), ~10 s to boot, <b>~50 s per compile</b></td><td>works, not interactive; offline fallback at best</td></tr>
<tr><td>v86</td><td>no: 32-bit x86 only, and .NET has no linux-x86 runtime</td><td>&ndash;</td><td>not viable</td></tr>
<tr><td>CheerpX (commercial; free tier personal/FOSS only, no self-hosting)</td><td>no: 32-bit x86 only today</td><td>&ndash;</td><td>not viable</td></tr>
<tr><td>Mono AOT / wasm codegen</td><td>no: that is WebAssembly, not x64</td><td>&ndash;</td><td>not offered</td></tr>
</table>
<h3>Use a JIT endpoint</h3>
<p class="dim">Optional. The page is static; nothing is sent anywhere unless you press the button. The endpoint receives the compiled assembly (base64) and returns the <code>DOTNET_JitDisasm</code> text.</p>
<p><input type="text" id="jit-url" placeholder="https://your-endpoint.example/jit" aria-label="JIT endpoint URL"> <input type="text" id="jit-method" value="*" size="10" aria-label="method filter" title="DOTNET_JitDisasm method filter, e.g. Main or *"> <button id="jit-go">Get JIT asm</button></p>
<pre id="jit-out" hidden></pre>`;
  const url = host.querySelector('#jit-url'), out = host.querySelector('#jit-out');
  url.value = localStorage.getItem(KEY) || '';
  host.querySelector('#jit-go').onclick = async () => {
    const c = ctx.compiled();
    out.hidden = false;
    if (!c?.success) { out.textContent = 'Fix the compile errors first.'; return; }
    if (!url.value.trim()) { out.textContent = 'Enter the URL of a JIT endpoint (see jit/ENDPOINT.md).'; return; }
    localStorage.setItem(KEY, url.value.trim());
    out.textContent = 'asking the endpoint…';
    try {
      const assembly = await ctx.getAssemblyBase64();
      const resp = await fetch(url.value.trim(), { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assembly, isExe: c.isExe, method: host.querySelector('#jit-method').value || '*', optimize: ctx.settings().optimize, arch: 'x64' }) });
      const text = await resp.text();
      out.textContent = resp.ok ? text : 'endpoint said HTTP ' + resp.status + ': ' + text;
    } catch (e) { out.textContent = 'could not reach the endpoint: ' + e.message; }
  };
}
