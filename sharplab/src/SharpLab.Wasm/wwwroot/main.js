import { dotnet } from './_framework/dotnet.js';
import { encodeShare, decodeShare, DEFAULTS } from './share.js';
import { findPath, nodeAt, selectionOf, label } from './syntaxpath.js';
import { renderJit } from './jit.js';

const $ = (id) => document.getElementById(id);
const metrics = (window.__metrics = { marks: {}, assets: [], compiles: [] });
const t0 = performance.now();
const now = () => Math.round(performance.now() - t0);
const mark = (k) => (metrics.marks[k] = now());
const setStatus = (s) => ($('status').textContent = s);
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

// ---- resilient fetch: 3 tries with backoff for every same-origin GET (also the .NET runtime's own downloads); copied from csharp/ ----
const net = (metrics.net = { started: 0, done: 0, bytes: 0, retries: 0 });
const nativeFetch = window.fetch.bind(window);
const fileName = (u) => decodeURIComponent(String(u?.url ?? u).split('?')[0].split('/').pop() || String(u));
window.fetch = async function (input, init) {
  const method = (init?.method || input?.method || 'GET').toUpperCase();
  if (method !== 'GET' || (!String(input?.url ?? input).startsWith(location.origin) && /^https?:/.test(String(input?.url ?? input)))) return nativeFetch(input, init);
  net.started++;
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const resp = await nativeFetch(input, init);
      if (resp.ok || (resp.status < 500 && resp.status !== 408 && resp.status !== 429)) {
        net.done++; net.bytes += Number(resp.headers.get('content-length') || 0);
        if (!metrics.ready) setStatus('downloading… ' + net.done + '/' + net.started + ' files, ' + (net.bytes / 1048576).toFixed(1) + ' MB');
        return resp;
      }
      lastErr = new Error('HTTP ' + resp.status);
    } catch (e) { lastErr = e; }
    net.retries++;
    setStatus('retrying ' + fileName(input) + ' (' + attempt + '/3)…');
    await new Promise((r) => setTimeout(r, 400 * 3 ** (attempt - 1)));
  }
  const err = new Error('Could not download ' + fileName(input) + ': ' + lastErr.message + ' (after 3 tries). Check your connection and reload.');
  err.fileName = fileName(input);
  throw err;
};

// ---- assets (reference assemblies): Cache API first, then network; copied from csharp/ ----
let refVersion = 'v0';
const taken = new Map();
async function cacheOpen(name) { try { return await caches.open(name); } catch { return null; } }
async function getBytes(url, cacheName, { cacheIt = true } = {}) {
  const key = new URL(url, location.href).href;
  const cache = cacheIt ? await cacheOpen(cacheName) : null;
  const t = performance.now();
  if (cache) {
    const hit = await cache.match(key);
    if (hit) return { bytes: new Uint8Array(await hit.arrayBuffer()), from: 'cache', ms: performance.now() - t };
  }
  const resp = await fetch(key);
  if (resp.status === 404) return { bytes: null, from: 'network', ms: performance.now() - t };
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  const b = new Uint8Array(await resp.arrayBuffer());
  if (cache) { try { await cache.put(key, new Response(b)); } catch (e) { console.warn('cache put failed', e); } }
  return { bytes: b, from: 'network', ms: performance.now() - t };
}
const hostModule = {
  async fetchAsset(path) {
    const volatile = /manifest\.json$/.test(path);
    const r = await getBytes(path, 'sharplab-refs-' + refVersion, { cacheIt: !volatile });
    taken.set(path, r.bytes ?? new Uint8Array(0));
    if (r.bytes && !volatile) metrics.assets.push({ path, bytes: r.bytes.length, from: r.from, ms: Math.round(r.ms) });
  },
  takeAsset(path) { const b = taken.get(path) ?? new Uint8Array(0); taken.delete(path); return b; },
};

// ---- Monaco from the CDN (a plain textarea / <pre> when it is unavailable) ----
const MONACO = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs';
function loadMonaco() {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = MONACO + '/loader.js';
    s.onerror = () => reject(new Error('monaco loader'));
    s.onload = () => {
      window.require.config({ paths: { vs: MONACO } });
      window.require(['vs/editor/editor.main'], () => resolve(window.monaco), reject);
    };
    document.head.appendChild(s);
    setTimeout(() => reject(new Error('monaco timeout')), 8000);
  });
}
let monaco = null;
const FONT = '"Cascadia Code", "Cascadia Mono", ui-monospace, Menlo, Consolas, monospace';

