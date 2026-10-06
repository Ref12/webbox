import { dotnet } from './_framework/dotnet.js';
import { History } from './history.js';
import { toHtml } from './classify.js';
import { registerIntellisense } from './intellisense.js';
import { brotliDecode } from './br.js';
import { parseCommand, directiveSpans, handleCommand } from './commands.js';
import { addCopyButton } from './copy.js';

// BUILD and the two manifest URLs are rewritten by tools/stage.mjs (content hashes) when the site is staged for GitHub Pages.
const BUILD = 'dev';
const MANIFESTS = { ref: 'ref/manifest.json', lazy: 'lazy/manifest.json' };
const hashes = (window.__hashes = {});   // site path -> content hash (from the manifests): the ?h= query makes a changed file a new URL, so GitHub Pages' 10 minute cache never serves a stale one
const noBr = new URLSearchParams(location.search).has('nobr');   // measuring: skip the .br files and fetch the plain ones
const withHash = (p) => (hashes[p] ? p + '?h=' + hashes[p] : p);
const $ = (id) => document.getElementById(id);
const metrics = (window.__metrics = { marks: {}, completion: [], assets: [] });
const t0 = performance.now();
const now = () => Math.round(performance.now() - t0);
const mark = (k) => (metrics.marks[k] = now());
const setStatus = (s) => ($('status').textContent = s);
const setBadge = (text, cls) => { const b = $('intelli'); b.textContent = text; b.className = 'badge ' + (cls || ''); };

// ---- resilient fetch: 3 tries with backoff for every same-origin GET (also the .NET runtime's own downloads) ----
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
        net.done++; net.bytes += Number(resp.headers.get('content-length') || 0); showProgress();
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
function showProgress() {
  if (metrics.ready) return;
  setStatus('downloading… ' + net.done + '/' + net.started + ' files, ' + (net.bytes / 1048576).toFixed(1) + ' MB');
}

