import test from 'node:test';
import assert from 'node:assert/strict';
import { snippetText, hoverContents, signatureValue, registerRoslyn, KIND, DEFAULT_COMMIT } from '../../js/roslyn-monaco.js';

test('snippets: the cursor stop goes on the blank indented line, dollars are escaped', () => {
  assert.equal(snippetText('for (;;)\n{\n    \n}'), 'for (;;)\n{\n    $0\n}');
  assert.equal(snippetText('Console.WriteLine();'), 'Console.WriteLine();$0');
  assert.equal(snippetText('var s = "$x";'), 'var s = "\\$x";$0');
});

test('hover: signature as a C# code block, documentation as text', () => {
  const c = hoverContents('class System.Console\n\nRepresents the standard streams.\n\nMore');
  assert.equal(c[0].value, '```csharp\nclass System.Console\n```');
  assert.deepEqual(c.slice(1).map((x) => x.value), ['Represents the standard streams.', 'More']);
  assert.equal(hoverContents('int x').length, 1);
});

test('signature help value', () => {
  const v = signatureValue({ signatures: [{ label: 'void F(int a)', parameters: ['int a'], doc: 'Does F.' }, { label: 'void F()', parameters: [], doc: null }], active: 1, activeParameter: 0 });
  assert.equal(v.activeSignature, 1);
  assert.deepEqual(v.signatures[0].parameters, [{ label: 'int a' }]);
  assert.equal(v.signatures[0].documentation, 'Does F.');
  assert.equal(v.signatures[1].documentation, undefined);
});

test('kinds map to Monaco completion kinds; default commit characters', () => {
  assert.equal(KIND.Method, 'Method'); assert.equal(KIND.Namespace, 'Module'); assert.equal(KIND.Local, 'Variable');
  assert.ok(DEFAULT_COMMIT.includes('.'));
});

// a minimal Monaco: records the providers and markers
function fakeMonaco() {
  const providers = {}, markers = {};
  const languages = {
    CompletionItemKind: new Proxy({}, { get: (_, k) => String(k) }),
    CompletionTriggerKind: { TriggerCharacter: 1, Invoke: 0 }, CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
    registerCompletionItemProvider: (l, p) => (providers.completion = p), registerSignatureHelpProvider: (l, p) => (providers.signature = p),
    registerHoverProvider: (l, p) => (providers.hover = p), registerDocumentSemanticTokensProvider: (l, p) => (providers.tokens = p),
  };
  class Range { constructor(a, b, c, d) { Object.assign(this, { startLineNumber: a, startColumn: b, endLineNumber: c, endColumn: d }); } }
  const editor = { setModelMarkers: (model, owner, list) => (markers[owner] = list), MarkerSeverity: { Error: 8, Warning: 4, Info: 2 } };
  return { providers, markers, languages, Range, editor, MarkerSeverity: editor.MarkerSeverity };
}
function fakeModel(text) {
  const starts = [0]; for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  const m = { value: text, getValue: () => m.value, isDisposed: () => false, onDidChangeContent: () => {},
    getOffsetAt: (p) => starts[p.lineNumber - 1] + p.column - 1,
    getPositionAt: (o) => { let l = 0; while (l + 1 < starts.length && starts[l + 1] <= o) l++; return { lineNumber: l + 1, column: o - starts[l] + 1 }; } };
  return m;
}