function registerIl(m) {
  m.languages.register({ id: 'cil' });
  m.languages.setMonarchTokensProvider('cil', {
    keywords: ['class', 'valuetype', 'void', 'int8', 'int16', 'int32', 'int64', 'uint8', 'uint16', 'uint32', 'uint64', 'float32', 'float64', 'bool', 'char', 'string', 'object', 'native', 'int', 'unsigned',
      'public', 'private', 'assembly', 'family', 'static', 'instance', 'virtual', 'abstract', 'sealed', 'hidebysig', 'specialname', 'rtspecialname', 'cil', 'managed', 'auto', 'ansi', 'beforefieldinit', 'extends', 'implements', 'newslot', 'final', 'init', 'initonly', 'literal', 'nested', 'interface', 'import', 'serializable', 'sequential', 'explicit'],
    tokenizer: { root: [
      [/\/\/.*$/, 'comment'], [/IL_[0-9A-Fa-f]+:/, 'number'], [/\.[a-z][\w]*/, 'keyword.control'], [/"([^"\\]|\\.)*"/, 'string'],
      [/\[[^\]]+\]/, 'type'], [/\b0x[0-9A-Fa-f]+\b|\b\d+(\.\d+)?\b/, 'number'],
      [/\b(ldarg|ldloc|stloc|starg|ldc|ldfld|stfld|ldsfld|stsfld|ldflda|ldelem|stelem|ldind|stind|call|callvirt|calli|newobj|newarr|ret|br|brtrue|brfalse|beq|bne|bge|bgt|ble|blt|switch|add|sub|mul|div|rem|and|or|xor|shl|shr|neg|not|conv|box|unbox|castclass|isinst|ldstr|ldnull|ldtoken|ldftn|ldlen|dup|pop|nop|throw|leave|endfinally|ceq|cgt|clt|initobj|constrained|ldobj|stobj|sizeof|localloc)[\w.]*\b/, 'keyword'],
      [/[a-z_][\w]*/, { cases: { '@keywords': 'type', '@default': 'identifier' } }],
    ] },
  });
}

async function createEditor(host) {
  try {
    monaco = await loadMonaco();
    registerIl(monaco);
    monaco.editor.defineTheme('sl', { base: 'vs-dark', inherit: true, rules: [], colors: { 'editor.background': '#1e1f22' } });
    const ed = monaco.editor.create(host, { value: '', language: 'csharp', theme: 'sl', minimap: { enabled: false }, automaticLayout: true, fontSize: 13, fontFamily: FONT,
      scrollBeyondLastLine: false, fixedOverflowWidgets: true, tabSize: 4, insertSpaces: true, quickSuggestions: false, suggestOnTriggerCharacters: false, padding: { top: 8 } });
    ed.getModel().setEOL(monaco.editor.EndOfLineSequence.LF);
    const model = ed.getModel();
    metrics.editor = 'monaco';
    return {
      get: () => model.getValue(), set: (v) => model.setValue(v), focus: () => ed.focus(),
      onChange: (cb) => model.onDidChangeContent(cb),
      onCursor: (cb) => ed.onDidChangeCursorSelection(cb),
      getSel: () => { const s = ed.getSelection(); const a = model.getOffsetAt(s.getStartPosition()), b = model.getOffsetAt(s.getEndPosition()); return { start: a, end: b }; },
      setSel: (a, b) => { const p = model.getPositionAt(a), q = model.getPositionAt(b); const r = new monaco.Range(p.lineNumber, p.column, q.lineNumber, q.column); ed.setSelection(r); ed.revealRangeInCenterIfOutsideViewport(r); },
      markers: (diags) => monaco.editor.setModelMarkers(model, 'roslyn', diags.map((d) => ({
        severity: d.severity === 'error' ? monaco.MarkerSeverity.Error : d.severity === 'warning' ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Info,
        message: d.id + ': ' + d.message, code: d.id, startLineNumber: d.startLine, startColumn: d.startColumn, endLineNumber: d.endLine, endColumn: Math.max(d.endColumn, d.startColumn + 1) }))),
      kind: 'monaco',
    };
  } catch (e) {
    console.warn('Monaco unavailable, using a textarea:', e.message);
    const ta = document.createElement('textarea');
    ta.className = 'fallback'; ta.id = 'fallback'; ta.spellcheck = false; host.appendChild(ta);
    metrics.editor = 'textarea';
    return {
      get: () => ta.value.replace(/\r\n/g, '\n'), set: (v) => (ta.value = v), focus: () => ta.focus(),
      onChange: (cb) => ta.addEventListener('input', cb), onCursor: (cb) => ta.addEventListener('select', cb),
      getSel: () => ({ start: ta.selectionStart, end: ta.selectionEnd }), setSel: (a, b) => { ta.focus(); ta.setSelectionRange(a, b); },
      markers() {}, kind: 'textarea',
    };
  }
}

