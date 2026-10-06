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
<h3>What can give real JIT output</h3>
<table>
<tr><th>Option</th><th>What it needs</th><th>Verdict</th></tr>
<tr><td><b>Real machine on demand</b></td><td>a tiny endpoint that runs the compiled assembly with <code>DOTNET_JitDisasm</code> (<code>jit/ENDPOINT.md</code>)</td><td>works today, exact output; needs a server</td></tr>
<tr><td><b>x86 emulation in the browser</b></td><td>a Linux x64 .NET runtime inside an emulator (container2wasm, CheerpX, v86)</td><td>see <code>jit/REPORT.md</code> for the measurements</td></tr>
<tr><td>Mono AOT / wasm codegen</td><td>that is WebAssembly, not x64: a different (and much less useful) listing</td><td>not offered</td></tr>
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
      const resp = await fetch(url.value.trim(), { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assembly: ctx.getAssemblyBase64(), isExe: c.isExe, method: host.querySelector('#jit-method').value || '*', optimize: ctx.settings().optimize, arch: 'x64' }) });
      const text = await resp.text();
      out.textContent = resp.ok ? text : 'endpoint said HTTP ' + resp.status + ': ' + text;
    } catch (e) { out.textContent = 'could not reach the endpoint: ' + e.message; }
  };
}
