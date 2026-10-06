// Local stand-in for Cloudflare Worker static assets: serves a staged site from / , applies its _headers file (same matching rules:
// '*' splat, matching rules' headers are joined, a later Content-Type replaces), and compresses on the fly (brotli/gzip) the content types
// Cloudflare's edge compresses (text/*, javascript, json, wasm, svg, ...; NOT application/octet-stream).
//   node tools/cf-sim.mjs <siteRoot> [port]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
export function parseHeaders(text) {
  const rules = []; let cur = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) { cur = { re: new RegExp('^' + line.trim().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'), set: [] }; rules.push(cur); }
    else { const i = line.indexOf(':'); cur.set.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]); }
  }
  return (p) => { const h = {}; for (const r of rules) if (r.re.test(p)) for (const [k, v] of r.set) { const key = k.toLowerCase(); h[key] = key === 'content-type' || !h[key] ? v : h[key] + ', ' + v; } return h; };
}
export const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
export const compressible = (ct) => /^(text\/|application\/(javascript|json|wasm|xml)|image\/svg)/.test(ct);
if (import.meta.url === 'file://' + process.argv[1]) {
  const root = path.resolve(process.argv[2] ?? '_cf_site'), port = Number(process.argv[3] ?? 8130);
  const hf = fs.existsSync(path.join(root, '_headers')) ? parseHeaders(fs.readFileSync(path.join(root, '_headers'), 'utf8')) : () => ({});
  const stats = { files: 0, byType: {} };
  http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = path.join(root, p);
    if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) { if (!p.endsWith('/')) { res.writeHead(307, { Location: p + '/' }); return res.end(); } file = path.join(file, 'index.html'); p += 'index.html'; }
    if (!fs.existsSync(file) || path.basename(file) === '_headers') { res.writeHead(404); return res.end('not found'); }
    const body = fs.readFileSync(file);
    const h = { 'content-type': types[path.extname(file)] || 'application/octet-stream', ...hf(p.endsWith('/index.html') ? p : p), 'cf-simulated': '1' };
    if (p.endsWith('/index.html')) Object.assign(h, hf(p.slice(0, -10)));
    h['content-type'] = hf(p)['content-type'] ?? h['content-type'];
    const ae = req.headers['accept-encoding'] || '';
    let out = body;
    if (compressible(h['content-type']) && body.length > 50) {
      if (ae.includes('br')) { out = zlib.brotliCompressSync(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } }); h['content-encoding'] = 'br'; }
      else if (ae.includes('gzip')) { out = zlib.gzipSync(body); h['content-encoding'] = 'gzip'; }
    }
    h['content-length'] = out.length; h.vary = 'Accept-Encoding';
    res.writeHead(200, h); res.end(out);
  }).listen(port, '0.0.0.0', () => console.log('cf-sim: ' + root + ' on http://localhost:' + port + '/'));
}
