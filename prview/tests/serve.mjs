// Static server for the repository root. Serves /prview/ and /webbox/prview/ (the two hosts' paths). node serve.mjs [port]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(new URL('../../', import.meta.url).pathname);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' };
export function serve(port = 0) {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/webbox\//, '/');
      if (p.endsWith('/')) p += 'index.html';
      const file = path.join(root, p);
      if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      fs.createReadStream(file).pipe(res);
    }).listen(port, '0.0.0.0', () => resolve({ srv, port: srv.address().port }));
  });
}
if (import.meta.url === 'file://' + process.argv[1]) serve(Number(process.argv[2] || 8080)).then(s => console.log('serving ' + root + ' on :' + s.port));