test('completion provider: Roslyn items become Monaco suggestions, descriptions are resolved on demand', async () => {
  const monaco = fakeMonaco(); const calls = [];
  const call = async (op, text, pos, extra) => {
    calls.push(op);
    if (op === 'Complete') return { start: 8, length: 3, items: [{ label: 'WriteLine', insert: 'WriteLine', kind: 'Method', filter: 'WriteLine', sort: 'a', commit: ['('], isSnippet: false, detail: null },
      { label: 'for (snippet)', insert: 'for (;;)\n{\n    \n}', kind: 'Snippet', filter: 'for', sort: '0for', commit: [], isSnippet: true }] };
    if (op === 'Describe') return 'void Console.WriteLine()\n\nWrites a line.';
    return null;
  };
  registerRoslyn(monaco, { call, ready: () => true });
  const model = fakeModel('Console.Wri');
  const res = await monaco.providers.completion.provideCompletionItems(model, { lineNumber: 1, column: 12 }, { triggerKind: 1, triggerCharacter: '.' }, { isCancellationRequested: false });
  assert.equal(res.suggestions.length, 2);
  const [wl, snip] = res.suggestions;
  assert.equal(wl.kind, 'Method'); assert.deepEqual(wl.commitCharacters, ['(']);
  assert.equal(snip.insertTextRules, 4); assert.equal(snip.insertText, 'for (;;)\n{\n    $0\n}'); assert.deepEqual(snip.commitCharacters, DEFAULT_COMMIT);
  assert.equal(snip._req, null);
  assert.equal(wl.range.startColumn, 9); assert.equal(wl.range.endColumn, 12);
  const full = await monaco.providers.completion.resolveCompletionItem(wl, {});
  assert.match(full.documentation.value, /Writes a line/); assert.equal(full.detail, 'void Console.WriteLine()');
  await monaco.providers.completion.resolveCompletionItem(snip, {});
  assert.deepEqual(calls, ['Complete', 'Describe']);   // snippets are not described
});

test('nothing is asked before the service is ready; hooks can veto completion', async () => {
  const monaco = fakeMonaco(); let n = 0;
  registerRoslyn(monaco, { call: async () => { n++; return null; }, ready: () => false });
  const model = fakeModel('x.');
  assert.deepEqual((await monaco.providers.completion.provideCompletionItems(model, { lineNumber: 1, column: 3 }, { triggerKind: 0 })).suggestions, []);
  assert.equal(await monaco.providers.hover.provideHover(model, { lineNumber: 1, column: 1 }), null);
  assert.equal(n, 0);
  const m2 = fakeMonaco();
  registerRoslyn(m2, { call: async () => { n++; return { start: 0, length: 0, items: [] }; }, ready: () => true, hooks: { skipCompletion: () => true } });
  await m2.providers.completion.provideCompletionItems(model, { lineNumber: 1, column: 1 }, { triggerKind: 0 });
  assert.equal(n, 0);
});

test('diagnostics become markers; skipDiagnostics clears or keeps them', async () => {
  const monaco = fakeMonaco(); let skip = false;
  const r = registerRoslyn(monaco, { call: async () => [{ start: 7, length: 3, severity: 'error', id: 'CS0103', message: 'no such name' }], ready: () => true, diagnosticsDelay: 0,
    hooks: { skipDiagnostics: () => skip } });
  const model = fakeModel('int x;\nfoo();');
  r.attach(model);
  await new Promise((res) => setTimeout(res, 20));
  const [mk] = monaco.markers.roslyn;
  assert.deepEqual([mk.startLineNumber, mk.startColumn, mk.endColumn, mk.severity, mk.code], [2, 1, 4, 8, 'CS0103']);
  skip = 'keep'; r.refresh(model); await new Promise((res) => setTimeout(res, 20));
  assert.equal(monaco.markers.roslyn.length, 1);
  skip = true; r.refresh(model); await new Promise((res) => setTimeout(res, 20));
  assert.equal(monaco.markers.roslyn.length, 0);
});

test('signature help and hover providers', async () => {
  const monaco = fakeMonaco();
  const call = async (op) => (op === 'Signature' ? { signatures: [{ label: 'void F()', parameters: [], doc: null }], active: 0, activeParameter: 0 } : { start: 0, length: 3, text: 'class Foo\n\ndocs' });
  registerRoslyn(monaco, { call, ready: () => true });
  const model = fakeModel('Foo(');
  const s = await monaco.providers.signature.provideSignatureHelp(model, { lineNumber: 1, column: 5 });
  assert.equal(s.value.signatures[0].label, 'void F()');
  const h = await monaco.providers.hover.provideHover(model, { lineNumber: 1, column: 2 });
  assert.equal(h.contents.length, 2); assert.equal(h.range.endColumn, 4);
});