// a read-only text view (IL, decompiled C#): a Monaco editor when available, else a <pre>
function createOut(host, language) {
  if (monaco) {
    const ed = monaco.editor.create(host, { value: '', language, theme: 'sl', readOnly: true, domReadOnly: true, minimap: { enabled: false }, automaticLayout: true, fontSize: 12.5, fontFamily: FONT,
      scrollBeyondLastLine: false, renderLineHighlight: 'none', padding: { top: 8 }, fixedOverflowWidgets: true });
    return { set: (t) => { ed.setValue(t); ed.setScrollTop(0); }, get: () => ed.getValue() };
  }
  const pre = document.createElement('pre'); host.appendChild(pre);
  return { set: (t) => (pre.textContent = t), get: () => pre.textContent };
}

// ---- Syntax tree: lazily-built expandable tree linked to the editor selection ----
const tree = { root: null, rootLi: null, sel: null, quiet: false };
function buildTree(host, root, onPick) {
  host.textContent = '';
  const ul = document.createElement('ul'); host.appendChild(ul);
  function make(node, parentUl) {
    const li = document.createElement('li'); li._node = node; li._kids = null;
    const row = document.createElement('div'); row.className = 'row ' + node.t + (node.err ? ' err' : ''); row.dataset.kind = node.k;
    const tg = document.createElement('span'); tg.className = 'tg'; tg.textContent = node.c?.length ? '▸' : '';
    const k = document.createElement('span'); k.className = 'k'; k.textContent = node.k + (node.l ? ' (' + node.l + ')' : '') + (node.missing ? ' (missing)' : '');
    row.append(tg, k);
    if (node.t !== 'node' && node.v !== undefined && node.v !== '') { const v = document.createElement('span'); v.className = 'v'; const t = node.v.length > 60 ? node.v.slice(0, 60) + '…' : node.v; v.textContent = JSON.stringify(t); row.appendChild(v); }
    const rg = document.createElement('span'); rg.className = 'rg'; rg.textContent = '[' + node.s + '..' + node.e + ')'; row.appendChild(rg);
    li.appendChild(row); parentUl.appendChild(li);
    li._row = row; li._tg = tg;
    li._open = () => {
      if (!node.c?.length) return;
      if (!li._kids) {
        const cul = document.createElement('ul'); li.appendChild(cul); li._ul = cul;
        li._kids = node.c.map((c) => make(c, cul));
      }
      li._ul.hidden = false; tg.textContent = '▾';
    };
    li._close = () => { if (li._ul) li._ul.hidden = true; if (node.c?.length) tg.textContent = '▸'; };
    tg.onclick = (ev) => { ev.stopPropagation(); (li._kids && !li._ul.hidden) ? li._close() : li._open(); };
    row.onclick = () => { select(li); onPick(node); };
    row.ondblclick = () => (li._kids && !li._ul.hidden ? li._close() : li._open());
    return li;
  }
  const rootLi = make(root, ul); rootLi._open();
  tree.root = root; tree.rootLi = rootLi; tree.sel = null;
}
function select(li) {
  tree.sel?._row.classList.remove('sel');
  tree.sel = li; li._row.classList.add('sel');
  li._row.scrollIntoView({ block: 'nearest' });
}
function revealForSelection(sel) {
  if (!tree.root) return;
  const path = findPath(tree.root, sel.start, sel.end);
  let li = tree.rootLi;
  for (const i of path) { li._open(); li = li._kids[i]; }
  select(li);
  return label(li._node);
}

// ---- state, options, views ----
const state = { ...DEFAULTS };
const settingsJson = () => JSON.stringify({ configuration: state.configuration, optimize: state.optimize, langVersion: state.langVersion, level: state.level });
const SAMPLE = `using System;
using System.Linq;

public class Greeter
{
    public static void Main()
    {
        var numbers = new[] { 1, 2, 3, 4, 5 };
        int limit = 2;
        var big = numbers.Where(n => n > limit).Select(n => n * n);
        Console.WriteLine(string.Join(", ", big));
    }
}
`;

