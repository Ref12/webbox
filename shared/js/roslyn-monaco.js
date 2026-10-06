// Roslyn IntelliSense -> Monaco providers, shared by csharp/ (REPL) and sharplab/. The Roslyn side runs in a worker (intelli-loader.js, protocol.js);
// this module only talks to it through call(op, text, pos, extra) -> Promise<object|null> and never blocks the page.
//   completion (kinds, descriptions resolved on demand, commit characters, keyword snippets), signature help, hover (quick info), semantic tokens, diagnostics -> markers.
import { TYPES, toSemanticTokens } from './classify.js';

export const KIND = { Class: 'Class', Struct: 'Struct', Interface: 'Interface', Enum: 'Enum', EnumMember: 'EnumMember', Delegate: 'Class',
  Method: 'Method', ExtensionMethod: 'Method', Property: 'Property', Field: 'Field', Local: 'Variable', Parameter: 'Variable',
  Keyword: 'Keyword', Namespace: 'Module', Event: 'Event', Constant: 'Constant', TypeParameter: 'TypeParameter', Snippet: 'Snippet',
  Label: 'Variable', RangeVariable: 'Variable', Module: 'Module', Constructor: 'Constructor' };
export const DEFAULT_COMMIT = ['.', '(', '[', ';', ','];

/** A snippet item from the service: body text with the cursor spot marked by a line of 4 spaces; Monaco snippet syntax needs \$ escaped and a final tab stop. */
export function snippetText(insert) {
  const esc = insert.replace(/\$/g, '\\$');
  const k = esc.indexOf('    \n');
  return k >= 0 ? esc.slice(0, k + 4) + '$0' + esc.slice(k + 4) : esc + '$0';
}

/** Roslyn quick info text ("sections" separated by blank lines) -> Monaco hover contents: the signature as a C# code block, the rest (docs) as text. */
export function hoverContents(text) {
  const [head, ...rest] = text.split('\n\n');
  return [{ value: '```csharp\n' + head + '\n```' }, ...rest.map((v) => ({ value: v }))];
}

export function signatureValue(r) {
  return { signatures: r.signatures.map((s) => ({ label: s.label, documentation: s.doc || undefined, parameters: s.parameters.map((p) => ({ label: p })) })),
    activeSignature: r.active, activeParameter: r.activeParameter };
}

/**
 * call(op, text, pos, extra) -> Promise<object|null>; ready() -> bool; onStats(name, ms) collects timings.
 * hooks (all optional): skipCompletion(text,pos) -> bool, skipDiagnostics(text) -> bool | 'keep' (true clears the markers, 'keep' leaves them), extraSpans(text) -> classified spans added to Roslyn's (e.g. directives),
 *   onDiagnostics(list, text) after the markers were set.
 * Returns { attach(model), refresh(model), setDiagnostics(model, list) }.
 */
