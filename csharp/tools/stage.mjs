// Stages the published app (dist/wwwroot) for a delivery target.
//   node tools/stage.mjs <dist/wwwroot> <outDir> [--target=pages|cloudflare] [--mt=<dist-mt/wwwroot>]
// target=pages (GitHub Pages: no headers, no Content-Encoding for precompressed files): only the big binaries keep their .br (fetched and decoded in the
//   worker, see wwwroot/br.js, config.js BROTLI=true); every .gz and every .br of a text file is dropped (Pages gzips text itself).
// target=cloudflare (Worker static assets): no .br/.gz at all and no decoder; the edge compresses. Writes _headers (COOP/COEP, cache rules, Content-Types).
// --mt: the multithreaded .NET build (?threads=1); only its _framework is staged, as mt/_framework.
// Cache busting for both: GitHub Pages sends max-age=600. App files get content-hashed names (main.1a2b3c4d.js, references
//    rewritten), dotnet.js and the data files get ?h=<hash> (hashes written into the manifests), the .NET framework files are already
//    fingerprinted by the SDK, and the Cache API names carry a build id (hash of dotnet.js).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const pos = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const opt = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')));
const [src, out] = [path.resolve(pos[0] ?? 'dist/wwwroot'), path.resolve(pos[1] ?? '_site/csharp')];
const target = opt.target ?? 'pages';
if (!['pages', 'cloudflare'].includes(target)) throw new Error('--target must be pages or cloudflare');
fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(src, out, { recursive: true });
if (opt.mt) {
  fs.cpSync(path.join(path.resolve(opt.mt), '_framework'), path.join(out, 'mt/_framework'), { recursive: true });
  fs.rmSync(path.join(out, 'mt/_framework/blazor.boot.json'), { force: true });
}
const hash = (buf) => crypto.createHash('sha1').update(buf).digest('hex').slice(0, 10);
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const rel = (p) => path.relative(out, p).split(path.sep).join('/');

// ---- 1. compression ----
const keepBr = /\.(wasm|dll|bin)$/;
if (target === 'cloudflare') { fs.rmSync(path.join(out, 'vendor'), { recursive: true, force: true }); fs.rmSync(path.join(out, 'br.js'), { force: true }); }
let kept = 0, dropped = 0;
for (const f of walk(out)) {
  if (target === 'cloudflare' && /\.(gz|br)$/.test(f)) { fs.rmSync(f); dropped++; continue; }
  if (f.endsWith('.gz')) { fs.rmSync(f); dropped++; }
  else if (f.endsWith('.br')) {
    const plain = f.slice(0, -3);
    if (keepBr.test(plain) && fs.existsSync(plain)) kept++; else { fs.rmSync(f); dropped++; }
  }
}

// ---- 2a. data hashes into the manifests ----
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(out, p), 'utf8'));
const hashOf = (p) => hash(fs.readFileSync(path.join(out, p)));
const refM = readJson('ref/manifest.json');
refM.coreHash = hashOf('ref/core.bin'); refM.typesHash = hashOf('ref/types.json');
for (const a of refM.assemblies) a.h = hashOf('ref/a/' + a.name);
fs.writeFileSync(path.join(out, 'ref/manifest.json'), JSON.stringify(refM));
const lazyM = readJson('lazy/manifest.json');
for (const x of lazyM.files) x.h = hashOf('lazy/' + x.name);
fs.writeFileSync(path.join(out, 'lazy/manifest.json'), JSON.stringify(lazyM));

// ---- 2b. fingerprint the app files ----
const dotnetJsHash = hashOf('_framework/dotnet.js');
const targets = ['index.html', 'app.css', ...walk(out).map(rel).filter((p) => /^[^/]+\.js$/.test(p) || /^vendor\/.*\.(js|wasm)$/.test(p))]
  .filter((p, i, a) => a.indexOf(p) === i);
