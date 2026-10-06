import { dotnet } from './_framework/dotnet.js';
import * as nuget from './nuget.js';
import { parse, format, resolveName, previousVersion } from './route.js';
import { toHtml, monacoHtml } from './highlight.js';

const $ = (id) => document.getElementById(id);
const metrics = (window.__metrics = { marks: {}, net: { started: 0, done: 0, bytes: 0, retries: 0 }, assets: nuget.log });
const mark = (k) => { if (!(k in metrics.marks)) metrics.marks[k] = Math.round(performance.now()); };
const setStatus = (s) => ($('status').textContent = s);

// ---- tiny DOM helper -------------------------------------------------------------------------------------------
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v; else if (k === 'text') el.textContent = v; else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(c));
  return el;
}
const fmtBytes = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
const fmtCount = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'K' : String(n));

// ---- resilient fetch for the site's own files (runtime, reference assemblies): 3 tries with backoff --------------------
const nativeFetch = window.fetch.bind(window);
window.fetch = async function (input, init) {
  const url = String(input?.url ?? input);
  if ((init?.method || 'GET').toUpperCase() !== 'GET' || (/^https?:/.test(url) && !url.startsWith(location.origin))) return nativeFetch(input, init);
  metrics.net.started++;
  let last;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const resp = await nativeFetch(input, init);
      if (resp.ok || (resp.status < 500 && resp.status !== 408 && resp.status !== 429)) { metrics.net.done++; return resp; }
      last = new Error('HTTP ' + resp.status);
    } catch (e) { last = e; }
    metrics.net.retries++;
    setStatus('retrying ' + decodeURIComponent(url.split('?')[0].split('/').pop()) + ' (' + attempt + '/3)…');
    await new Promise((r) => setTimeout(r, 400 * 3 ** (attempt - 1)));
  }
  throw new Error('Could not download ' + url.split('/').pop() + ': ' + last.message + ' (after 3 tries). Check your connection and reload.');
};

// ---- host module: what C# calls to fetch bytes (Cache API first) -----------------------------------------------------
let refVersion = 'v0';
const taken = new Map();
const hostModule = {
  async fetchAsset(url) {
    let r;
    if (/^https?:/.test(url)) r = await nuget.getBytes(url, /index\.json$/.test(url) ? { cacheName: nuget.META_CACHE, ttl: nuget.META_TTL_MS } : {});
    else r = await nuget.getBytes(new URL(url, location.href).href, { cacheName: 'fuget-refs-' + refVersion });
    taken.set(url, r.bytes ?? new Uint8Array(0));
  },
  takeAsset(url) { const b = taken.get(url) ?? new Uint8Array(0); taken.delete(url); return b; },
};

// ---- .NET runtime ------------------------------------------------------------------------------------------------
let exportsRef = null;
let resolveRuntime; const runtimeReady = new Promise((r) => (resolveRuntime = r));
async function startRuntime() {
  try {
    setStatus('downloading .NET runtime…');
    const { getAssemblyExports, getConfig, setModuleImports } = await dotnet.withDiagnosticTracing(false).create();
    setModuleImports('host', hostModule);
    mark('runtimeCreated');
    exportsRef = await getAssemblyExports(getConfig().mainAssemblyName);
    const mf = await (await fetch('ref/manifest.json')).text();
    refVersion = JSON.parse(mf).version;
    for (const k of await caches.keys()) if (k.startsWith('fuget-refs-') && k !== 'fuget-refs-' + refVersion) await caches.delete(k);
    exportsRef.Interop.Configure(mf);
    mark('runtimeReady');
    setStatus('ready');
    resolveRuntime();
  } catch (e) { metrics.error = String(e.message || e); setStatus('failed: ' + metrics.error); document.body.classList.add('failed'); console.error(e); }
}
async function call(name, ...args) {
  await runtimeReady;
  const r = JSON.parse(await exportsRef.Interop[name[0].toUpperCase() + name.slice(1)](...args));
  if (r && r.error) throw new Error(r.error);
  return r;
}

// ---- state -------------------------------------------------------------------------------------------------------
const S = { id: '', versions: [], version: '', pkg: null, pkgFrom: '', apis: new Map(), dir: '', asm: '', api: null, seq: 0, r: null, filter: '' };
const decompiled = new Map();
const panel = () => $('panel');
const stale = (seq) => seq !== S.seq;
const link = (r) => format({ ...baseRoute(), ...r });
const baseRoute = () => ({ id: S.id, version: S.version, dir: S.dir, asm: asmName(S.asm), tab: S.r?.tab });
const asmName = (f) => f.replace(/\.dll$/i, '');

