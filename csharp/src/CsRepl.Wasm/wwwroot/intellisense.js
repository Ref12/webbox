// Wires the Roslyn services (running in the intelli worker, see Interop.Intelli) to Monaco's providers: the shared Roslyn providers (roslyn-monaco.js)
// plus what only the REPL has: #r completion (NuGet, framework assemblies) and #commands.
import { registerRoslyn } from './roslyn-monaco.js';
import { parseCommand, directiveSpans } from './commands.js';
import { completeR, createNuGetClient, rContext } from './rcomplete.js';

/** call(op, text, pos, extra) -> Promise<object|null> ; ready() -> bool ; stats collects timings. */
export function registerIntellisense(monaco, { call, ready, onStats, assemblies, nuget = createNuGetClient() }) {
  const K = monaco.languages.CompletionItemKind;
  const timed = async (name, f) => { const t = performance.now(); const r = await f(); onStats?.(name, performance.now() - t); return r; };

  // #r "..." : `nuget: `, package names and versions from nuget.org, framework assemblies. Needs no Roslyn, so it works before IntelliSense is ready.
  const RK = { nuget: K.Keyword, package: K.Module, version: K.Value, assembly: K.Reference };
  monaco.languages.registerCompletionItemProvider('csharp', {
    triggerCharacters: ['"', ':', ' ', ',', '.'],
    async provideCompletionItems(model, position) {
      const text = model.getValue(), pos = model.getOffsetAt(position);
      if (!rContext(text, pos)) return { suggestions: [] };
      const res = await timed('rcompletion', () => completeR(text, pos, { nuget, assemblies }));
      if (!res || model.getValue() !== text) return { suggestions: [] };
      const retrigger = { id: 'editor.action.triggerSuggest', title: '' };
      return { incomplete: res.context.kind === 'package',   // package names are searched on nuget.org: ask again as the text grows
        suggestions: res.items.map((i) => {
        const a = model.getPositionAt(i.start);
        return { label: i.label, kind: RK[i.kind] ?? K.Text, insertText: i.insertText, filterText: i.label, sortText: i.sortText, detail: i.detail,
          range: new monaco.Range(a.lineNumber, a.column, position.lineNumber, position.column),
          command: i.kind === 'nuget' || i.kind === 'package' ? retrigger : undefined };   // after `nuget: ` offer packages, after a package offer versions
      }) };
    },
  });

  return registerRoslyn(monaco, { call, ready, onStats, hooks: {
    skipCompletion: (text, pos) => rContext(text, pos),            // inside #r "...": the provider above answers
    skipDiagnostics: (text) => !!parseCommand(text),              // #help, #clear...: not C#
    extraSpans: (text) => directiveSpans(text),
  } });
}
