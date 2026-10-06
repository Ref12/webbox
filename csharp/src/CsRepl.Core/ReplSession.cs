using System.Reflection;
using System.Runtime.Loader;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Emit;

namespace CsRepl;

/// <summary>Outcome of one submission.</summary>
public sealed record SubmissionResult(
    bool Success, string? Value, string Output, string? Error, IReadOnlyList<string> Diagnostics, double Milliseconds, IReadOnlyList<string>? Loaded = null);

/// <summary>
/// A csi-style session built directly on CSharpCompilation.CreateScriptCompilation (not CSharpScript):
/// the scripting layer always adds a reference to typeof(object).Assembly, which has no file location in the
/// browser (Webcil / bundled), so we drive the compiler ourselves. Each Submit compiles one submission chained to
/// the previous compilation (variables, usings, methods, types carry over), emits it to a byte array, loads it with
/// Assembly.Load and runs the generated submission factory.
/// </summary>
public sealed class ReplSession
{
    private static readonly string[] DefaultImports =
        { "System", "System.IO", "System.Linq", "System.Collections.Generic", "System.Threading.Tasks", "System.Text" };

    private readonly Func<IReadOnlyCollection<MetadataReference>> _references;
    private readonly RefResolver? _resolver;
    private readonly NuGetResolver? _nuget;
    private readonly CSharpParseOptions _parseOptions = new(LanguageVersion.Latest, kind: SourceCodeKind.Script);
    private readonly CSharpCompilationOptions _compilationOptions;
    private readonly Dictionary<string, Assembly> _loaded = new();
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly ReferenceStore? _store;
    private CSharpCompilation? _previous;
    private object?[] _submissionArray = new object?[2];

    public ReplSession(IEnumerable<MetadataReference> references) : this(references.ToList(), null, null, null) { }

    /// <summary>Session over a growing reference set: `resolver` loads reference assemblies on demand, `nuget` serves #r "nuget: ...".</summary>
    public ReplSession(ReferenceStore store, RefResolver? resolver, NuGetResolver? nuget) : this(null, store, resolver, nuget) { }