function go(r) { location.hash = format(r); }
function replace(r) { history.replaceState(null, '', format(r)); S.r = parse(location.hash); }

// ---- navigation --------------------------------------------------------------------------------------------------
async function navigate() {
  const seq = ++S.seq;
  const r = (S.r = parse(location.hash));
  document.body.classList.remove('tree-open');
  if (!r.id) { S.id = ''; return landing(r); }
  $('q').value = r.id;
  try {
    panel().replaceChildren(h('p', { class: 'busy', text: 'Loading ' + r.id + '…' }));
    if (S.id.toLowerCase() !== r.id.toLowerCase()) {
      S.versions = await nuget.versions(r.id);
      if (stale(seq)) return;
      if (!S.versions.length) throw new Error(`Package "${r.id}" was not found on nuget.org.`);
      S.id = r.id; S.pkg = null; S.apis.clear(); decompiled.clear();
    }
    const version = r.version || nuget.latestStable(S.versions);
    if (!S.pkg || S.pkg.version.toLowerCase() !== version.toLowerCase()) {
      setStatus('downloading ' + r.id + ' ' + version + '…');
      const n0 = nuget.log.length;
      S.pkg = await call('open', r.id, version);
      if (stale(seq)) return;
      const ev = nuget.log.slice(n0).find((e) => e.url.endsWith('.nupkg'));
      S.pkgFrom = ev ? ev.from + ', ' + ev.ms + ' ms' : '';
      mark('package'); setStatus('ready');
      S.id = S.pkg.id; S.apis.clear(); decompiled.clear();
    }
    S.version = S.pkg.version;
    $('q').value = S.pkg.id;
    renderVersions();
    document.title = S.pkg.id + ' ' + S.version + ' — fuget';
    // framework + assembly (fall back to sensible defaults and rewrite the URL)
    const withAsm = S.pkg.frameworks.filter((f) => f.assemblies.length);
    let fw = S.pkg.frameworks.find((f) => f.dir === r.dir) ?? withAsm[0] ?? S.pkg.frameworks[0];
    if (!fw) { S.dir = ''; S.asm = ''; S.api = null; renderTree(); return noAssemblies(); }
    S.dir = fw.dir;
    if (!fw.assemblies.length) { S.asm = ''; S.api = null; renderTree(); return noAssemblies(); }
    S.asm = fw.assemblies.find((a) => asmName(a).toLowerCase() === r.asm.toLowerCase()) ?? fw.assemblies.find((a) => asmName(a).toLowerCase() === S.pkg.id.toLowerCase()) ?? fw.assemblies[0];
    const key = S.dir + '/' + S.asm;
    if (!S.apis.has(key)) {
      panel().replaceChildren(h('p', { class: 'busy', text: 'Reading ' + S.asm + '…' }));
      S.apis.set(key, await call('readAssembly', S.id, S.version, S.dir, asmName(S.asm)));
      if (stale(seq)) return;
      mark('assembly');
    }
    S.api = S.apis.get(key);
    const sel = resolveName(S.api.types, r.name);
    const canonical = { id: S.id, version: S.version, dir: S.dir, asm: asmName(S.asm), name: sel.type?.fullName ?? sel.ns ?? '', tab: r.tab, member: r.member, base: r.base };
    if (format(canonical) !== format(r)) replace(canonical);
    S.sel = { ...sel, member: r.member };
    renderTree();
    renderTabs();
    await renderPanel(seq);
    if (stale(seq)) return;
    if (!metrics.marks.firstView) { mark('firstView'); metrics.ready = true; window.__ready = true; }
  } catch (e) {
    if (stale(seq)) return;
    console.error(e);
    panel().replaceChildren(h('div', { class: 'error' }, h('strong', { text: 'Something went wrong' }), h('p', { text: String(e.message || e) })));
    setStatus('error'); metrics.lastError = String(e.message || e);
  }
}
window.addEventListener('hashchange', navigate);