// ---- assets (reference assemblies, NuGet packages, lazy IntelliSense assemblies): Cache API first, then network ----
let refVersion = 'v0';
const taken = new Map();
const assetLog = (window.__assetLog = []);
async function cacheOpen(name) { try { return await caches.open(name); } catch { return null; } }
// Binary assets are shipped as <file>.br and decoded here (see br.js); the plain file is the fallback (and what ?nobr=1 uses).
const PACKED = /\.(wasm|dll|bin|pdb)(\?|$)/;
async function fetchPacked(key) {
  if (!noBr && PACKED.test(key)) {
    try {
      const u = new URL(key); u.pathname += '.br';
      const resp = await fetch(u.href);
      if (resp.ok) {
        const packed = new Uint8Array(await resp.arrayBuffer());
        const bytes = await brotliDecode(packed);
        return { bytes, wire: packed.length, status: 200 };
      }
    } catch (e) { console.warn('brotli path failed for ' + fileName(key) + ', using the plain file:', e.message); }
  }
  const resp = await fetch(key);
  if (!resp.ok) return { bytes: null, status: resp.status };
  const bytes = new Uint8Array(await resp.arrayBuffer());
  return { bytes, wire: Number(resp.headers.get('content-length') || 0) || bytes.length, status: 200 };
}
async function getBytes(url, cacheName, { cacheIt = true } = {}) {
  const key = new URL(withHash(url), location.href).href;
  const cache = cacheIt ? await cacheOpen(cacheName) : null;
  const t = performance.now();
  if (cache) {
    const hit = await cache.match(key);
    if (hit) { const b = new Uint8Array(await hit.arrayBuffer()); return { bytes: b, from: 'cache', ms: performance.now() - t }; }
  }
  let last;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const got = await fetchPacked(key);   // same-origin goes through the retrying wrapper above
      if (got.status === 404) return { bytes: null, from: 'network', ms: performance.now() - t };
      if (!got.bytes) throw new Error('HTTP ' + got.status);
      if (cache) { try { await cache.put(key, new Response(got.bytes)); } catch (e) { console.warn('cache put failed', e); } }
      return { bytes: got.bytes, from: 'network', ms: performance.now() - t, wire: got.wire };
    } catch (e) { last = e; await new Promise((r) => setTimeout(r, 400 * 3 ** (attempt - 1))); }
  }
  throw new Error('Could not download ' + fileName(url) + ': ' + last.message);
}
function registerHashes(kind, m) {
  if (kind === 'ref') {
    if (m.coreHash) hashes['ref/core.bin'] = m.coreHash;
    if (m.typesHash) hashes['ref/types.json'] = m.typesHash;
    for (const a of m.assemblies || []) if (a.h) hashes['ref/a/' + a.name] = a.h;
  } else for (const x of m.files || []) if (x.h) hashes['lazy/' + x.name] = x.h;
}
// The .NET runtime's own downloads (assemblies, dotnet.native.wasm): from the Cache API, else <file>.br decoded here, else the plain file.
const fwCacheName = 'csrepl-fw-' + BUILD;
function loadBootResource(type, name, defaultUri) {
  if (noBr || !/\.wasm$/.test(name)) return undefined;   // scripts and everything else: the runtime's default (Pages gzips those)
  return (async () => {
    const key = new URL(defaultUri, location.href).href;
    const cache = await cacheOpen(fwCacheName);
    let bytes;
    const hit = cache && (await cache.match(key));
    if (hit) bytes = new Uint8Array(await hit.arrayBuffer());
    else {
      const got = await fetchPacked(key);
      if (!got.bytes) throw new Error('Could not download ' + name + ': HTTP ' + got.status + ' (after 3 tries). Check your connection and reload.');
      bytes = got.bytes;
      if (cache) cache.put(key, new Response(bytes)).catch((e) => console.warn('cache put failed', e));
    }
    return new Response(bytes, { headers: { 'content-type': 'application/wasm' } });
  })();
}
// JS side of Interop.FetchAsset / TakeAsset
const hostModule = {
  async fetchAsset(path) {
    const external = /^https?:/.test(path);
    const isNuget = external;
    const volatile = /index\.json$|manifest\.json$/.test(path);
    const r = await getBytes(path, isNuget ? 'csrepl-nuget-v1' : 'csrepl-refs-' + refVersion, { cacheIt: !volatile });
    taken.set(path, r.bytes ?? new Uint8Array(0));
    if (r.bytes && !volatile) { const e = { path, bytes: r.bytes.length, from: r.from, ms: Math.round(r.ms) }; assetLog.push(e); metrics.assets.push(e); }
  },
  takeAsset(path) { const b = taken.get(path) ?? new Uint8Array(0); taken.delete(path); return b; },
};

// ---- editor: Monaco from CDN, plain textarea when it is unavailable ----
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
const VS_DARK = {
  keyword: '569cd6', keywordControl: 'd8a0df', class: '4ec9b0', struct: '4ec9b0', delegate: '4ec9b0', typeParam: '4ec9b0', interface: 'b8d7a3', enum: 'b8d7a3',
  method: 'dcdcdc', property: 'dcdcdc', field: 'dcdcdc', local: 'dcdcdc', event: 'dcdcdc', namespace: 'dcdcdc', constant: 'dcdcdc', enumMember: 'dcdcdc', label: 'dcdcdc',
  parameter: '9cdcfe', string: 'd69d85', regex: 'd69d85', stringEscape: 'ffd68f', number: 'b5cea8', comment: '57a64a', xmlDoc: '608b4e', operator: 'b4b4b4', punct: 'dcdcdc', preproc: '9b9b9b',
};

