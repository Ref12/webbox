// Reference implementation of the JIT endpoint (see ENDPOINT.md). No dependencies; needs the .NET 10 SDK or runtime on the machine.
//   dotnet build -c Release JitRunner     (once)
//   node server.mjs [port=8787]
// POST /jit  { assembly: <base64 dll>, method?: "*" | "Main" | "Type:Method", optimize?: true, arch?: "x64" }  ->  text/plain DOTNET_JitDisasm listing
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const runner = process.env.JIT_RUNNER || path.join(here, 'JitRunner', 'bin', 'Release', 'net10.0', 'JitRunner.dll');
const port = Number(process.argv[2] ?? process.env.PORT ?? 8787);
const origin = process.env.ALLOW_ORIGIN ?? '*';          // set to https://ref12labs.github.io to lock it to the app
const MAX_BODY = 2 * 1024 * 1024, TIMEOUT_MS = 15000, MAX_CONCURRENT = 2, MAX_OUTPUT = 4 * 1024 * 1024;
let running = 0;

export function jitEnv({ method = '*', optimize = true }) {
  if (!/^[A-Za-z0-9_.*:<>`+\- ]{1,200}$/.test(method)) throw new Error('bad method filter');
  const env = { ...process.env, DOTNET_JitDisasm: method, DOTNET_TieredCompilation: '0', DOTNET_TieredPGO: '0', DOTNET_ReadyToRun: '0', DOTNET_TC_QuickJitForLoops: '0', DOTNET_gcServer: '0' };
  if (!optimize) env.DOTNET_JITMinOpts = '1';
  return env;
}

/** Keeps only the listings whose method belongs to one of the given types ("; Assembly listing for method Ns.Type:Method(sig) (FullOpts)"). */
export function filterListings(text, typeNames) {
  const parts = text.split(/(?=^; Assembly listing for method )/m);
  const own = (p) => {
    const m = /^; Assembly listing for method ([^\s]+)/.exec(p);
    if (!m) return false;
    const name = m[1];
    return typeNames.some((t) => name.startsWith(t + ':') || name.startsWith(t + '['));
  };
  return parts.filter(own).join('').trimEnd() + '\n';
}

export function runJit(bytes, opts) {
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jit-'));
    const file = path.join(dir, 'SharpLabApp.dll');
    fs.writeFileSync(file, bytes);
    const typesFile = path.join(dir, 'types.txt');
    const child = spawn('dotnet', [runner, file, typesFile], { env: jitEnv(opts), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const kill = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
    child.stdout.on('data', (d) => { if (out.length < MAX_OUTPUT) out += d; });
    child.stderr.on('data', (d) => { if (err.length < 65536) err += d; });
    child.on('close', (code, sig) => {
      clearTimeout(kill);
      if (sig) { fs.rmSync(dir, { recursive: true, force: true }); return reject(new Error('timed out after ' + TIMEOUT_MS + ' ms')); }
      const types = fs.existsSync(typesFile) ? fs.readFileSync(typesFile, 'utf8').split(/\r?\n/).filter(Boolean) : [];
      fs.rmSync(dir, { recursive: true, force: true });
      resolve({ code, text: types.length ? filterListings(out, types) : out, err });
    });
    child.on('error', (e) => { clearTimeout(kill); fs.rmSync(dir, { recursive: true, force: true }); reject(e); });
  });
}

const cors = { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' };
const send = (res, status, body, type = 'text/plain; charset=utf-8') => { res.writeHead(status, { 'Content-Type': type, ...cors }); res.end(body); };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') return send(res, 204, '');
    if (req.method === 'GET' && req.url === '/health') return send(res, 200, JSON.stringify({ ok: true, runner: fs.existsSync(runner), arch: process.arch }), 'application/json');
    if (req.method !== 'POST' || req.url !== '/jit') return send(res, 404, 'POST /jit');
    const chunks = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > MAX_BODY) return send(res, 413, 'assembly too large'); chunks.push(c); }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(res, 400, 'body must be JSON'); }
    if (typeof body.assembly !== 'string' || !body.assembly) return send(res, 400, 'assembly (base64) is required');
    if (body.arch && body.arch !== process.arch && !(body.arch === 'x64' && process.arch === 'x64')) return send(res, 400, 'this endpoint serves ' + process.arch + ' only');
    const bytes = Buffer.from(body.assembly, 'base64');
    if (bytes.length < 64 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) return send(res, 400, 'not a PE file');
    if (running >= MAX_CONCURRENT) return send(res, 429, 'busy, try again');
    running++;
    try {
      const t = Date.now();
      const r = await runJit(bytes, { method: body.method || '*', optimize: body.optimize !== false });
      res.setHeader?.('X-Jit-Ms', String(Date.now() - t));
      send(res, r.code === 0 ? 200 : 500, r.text || (r.code === 0 ? '; no methods matched ' + (body.method || '*') : r.err));
    } catch (e) { send(res, 500, String(e.message || e)); } finally { running--; }
  }).listen(port, () => console.log('jit endpoint on http://localhost:' + port + '/jit (runner ' + runner + ')'));
}