// ---- header: search, versions --------------------------------------------------------------------------------------
let suggestTimer = 0, suggestSeq = 0;
function setupSearch() {
  const q = $('q'), box = $('suggest');
  const hide = () => (box.hidden = true);
  q.addEventListener('input', () => {
    clearTimeout(suggestTimer);
    const text = q.value.trim();
    if (text.length < 2) return hide();
    suggestTimer = setTimeout(async () => {
      const mine = ++suggestSeq;
      try {
        const ids = await nuget.autocomplete(text);
        if (mine !== suggestSeq) return;
        box.replaceChildren(...ids.map((id) => h('a', { href: format({ id, version: '' }), onclick: hide, text: id })));
        box.hidden = ids.length === 0;
      } catch { hide(); }
    }, 180);
  });
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { hide(); const t = q.value.trim(); if (t) go(/^[\w.-]+$/.test(t) && !t.includes(' ') && box.firstChild?.textContent?.toLowerCase() === t.toLowerCase() ? { id: box.firstChild.textContent, version: '' } : { id: '', q: t }); }
    if (e.key === 'Escape') hide();
  });
  document.addEventListener('click', (e) => { if (!box.contains(e.target) && e.target !== q) hide(); });
  $('menu').onclick = () => document.body.classList.toggle('tree-open');
  $('version').onchange = (e) => go({ ...baseRoute(), version: e.target.value, name: S.sel?.type?.fullName ?? S.sel?.ns ?? '', member: '', base: '' });
}
function renderVersions() {
  const sel = $('version');
  sel.hidden = false;
  sel.replaceChildren(...[...S.versions].reverse().map((v) => h('option', { value: v, text: v, selected: v.toLowerCase() === S.version.toLowerCase() })));
}

// ---- landing / search results -------------------------------------------------------------------------------------
async function landing(r) {
  $('version').hidden = true; $('tree').replaceChildren(); $('tabs').replaceChildren(); $('crumbs').replaceChildren();
  document.title = 'fuget — NuGet package browser on .NET WebAssembly';
  const seq = S.seq;
  if (!r.q) {
    $('q').value = '';
    panel().replaceChildren(h('div', { class: 'landing' },
      h('h1', { text: 'Browse any NuGet package' }),
      h('p', { text: 'Namespaces, types, members and docs, decompiled C#, dependencies and API diffs between versions — all computed in your browser on .NET WebAssembly. Nothing is sent anywhere but nuget.org.' }),
      h('p', { class: 'chips' }, ['Newtonsoft.Json', 'Humanizer.Core', 'Serilog', 'Dapper', 'AutoMapper', 'Polly'].map((id) => h('a', { class: 'chip', href: format({ id, version: '' }), text: id }))),
      h('p', { class: 'dim', text: 'Try a deep link: ' }, h('a', { href: '#/Newtonsoft.Json/13.0.3/lib/net6.0/Newtonsoft.Json/Newtonsoft.Json.Linq.JObject', text: 'JObject in Newtonsoft.Json 13.0.3' }))));
    mark('landing'); return;
  }
  $('q').value = r.q;
  panel().replaceChildren(h('p', { class: 'busy', text: 'Searching nuget.org for “' + r.q + '”…' }));
  try {
    const res = await nuget.search(r.q);
    if (stale(seq)) return;
    panel().replaceChildren(h('h2', { text: res.length ? 'Search results for “' + r.q + '”' : 'No packages match “' + r.q + '”' }),
      h('div', { class: 'cards' }, res.map((p) => h('a', { class: 'card', href: format({ id: p.id, version: '' }) },
        h('div', { class: 'card-title' }, h('strong', { text: p.id }), h('span', { class: 'dim', text: ' ' + p.version }), p.verified ? h('span', { class: 'badge ok', text: 'verified' }) : null),
        h('div', { class: 'card-desc', text: (p.description || p.summary || '').slice(0, 220) }),
        h('div', { class: 'dim', text: fmtCount(p.totalDownloads || 0) + ' downloads' })))));
    mark('searchResults');
  } catch (e) { panel().replaceChildren(h('div', { class: 'error' }, h('p', { text: 'Search failed: ' + e.message }))); }
}

function noAssemblies() {
  panel().replaceChildren(h('div', { class: 'note' }, h('strong', { text: S.pkg.id + ' ' + S.version }), h('p', { text: 'This package has no assemblies under lib/ or ref/ (it may be a meta-package, a tool or contain only build assets).' })), packageCard());
  renderTabs();
}