let editor;   // { get(), set(v), focus(), model?, refresh() }
let monacoRef = null, intelli = null;
async function createEditor(host, onSubmit, history) {
  const histPrev = () => { const v = history.prev(editor.get()); if (v !== null) editor.set(v); };
  const histNext = () => { const v = history.next(); if (v !== null) editor.set(v); };
  try {
    const monaco = monacoRef = await loadMonaco();
    monaco.editor.defineTheme('vs-cs', { base: 'vs-dark', inherit: true,
      rules: [...Object.entries(VS_DARK).map(([token, c]) => ({ token, foreground: c })),
        ...['delimiter', 'delimiter.bracket', 'delimiter.parenthesis', 'delimiter.square', 'delimiter.curly', 'delimiter.angle'].map((token) => ({ token, foreground: 'dcdcdc' }))],
      colors: { 'editorBracketHighlight.foreground1': '#dcdcdc', 'editorBracketHighlight.foreground2': '#dcdcdc', 'editorBracketHighlight.foreground3': '#dcdcdc', 'editorBracketHighlight.foreground4': '#dcdcdc', 'editorBracketHighlight.foreground5': '#dcdcdc', 'editorBracketHighlight.foreground6': '#dcdcdc', 'editor.background': '#2a2d33', 'editorGutter.background': '#2a2d33', 'editor.lineHighlightBackground': '#2a2d33',
        'editorSuggestWidget.background': '#252526', 'editorSuggestWidget.selectedBackground': '#04395e' } });
    const ed = monaco.editor.create(host, {
      value: '', language: 'csharp', theme: 'vs-cs', minimap: { enabled: false }, automaticLayout: true, lineNumbers: 'off',
      glyphMargin: false, folding: false, lineDecorationsWidth: 8, renderLineHighlight: 'none', overviewRulerLanes: 0, scrollBeyondLastLine: false,
      fontSize: 13, fontFamily: '"Cascadia Code", "Cascadia Mono", ui-monospace, Menlo, Consolas, monospace', padding: { top: 8, bottom: 8 },
      'semanticHighlighting.enabled': true, bracketPairColorization: { enabled: false }, matchBrackets: 'never', quickSuggestions: { other: true, comments: false, strings: true }, fixedOverflowWidgets: true,
      suggestOnTriggerCharacters: true, acceptSuggestionOnEnter: 'on', parameterHints: { enabled: true }, scrollbar: { alwaysConsumeMouseWheel: false },
    });
    // Enter = run (when the code is complete); Shift+Enter = newline (default). Plain Up/Down keep moving the cursor.
    ed.addCommand(monaco.KeyCode.Enter, () => onSubmit(), 'editorTextFocus && !suggestWidgetVisible && !parameterHintsVisible');
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => onSubmit(true));
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.UpArrow, histPrev);
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.DownArrow, histNext);
    // the input box grows with its content (up to ~10 lines), so it stays usable on a phone
    const fit = () => { const h = Math.min(Math.max(ed.getContentHeight(), 56), 240); host.style.height = h + 'px'; ed.layout(); };
    ed.onDidContentSizeChange(fit); fit();
    metrics.editor = 'monaco';
    editor = {
      get: () => ed.getValue(), focus: () => ed.focus(), model: ed.getModel(),
      set: (v) => { ed.setValue(v); ed.setPosition(ed.getModel().getFullModelRange().getEndPosition()); },
      refresh: () => intelli?.refresh(ed.getModel()),
    };
    return editor;
  } catch (e) {
    console.warn('Monaco unavailable, using textarea:', e.message);
    const ta = document.createElement('textarea');
    ta.className = 'fallback'; ta.id = 'fallback'; ta.spellcheck = false;
    host.appendChild(ta);
    ta.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); onSubmit(ev.ctrlKey || ev.metaKey); }
      else if (ev.key === 'ArrowUp' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); histPrev(); }
      else if (ev.key === 'ArrowDown' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); histNext(); }
    });
    metrics.editor = 'textarea';
    editor = { get: () => ta.value, set: (v) => (ta.value = v), focus: () => ta.focus(), refresh() {} };
    return editor;
  }
}

