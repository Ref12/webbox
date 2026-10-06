using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace SharpLab;

/// <summary>What the user can change in the options bar; it is also what a share link carries next to the code.</summary>
public sealed record Settings
{
    /// <summary>"debug" or "release": the build configuration (defines DEBUG in debug).</summary>
    public string Configuration { get; init; } = "release";
    /// <summary>Compiler optimizations. Defaults to what the configuration implies (release = on) but can be set independently.</summary>
    public bool Optimize { get; init; } = true;
    /// <summary>"latest", "preview", "default" or a number: 8, 9, ... 14 (also "7.3").</summary>
    public string LangVersion { get; init; } = "latest";
    /// <summary>How high-level the decompiled C# is: 1 = nearly raw, 2 = lowered (state machines, closures, display classes visible), 3 = full ILSpy output.</summary>
    public int Level { get; init; } = 2;
    /// <summary>"auto" (console app when there is a Main / top-level statements, else library), "exe" or "dll".</summary>
    public string Output { get; init; } = "auto";

    public bool IsDebug => string.Equals(Configuration, "debug", StringComparison.OrdinalIgnoreCase);

    public static readonly string[] LangVersions = { "7.3", "8", "9", "10", "11", "12", "13", "14", "preview", "latest" };

    public LanguageVersion ParseLanguageVersion() =>
        LanguageVersionFacts.TryParse(LangVersion, out var v) ? v : LanguageVersion.Latest;
}

public sealed record DiagInfo(string Id, string Severity, string Message, int Start, int End, int StartLine, int StartColumn, int EndLine, int EndColumn);

public sealed record CompileResult(bool Success, byte[]? Assembly, IReadOnlyList<DiagInfo> Diagnostics, bool IsExe, double Milliseconds, IReadOnlyList<string> Loaded);

/// <summary>Compiles the playground source with Roslyn against the reference assemblies the page has loaded (ref pack, fetched on demand).</summary>
public static class Compiler
{
    public static CSharpParseOptions ParseOptions(Settings s) =>
        new(s.ParseLanguageVersion(), DocumentationMode.None, SourceCodeKind.Regular,
            s.IsDebug ? new[] { "DEBUG", "TRACE" } : new[] { "TRACE", "RELEASE" });

    /// <summary>Console app when the text has top-level statements or a static Main, else a library.</summary>
    public static bool LooksLikeProgram(SyntaxTree tree)
    {
        var root = tree.GetRoot();
        if (root is CompilationUnitSyntax cu && cu.Members.OfType<GlobalStatementSyntax>().Any()) return true;
        return root.DescendantNodes().OfType<MethodDeclarationSyntax>()
            .Any(m => m.Identifier.ValueText == "Main" && m.Modifiers.Any(SyntaxKind.StaticKeyword));
    }

    public static CSharpCompilation Create(string code, Settings s, IEnumerable<MetadataReference> refs, bool exe)
    {
        var tree = CSharpSyntaxTree.ParseText(code, ParseOptions(s), path: "Program.cs", encoding: Encoding.UTF8);
        var options = new CSharpCompilationOptions(exe ? OutputKind.ConsoleApplication : OutputKind.DynamicallyLinkedLibrary,
                optimizationLevel: s.Optimize ? OptimizationLevel.Release : OptimizationLevel.Debug,
                allowUnsafe: true, concurrentBuild: false /* single thread in the browser */,
                deterministic: true, nullableContextOptions: NullableContextOptions.Disable)
            .WithMetadataImportOptions(MetadataImportOptions.All);
        return CSharpCompilation.Create("SharpLabApp", new[] { tree }, refs, options);
    }

    public static async Task<CompileResult> CompileAsync(string code, Settings s, ReferenceStore store, RefResolver? resolver = null)
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();
        var loaded = new List<string>();
        var exe = s.Output switch { "exe" => true, "dll" => false, _ => LooksLikeProgram(CSharpSyntaxTree.ParseText(code, ParseOptions(s))) };
        if (resolver is not null) await resolver.LoadForUsingsAsync(code, loaded);
        for (var attempt = 0; ; attempt++)
        {
            var compilation = Create(code, s, store.References, exe);
            using var pe = new MemoryStream();
            var emit = compilation.Emit(pe);
            var errors = emit.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error).ToList();
            if (!emit.Success && s.Output == "auto" && exe && errors.Count > 0 && errors.All(d => d.Id == "CS5001")) { exe = false; continue; }
            if (!emit.Success && resolver is not null && attempt < 6 && await resolver.LoadForErrorsAsync(emit.Diagnostics, loaded)) continue;
            return new(emit.Success, emit.Success ? pe.ToArray() : null,
                emit.Diagnostics.Where(d => d.Severity != DiagnosticSeverity.Hidden).Select(ToInfo).OrderBy(d => d.Start).ToList(),
                exe, sw.Elapsed.TotalMilliseconds, loaded);
        }
    }

    /// <summary>Diagnostics only (what the squiggles are made of): parse + bind, no emit.</summary>
    public static async Task<IReadOnlyList<DiagInfo>> DiagnoseAsync(string code, Settings s, ReferenceStore store, RefResolver? resolver = null)
    {
        var exe = s.Output switch { "exe" => true, "dll" => false, _ => LooksLikeProgram(CSharpSyntaxTree.ParseText(code, ParseOptions(s))) };
        if (resolver is not null) await resolver.LoadForUsingsAsync(code);
        for (var attempt = 0; ; attempt++)
        {
            var compilation = Create(code, s, store.References, exe);
            var diags = compilation.GetDiagnostics().Where(d => d.Severity != DiagnosticSeverity.Hidden).ToList();
            if (resolver is not null && attempt < 6 && diags.Any(d => d.Severity == DiagnosticSeverity.Error) && await resolver.LoadForErrorsAsync(diags)) continue;
            return diags.Select(ToInfo).OrderBy(d => d.Start).ToList();
        }
    }

    private static DiagInfo ToInfo(Diagnostic d)
    {
        var span = d.Location.SourceSpan;
        var lines = d.Location.GetLineSpan();
        var sev = d.Severity switch { DiagnosticSeverity.Error => "error", DiagnosticSeverity.Warning => "warning", DiagnosticSeverity.Info => "info", _ => "hidden" };
        return new(d.Id, sev, d.GetMessage(), span.Start, span.End,
            lines.StartLinePosition.Line + 1, lines.StartLinePosition.Character + 1, lines.EndLinePosition.Line + 1, lines.EndLinePosition.Character + 1);
    }
}
