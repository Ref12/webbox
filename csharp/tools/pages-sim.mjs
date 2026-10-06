// Static server that behaves like GitHub Pages for this app: served under a path prefix, Cache-Control: max-age=600, no Content-Encoding
// for precompressed files (a .br is just application/octet-stream), gzip on the fly for text types only (html/css/js/json/svg/txt).
//   node tools/pages-sim.mjs <siteRoot> [port] [prefix=/webbox] [--gzip=text|all|none]
//   --gzip=all  also gzips .wasm/.dll/.bin on the fly (what Pages does if it treats them as compressible); none = no compression at all.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const opt = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')));
const root = path.resolve(args[0] ?? '_site');
const port = Number(args[1] ?? 8080);
const prefix = (args[2] ?? '/webbox').replace(/\/$/, '');
const mode = opt.gzip ?? 'text';
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };
const textual = /\.(html|css|js|mjs|json|txt|svg)$/;
const binaryCompressible = /\.(wasm|dll|bin)$/;
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let p = decodeURIComponent(url.pathname);
  if (!p.startsWith(prefix + '/')) {
    if (p === prefix) { res.writeHead(301, { Location: prefix + '/' }); return res.end(); }
    res.writeHead(404); return res.end('not found (outside ' + prefix + ')');
  }
  p = p.slice(prefix.length);
  const dirIdx = p.endsWith('/') ? p + 'index.html' : p;
  let file = path.join(root, dirIdx);
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) { res.writeHead(301, { Location: prefix + p + '/' }); return res.end(); }
  if (!file.startsWith(root) || !fs.existsSync(file)) { res.writeHead(404, { 'Content-Type': 'text/html' }); return res.end('<h1>404</h1>'); }
  const body = fs.readFileSync(file);
  const headers = { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'max-age=600', 'Access-Control-Allow-Origin': '*' };
  const ae = req.headers['accept-encoding'] || '';
  const gz = ae.includes('gzip') && mode !== 'none' && (textual.test(file) || (mode === 'all' && binaryCompressible.test(file)));
  const out = gz ? zlib.gzipSync(body, { level: 6 }) : body;
  if (gz) headers['Content-Encoding'] = 'gzip';
  headers['Content-Length'] = out.length;
  res.writeHead(200, headers); res.end(out);
}).listen(port, '0.0.0.0', () => console.log('pages-sim: ' + root + ' on http://localhost:' + port + prefix + '/ (gzip=' + mode + ')'));