// ---- tree ----------------------------------------------------------------------------------------------------------
const KIND_ICON = { class: 'C', struct: 'S', interface: 'I', enum: 'E', delegate: 'D' };
function renderTree() {
  const tree = $('tree');
  if (!S.pkg) return tree.replaceChildren();
  const filter = h('input', { type: 'search', class: 'filter', placeholder: 'Filter types…', value: S.filter, 'aria-label': 'Filter types' });
  filter.addEventListener('input', () => { S.filter = filter.value; fillTypes(); });
  const root = h('div', { class: 'tnode' });
  root.append(h('a', { class: 'trow pkg', href: link({ name: '', member: '', tab: 'docs' }), text: S.pkg.id + ' ' + S.version }));
  for (const fw of S.pkg.frameworks) {
    const cur = fw.dir === S.dir;
    const d = h('details', { class: 'tnode', open: cur });
    d.append(h('summary', { class: 'trow fw' + (cur ? ' cur' : ''), text: fw.dir }));
    if (!cur) { d.querySelector('summary').addEventListener('click', (e) => { e.preventDefault(); go({ id: S.id, version: S.version, dir: fw.dir, asm: '', tab: S.r.tab }); }); }
    else for (const a of fw.assemblies) {
      const isCur = a === S.asm;
      const ad = h('details', { class: 'tnode', open: isCur });
      ad.append(h('summary', { class: 'trow asm' + (isCur ? ' cur' : ''), text: a }));
      if (!isCur) ad.querySelector('summary').addEventListener('click', (e) => { e.preventDefault(); go({ id: S.id, version: S.version, dir: fw.dir, asm: asmName(a), tab: S.r.tab }); });
      else { ad.append(h('div', { id: 'types' })); }
      d.append(ad);
    }
    root.append(d);
  }
  tree.replaceChildren(filter, root);
  fillTypes();
}

function fillTypes() {
  const host = $('types');
  if (!host || !S.api) return;
  const f = S.filter.trim().toLowerCase();
  const byNs = new Map();
  for (const t of S.api.types) {
    if (f && !t.name.toLowerCase().includes(f) && !t.namespace.toLowerCase().includes(f)) continue;
    if (!byNs.has(t.namespace)) byNs.set(t.namespace, []);
    byNs.get(t.namespace).push(t);
  }
  let budget = 400;
  const nodes = [];
  for (const [ns, types] of [...byNs].sort((a, b) => a[0].localeCompare(b[0]))) {
    const selected = S.sel?.ns === ns || ns === S.sel?.type?.namespace;
    const d = h('details', { class: 'tnode', open: selected || (f && budget > 0) });
    d.append(h('summary', { class: 'trow ns' + (S.sel?.ns === ns && !S.sel.type ? ' cur' : ''), title: ns }, ns || '(global)', h('span', { class: 'count', text: types.length })));
    const fill = () => {
      if (d.dataset.filled) return; d.dataset.filled = '1';
      for (const t of types.slice(0, budget > 0 ? budget : 100)) {
        budget--;
        d.append(h('a', { class: 'trow type' + (S.sel?.type === t ? ' cur' : ''), href: link({ name: t.fullName, member: '', tab: S.r.tab === 'diff' || S.r.tab === 'deps' ? 'docs' : S.r.tab }), title: t.fullName },
          h('span', { class: 'ico ' + t.kind, text: KIND_ICON[t.kind] || 'C' }), h('span', { class: t.obsolete != null ? 'obs' : '', text: t.name })));
      }
    };
    if (d.open) fill(); else d.addEventListener('toggle', fill, { once: true });
    d.querySelector('summary').addEventListener('dblclick', () => go({ id: S.id, version: S.version, dir: S.dir, asm: asmName(S.asm), name: ns, tab: 'docs' }));
    nodes.push(d);
  }
  host.replaceChildren(...nodes);
  if (!nodes.length) host.append(h('p', { class: 'dim pad', text: 'No types match.' }));
  document.querySelector('.type.cur')?.scrollIntoView({ block: 'nearest' });
}

// ---- tabs + breadcrumbs ----------------------------------------------------------------------------------------------
const TABS = [['docs', 'Docs'], ['decompiled', 'Decompiled'], ['diff', 'Diff'], ['deps', 'Dependencies']];
function renderTabs() {
  const r = S.r;
  $('tabs').replaceChildren(...TABS.map(([k, label]) => h('a', { class: 'tab' + (r.tab === k ? ' on' : ''), href: link({ name: S.sel?.type?.fullName ?? S.sel?.ns ?? '', member: r.member, tab: k, base: r.base }), text: label })));
  const crumbs = [h('a', { href: link({ name: '', member: '', tab: 'docs' }), text: S.id })];
  if (S.dir) crumbs.push(h('span', { class: 'sep', text: '›' }), h('span', { text: S.dir }));
  if (S.asm) crumbs.push(h('span', { class: 'sep', text: '›' }), h('a', { href: link({ name: '', member: '', tab: 'docs' }), text: S.asm }));
  const ns = S.sel?.ns;
  if (ns) crumbs.push(h('span', { class: 'sep', text: '›' }), h('a', { href: link({ name: ns, member: '', tab: 'docs' }), text: ns }));
  if (S.sel?.type) crumbs.push(h('span', { class: 'sep', text: '›' }), h('strong', { text: S.sel.type.name }));
  $('crumbs').replaceChildren(...crumbs);
}