async function main() {
  const shared = await decodeShare(location.hash);
  Object.assign(state, shared ?? { code: SAMPLE });
  metrics.fromShareLink = !!shared;
  let X = null, ed = null, compileId = 0, rendered = {}, last = null;
  const outs = {};

  // options bar
  const langSel = $('lang');
  for (const v of ['7.3', '8', '9', '10', '11', '12', '13', '14', 'preview', 'latest']) langSel.add(new Option(v === 'latest' ? 'latest' : v, v));
  const syncOptions = () => { $('cfg').value = state.configuration; $('opt').checked = state.optimize; langSel.value = state.langVersion; $('level').value = String(state.level); };
  syncOptions();
  const showTab = (t) => {
    state.tab = t;
    for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('on', b.dataset.tab === t);
    for (const p of document.querySelectorAll('.pane')) p.classList.toggle('on', p.id === 'pane-' + t);
    $('levelwrap').hidden = t !== 'cs';
  };
  showTab(state.tab);

  setStatus('loading editor…');
  ed = await createEditor($('editor'));
  ed.set(state.code);
  mark('editorReady');
  outs.il = createOut($('out-il'), monaco ? 'cil' : 'plaintext');
  outs.cs = createOut($('out-cs'), 'csharp');

  function showProblems(diags) {
    const box = $('problems'); box.textContent = '';
    if (!diags.length) { const d = document.createElement('div'); d.className = 'ok'; d.textContent = 'No diagnostics'; box.appendChild(d); return; }
    for (const d of diags) {
      const row = document.createElement('div'); row.className = d.severity; row.textContent = d.id + ' (' + d.startLine + ',' + d.startColumn + '): ' + d.message;
      row.onclick = () => { ed.setSel(d.start, d.end); ed.focus(); }; box.appendChild(row);
    }
  }

  async function renderActive() {
    const tab = state.tab, key = compileId + ':' + state.level;
    if (!X) return;
    if (rendered[tab] === key && tab !== 'syntax') return;
    const t = performance.now();
    if (tab === 'syntax') {
      const root = JSON.parse(X.Syntax(state.code, settingsJson()));
      buildTree($('tree'), root, (n) => { const s = selectionOf(n); tree.quiet = true; ed.setSel(s.start, s.end); setTimeout(() => (tree.quiet = false), 50); });
      revealForSelection(ed.getSel());
    } else if (tab === 'il') outs.il.set(X.Il());
    else if (tab === 'cs') { try { outs.cs.set(X.Decompile(state.level)); } catch (e) { outs.cs.set('// the decompiler failed: ' + e); } }
    else if (tab === 'verify') {
      const v = JSON.parse(X.Verify()); const box = $('verifyout'); box.textContent = '';
      const head = document.createElement('div'); head.className = v.ok ? 'ok' : 'bad';
      head.textContent = (v.available ? (v.ok ? '✔ ' : '✘ ') : '⚠ ') + v.note + (v.available ? '  (' + Math.round(v.milliseconds) + ' ms, ILVerify)' : '');
      box.appendChild(head);
      for (const e of v.errors) { const d = document.createElement('div'); d.className = 'bad'; d.textContent = '  ' + e; box.appendChild(d); }
    } else if (tab === 'run') { $('runbtn').disabled = !last?.success; $('runinfo').textContent = last?.success ? (last.isExe ? 'Compiled ' + last.size + ' bytes. Press Run.' : 'A library: nothing to run.') : 'Fix the errors first.'; }
    else if (tab === 'jit') renderJit($('jit'), { getAssemblyBase64: () => X.AssemblyBase64(), compiled: () => last, settings: () => ({ ...state }) });
    rendered[tab] = key;
    (metrics.views ||= {})[tab] = Math.round(performance.now() - t);
  }

  let timer = null;
  async function refresh() {
    if (!X) return;
    state.code = ed.get();
    const id = ++compileId, t = performance.now();
    setStatus('compiling…');
    await nextFrame();
    const res = JSON.parse(await X.Compile(state.code, settingsJson()));
    if (id !== compileId) return;
    last = res;
    const ms = Math.round(performance.now() - t);
    metrics.compiles.push({ ms, coreMs: Math.round(res.ms), bytes: res.size });
    ed.markers(res.diagnostics); showProblems(res.diagnostics);
    rendered = {};
    await renderActive();
    if (!metrics.marks.firstView) { mark('firstView'); metrics.wireBytesAtFirstView = performance.getEntriesByType('resource').filter((r) => r.name.startsWith(location.origin)).reduce((s, r) => s + (r.encodedBodySize || 0), 0); }
    setStatus(res.success ? 'compiled in ' + ms + ' ms' : res.diagnostics.filter((d) => d.severity === 'error').length + ' error(s)');
    syncUrlSoon();
  }
  let urlTimer = null;
  function syncUrlSoon() { clearTimeout(urlTimer); urlTimer = setTimeout(async () => { try { history.replaceState(null, '', '#' + await encodeShare(state)); } catch {} }, 600); }
  const refreshSoon = () => { clearTimeout(timer); timer = setTimeout(refresh, 350); };
  ed.onChange(refreshSoon);
  ed.onCursor(() => { if (state.tab === 'syntax' && !tree.quiet) revealForSelection(ed.getSel()); });

  // controls
  $('cfg').onchange = (e) => { state.configuration = e.target.value; state.optimize = state.configuration === 'release'; syncOptions(); refresh(); };
  $('opt').onchange = (e) => { state.optimize = e.target.checked; refresh(); };
  langSel.onchange = (e) => { state.langVersion = e.target.value; refresh(); };
  $('level').onchange = (e) => { state.level = Number(e.target.value); rendered = {}; renderActive(); syncUrlSoon(); };
  for (const b of document.querySelectorAll('#tabs button')) b.onclick = () => { showTab(b.dataset.tab); renderActive(); syncUrlSoon(); };
  $('runbtn').onclick = async () => {
    if (!X || !last?.success) return;
    $('runbtn').disabled = true; $('runinfo').textContent = 'running…'; await nextFrame();
    const r = JSON.parse(await X.Run());
    const out = $('runout'); out.textContent = '';
    const o = document.createElement('span'); o.textContent = r.output; out.appendChild(o);
    if (r.error) { const e = document.createElement('div'); e.className = 'err'; e.textContent = r.error; out.appendChild(e); }
    const m = document.createElement('div'); m.className = 'meta'; m.textContent = '— ' + (r.success ? 'finished' : 'failed') + (r.exitCode != null ? ', exit code ' + r.exitCode : '') + ' in ' + Math.round(r.milliseconds) + ' ms'; out.appendChild(m);
    $('runinfo').textContent = ''; $('runbtn').disabled = false; metrics.lastRun = r;
  };
  $('share').onclick = async () => {
    state.code = ed.get();
    const frag = await encodeShare(state); history.replaceState(null, '', '#' + frag);
    const url = location.href;
    try { await navigator.clipboard.writeText(url); } catch { /* clipboard may be blocked: the URL bar has it */ }
    window.__lastShare = url;
    const t = Object.assign(document.createElement('div'), { className: 'toast', textContent: 'Link copied (' + url.length + ' characters)' }); document.body.appendChild(t); setTimeout(() => t.remove(), 2200);
  };
  window.__sharplab = { state, refresh, showTab: (t) => { showTab(t); return renderActive(); }, setCode: (c) => { ed.set(c); return refresh(); }, tree, revealForSelection, ed, get last() { return last; }, getRun: () => $('runbtn').click(), decode: decodeShare };

  // runtime + references
  setStatus('downloading .NET runtime…');
  const { getAssemblyExports, getConfig, setModuleImports } = await dotnet.withDiagnosticTracing(false).create();
  setModuleImports('host', hostModule);
  mark('runtimeCreated');
  X = (await getAssemblyExports(getConfig().mainAssemblyName)).Interop;
  mark('exportsReady');
  setStatus('loading reference assemblies…');
  const mf = await (await fetch('ref/manifest.json')).text();
  refVersion = JSON.parse(mf).version;
  for (const k of await caches.keys()) if (k.startsWith('sharplab-refs-') && k !== 'sharplab-refs-' + refVersion) await caches.delete(k);
  const core = await getBytes('ref/core.bin', 'sharplab-refs-' + refVersion);
  metrics.coreBundle = { bytes: core.bytes.length, from: core.from, ms: Math.round(core.ms) };
  if (!X.AddReferenceBundle(core.bytes)) throw new Error('reference bundle contained no usable assemblies');
  X.Configure(mf);
  mark('refsReady');
  metrics.ready = true;
  await refresh();
  mark('firstCompileDone');
  $('runbtn').disabled = !last?.success;
  ed.focus();
}
main().catch((e) => { console.error(e); setStatus('error: ' + e.message); metrics.error = String(e);
  const d = document.createElement('div'); d.className = 'problems'; d.textContent = e.message; document.body.appendChild(d); });
