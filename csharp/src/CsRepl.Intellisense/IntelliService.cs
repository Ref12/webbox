using System.Collections.Immutable;
using System.Reflection;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Classification;
using Microsoft.CodeAnalysis.Completion;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Host.Mef;
using Microsoft.CodeAnalysis.QuickInfo;
using Microsoft.CodeAnalysis.Text;

namespace CsRepl.Intellisense;

public sealed record CompletionDto(string Label, string Insert, string Kind, string Filter, string Sort, string[] Commit, bool IsSnippet, string? Detail);
public sealed record CompletionResultDto(int Start, int Length, CompletionDto[] Items);
public sealed record SignatureDto(string Label, string[] Parameters, string? Doc);
public sealed record SignatureHelpDto(SignatureDto[] Signatures, int Active, int ActiveParameter);
public sealed record HoverDto(int Start, int Length, string Text);
public sealed record DiagnosticDto(int Start, int Length, string Severity, string Id, string Message);
public sealed record ClassifiedSpanDto(int Start, int Length, string Type);

/// <summary>
/// Roslyn language services over an AdhocWorkspace that holds the REPL's submissions as a chain of submission projects
/// (each one references the previous). Completion, quick info and classification use the public Features/Workspaces
/// services (CompletionService, QuickInfoService, Classifier); signature help is built from the semantic model because
/// SignatureHelpService is internal to Features. Diagnostics come from the compilation.
/// </summary>
public sealed class IntelliService
{
    private static readonly string[] DefaultImports =
        { "System", "System.IO", "System.Linq", "System.Collections.Generic", "System.Threading.Tasks", "System.Text" };

    private readonly AdhocWorkspace _ws;
    private IReadOnlyList<MetadataReference> _refs;
    private readonly List<string> _submissions = new();
    private ProjectId? _lastCommitted;
    private readonly List<DocumentId> _committedDocs = new();
    private ProjectId? _scratch;
    private static readonly CSharpParseOptions Parse = new(LanguageVersion.Latest, kind: SourceCodeKind.Script);

    public IntelliService(IEnumerable<MetadataReference> refs)
    {
        _refs = refs.ToList();
        var asms = new List<Assembly>();
        foreach (var n in new[] { "Microsoft.CodeAnalysis.Workspaces", "Microsoft.CodeAnalysis.CSharp.Workspaces",
                     "Microsoft.CodeAnalysis.Features", "Microsoft.CodeAnalysis.CSharp.Features" })
            asms.Add(Assembly.Load(n));
        _ws = new AdhocWorkspace(CreateHost(asms));
    }

    /// <summary>
    /// Roslyn's MEF parts minus the persistent-storage configuration: DefaultPersistentStorageConfiguration's static constructor
    /// calls Process.GetCurrentProcess(), which throws PlatformNotSupportedException in the browser (it surfaced as an unhandled
    /// exception in the console during completion). Without it Roslyn keeps no on-disk cache (there is no disk anyway).
    /// </summary>
    public static IEnumerable<Type> HostPartTypes(IEnumerable<Assembly> assemblies) =>
        assemblies.SelectMany(a => a.DefinedTypes).Select(t => t.AsType())
            .Where(t => t.Name != "DefaultPersistentStorageConfiguration");

    private static MefHostServices CreateHost(IEnumerable<Assembly> assemblies) =>
        MefHostServices.Create(new System.Composition.Hosting.ContainerConfiguration().WithParts(HostPartTypes(assemblies)).CreateContainer());

    public int SubmissionCount => _submissions.Count;

    /// <summary>Replace the reference set (after assemblies were loaded on demand).</summary>
    public void SetReferences(IEnumerable<MetadataReference> refs)
    {
        _refs = refs.ToList();
        var chain = _submissions.ToList();
        Reset();
        foreach (var s in chain) Commit(s);
    }

    public void Reset()
    {
        _ws.ClearSolution();
        _submissions.Clear(); _committedDocs.Clear(); _lastCommitted = null; _scratch = null;
    }

