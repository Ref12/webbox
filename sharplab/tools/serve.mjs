// Minimal static file server for the published site (no app logic). Serves precompressed .br/.gz when present.
// Usage: node tools/serve.mjs <dir> [port] [urlPrefix]   (urlPrefix e.g. /webbox/sharplab mimics the GitHub Pages path)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(process.argv[2] ?? 'dist');
const port = Number(process.argv[3] ?? 8080);
const prefix = (process.argv[4] ?? '').replace(/\/$/, '');
// SERVE_ENCODINGS=gzip mimics GitHub Pages (gzip only, no brotli): the page's download size is then the .gz size
const allowed = (process.env.SERVE_ENCODINGS ?? 'br,gzip').split(',');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.wasm': 'application/wasm', '.dll': 'application/octet-stream', '.txt': 'text/plain', '.png': 'image/png' };
http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (prefix) { if (p === prefix) { res.writeHead(301, { Location: prefix + '/' }); return res.end(); } if (!p.startsWith(prefix + '/')) { res.writeHead(404); return res.end('not found'); } p = p.slice(prefix.length); }
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(root, p);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  const ae = (req.headers['accept-encoding'] || '').split(',').map((x) => x.trim().split(';')[0]).filter((x) => allowed.includes(x)).join(',');
  const headers = { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'Vary': 'Accept-Encoding' };
  let f = file;
  if (ae.includes('br') && fs.existsSync(file + '.br')) { f = file + '.br'; headers['Content-Encoding'] = 'br'; }
  else if (ae.includes('gzip') && fs.existsSync(file + '.gz')) { f = file + '.gz'; headers['Content-Encoding'] = 'gzip'; }
  headers['Content-Length'] = fs.statSync(f).size;
  res.writeHead(200, headers);
  fs.createReadStream(f).pipe(res);
}).listen(port, '0.0.0.0', () => console.log('serving ' + root + ' on http://localhost:' + port));