// ---- transcript ----
const entries = [];   // { code, codeEl, committed: index|null, coloured: bool }
function addEntry(code, spans) {
  const div = document.createElement('div'); div.className = 'entry';
  const box = document.createElement('div'); box.className = 'code';
  const pre = document.createElement('pre'); const codeEl = document.createElement('code'); codeEl.textContent = code; pre.appendChild(codeEl);
  box.appendChild(pre);
  addCopyButton(box, code, { title: 'Copy code', onCopied: (v) => (window.__lastCopied = v) });
  div.appendChild(box);
  $('transcript').appendChild(div);
  const e = { code, codeEl, div, committed: null, coloured: false };
  if (spans) { codeEl.innerHTML = toHtml(code, spans); e.coloured = true; e.command = true; }   // REPL command: coloured as a directive, never sent to Roslyn
  entries.push(e);
  return e;
}
// Output, return value and error blocks (cls has 'block') carry the same copy icon as the code blocks; it copies the block's plain text.
function addBlock(div, cls, text) {
  const d = document.createElement('div'); d.className = cls; d.textContent = text; div.appendChild(d);
  if (/\bblock\b/.test(cls)) addCopyButton(d, text, { title: 'Copy ' + (/\berr\b/.test(cls) ? 'error' : /\bval\b/.test(cls) ? 'value' : 'output'), onCopied: (v) => (window.__lastCopied = v) });
  return d;
}
let assemblyNames = [];   // framework assemblies for #r "..." completion (from ref/manifest.json)