async function renderPanel(seq) {
  const tab = S.r.tab;
  let node;
  if (tab === 'decompiled') node = await decompiledPanel(seq);
  else if (tab === 'diff') node = await diffPanel(seq);
  else if (tab === 'deps') node = depsPanel();
  else node = await docsPanel(seq);
  if (stale(seq) || !node) return;
  panel().replaceChildren(node);
  panel().scrollTop = 0;
  if (S.r.member) document.querySelector('.member.open')?.scrollIntoView({ block: 'center' });
}

// ---- docs rendering ------------------------------------------------------------------------------------------------------
function md(text) {
  const out = h('div', { class: 'md' });
  if (!text) return out;
  text.split(/```\n?/).forEach((chunk, i) => {
    if (i % 2 === 1) { out.append(h('pre', { class: 'code', html: toHtml(chunk.replace(/\n$/, '')) })); return; }
    for (const para of chunk.split(/\n\s*\n/)) {
      const lines = para.split('\n').filter((l) => l.trim());
      if (!lines.length) continue;
      const inline = (s) => { const f = document.createDocumentFragment(); s.split(/(`[^`]+`)/).forEach((p) => f.append(p.startsWith('`') && p.endsWith('`') && p.length > 2 ? h('code', { text: p.slice(1, -1) }) : p)); return f; };
      if (lines.every((l) => l.startsWith('- '))) out.append(h('ul', {}, lines.map((l) => h('li', {}, inline(l.slice(2))))));
      else out.append(h('p', {}, inline(lines.join(' '))));
    }
  });
  return out;
}

function docSections(d) {
  if (!d) return [];
  const out = [];
  const sec = (title, body) => body && out.push(h('div', { class: 'dsec' }, h('h4', { text: title }), body));
  sec('Summary', d.summary ? md(d.summary) : null);
  const dl = (obj) => (obj && Object.keys(obj).length ? h('dl', {}, Object.entries(obj).flatMap(([k, v]) => [h('dt', {}, h('code', { text: k })), h('dd', {}, md(v))])) : null);
  sec('Type parameters', dl(d.typeParams)); sec('Parameters', dl(d.params));
  sec('Returns', d.returns ? md(d.returns) : null); sec('Value', d.value ? md(d.value) : null);
  sec('Exceptions', d.exceptions?.length ? h('dl', {}, d.exceptions.flatMap((e) => [h('dt', {}, h('code', { text: e.type })), h('dd', {}, md(e.text))])) : null);
  sec('Remarks', d.remarks ? md(d.remarks) : null); sec('Example', d.example ? md(d.example) : null);
  sec('See also', d.seeAlso?.length ? h('p', {}, d.seeAlso.map((s) => h('code', { class: 'seealso', text: s }))) : null);
  return out;
}

const badge = (text, cls) => h('span', { class: 'badge ' + (cls || ''), text });
function obsoleteBanner(x) { return x.obsolete != null ? h('div', { class: 'obsolete' }, h('strong', { text: 'Obsolete' }), x.obsoleteError ? ' (error)' : '', x.obsolete ? ': ' + x.obsolete : '') : null; }
const sigBlock = (text) => h('pre', { class: 'sig', html: toHtml(text) });

async function docsPanel(seq) {
  const { type, ns } = S.sel;
  if (type) return typePage(type, seq);
  if (ns !== null && ns !== undefined) return nsPage(ns);
  return assemblyPage();
}

function packageCard() {
  const n = S.pkg.nuspec;
  const rows = [];
  const row = (k, v) => v && rows.push(h('div', { class: 'kv' }, h('span', { class: 'k', text: k }), h('span', { class: 'v' }, v)));
  const a = (u) => (u ? h('a', { href: u, target: '_blank', rel: 'noopener', text: u }) : null);
  row('Authors', n.authors); row('License', n.license || (n.licenseUrl ? a(n.licenseUrl) : null)); row('Project', a(n.projectUrl)); row('Repository', a(n.repository));
  row('Tags', n.tags); row('Package size', fmtBytes(S.pkg.size) + (S.pkgFrom ? ' (' + S.pkgFrom + ')' : ''));
  row('Frameworks', S.pkg.frameworks.map((f) => f.dir).join(', '));
  return h('section', { class: 'card-info' }, h('h3', { text: S.pkg.id + ' ' + S.version }), n.description ? md(n.description) : null, rows);
}