export function registerRoslyn(monaco, { call, ready, onStats, language = 'csharp', hooks = {}, markerOwner = 'roslyn', diagnosticsDelay = 350 }) {
  const K = monaco.languages.CompletionItemKind;
  const changeListeners = [];
  const timed = async (name, f) => { const t = performance.now(); const r = await f(); onStats?.(name, performance.now() - t); return r; };

  monaco.languages.registerCompletionItemProvider(language, {
    triggerCharacters: ['.'],
    async provideCompletionItems(model, position, context, token) {
      if (!ready()) return { suggestions: [] };
      const text = model.getValue(), pos = model.getOffsetAt(position);
      if (hooks.skipCompletion?.(text, pos)) return { suggestions: [] };
      const trigger = context.triggerKind === monaco.languages.CompletionTriggerKind.TriggerCharacter ? context.triggerCharacter : '';
      const res = await timed('completion', () => call('Complete', text, pos, trigger));
      if (!res || token?.isCancellationRequested) return { suggestions: [] };
      const a = model.getPositionAt(res.start), b = model.getPositionAt(res.start + res.length);
      const range = new monaco.Range(a.lineNumber, a.column, Math.max(b.lineNumber, position.lineNumber), Math.max(b.column, position.column));
      return {
        suggestions: res.items.map((i) => ({
          label: i.label, kind: K[KIND[i.kind]] ?? K.Text, insertText: i.isSnippet ? snippetText(i.insert) : i.insert, filterText: i.filter, sortText: i.sort, range,
          detail: i.detail || undefined, commitCharacters: i.commit?.length ? i.commit : DEFAULT_COMMIT,
          insertTextRules: i.isSnippet ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
          _req: i.isSnippet ? null : { text, pos, label: i.label },
        })),
      };
    },
    // the description (signature + documentation) of the highlighted item, asked for only when the item is shown
    async resolveCompletionItem(item, token) {
      if (!item._req || !ready()) return item;
      const { text, pos, label } = item._req;
      const d = await timed('describe', () => call('Describe', text, pos, label));
      if (d && !token?.isCancellationRequested) {
        const [head, ...rest] = String(d).split('\n\n');
        item.detail = item.detail || head.split('\n')[0];
        item.documentation = { value: '```csharp\n' + head + '\n```' + (rest.length ? '\n\n' + rest.join('\n\n') : '') };
      }
      return item;
    },
  });

  monaco.languages.registerSignatureHelpProvider(language, {
    signatureHelpTriggerCharacters: ['(', ','], signatureHelpRetriggerCharacters: [','],
    async provideSignatureHelp(model, position) {
      if (!ready()) return null;
      const r = await timed('signature', () => call('Signature', model.getValue(), model.getOffsetAt(position), ''));
      return r ? { value: signatureValue(r), dispose() {} } : null;
    },
  });

  monaco.languages.registerHoverProvider(language, {
    async provideHover(model, position) {
      if (!ready()) return null;
      const r = await timed('hover', () => call('QuickInfo', model.getValue(), model.getOffsetAt(position), ''));
      if (!r || !r.text) return null;
      const a = model.getPositionAt(r.start), b = model.getPositionAt(r.start + r.length);
      return { range: new monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column), contents: hoverContents(r.text) };
    },
  });

  monaco.languages.registerDocumentSemanticTokensProvider(language, {
    onDidChange: (l) => { changeListeners.push(l); return { dispose() {} }; },
    getLegend: () => ({ tokenTypes: TYPES, tokenModifiers: [] }),
    async provideDocumentSemanticTokens(model) {
      if (!ready()) return null;
      const text = model.getValue();
      const spans = await timed('classify', () => call('Classify', text, 0, ''));
      return spans ? { data: toSemanticTokens(text, [...spans, ...(hooks.extraSpans?.(text) ?? [])]) } : null;
    },
    releaseDocumentSemanticTokens() {},
  });

  // diagnostics -> squiggles (debounced per model)
  const sev = { error: monaco.MarkerSeverity.Error, warning: monaco.MarkerSeverity.Warning, info: monaco.MarkerSeverity.Info };
  const setDiagnostics = (model, ds) => monaco.editor.setModelMarkers(model, markerOwner, ds.map((d) => {
    const a = model.getPositionAt(d.start), b = model.getPositionAt(d.start + d.length);
    return { startLineNumber: a.lineNumber, startColumn: a.column, endLineNumber: b.lineNumber, endColumn: Math.max(b.column, a.column + 1),
      severity: sev[d.severity] ?? monaco.MarkerSeverity.Info, message: d.id + ': ' + d.message, code: d.id, source: 'Roslyn' };
  }));
  let timer;
  const refreshMarkers = (model, delay = diagnosticsDelay) => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (!ready() || model.isDisposed()) return;
      const text = model.getValue();
      const skip = hooks.skipDiagnostics?.(text);
      if (skip === 'keep') return;   // the host already has the markers for this text
      if (skip) { monaco.editor.setModelMarkers(model, markerOwner, []); return; }
      const ds = (await timed('diagnostics', () => call('Diagnostics', text, 0, ''))) || [];
      if (model.isDisposed() || model.getValue() !== text) return;   // stale
      setDiagnostics(model, ds);
      hooks.onDiagnostics?.(ds, text);
    }, delay);
  };
  return {
    attach(model) { model.onDidChangeContent(() => refreshMarkers(model)); refreshMarkers(model); },
    /** Re-ask everything for a model (IntelliSense became ready, or an option changed): colours and squiggles. */
    refresh(model) { changeListeners.forEach((l) => l()); if (model) refreshMarkers(model, 0); },
    setDiagnostics,
  };
}