async function main() {
  const history = new History();
  let exportsRef = null, busy = false, intelliReady = false, committedCount = 0;
  const call = async (op, text, pos, extra) => JSON.parse(await exportsRef.Interop.Intelli(op, text, pos ?? 0, extra ?? ''));
  window.__intelli = (op, text, pos, extra) => call(op, text, pos, extra);

  async function colour(e) {
    if (!intelliReady || e.coloured || e.command) return;
    try {
      const spans = e.committed !== null ? await call('ClassifyCommitted', '', e.committed) : await call('Classify', e.code, 0);
      if (spans) { e.codeEl.innerHTML = toHtml(e.code, [...spans, ...directiveSpans(e.code)]); e.coloured = true; }
    } catch (err) { console.warn('classify failed', err); }
  }

  // Runs C# (compile + run) and shows the result under its own transcript entry.
  async function execute(code) {
    const entry = addEntry(code);
    // colour the submission in the context it will run in (before it joins the session chain)
    if (intelliReady) await colour(entry);
    else {
      const dir = directiveSpans(code);
      if (monacoRef) monacoRef.editor.colorize(code, 'csharp', { tabSize: 4 }).then((h) => { if (!entry.coloured) entry.codeEl.innerHTML = h; });
      if (dir.length && !monacoRef) entry.codeEl.innerHTML = toHtml(code, dir);
    }
    setStatus('running…');
    await new Promise((r) => setTimeout(r, 0)); // let the UI paint before the (synchronous, single-threaded) compile
    const logStart = assetLog.length;
    const t = performance.now();
    const res = JSON.parse(await exportsRef.Interop.Submit(code));
    const total = performance.now() - t;
    if (res.success) { entry.committed = committedCount++; }
    (metrics.runs ||= []).push({ code: code.length > 60 ? code.slice(0, 60) + '…' : code, ms: Math.round(total), coreMs: Math.round(res.milliseconds) });
    for (const a of assetLog.slice(logStart)) addBlock(entry.div, 'load', '↓ ' + fileName(a.path) + ' · ' + (a.bytes / 1024).toFixed(0) + ' KB · ' + a.from + ' · ' + a.ms + ' ms');
    for (const l of res.loaded || []) if (l.startsWith('nuget')) addBlock(entry.div, 'load', '📦 ' + l);
    if (res.output) addBlock(entry.div, 'block out', res.output.replace(/\n$/, ''));
    if (!res.success) {
      for (const d of res.diagnostics || []) addBlock(entry.div, 'block err', d);
      if (res.error) addBlock(entry.div, 'block err', res.error);
    } else if (res.value != null) addBlock(entry.div, 'block val', res.value);
    addBlock(entry.div, 'ms', Math.round(total) + ' ms');
    $('transcript').scrollTop = $('transcript').scrollHeight;
    return entry;
  }

  function resetSession() {
    exportsRef.Interop.Reset(); committedCount = 0; history.reset(); entries.forEach((e) => (e.committed = null));
    $('transcript').appendChild(Object.assign(document.createElement('div'), { className: 'note', textContent: '— session reset —' }));
  }

  // #help, #clear / clear, #reset, #load "url": handled here, never compiled
  async function runCommand(code, cmd) {
    let entry = null;
    const own = () => (entry ||= addEntry(code, cmd.spans));
    await handleCommand(cmd, {
      print: (text) => addBlock(own().div, 'block out', text),
      error: (text) => addBlock(own().div, 'block err', text),
      clearTranscript: () => {
        $('transcript').replaceChildren();
        $('transcript').appendChild(Object.assign(document.createElement('div'), { className: 'note', textContent: 'transcript cleared · variables, usings and references are kept · #reset forgets them too' }));
      },
      resetSession: () => { own(); resetSession(); },
      loadScript: async (url) => {
        const e = own();
        setStatus('loading ' + url + '…');
        let text;
        try {
          const resp = await fetch(url);
          if (!resp.ok) throw new Error('HTTP ' + resp.status);
          text = await resp.text();
          if (text.length > 1048576) throw new Error('the script is larger than 1 MB');
        } catch (err) { addBlock(e.div, 'block err', '#load "' + url + '": ' + err.message + (/Failed to fetch|NetworkError|Load failed/.test(err.message) ? ' (the server must allow cross-origin requests, e.g. raw.githubusercontent.com does)' : '')); return; }
        addBlock(e.div, 'load', '↓ ' + url + ' · ' + (text.length / 1024).toFixed(1) + ' KB');
        await execute(text);
      },
    });
    $('transcript').scrollTop = $('transcript').scrollHeight;
  }

  async function submit(force) {
    const code = editor.get();
    if (!exportsRef || busy || !code.trim()) return;
    const cmd = parseCommand(code);
    if (!cmd && !force && !exportsRef.Interop.IsComplete(code)) { editor.set(code + '\n'); return; } // incomplete: behave like a newline
    busy = true; $('run').disabled = true;
    history.add(code);
    editor.set('');
    try { if (cmd) await runCommand(code, cmd); else await execute(code); }
    finally { setStatus('ready'); busy = false; $('run').disabled = false; editor.focus(); }
  }
  window.__submit = async (code) => { editor.set(code); await submit(true); };

  editor = await createEditor($('editor'), submit, history);
  mark('editorReady');
  if (monacoRef) {
    intelli = registerIntellisense(monacoRef, {
      call, ready: () => intelliReady, assemblies: () => assemblyNames,
      onStats: (name, ms) => { if (name === 'completion') metrics.completion.push(Math.round(ms)); (metrics.latency ||= {})[name] = Math.round(ms); },
    });
    intelli.attach(editor.model);
  }
  $('run').onclick = () => submit(true); // explicit Run (touch): always run

  setStatus('downloading .NET runtime…');
  const { getAssemblyExports, getConfig, setModuleImports } = await dotnet.withDiagnosticTracing(false).withResourceLoader(loadBootResource).create();
  for (const k of await caches.keys()) if (k.startsWith('csrepl-fw-') && k !== fwCacheName) await caches.delete(k);
  setModuleImports('host', hostModule);
  mark('runtimeCreated');
  exportsRef = await getAssemblyExports(getConfig().mainAssemblyName);
  mark('exportsReady');
  $('reset').onclick = () => resetSession();

  // reference assemblies: manifest (small) + the core bundle (one request); everything else on demand
  setStatus('loading reference assemblies…');
  const mf = await (await fetch(MANIFESTS.ref)).text();
  refVersion = JSON.parse(mf).version;
  registerHashes('ref', JSON.parse(mf));
  assemblyNames = JSON.parse(mf).assemblies.map((a) => a.name.replace(/\.dll$/i, ''));
  for (const k of await caches.keys()) if (k.startsWith('csrepl-refs-') && k !== 'csrepl-refs-' + refVersion) await caches.delete(k);
  const core = await getBytes('ref/core.bin', 'csrepl-refs-' + refVersion);
  metrics.coreBundle = { bytes: core.bytes.length, from: core.from, ms: Math.round(core.ms) };
  const n = exportsRef.Interop.AddReferenceBundle(core.bytes);
  if (!n) throw new Error('reference bundle contained no usable assemblies');
  exportsRef.Interop.Configure(mf);
  mark('refsReady');

  setStatus('warming up compiler…');
  const tw = performance.now();
  const warm = JSON.parse(await exportsRef.Interop.Submit('1'));
  metrics.firstResultMs = Math.round(performance.now() - tw);
  exportsRef.Interop.Reset();
  mark('firstResult');
  if (!warm.success) console.error('warm-up failed', warm);
  metrics.ready = true;
  metrics.wireBytesAtFirstResult = performance.getEntriesByType('resource').filter((r) => r.name.startsWith(location.origin)).reduce((s, r) => s + (r.encodedBodySize || 0), 0);
  setStatus('ready');
  $('run').disabled = false; $('reset').disabled = false;
  editor.focus();

  // ---- after the first paint: Microsoft.CodeAnalysis.Features & co. (IntelliSense) ----
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  try { await loadIntellisense(); } catch (e) { console.error(e); setBadge('IntelliSense: failed', ''); metrics.intellisenseError = String(e); }

  async function loadIntellisense() {
    setBadge('IntelliSense: loading…', 'loading');
    const tl = performance.now();
    const man = await (await fetch(MANIFESTS.lazy)).json();
    registerHashes('lazy', man);
    const cacheName = 'csrepl-lazy-' + man.version;
    for (const k of await caches.keys()) if (k.startsWith('csrepl-lazy-') && k !== cacheName) await caches.delete(k);
    const total = man.files.reduce((s, f) => s + f.size, 0); let got = 0, fromCache = 0, wire = 0, doneN = 0;
    const queue = [...man.files];
    const worker = async () => {
      for (let f; (f = queue.shift());) {
        const r = await getBytes('lazy/' + f.name, cacheName);
        if (!r.bytes) throw new Error('missing lazy/' + f.name);
        got += r.bytes.length; doneN++; if (r.from === 'cache') fromCache++; else wire += r.wire || f.br;
        exportsRef.Interop.AddLazyAssembly(f.name, r.bytes);
        setBadge('IntelliSense: ' + (got / 1048576).toFixed(1) + '/' + (total / 1048576).toFixed(1) + ' MB', 'loading');
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    metrics.lazy = { files: man.files.length, rawBytes: total, wireBytesBr: wire, fromCache, downloadMs: Math.round(performance.now() - tl) };
    setBadge('IntelliSense: starting…', 'loading');
    await new Promise((r) => setTimeout(r, 30));
    const ts = performance.now();
    exportsRef.Interop.StartIntellisense(man.entry);
    metrics.lazy.startMs = Math.round(performance.now() - ts);
    intelliReady = true;
    // warm-up (JIT-cold Roslyn Features): first completion is slow, later ones are not; measure both
    const tc = performance.now();
    await call('Complete', 'Console.Wri', 11, '');
    metrics.firstCompletionMs = Math.round(performance.now() - tc);
    mark('intellisenseReady');
    setBadge('IntelliSense: ready', 'ready');
    editor.refresh();
    for (const e of entries) await colour(e);   // history entries typed before IntelliSense was ready
  }
}
main().catch((e) => { console.error(e); setStatus('error: ' + e.message);
  const d = document.createElement('div'); d.className = 'entry'; d.appendChild(Object.assign(document.createElement('div'), { className: 'block err', textContent: e.message })); $('transcript').appendChild(d); metrics.error = String(e); });