function assemblyPage() {
  const api = S.api;
  const nss = new Map();
  for (const t of api.types) nss.set(t.namespace, (nss.get(t.namespace) || 0) + 1);
  return h('div', {}, packageCard(),
    h('section', {}, h('h3', { text: api.name + ' ' + api.version }), h('p', { class: 'dim', text: api.types.length + ' public types in ' + nss.size + ' namespaces · ' + S.dir }),
      api.attributes.length ? h('p', {}, api.attributes.map((x) => h('code', { class: 'attr', text: '[assembly: ' + x + ']' }))) : null,
      h('ul', { class: 'nslist' }, [...nss].sort((x, y) => x[0].localeCompare(y[0])).map(([ns, c]) => h('li', {}, h('a', { href: link({ name: ns, tab: 'docs' }), text: ns || '(global)' }), h('span', { class: 'count', text: c })))),
      h('details', { class: 'refs' }, h('summary', { text: api.references.length + ' referenced assemblies' }), h('p', { class: 'dim', text: api.references.join(', ') }))));
}

function nsPage(ns) {
  const types = S.api.types.filter((t) => t.namespace === ns);
  return h('div', {}, h('h2', { text: ns || '(global namespace)' }), h('p', { class: 'dim', text: types.length + ' types' }),
    h('div', { class: 'tlist' }, types.map((t) => h('a', { class: 'trow2', href: link({ name: t.fullName, tab: 'docs' }) },
      h('span', { class: 'ico ' + t.kind, text: KIND_ICON[t.kind] }), h('code', { class: t.obsolete != null ? 'obs' : '', text: t.name }), h('span', { class: 'dim sum', text: t.summary || '' })))));
}

const GROUPS = [['constructor', 'Constructors'], ['const', 'Constants'], ['field', 'Fields'], ['property', 'Properties'], ['event', 'Events'], ['method', 'Methods'], ['operator', 'Operators']];

async function typePage(type, seq) {
  const doc = await call('doc', S.id, S.version, S.dir, asmName(S.asm), type.id).catch(() => ({}));
  if (stale(seq)) return null;
  const root = h('div', { class: 'typepage' });
  root.append(h('h2', {}, h('span', { class: 'ico big ' + type.kind, text: KIND_ICON[type.kind] }), type.name, ' ', badge(type.kind)), h('div', { class: 'dim ns', text: type.namespace }));
  root.append(obsoleteBanner(type), sigBlock((type.attributes.length ? type.attributes.map((a) => '[' + a + ']').join('\n') + '\n' : '') + type.declaration));
  for (const s of docSections(doc)) root.append(s);
  const members = type.members;
  if (type.kind === 'enum') {
    root.append(h('h3', { text: 'Values' }), h('table', { class: 'enum' }, members.map((m) => h('tr', { class: m.obsolete != null ? 'obs' : '' }, h('td', {}, h('code', { text: m.name })), h('td', { class: 'dim', text: m.signature.split(' = ')[1] ?? '' }), h('td', { text: m.summary || '' })))));
    return root;
  }
  for (const [kind, title] of GROUPS) {
    const list = members.filter((m) => m.kind === kind);
    if (!list.length) continue;
    root.append(h('h3', {}, title, h('span', { class: 'count', text: list.length })));
    root.append(...list.map((m) => memberRow(type, m)));
  }
  if (!members.length) root.append(h('p', { class: 'dim', text: 'No public members.' }));
  return root;
}

function memberRow(type, m) {
  const open = S.r.member === m.id;
  const row = h('div', { class: 'member' + (open ? ' open' : '') + (m.obsolete != null ? ' obsolete' : ''), id: 'm-' + btoa(unescape(encodeURIComponent(m.id))).replace(/=/g, '') });
  const head = h('div', { class: 'mhead', tabindex: '0', role: 'button', 'aria-expanded': String(open) });
  head.append(h('code', { class: 'msig', html: toHtml(m.signature) }));
  if (m.obsolete != null) head.append(badge('obsolete', 'warn'));
  if (m.summary) head.append(h('div', { class: 'msum dim', text: m.summary.split('\n')[0] }));
  const body = h('div', { class: 'mbody' });
  row.append(head, body);
  const fill = async () => {
    if (body.dataset.filled) return; body.dataset.filled = '1';
    body.append(h('span', { class: 'dim', text: 'loading…' }));
    const doc = await call('doc', S.id, S.version, S.dir, asmName(S.asm), m.id).catch(() => ({}));
    body.replaceChildren(obsoleteBanner(m) ?? '', ...(m.attributes.length ? [h('p', {}, m.attributes.map((a) => h('code', { class: 'attr', text: '[' + a + ']' })))] : []),
      ...docSections(doc),
      !Object.keys(doc || {}).length ? h('p', { class: 'dim', text: 'No XML documentation for this member.' }) : '',
      h('p', {}, h('a', { class: 'btn', href: link({ name: type.fullName, member: m.id, tab: 'decompiled' }), text: 'Decompile this member' }), ' ', h('code', { class: 'docid dim', text: m.id })));
  };
  const toggle = () => {
    const on = row.classList.toggle('open'); head.setAttribute('aria-expanded', String(on));
    if (on) { fill(); history.replaceState(null, '', format({ ...baseRoute(), name: type.fullName, member: m.id, tab: 'docs', base: S.r.base })); }
    else history.replaceState(null, '', format({ ...baseRoute(), name: type.fullName, tab: 'docs' }));
    S.r = parse(location.hash);
  };
  head.addEventListener('click', toggle);
  head.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
  if (open) fill();
  return row;
}

