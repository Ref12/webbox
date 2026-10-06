import { History } from './history.js';
import { toHtml, VS_DARK } from './classify.js';
import { registerIntellisense } from './intellisense.js';
import { parseCommand, directiveSpans, handleCommand } from './commands.js';
import { addCopyButton } from './copy.js';
import { RuntimeClient, CancelledError, SessionLog } from './protocol.js';
import { BUILD, wantAot } from './config.js';

const params = new URLSearchParams(location.search);
const AOT = wantAot();   // opt-in AOT runtime build (?aot=1 or the remembered header toggle)
const THREADS = params.get('threads') === '1';   // experimental multithreaded .NET (needs the COOP/COEP headers of the Cloudflare deployment)
const $ = (id) => document.getElementById(id);
const metrics = (window.__metrics = { marks: {}, completion: [], assets: [], build: BUILD, threadsRequested: THREADS, aotRequested: AOT });
const t0 = performance.now();
const now = () => Math.round(performance.now() - t0);
const mark = (k) => (metrics.marks[k] = now());
{ const t = document.getElementById('aot'); if (t) { t.checked = AOT; t.onchange = () => { try { localStorage.setItem('webbox-aot', t.checked ? '1' : '0'); } catch {} const u = new URL(location.href); u.searchParams.delete('aot'); location.href = u.href; }; } }
const setStatus = (s) => ($('status').textContent = s);
const setBadge = (text, cls) => { const b = $('intelli'); b.textContent = text; b.className = 'badge ' + (cls || ''); };
const fileName = (u) => decodeURIComponent(String(u?.url ?? u).split('?')[0].split('/').pop() || String(u));
const assetLog = (window.__assetLog = []);

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
  const log = new SessionLog();   // successful submissions, replayed after Stop
  let busy = false, intelliReady = false, committedCount = 0;
  const spawn = (name) => () => new Worker(new URL('./runtime-worker.js', import.meta.url), { type: 'module', name });
  let wantIntelli = false;
  const onEvent = (who) => (m) => {
    if (m.event === 'status' && (who === 'exec' && !metrics.ready)) setStatus(m.text);
    else if (m.event === 'badge') setBadge(m.text, m.cls);
    else if (m.event === 'mark') mark(who + '.' + m.name);
    else if (m.event === 'metrics') Object.assign(metrics, m.patch);
    else if (m.event === 'crashed') { console.error(who + ' worker crashed', m.message); if (who === 'exec') setStatus('runtime crashed: ' + m.message); }
  };
  const useThreadsRef = { v: false };
  const exec = new RuntimeClient(spawn('exec'), { onEvent: onEvent('exec'), name: 'exec' });
  const intelliW = new RuntimeClient(spawn('intelli'), { onEvent: onEvent('intelli'), name: 'intelli' });
  window.__workers = { exec, intelli: intelliW };
  const call = async (op, text, pos, extra) => (intelliReady ? JSON.parse(await intelliW.request('intelli', { op, text, pos: pos ?? 0, extra: extra ?? '' })) : null);
  window.__intelli = (op, text, pos, extra) => call(op, text, pos, extra);
  const isComplete = (code) => exec.request('isComplete', { code });

  async function colour(e) {
    if (!intelliReady || e.coloured || e.command) return;
    try {
      const spans = e.committed !== null ? await call('ClassifyCommitted', '', e.committed) : await call('Classify', e.code, 0);
      if (spans) { e.codeEl.innerHTML = toHtml(e.code, [...spans, ...directiveSpans(e.code)]); e.coloured = true; }
    } catch (err) { if (!(err instanceof CancelledError)) console.warn('classify failed', err); }
  }

  // Runs C# in the exec worker and shows the result under its own transcript entry. Console output streams into the entry while the code runs.
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
    let live = null, streamed = '';
    const t = performance.now();
    let out;
    try {
      out = await exec.request('submit', { code }, { onOut: (text) => {
        streamed += text;
        if (!live) live = addBlock(entry.div, 'out live', ' ');   // no copy button until it is final
        live.firstChild.textContent = streamed.replace(/\n$/, '') || ' ';
        $('transcript').scrollTop = $('transcript').scrollHeight;
      } });
    } catch (err) {
      if (!(err instanceof CancelledError)) { addBlock(entry.div, 'block err', String(err.message)); throw err; }
      live?.remove(); if (streamed) addBlock(entry.div, 'block out', streamed);
      addBlock(entry.div, 'block err', 'Stopped. The runtime was restarted' + (log.length ? '; ' + log.length + ' earlier submission(s) are being replayed.' : '.'));
      entry.stopped = true;
      await restartExec();
      return entry;
    }
    const { res } = out;
    const total = performance.now() - t;
    if (res.success) { entry.committed = committedCount++; log.add(code); await intelliW.request('track', { code }).catch(() => {}); }
    (metrics.runs ||= []).push({ code: code.length > 60 ? code.slice(0, 60) + '…' : code, ms: Math.round(total), coreMs: Math.round(res.milliseconds) });
    for (const a of out.assets) { assetLog.push(a); metrics.assets.push(a); addBlock(entry.div, 'load', '↓ ' + fileName(a.path) + ' · ' + (a.bytes / 1024).toFixed(0) + ' KB · ' + a.from + ' · ' + a.ms + ' ms'); }
    for (const l of res.loaded || []) if (l.startsWith('nuget')) addBlock(entry.div, 'load', '📦 ' + l);
    live?.remove();
    if (res.output || streamed) addBlock(entry.div, 'block out', (res.output || streamed).replace(/\n$/, ''));
    if (!res.success) {
      for (const d of res.diagnostics || []) addBlock(entry.div, 'block err', d);
      if (res.error) addBlock(entry.div, 'block err', res.error);
    } else if (res.value != null) addBlock(entry.div, 'block val', res.value);
    addBlock(entry.div, 'ms', Math.round(total) + ' ms');
    $('transcript').scrollTop = $('transcript').scrollHeight;
    return entry;
  }

  // Stop / Ctrl+C: the only way to interrupt a running .NET loop is to kill the worker. A new one starts and the session's successful submissions are replayed.
  function stop() { if (busy && exec.running) exec.terminate('stopped by the user'); }
  async function restartExec() {
    exec.restart('restart');
    metrics.restarts = (metrics.restarts || 0) + 1;
    setStatus('restarting the runtime…');
    await exec.request('init', { threads: useThreadsRef.v, aot: AOT });
    let replayed = 0;
    for (const code of log.codes) {
      setStatus('restoring the session (' + ++replayed + '/' + log.length + ')…');
      try { await exec.request('submit', { code, quiet: true }); } catch (e) { console.warn('replay failed', e); break; }
    }
    const note = Object.assign(document.createElement('div'), { className: 'note' });
    note.append(log.length ? 'session restored (' + log.length + ' submission' + (log.length === 1 ? '' : 's') + ' replayed) · ' : 'runtime restarted · ');
    const b = Object.assign(document.createElement('button'), { textContent: 'reset the session instead', className: 'linklike' });
    b.onclick = async () => { b.disabled = true; await resetSession(); };
    note.append(b);
    $('transcript').appendChild(note);
    $('transcript').scrollTop = $('transcript').scrollHeight;
  }

  async function resetSession() {
    await Promise.all([exec.request('reset'), intelliW.request('reset').catch(() => {})]);
    log.reset(); committedCount = 0; history.reset(); entries.forEach((e) => (e.committed = null));
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
      resetSession: async () => { own(); await resetSession(); },
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

  const setBusy = (b) => { busy = b; $('run').disabled = b || !metrics.ready; $('stop').hidden = !b; };
  async function submit(force) {
    const code = editor.get();
    if (!metrics.ready || busy || !code.trim()) return;
    const cmd = parseCommand(code);
    if (!cmd && !force && !(await isComplete(code))) { editor.set(code + '\n'); return; } // incomplete: behave like a newline
    setBusy(true);
    history.add(code);
    editor.set('');
    try { if (cmd) await runCommand(code, cmd); else await execute(code); }
    finally { setStatus('ready'); setBusy(false); editor.focus(); }
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
  $('stop').onclick = stop;
  document.addEventListener('keydown', (e) => {   // Ctrl+C with nothing selected while code runs
    if (busy && e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'c' && !String(window.getSelection()) && !(monacoRef && window.monaco.editor.getEditors()[0].getSelection()?.isEmpty() === false)) { e.preventDefault(); stop(); }
  }, true);
  $('reset').onclick = () => { if (!busy) resetSession(); };

  // ---- the runtimes: the page only draws; compile/run live in the exec worker, Roslyn IntelliSense in the intelli worker ----
  setStatus('downloading .NET runtime…');
  exec.start();
  let useThreads = THREADS, info;
  if (THREADS) {
    // Experimental: .NET 10's threaded runtime does not start inside a Web Worker (see README); fall back to the normal runtime instead of hanging.
    info = await Promise.race([exec.request('init', { threads: true, aot: AOT }).catch((e) => ({ failed: String(e.message) })), new Promise((r) => setTimeout(() => r({ failed: 'timeout' }), 15000))]);
    if (info.failed) {
      console.warn('threads=1: the threaded runtime did not start in the worker (' + info.failed + '); using the normal runtime');
      metrics.threadsFailed = info.failed; useThreads = false;
      exec.restart('threads fallback');
    }
  }
  if (!info || info.failed) info = await exec.request('init', { threads: false, aot: AOT });
  useThreadsRef.v = useThreads;
  assemblyNames = info.assemblies;
  Object.assign(metrics, { aot: info.aot, threads: info.threads, cores: info.cores, crossOriginIsolated: info.crossOriginIsolated });
  metrics.ready = true;
  setStatus('ready');
  $('run').disabled = false; $('reset').disabled = false;
  editor.focus();

  // ---- after the first paint: the IntelliSense worker boots its own runtime, then loads Microsoft.CodeAnalysis.Features & co. ----
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  try {
    setBadge('IntelliSense: starting runtime…', 'loading');
    intelliW.start();
    await intelliW.request('init', { threads: false, aot: false });   // IntelliSense never needs threads, and always runs on the relink build (Roslyn Features does not survive the AOT build's trimming)
    await intelliW.request('loadIntellisense');
    for (const c of log.codes) await intelliW.request('track', { code: c });   // submissions made before it was ready
    intelliReady = true;
    mark('intellisenseReady');
    setBadge('IntelliSense: ready', 'ready');
    editor.refresh();
    for (const e of entries) await colour(e);   // history entries typed before IntelliSense was ready
  } catch (e) { console.error(e); setBadge('IntelliSense: failed', ''); metrics.intellisenseError = String(e); }
}
main().catch((e) => { console.error(e); setStatus('error: ' + e.message);
  const d = document.createElement('div'); d.className = 'entry'; d.appendChild(Object.assign(document.createElement('div'), { className: 'block err', textContent: e.message })); $('transcript').appendChild(d); metrics.error = String(e); });
