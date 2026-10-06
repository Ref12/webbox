// Stages the published app (dist/wwwroot) for GitHub Pages: nothing here needs server support beyond static files.
//   node tools/stage.mjs <dist/wwwroot> <outDir>   (copied from csharp/tools/stage.mjs)
// 1. Compression: Pages cannot serve precompressed .br with Content-Encoding, so only the big binaries keep their .br
//    (fetched and decoded in the page, see wwwroot/br.js); every .gz and every .br of a text file is dropped (Pages gzips text itself).
// 2. Cache busting: GitHub Pages sends Cache-Control: max-age=600. App files get content-hashed names (main.1a2b3c4d.js, references
//    rewritten), dotnet.js and the data files get ?h=<hash> (hashes written into the manifests), the .NET framework files are already
//    fingerprinted by the SDK, and the Cache API names carry a build id (hash of dotnet.js).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const [src, out] = [path.resolve(process.argv[2] ?? 'dist/wwwroot'), path.resolve(process.argv[3] ?? '_site/sharplab')];
fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(src, out, { recursive: true });
const hash = (buf) => crypto.createHash('sha1').update(buf).digest('hex').slice(0, 10);
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const rel = (p) => path.relative(out, p).split(path.sep).join('/');

// ---- 1. compression ----
const keepBr = /\.(wasm|dll|bin)$/;
let kept = 0, dropped = 0;
for (const f of walk(out)) {
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
const lazyM = readJson('lazy/manifest.json');   // IntelliSense assemblies (tools/PrepareLazy.cs)
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
      const need = (s, r) => { if (!text.includes(s)) throw new Error('config.js: expected ' + s); text = text.replace(s, r); };
      need("export const BUILD = 'dev';", "export const BUILD = '" + dotnetJsHash + "';");
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
fs.writeFileSync(path.join(out, 'build.json'), JSON.stringify({ build: dotnetJsHash, files: Object.fromEntries(name) }, null, 1));
console.log('staged ' + out + ': kept ' + kept + ' .br, dropped ' + dropped + ' compressed copies; app files: ' + [...name].map(([a, b]) => b).join(', '));