    private ReplSession(IReadOnlyCollection<MetadataReference>? fixedRefs, ReferenceStore? store, RefResolver? resolver, NuGetResolver? nuget)
    {
        _references = fixedRefs is not null ? () => fixedRefs : () => store!.References;
        _store = store; _resolver = resolver; _nuget = nuget;
        _compilationOptions = new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary,
                usings: DefaultImports, optimizationLevel: OptimizationLevel.Release,
                concurrentBuild: false /* single-threaded in the browser */)
            .WithMetadataImportOptions(MetadataImportOptions.All);
    }

    public int SubmissionCount { get; private set; }

    /// <summary>Quick syntax check so a UI can tell "incomplete, keep typing" from "ready to run".</summary>
    public static bool IsCompleteSubmission(string code) =>
        SyntaxFactory.IsCompleteSubmission(CSharpSyntaxTree.ParseText(code,
            new CSharpParseOptions(LanguageVersion.Latest, kind: SourceCodeKind.Script)));

    public async Task<SubmissionResult> SubmitAsync(string code)
    {
        await _gate.WaitAsync();
        var sw = System.Diagnostics.Stopwatch.StartNew();
        var stdout = new StringWriter();
        var oldOut = Console.Out; var oldErr = Console.Error;
        ResolveEventHandler resolver = (_, a) => _loaded.TryGetValue(new AssemblyName(a.Name).Name ?? "", out var asm) ? asm : null;
        AppDomain.CurrentDomain.AssemblyResolve += resolver;
        try
        {
            var loaded = new List<string>();
            var (clean, rdirs) = Directives.Extract(code);
            foreach (var d in rdirs)
            {
                var err = await LoadDirectiveAsync(d, loaded);
                if (err is not null) return new(false, null, "", null, new[] { err }, sw.Elapsed.TotalMilliseconds, loaded);
            }
            if (_resolver is not null) await _resolver.LoadForUsingsAsync(clean, loaded);
            var name = "Submission" + Guid.NewGuid().ToString("N");
            CSharpCompilation compilation; MemoryStream peStream; EmitResult emit;
            for (var attempt = 0; ; attempt++)
            {
                var tree = CSharpSyntaxTree.ParseText(clean, _parseOptions);
                compilation = CSharpCompilation.CreateScriptCompilation(name, tree, _references(), _compilationOptions,
                    _previous, returnType: null);
                peStream = new MemoryStream();
                emit = compilation.Emit(peStream);
                // Missing reference assemblies are fetched when a compile error says they are needed, then we retry.
                if (emit.Success || _resolver is null || attempt >= 6) break;
                if (!await _resolver.LoadForErrorsAsync(emit.Diagnostics, loaded)) break;
            }
            using var _pe = peStream;
            if (!emit.Success && !emit.Diagnostics.Any(d => d.Severity == DiagnosticSeverity.Error))
            {
                // Nothing to emit (e.g. a using-only submission): keep its effect on the chain, run nothing.
                _previous = compilation;
                SubmissionCount++;
                Array.Resize(ref _submissionArray, SubmissionCount + 2);
                return new(true, null, "", null, Array.Empty<string>(), sw.Elapsed.TotalMilliseconds, loaded);
            }
            if (!emit.Success)
            {
                var errs = emit.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error)
                    .Select(d => d.ToString()).ToList();
                return new(false, null, "", null, errs, sw.Elapsed.TotalMilliseconds, loaded);
            }

            var assembly = Assembly.Load(peStream.ToArray());
            _loaded[name] = assembly;

            var submissionType = assembly.GetTypes().FirstOrDefault(t => t.GetMethod("<Factory>", BindingFlags.Public | BindingFlags.Static | BindingFlags.NonPublic) != null)
                ?? throw new InvalidOperationException("no submission type among: " + string.Join(", ", assembly.GetTypes().Select(t => t.FullName)));
            var factory = submissionType.GetMethod("<Factory>", BindingFlags.Public | BindingFlags.Static | BindingFlags.NonPublic)
                          ?? throw new InvalidOperationException("submission factory not found");

            var array = new object?[SubmissionCount + 2];
            Array.Copy(_submissionArray, array, Math.Min(_submissionArray.Length, array.Length));

            Console.SetOut(stdout); Console.SetError(stdout);
            object? value;
            try
            {
                var task = (Task<object?>)factory.Invoke(null, new object[] { array })!;
                value = await task;
            }
            catch (Exception e)
            {
                // Runtime exception from user code: the session continues from the previous submission.
                return new(false, null, stdout.ToString(), ResultFormatter.FormatException(e), Array.Empty<string>(),
                    sw.Elapsed.TotalMilliseconds, loaded);
            }
            finally { Console.SetOut(oldOut); Console.SetError(oldErr); }

            _previous = compilation;
            _submissionArray = array;
            SubmissionCount++;
            return new(true, value is null ? null : ResultFormatter.Format(value), stdout.ToString(), null,
                Array.Empty<string>(), sw.Elapsed.TotalMilliseconds, loaded);
        }
        finally
        {
            AppDomain.CurrentDomain.AssemblyResolve -= resolver;
            _gate.Release();
        }
    }

    /// <summary>Handles one #r: a nuget package, or a framework assembly name.</summary>
    private async Task<string?> LoadDirectiveAsync(string directive, List<string> loaded)
    {
        if (NuGetResolver.ParseDirective(directive) is { } n)
        {
            if (_nuget is null || _store is null) return "#r \"nuget:\" is not available in this session";
            try
            {
                foreach (var pkg in await _nuget.ResolveAsync(n.Id, n.Version))
                {
                    var ok = 0;
                    foreach (var (an, bytes) in pkg.Assemblies)
                    {
                        if (!_store.TryAdd(an, bytes)) continue;
                        ok++;
                        try { _loaded[Path.GetFileNameWithoutExtension(an)] = Assembly.Load(bytes); } catch (Exception) { /* e.g. already loaded */ }
                    }
                    loaded.Add($"nuget {pkg.Id} {pkg.Version} ({ok} assemblies, {pkg.DownloadBytes / 1024} KB)");
                }
                return null;
            }
            catch (Exception e) { return $"#r \"{directive}\": {e.Message}"; }
        }
        var file = Path.GetFileName(directive.Trim());
        if (_resolver is not null && (await _resolver.EnsureAsync(file, loaded) || _resolver.Loaded.Contains(file.EndsWith(".dll", StringComparison.OrdinalIgnoreCase) ? file : file + ".dll"))) return null;
        return $"#r \"{directive}\": no such reference assembly or NuGet package (use #r \"nuget: Id, Version\" or a framework assembly name)";
    }

    public void Reset() { _previous = null; _submissionArray = new object?[2]; SubmissionCount = 0; _loaded.Clear(); }
}