// ---- decompiled ------------------------------------------------------------------------------------------------------------
async function decompiledPanel(seq) {
  const type = S.sel.type;
  if (!type) return h('div', { class: 'note' }, h('p', { text: 'Select a type in the tree to see its decompiled C#.' }));
  const member = S.r.member ? type.members.find((m) => m.id === S.r.member) : null;
  const token = member ? member.token : type.token;
  const key = [S.id, S.version, S.dir, S.asm, token].join('|');
  const head = h('div', { class: 'dhead' }, h('strong', { text: member ? member.name : type.name }),
    member ? h('a', { class: 'btn', href: link({ name: type.fullName, member: '', tab: 'decompiled' }), text: 'Show whole type' }) : null);
  const view = h('div', { class: 'decompiled' }, head);
  panel().replaceChildren(view, h('p', { class: 'busy', text: 'Decompiling ' + (member ? member.name : type.name) + ' with ICSharpCode.Decompiler (ILSpy) in WebAssembly…' }));
  await new Promise((r) => setTimeout(r, 30));   // let the "decompiling" text paint: the runtime is single-threaded
  let res = decompiled.get(key);
  if (!res) {
    const t0 = performance.now();
    res = await call('decompile', S.id, S.version, S.dir, asmName(S.asm), token);
    res.wallMs = Math.round(performance.now() - t0);
    decompiled.set(key, res);
    (metrics.decompile ||= []).push({ type: type.fullName, member: member?.name, ms: res.wallMs, loaded: res.loaded.length, missing: res.missing });
  }
  if (stale(seq)) return null;
  const pre = h('pre', { class: 'code decomp', html: toHtml(res.code) });
  view.append(pre);
  const info = h('p', { class: 'dim small' }, `Decompiled in ${res.wallMs} ms (${Math.round(res.ms)} ms in .NET). `,
    res.missing.length ? h('span', { class: 'warn', text: 'Unresolved references: ' + res.missing.join(', ') + '. ' }) : '',
    res.loaded.length ? h('details', { class: 'refs' }, h('summary', { text: res.loaded.length + ' assemblies loaded for resolution' }), h('ul', {}, res.loaded.map((l) => h('li', { text: l.name + ' — ' + l.source + ', ' + fmtBytes(l.bytes) })))) : '');
  view.append(info);
  mark('decompiled');
  monacoHtml(res.code).then((html) => { if (html && !stale(seq) && pre.isConnected) { pre.innerHTML = html; pre.classList.add('monaco-colored'); metrics.monacoColored = true; } });
  return view;
}

