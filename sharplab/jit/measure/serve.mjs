// static server with COOP/COEP (needed for SharedArrayBuffer). usage: node serve.mjs <dir> <port>
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const [dir, port] = [process.argv[2], +process.argv[3]||8099];
const types={'.js':'text/javascript','.mjs':'text/javascript','.html':'text/html','.wasm':'application/wasm','.css':'text/css'};
http.createServer((q,s)=>{let p=path.join(dir,decodeURIComponent(q.url.split('?')[0]));if(p.endsWith('/'))p+='index.html';
 fs.stat(p,(e,st)=>{if(e||!st.isFile()){s.writeHead(404);return s.end();}
 s.writeHead(200,{'content-type':types[path.extname(p)]||'application/octet-stream','content-length':st.size,'cross-origin-opener-policy':'same-origin','cross-origin-embedder-policy':'require-corp','cache-control':'no-store'});
 fs.createReadStream(p).pipe(s);});}).listen(port,()=>console.log('listening',port));