    private ProjectId AddSubmissionProject(string code, ProjectId? previous, out DocumentId docId)
    {
        var pid = ProjectId.CreateNewId();
        docId = DocumentId.CreateNewId(pid);
        var opts = new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, usings: DefaultImports,
            concurrentBuild: false).WithMetadataImportOptions(MetadataImportOptions.All);
        var info = ProjectInfo.Create(pid, VersionStamp.Create(), "Sub" + pid.Id.ToString("N"), "Sub" + pid.Id.ToString("N"),
            LanguageNames.CSharp, compilationOptions: opts, parseOptions: Parse, metadataReferences: _refs,
            projectReferences: previous is null ? null : new[] { new ProjectReference(previous) }, isSubmission: true)
            .WithDocuments(new[] { DocumentInfo.Create(docId, "s.csx", sourceCodeKind: SourceCodeKind.Script,
                loader: TextLoader.From(TextAndVersion.Create(SourceText.From(code), VersionStamp.Create()))) });
        _ws.AddProject(info);
        return pid;
    }

    /// <summary>Record a successfully executed submission; later editing contexts chain after it.</summary>
    public void Commit(string code)
    {
        _lastCommitted = AddSubmissionProject(code, _lastCommitted, out var d);
        _committedDocs.Add(d);
        _submissions.Add(code);
    }

    private Document Scratch(string text)
    {
        if (_scratch is { } old) _ws.TryApplyChanges(_ws.CurrentSolution.RemoveProject(old));
        _scratch = AddSubmissionProject(text, _lastCommitted, out var d);
        return _ws.CurrentSolution.GetDocument(d)!;
    }

    // ---- completion ----
    public async Task<CompletionResultDto?> CompleteAsync(string text, int pos, char? trigger = null, bool explicitRequest = false)
    {
        pos = Math.Clamp(pos, 0, text.Length);
        var doc = Scratch(text);
        var svc = CompletionService.GetService(doc);
        if (svc is null) return null;
        var t = trigger is null ? CompletionTrigger.Invoke : CompletionTrigger.CreateInsertionTrigger(trigger.Value);
        if (trigger is not null && !svc.ShouldTriggerCompletion(await doc.GetTextAsync(), pos, t)) return null;
        var list = await svc.GetCompletionsAsync(doc, pos, t);
        if (list is null || list.ItemsList.Count == 0) return null;
        var items = new List<CompletionDto>();
        foreach (var i in list.ItemsList)
        {
            var kind = i.Tags.FirstOrDefault() ?? "";
            var commit = i.Rules.CommitCharacterRules.SelectMany(r => r.Kind == CharacterSetModificationKind.Add ? r.Characters : Enumerable.Empty<char>())
                .Distinct().Select(c => c.ToString()).ToArray();
            items.Add(new CompletionDto(i.DisplayText, i.Properties.TryGetValue("InsertionText", out var ins) && ins.Length > 0 ? ins : i.DisplayText, kind, i.FilterText, i.SortText, commit, false, i.InlineDescription is { Length: > 0 } d ? d : null));
        }
        var span = list.Span;
        // keyword snippets (the Roslyn snippet service is VS-only): a few common statement templates
        if (trigger is null)
            foreach (var s in Snippets.ForPrefix(text.Substring(span.Start, span.Length)))
                items.Add(s);
        return new CompletionResultDto(span.Start, span.Length, items.ToArray());
    }

    /// <summary>The text edit for an item: Roslyn may change more than the typed word (e.g. adds a using or a suffix).</summary>
    public async Task<(int Start, int Length, string NewText, int? Caret)> GetChangeAsync(string text, int pos, string label)
    {
        var doc = Scratch(text);
        var svc = CompletionService.GetService(doc)!;
        var list = await svc.GetCompletionsAsync(doc, pos);
        var item = list!.ItemsList.First(i => i.DisplayText == label);
        var ch = await svc.GetChangeAsync(doc, item);
        var tc = ch.TextChange;
        return (tc.Span.Start, tc.Span.Length, tc.NewText ?? "", ch.NewPosition);
    }

    // ---- quick info ----
    public async Task<HoverDto?> QuickInfoAsync(string text, int pos)
    {
        pos = Math.Clamp(pos, 0, text.Length);
        var doc = Scratch(text);
        var svc = QuickInfoService.GetService(doc);
        if (svc is null) return null;
        var qi = await svc.GetQuickInfoAsync(doc, pos);
        if (qi is null) return null;
        var parts = qi.Sections.Select(s => string.Concat(s.TaggedParts.Select(p => p.Text))).Where(s => s.Length > 0);
        return new HoverDto(qi.Span.Start, qi.Span.Length, string.Join("\n\n", parts));
    }

    // ---- diagnostics ----
    public async Task<DiagnosticDto[]> DiagnosticsAsync(string text)
    {
        var doc = Scratch(text);
        var comp = (await doc.Project.GetCompilationAsync())!;
        var tree = await doc.GetSyntaxTreeAsync();
        return comp.GetDiagnostics().Where(d => d.Location.SourceTree == tree && d.Severity != DiagnosticSeverity.Hidden)
            .Select(d => new DiagnosticDto(d.Location.SourceSpan.Start, Math.Max(1, d.Location.SourceSpan.Length),
                d.Severity.ToString().ToLowerInvariant(), d.Id, d.GetMessage())).ToArray();
    }

    // ---- classification ----
    public async Task<ClassifiedSpanDto[]> ClassifyAsync(string text)
    {
        var doc = Scratch(text);
        return await ClassifyDocAsync(doc);
    }

    /// <summary>Classify a committed submission in its own context (index into the history of committed submissions).</summary>
    public async Task<ClassifiedSpanDto[]> ClassifyCommittedAsync(int index)
    {
        var doc = _ws.CurrentSolution.GetDocument(_committedDocs[index])!;
        return await ClassifyDocAsync(doc);
    }

    private static async Task<ClassifiedSpanDto[]> ClassifyDocAsync(Document doc)
    {
        var text = await doc.GetTextAsync();
        var spans = await Classifier.GetClassifiedSpansAsync(doc, new TextSpan(0, text.Length));
        return spans.Where(s => s.ClassificationType != ClassificationTypeNames.Text && s.ClassificationType != ClassificationTypeNames.StaticSymbol && s.TextSpan.Length > 0)
            .OrderBy(s => s.TextSpan.Start).ThenBy(s => s.TextSpan.Length)
            .Select(s => new ClassifiedSpanDto(s.TextSpan.Start, s.TextSpan.Length, s.ClassificationType)).ToArray();
    }

    // ---- signature help ----
    public async Task<SignatureHelpDto?> SignatureHelpAsync(string text, int pos)
    {
        pos = Math.Clamp(pos, 0, text.Length);
        var doc = Scratch(text);
        var root = await doc.GetSyntaxRootAsync();
        var model = await doc.GetSemanticModelAsync();
        if (root is null || model is null) return null;
        var token = root.FindToken(Math.Max(0, pos - 1));
        for (var node = token.Parent; node != null; node = node.Parent)
        {
            Microsoft.CodeAnalysis.CSharp.Syntax.ArgumentListSyntax? args = node switch
            {
                Microsoft.CodeAnalysis.CSharp.Syntax.InvocationExpressionSyntax i => i.ArgumentList,
                Microsoft.CodeAnalysis.CSharp.Syntax.ObjectCreationExpressionSyntax o => o.ArgumentList,
                _ => null
            };
            if (args is null || pos <= args.OpenParenToken.SpanStart || (!args.CloseParenToken.IsMissing && pos > args.CloseParenToken.SpanStart)) continue;
            var expr = node is Microsoft.CodeAnalysis.CSharp.Syntax.InvocationExpressionSyntax inv ? (SyntaxNode)inv.Expression : node;
            var info = model.GetSymbolInfo(node);
            var candidates = new List<IMethodSymbol>();
            if (info.Symbol is IMethodSymbol m) candidates.Add(m);
            candidates.AddRange(info.CandidateSymbols.OfType<IMethodSymbol>());
            if (node is Microsoft.CodeAnalysis.CSharp.Syntax.InvocationExpressionSyntax)
                candidates.AddRange(model.GetMemberGroup(expr).OfType<IMethodSymbol>());
            var all = candidates.GroupBy(c => c.OriginalDefinition.ToDisplayString()).Select(g => g.First())
                .OrderBy(c => c.Parameters.Length).ToList();
            if (all.Count == 0) continue;
            var argIndex = args.Arguments.GetSeparators().Count(s => s.SpanStart < pos);
            var fmt = SymbolDisplayFormat.MinimallyQualifiedFormat.WithParameterOptions(
                SymbolDisplayParameterOptions.IncludeType | SymbolDisplayParameterOptions.IncludeName | SymbolDisplayParameterOptions.IncludeDefaultValue | SymbolDisplayParameterOptions.IncludeParamsRefOut)
                .WithMemberOptions(SymbolDisplayMemberOptions.IncludeParameters | SymbolDisplayMemberOptions.IncludeContainingType | SymbolDisplayMemberOptions.IncludeType);
            var sigs = all.Select(c => new SignatureDto(c.ToDisplayString(fmt),
                c.Parameters.Select(p => p.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat.WithParameterOptions(
                    SymbolDisplayParameterOptions.IncludeType | SymbolDisplayParameterOptions.IncludeName | SymbolDisplayParameterOptions.IncludeDefaultValue | SymbolDisplayParameterOptions.IncludeParamsRefOut))).ToArray(),
                c.GetDocumentationCommentXml() is { Length: > 0 } x ? System.Text.RegularExpressions.Regex.Match(x, "<summary>(.*?)</summary>", System.Text.RegularExpressions.RegexOptions.Singleline).Groups[1].Value.Trim() : null)).ToArray();
            var best = info.Symbol as IMethodSymbol;
            int active;
            if (best is not null) active = all.FindIndex(c => SymbolEqualityComparer.Default.Equals(c, best));
            else
            {
                // incomplete call: pick the overload that fits the arguments typed so far (identity first, then implicit conversion)
                var types = args.Arguments.Take(argIndex).Select(a => model.GetTypeInfo(a.Expression).Type).ToList();
                bool Fits(IMethodSymbol c, bool exact) => c.Parameters.Length > argIndex && types.Select((t, i) =>
                    t is null || (exact ? SymbolEqualityComparer.Default.Equals(t, c.Parameters[i].Type) : model.Compilation.ClassifyConversion(t, c.Parameters[i].Type).IsImplicit)).All(x => x);
                active = all.FindIndex(c => Fits(c, true));
                if (active < 0) active = all.FindIndex(c => Fits(c, false));
                if (active < 0) active = all.FindIndex(c => c.Parameters.Length > argIndex);
            }
            return new SignatureHelpDto(sigs, Math.Max(active, 0), argIndex);
        }
        return null;
    }
}

internal static class Snippets
{
    private static readonly (string Key, string Body)[] All =
    {
        ("for", "for (int i = 0; i < n; i++)\n{\n    \n}"), ("foreach", "foreach (var item in items)\n{\n    \n}"),
        ("while", "while (cond)\n{\n    \n}"), ("if", "if (cond)\n{\n    \n}"), ("try", "try\n{\n    \n}\ncatch (Exception e)\n{\n    \n}"),
        ("switch", "switch (value)\n{\n    case 0:\n        break;\n    default:\n        break;\n}"),
        ("class", "class Name\n{\n    \n}"), ("using", "using (var x = new Disposable())\n{\n    \n}"),
        ("cw", "Console.WriteLine();"),
    };
    public static IEnumerable<CompletionDto> ForPrefix(string prefix)
    {
        if (prefix.Length == 0) yield break;
        foreach (var (k, b) in All)
            if (k.StartsWith(prefix, StringComparison.Ordinal))
                yield return new CompletionDto(k + " (snippet)", b, "Snippet", k, "0" + k, Array.Empty<string>(), true, null);
    }
}
