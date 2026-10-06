// Minimal static file server for the published site (no app logic). Serves precompressed .br/.gz when present.
// Usage: node tools/serve.mjs <dir> [port]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(process.argv[2] ?? 'dist');
const port = Number(process.argv[3] ?? 8080);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.wasm': 'application/wasm', '.dll': 'application/octet-stream', '.txt': 'text/plain', '.png': 'image/png' };
http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(root, p);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  const ae = req.headers['accept-encoding'] || '';
  const headers = { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'Vary': 'Accept-Encoding' };
  let f = file;
  if (ae.includes('br') && fs.existsSync(file + '.br')) { f = file + '.br'; headers['Content-Encoding'] = 'br'; }
  else if (ae.includes('gzip') && fs.existsSync(file + '.gz')) { f = file + '.gz'; headers['Content-Encoding'] = 'gzip'; }
  headers['Content-Length'] = fs.statSync(f).size;
  res.writeHead(200, headers);
  fs.createReadStream(f).pipe(res);
}).listen(port, '0.0.0.0', () => console.log('serving ' + root + ' on http://localhost:' + port));