const name = new Map(targets.map((t) => [t, t]));   // original path -> current (hashed) path
const done = new Set();
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isText = (p) => /\.(html|css|js)$/.test(p);
const refsIn = (file, text) => targets.filter((t) => t !== file && !done.has(t) && new RegExp('(?<![\\w./-])(\\./)?' + escape(path.posix.relative(path.posix.dirname(file), t)) + '(?![\\w.-])').test(text));
while (done.size < targets.length) {
  const ready = targets.find((t) => !done.has(t) && (!isText(t) || refsIn(t, fs.readFileSync(path.join(out, name.get(t)), 'utf8')).length === 0) && t !== 'index.html')
    ?? (targets.length - done.size === 1 ? 'index.html' : null);
  if (!ready) throw new Error('circular references between app files: ' + targets.filter((t) => !done.has(t)).join(', '));
  const cur = path.join(out, name.get(ready));
  let buf = fs.readFileSync(cur);
  if (isText(ready)) {
    let text = buf.toString('utf8');
    for (const t of targets.filter((x) => x !== ready && done.has(x))) {
      const from = path.posix.relative(path.posix.dirname(ready), t), to = path.posix.relative(path.posix.dirname(ready), name.get(t));
      text = text.replace(new RegExp('(?<![\\w./-])(\\./)?' + escape(from) + '(?![\\w.-])', 'g'), (m, dot) => (dot ?? '') + to);
    }
    if (ready === 'config.js') {
      const need = (s, r) => { if (!text.includes(s)) throw new Error('main.js: expected ' + s); text = text.replace(s, r); };
      need("export const BUILD = 'dev';", "export const BUILD = '" + dotnetJsHash + "';");
      need('export const BROTLI = false;', 'export const BROTLI = ' + (target === 'pages') + ';');
      if (opt.mt) need("mt: './mt/_framework/dotnet.js'", "mt: './mt/_framework/dotnet.js?h=" + hash(fs.readFileSync(path.join(out, 'mt/_framework/dotnet.js'))) + "'");
      need("ref: 'ref/manifest.json'", "ref: 'ref/manifest.json?h=" + hashOf('ref/manifest.json') + "'");
      need("lazy: 'lazy/manifest.json'", "lazy: 'lazy/manifest.json?h=" + hashOf('lazy/manifest.json') + "'");
      need("st: './_framework/dotnet.js'", "st: './_framework/dotnet.js?h=" + dotnetJsHash + "'");
    }
    buf = Buffer.from(text);
  }
  if (ready === 'index.html') fs.writeFileSync(cur, buf);
  else {
    const ext = path.extname(ready), hashed = ready.slice(0, -ext.length) + '.' + hash(buf) + ext;
    fs.writeFileSync(path.join(out, hashed), buf); fs.rmSync(cur);
    name.set(ready, hashed);
  }
  done.add(ready);
}
if (target === 'cloudflare') {
  // _headers (Workers static assets). Rules combine: a header set by two matching rules is joined, so every file matches exactly one Cache-Control rule.
  const hashedApp = [...name.values()].filter((n) => n !== 'index.html').map((n) => '/csharp/' + n);
  const rule = (pat, ...h) => pat + '\n' + h.map((x) => '  ' + x).join('\n') + '\n';
  const immutable = 'Cache-Control: public, max-age=31536000, immutable';
  const wasmType = 'Content-Type: application/wasm';   // Cloudflare compresses application/wasm, javascript and json at the edge, not application/octet-stream
  const parts = [
    '# generated by csharp/tools/stage.mjs --target=cloudflare',
    rule('/csharp/*', 'Cross-Origin-Opener-Policy: same-origin', 'Cross-Origin-Embedder-Policy: credentialless'),
    rule('/csharp/', 'Cache-Control: no-cache'), rule('/csharp/index.html', 'Cache-Control: no-cache'), rule('/csharp/build.json', 'Cache-Control: no-cache'),
    ...hashedApp.map((n) => rule(n, immutable)),
    rule('/csharp/_framework/*', immutable), rule('/csharp/mt/_framework/*', immutable), rule('/csharp/ref/*', immutable), rule('/csharp/lazy/*', immutable),
    rule('/csharp/_framework/*.wasm', wasmType), rule('/csharp/mt/_framework/*.wasm', wasmType),
    rule('/csharp/ref/*.bin', wasmType), rule('/csharp/ref/a/*', wasmType), rule('/csharp/lazy/*.dll', wasmType),
  ];
  fs.writeFileSync(path.join(out, '..', '_headers'), parts.join('\n'));   // the assets root: out is <root>/csharp
}
fs.writeFileSync(path.join(out, 'build.json'), JSON.stringify({ build: dotnetJsHash, files: Object.fromEntries(name) }, null, 1));
console.log('staged (' + target + ') ' + out + ': kept ' + kept + ' .br, dropped ' + dropped + ' compressed copies; app files: ' + [...name].map(([a, b]) => b).join(', '));