// ---- diff --------------------------------------------------------------------------------------------------------------------
const SIGN = { added: '+', removed: '−', changed: '~' };
async function diffPanel(seq) {
  const base = S.r.base || previousVersion(S.versions, S.version);
  const others = S.versions.filter((v) => v.toLowerCase() !== S.version.toLowerCase());
  if (!base) return h('div', { class: 'note' }, h('p', { text: S.version + ' is the first version of ' + S.id + ': there is nothing to compare with.' }));
  const picker = h('div', { class: 'diffbar' }, h('label', { text: 'Compare ' + S.version + ' with ' }),
    h('select', { onchange: (e) => go({ ...baseRoute(), name: S.sel.type?.fullName ?? S.sel.ns ?? '', tab: 'diff', base: e.target.value }) }, [...others].reverse().map((v) => h('option', { value: v, text: v, selected: v === base }))));
  panel().replaceChildren(picker, h('p', { class: 'busy', text: 'Comparing the public API of ' + asmName(S.asm) + ' ' + base + ' → ' + S.version + '…' }));
  const t0 = performance.now();
  await call('open', S.id, base);
  const d = await call('diff', S.id, base, S.version, S.dir, asmName(S.asm));
  (metrics.diff ||= []).push({ base, ms: Math.round(performance.now() - t0), types: d.types.length });
  if (stale(seq)) return null;
  mark('diff');
  const root = h('div', { class: 'diff' }, picker);
  const chip = (cls, text) => h('span', { class: 'chip2 ' + cls, text });
  root.append(h('div', { class: 'dsum' },
    chip('added', `+${d.addedTypes} types, +${d.addedMembers} members`), chip('removed', `−${d.removedTypes} types, −${d.removedMembers} members`),
    chip('changed', `~${d.changedTypes} types, ~${d.changedMembers} members`), chip(d.breaking ? 'breaking' : 'ok', d.breaking + ' breaking')));
  if (d.oldDir !== d.newDir) root.append(h('p', { class: 'dim small', text: `Compared ${base} ${d.oldDir ?? '(assembly absent)'} with ${S.version} ${d.newDir}.` }));
  if (!d.types.length) { root.append(h('p', { class: 'note', text: 'No public API differences.' })); return root; }
  const list = h('div', { class: 'dlist' });
  const show = new Set(['added', 'removed', 'changed']); let breakingOnly = false;
  const filters = h('div', { class: 'dfilters' }, ['added', 'removed', 'changed'].map((s) => h('label', {}, h('input', { type: 'checkbox', checked: true, onchange: (e) => { e.target.checked ? show.add(s) : show.delete(s); draw(); } }), ' ' + s)),
    h('label', {}, h('input', { type: 'checkbox', onchange: (e) => { breakingOnly = e.target.checked; draw(); } }), ' breaking only'));
  const draw = () => {
    list.replaceChildren(...d.types.filter((t) => show.has(t.status) && (!breakingOnly || t.breaking || t.members.some((m) => m.breaking))).map((t, i) => {
      const det = h('details', { class: 'dtype ' + t.status, open: t.status === 'changed' && i < 40 || S.sel.type?.fullName === t.fullName });
      det.append(h('summary', {}, h('span', { class: 'dsign', text: SIGN[t.status] }), h('a', { href: link({ name: t.fullName, tab: 'docs' }), text: t.fullName }), ' ', badge(t.kind), t.breaking ? badge('breaking', 'warn') : null,
        h('span', { class: 'count', text: t.members.length })));
      if (t.status === 'changed' && t.oldDeclaration !== t.newDeclaration) det.append(h('div', { class: 'dmember changed' }, h('div', { class: 'old', text: '− ' + t.oldDeclaration }), h('div', { class: 'new', text: '+ ' + t.newDeclaration })));
      for (const m of t.members) {
        const mm = h('div', { class: 'dmember ' + m.status });
        if (m.old) mm.append(h('div', { class: 'old', text: (m.status === 'removed' ? '− ' : '− ') + m.old }));
        if (m.new) mm.append(h('div', { class: 'new', text: '+ ' + m.new }));
        if (m.breaking) mm.append(badge('breaking', 'warn'));
        det.append(mm);
      }
      return det;
    }));
  };
  draw();
  root.append(filters, list);
  return root;
}

// ---- dependencies ----------------------------------------------------------------------------------------------------------------
function depsPanel() {
  const n = S.pkg.nuspec;
  const applies = S.pkg.dependencyGroupFor?.[S.dir];
  const root = h('div', { class: 'deps' }, packageCard(), h('h3', { text: 'Dependencies' }));
  if (!n.dependencyGroups.length) root.append(h('p', { class: 'dim', text: 'This package has no dependencies.' }));
  for (const g of n.dependencyGroups) {
    const mine = applies !== undefined && applies === g.tfm;
    root.append(h('section', { class: 'dgroup' + (mine ? ' mine' : '') }, h('h4', { text: g.tfm ? g.targetFramework || g.tfm : 'All frameworks' }, mine ? badge('used for ' + S.dir, 'ok') : ''),
      g.dependencies.length ? h('ul', {}, g.dependencies.map((d) => h('li', {}, h('a', { href: format({ id: d.id, version: minVersion(d.range) }), text: d.id }), h('span', { class: 'dim', text: ' ' + (d.range || '') })))) : h('p', { class: 'dim', text: 'No dependencies for this framework.' })));
  }
  return root;
}
function minVersion(range) {
  if (!range) return '';
  const first = range.trim().replace(/^[[(]/, '').replace(/[\])]$/, '').split(',')[0].trim();
  return first;
}

// ---- start -----------------------------------------------------------------------------------------------------------------------------
setupSearch();
mark('uiReady');
// Start downloading the package while the runtime boots: it lands in the Cache API and C# then reads it from there.
(async () => {
  const r = parse(location.hash);
  if (r.id && r.version) nuget.getBytes(nuget.nupkgUrl(r.id, r.version)).catch(() => {});
})();
startRuntime();
navigate();
