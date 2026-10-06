// Wires the Roslyn services (running in the .NET wasm app, see Interop.Intelli) to Monaco's providers.
import { TYPES, toSemanticTokens } from './classify.js';

const KIND = { Class: 'Class', Struct: 'Struct', Interface: 'Interface', Enum: 'Enum', EnumMember: 'EnumMember', Delegate: 'Class',
  Method: 'Method', ExtensionMethod: 'Method', Property: 'Property', Field: 'Field', Local: 'Variable', Parameter: 'Variable',
  Keyword: 'Keyword', Namespace: 'Module', Event: 'Event', Constant: 'Constant', TypeParameter: 'TypeParameter', Snippet: 'Snippet',
  Label: 'Variable', RangeVariable: 'Variable', Module: 'Module', Constructor: 'Constructor' };
const DEFAULT_COMMIT = ['.', '(', '[', ';', ','];

/** call(op, text, pos, extra) -> Promise<object|null> ; ready() -> bool ; stats collects timings. */
export function registerIntellisense(monaco, { call, ready, onStats }) {
  const K = monaco.languages.CompletionItemKind;
  const changeListeners = [];
  const timed = async (name, f) => { const t = performance.now(); const r = await f(); onStats?.(name, performance.now() - t); return r; };

  monaco.languages.registerCompletionItemProvider('csharp', {
    triggerCharacters: ['.'],
    async provideCompletionItems(model, position, context) {
      if (!ready()) return { suggestions: [] };
      const text = model.getValue(), pos = model.getOffsetAt(position);
      const trigger = context.triggerKind === monaco.languages.CompletionTriggerKind.TriggerCharacter ? context.triggerCharacter : '';
      const res = await timed('completion', () => call('Complete', text, pos, trigger));
      if (!res) return { suggestions: [] };
      const a = model.getPositionAt(res.start), b = model.getPositionAt(res.start + res.length);
      const range = new monaco.Range(a.lineNumber, a.column, Math.max(b.lineNumber, position.lineNumber), Math.max(b.column, position.column));
      return {
        suggestions: res.items.map((i) => {
          const snippet = i.isSnippet;
          let insert = i.insert;
          if (snippet) { insert = insert.replace(/\$/g, '\\$'); const k = insert.indexOf('    \n'); insert = k >= 0 ? insert.slice(0, k + 4) + '$0' + insert.slice(k + 4) : insert + '$0'; }
          return {
            label: i.label, kind: K[KIND[i.kind]] ?? K.Text, insertText: insert, filterText: i.filter, sortText: i.sort, range,
            detail: i.detail || undefined, commitCharacters: i.commit?.length ? i.commit : DEFAULT_COMMIT,
            insertTextRules: snippet ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
          };
        }),
      };
    },
  });

  monaco.languages.registerSignatureHelpProvider('csharp', {
    signatureHelpTriggerCharacters: ['(', ','], signatureHelpRetriggerCharacters: [','],
    async provideSignatureHelp(model, position) {
      if (!ready()) return null;
      const r = await timed('signature', () => call('Signature', model.getValue(), model.getOffsetAt(position), ''));
      if (!r) return null;
      return { value: { signatures: r.signatures.map((s) => ({ label: s.label, documentation: s.doc || undefined, parameters: s.parameters.map((p) => ({ label: p })) })),
        activeSignature: r.active, activeParameter: r.activeParameter }, dispose() {} };
    },
  });

  monaco.languages.registerHoverProvider('csharp', {
    async provideHover(model, position) {
      if (!ready()) return null;
      const r = await timed('hover', () => call('QuickInfo', model.getValue(), model.getOffsetAt(position), ''));
      if (!r || !r.text) return null;
      const a = model.getPositionAt(r.start), b = model.getPositionAt(r.start + r.length);
      const [head, ...rest] = r.text.split('\n\n');
      return { range: new monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column),
        contents: [{ value: '```csharp\n' + head + '\n```' }, ...rest.map((v) => ({ value: v }))] };
    },
  });

  monaco.languages.registerDocumentSemanticTokensProvider('csharp', {
    onDidChange: (l) => { changeListeners.push(l); return { dispose() {} }; },
    getLegend: () => ({ tokenTypes: TYPES, tokenModifiers: [] }),
    async provideDocumentSemanticTokens(model) {
      if (!ready()) return null;
      const text = model.getValue();
      const spans = await timed('classify', () => call('Classify', text, 0, ''));
      return spans ? { data: toSemanticTokens(text, spans) } : null;
    },
    releaseDocumentSemanticTokens() {},
  });

  // diagnostics -> squiggles (debounced per model)
  const sev = { error: monaco.MarkerSeverity.Error, warning: monaco.MarkerSeverity.Warning, info: monaco.MarkerSeverity.Info };
  let timer;
  const refreshMarkers = (model) => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (!ready() || model.isDisposed()) return;
      const text = model.getValue();
      const ds = (await timed('diagnostics', () => call('Diagnostics', text, 0, ''))) || [];
      if (model.getValue() !== text) return;   // stale
      monaco.editor.setModelMarkers(model, 'roslyn', ds.map((d) => {
        const a = model.getPositionAt(d.start), b = model.getPositionAt(d.start + d.length);
        return { startLineNumber: a.lineNumber, startColumn: a.column, endLineNumber: b.lineNumber, endColumn: Math.max(b.column, a.column + 1),
          severity: sev[d.severity] ?? monaco.MarkerSeverity.Info, message: d.id + ': ' + d.message, code: d.id, source: 'Roslyn' };
      }));
    }, 350);
  };
  return {
    attach(model) { model.onDidChangeContent(() => refreshMarkers(model)); refreshMarkers(model); },
    refresh(model) { changeListeners.forEach((l) => l()); if (model) refreshMarkers(model); },
  };
}
