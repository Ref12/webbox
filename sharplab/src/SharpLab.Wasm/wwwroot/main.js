import { encodeShare, decodeShare, DEFAULTS } from './share.js';
import { findPath, nodeAt, selectionOf, label } from './syntaxpath.js';
import { renderJit } from './jit.js';
import { RuntimeClient } from './protocol.js';
import { registerRoslyn } from './roslyn-monaco.js';
import { VS_DARK } from './classify.js';
import { BUILD } from './config.js';

// The page only draws: compile, the views and Run live in the "exec" worker, Roslyn IntelliSense in the "intelli" worker (runtime-worker.js), so neither a long
// compile nor a running program blocks typing. BUILD and the manifest URLs (config.js) are rewritten by tools/stage.mjs (content hashes) when the site is staged.
const noBr = new URLSearchParams(location.search).has('nobr');   // measuring: skip the .br files

const $ = (id) => document.getElementById(id);
const metrics = (window.__metrics = { marks: {}, assets: [], compiles: [], build: BUILD, latency: {}, completion: [] });
const t0 = performance.now();
const now = () => Math.round(performance.now() - t0);
const mark = (k) => (metrics.marks[k] = now());
const setStatus = (s) => ($('status').textContent = s);
const setBadge = (text, cls) => { const b = $('intelli'); if (b) { b.textContent = text; b.className = 'badge ' + (cls || ''); } };
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

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
    monaco.editor.defineTheme('sl', { base: 'vs-dark', inherit: true, rules: Object.entries(VS_DARK).map(([token, c]) => ({ token, foreground: c })), colors: { 'editor.background': '#1e1f22' } });
    const ed = monaco.editor.create(host, { value: '', language: 'csharp', theme: 'sl', minimap: { enabled: false }, automaticLayout: true, fontSize: 13, fontFamily: FONT,
      scrollBeyondLastLine: false, fixedOverflowWidgets: true, tabSize: 4, insertSpaces: true, quickSuggestions: { other: true, comments: false, strings: false }, suggestOnTriggerCharacters: true, acceptSuggestionOnEnter: 'on',
      parameterHints: { enabled: true }, 'semanticHighlighting.enabled': true, padding: { top: 8 } });
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
      kind: 'monaco', model, monaco, editor: ed,
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
const tree = { root: null, rootLi: null, sel: null, pickSel: null };
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
  let ready = false, intelliReady = false, ed = null, compileId = 0, rendered = {}, last = null, compiledKey = null;
  const spawn = (name) => () => new Worker(new URL('./runtime-worker.js', import.meta.url), { type: 'module', name });
  const onEvent = (who) => (m) => {
    if (m.event === 'status' && who === 'exec' && !metrics.ready) setStatus(m.text);
    else if (m.event === 'badge') setBadge(m.text, m.cls);
    else if (m.event === 'mark') mark(who + '.' + m.name);
    else if (m.event === 'metrics') Object.assign(metrics, m.patch);
    else if (m.event === 'crashed') { console.error(who + ' worker crashed', m.message); if (who === 'exec') setStatus('runtime crashed: ' + m.message); }
  };
  const exec = new RuntimeClient(spawn('exec'), { onEvent: onEvent('exec'), name: 'exec' });
  const intelliW = new RuntimeClient(spawn('intelli'), { onEvent: onEvent('intelli'), name: 'intelli' });
  window.__workers = { exec, intelli: intelliW };
  // Roslyn IntelliSense requests carry the options bar, so the workspace is configured like the compile (language version, Release/Debug, optimize)
  const call = async (op, text, pos, extra) => (intelliReady ? JSON.parse(await intelliW.request('intelli', { op, text, pos: pos ?? 0, extra: extra ?? '', settings: settingsJson() })) : null);
  window.__intelli = call;
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

  let rendering = Promise.resolve();   // the view being drawn (tests await it)
  const renderActive = () => (rendering = renderImpl());
  async function renderImpl() {
    const tab = state.tab, key = compileId + ':' + state.level;
    if (!ready) return;
    if (rendered[tab] === key && tab !== 'syntax') return;
    const t = performance.now();
    if (tab === 'syntax') {
      const root = JSON.parse(await exec.request('syntax', { code: state.code, settings: settingsJson() }));
      buildTree($('tree'), root, (n) => { const s = selectionOf(n); tree.pickSel = s; ed.setSel(s.start, s.end); });
      revealForSelection(ed.getSel());
    } else if (tab === 'il') outs.il.set(await exec.request('il'));
    else if (tab === 'cs') { try { outs.cs.set(await exec.request('decompile', { level: state.level })); } catch (e) { outs.cs.set('// the decompiler failed: ' + e); } }
    else if (tab === 'verify') {
      const v = JSON.parse(await exec.request('verify')); const box = $('verifyout'); box.textContent = '';
      const head = document.createElement('div'); head.className = v.ok ? 'ok' : 'bad';
      head.textContent = (v.available ? (v.ok ? '✔ ' : '✘ ') : '⚠ ') + v.note + (v.available ? '  (' + Math.round(v.milliseconds) + ' ms, ILVerify)' : '');
      box.appendChild(head);
      for (const e of v.errors) { const d = document.createElement('div'); d.className = 'bad'; d.textContent = '  ' + e; box.appendChild(d); }
    } else if (tab === 'run') { $('runbtn').disabled = !last?.success; $('runinfo').textContent = last?.success ? (last.isExe ? 'Compiled ' + last.size + ' bytes. Press Run.' : 'A library: nothing to run.') : 'Fix the errors first.'; }
    else if (tab === 'jit') renderJit($('jit'), { getAssemblyBase64: () => exec.request('assemblyBase64'), compiled: () => last, settings: () => ({ ...state }) });
    rendered[tab] = key;
    (metrics.views ||= {})[tab] = Math.round(performance.now() - t);
  }

  // Compiles run one at a time in the exec worker; a compile that is still waiting when a newer text arrives is skipped, so typing never piles them up.
  let timer = null, chain = Promise.resolve(), pendingKey = null;
  function refresh() {
    if (!ready) return Promise.resolve();
    state.code = ed.get();
    const key = settingsJson() + '\n' + state.code;
    if (key === compiledKey || key === pendingKey) return chain;   // this text was compiled (or is queued) with these options already
    pendingKey = key;
    const id = ++compileId;
    setStatus('compiling…');
    return (chain = chain.then(() => (id === compileId ? compileNow(id) : null)).catch((e) => { pendingKey = null; console.error(e); setStatus('error: ' + e.message); }));
  }
  async function compileNow(id) {
    const t = performance.now(), code = state.code, settings = settingsJson();
    const { res, assets, wire } = await exec.request('compile', { code, settings });
    if (id !== compileId || ed.get() !== code) { if (pendingKey === settings + '\n' + code) pendingKey = null; return; }   // typed on meanwhile: its offsets do not fit the editor any more; the debounced compile follows
    last = res; compiledKey = settings + '\n' + code;
    if (pendingKey === compiledKey) pendingKey = null;
    const ms = Math.round(performance.now() - t);
    metrics.compiles.push({ ms, coreMs: Math.round(res.ms), bytes: res.size });
    metrics.assets.push(...assets);
    ed.markers(res.diagnostics); showProblems(res.diagnostics);
    rendered = {};
    await renderActive();
    if (!metrics.marks.firstView) { mark('firstView'); metrics.wireBytesAtFirstView = wire + performance.getEntriesByType('resource').filter((r) => r.name.startsWith(location.origin)).reduce((s, r) => s + (r.encodedBodySize || 0), 0); }
    setStatus(res.success ? 'compiled in ' + ms + ' ms' : res.diagnostics.filter((d) => d.severity === 'error').length + ' error(s)');
    syncUrlSoon();
  }
  let urlTimer = null;
  function syncUrlSoon() { clearTimeout(urlTimer); urlTimer = setTimeout(async () => { try { history.replaceState(null, '', '#' + await encodeShare(state)); } catch {} }, 600); }
  // IntelliSense diagnostics (squiggles) come back within ~250 ms, so once it is ready the compile (IL, C#, ...) can wait a little longer
  const refreshSoon = () => { clearTimeout(timer); timer = setTimeout(refresh, intelliReady ? 700 : 350); };
  ed.onChange(refreshSoon);
  ed.onCursor(() => {
    if (state.tab !== 'syntax') return;
    const sel = ed.getSel(), p = tree.pickSel;
    tree.pickSel = null;
    if (p && p.start === sel.start && p.end === sel.end) return;   // the selection the tree itself just set: it is already selected there
    revealForSelection(sel);
  });

  // controls
  const optionsChanged = () => { refresh(); intelli?.refresh(ed.model); };   // the workspace follows the options: new squiggles, colours and completions
  $('cfg').onchange = (e) => { state.configuration = e.target.value; state.optimize = state.configuration === 'release'; syncOptions(); optionsChanged(); };
  $('opt').onchange = (e) => { state.optimize = e.target.checked; optionsChanged(); };
  langSel.onchange = (e) => { state.langVersion = e.target.value; optionsChanged(); };
  $('level').onchange = (e) => { state.level = Number(e.target.value); rendered = {}; renderActive(); syncUrlSoon(); };
  for (const b of document.querySelectorAll('#tabs button')) b.onclick = () => { showTab(b.dataset.tab); renderActive(); syncUrlSoon(); };
  $('runbtn').onclick = async () => {
    if (!ready || !last?.success) return;
    $('runbtn').disabled = true; $('runinfo').textContent = 'running…'; await nextFrame();
    const r = JSON.parse(await exec.request('run'));
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
  window.__sharplab = { state, refresh, get rendering() { return rendering; }, call, intelliReady: () => intelliReady, exec, intelliW, showTab: (t) => { showTab(t); return renderActive(); }, setCode: (c) => { ed.set(c); return refresh(); }, tree, revealForSelection, ed, get last() { return last; }, getRun: () => $('runbtn').click(), decode: decodeShare };

  // IntelliSense: providers are registered once; the intelli worker comes up after the first compile (see below)
  let intelli = null;
  if (ed.monaco) {
    intelli = registerRoslyn(ed.monaco, {
      call, ready: () => intelliReady, diagnosticsDelay: 250,
      onStats: (name, ms) => { if (name === 'completion') metrics.completion.push(Math.round(ms)); metrics.latency[name] = Math.round(ms); },
      // the compile already produced exactly these squiggles for this text and these options: nothing to add
      hooks: { skipDiagnostics: (text) => (compiledKey === settingsJson() + '\n' + text ? 'keep' : false) },
    });
    intelli.attach(ed.model);
  }
  window.__sharplab.intelli = intelli;

  // the runtimes
  setStatus('downloading .NET runtime…');
  exec.start();
  await exec.request('init', { nobr: noBr });
  ready = true;
  metrics.ready = true;
  await refresh();
  mark('firstCompileDone');
  $('runbtn').disabled = !last?.success;
  ed.focus();

  // after the first compile: the IntelliSense worker boots its own runtime (the files are in the cache by now), then loads Microsoft.CodeAnalysis.Features & co.
  try {
    setBadge('IntelliSense: starting runtime…', 'loading');
    intelliW.start();
    await intelliW.request('init', { nobr: noBr });
    await intelliW.request('loadIntellisense');
    intelliReady = true;
    mark('intellisenseReady');
    setBadge('IntelliSense: ready', 'ready');
    intelli?.refresh(ed.model);   // colours and squiggles for the text that is already there
  } catch (e) { console.error(e); setBadge('IntelliSense: failed', ''); metrics.intellisenseError = String(e); }
}
main().catch((e) => { console.error(e); setStatus('error: ' + e.message); metrics.error = String(e);
  const d = document.createElement('div'); d.className = 'problems'; d.textContent = e.message; document.body.appendChild(d); });
