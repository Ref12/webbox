using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace SharpLab;

/// <summary>Fetches an asset by site-relative path (e.g. "ref/a/System.Net.Http.dll") or absolute URL; null = not found. Implemented by JS (with Cache API) in the browser.</summary>
public delegate Task<byte[]?> AssetFetcher(string path);

/// <summary>ref/manifest.json: which reference assemblies exist, which are in the always-loaded core bundle, and which namespaces each defines.</summary>
public sealed class RefCatalog
{
    public string Version { get; private init; } = "";
    public IReadOnlyList<string> Core { get; private init; } = Array.Empty<string>();
    private readonly Dictionary<string, long> _size = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, List<string>> _byNamespace = new(StringComparer.Ordinal);
    private readonly Dictionary<string, List<string>> _bySegment = new(StringComparer.Ordinal);

    public static RefCatalog Parse(string json)
    {
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;
        var cat = new RefCatalog
        {
            Version = root.GetProperty("version").GetString() ?? "",
            Core = root.GetProperty("core").EnumerateArray().Select(e => e.GetString()!).ToList(),
        };
        foreach (var a in root.GetProperty("assemblies").EnumerateArray())
        {
            var name = a.GetProperty("name").GetString()!;
            cat._size[name] = a.GetProperty("size").GetInt64();
            foreach (var ns in a.GetProperty("ns").EnumerateArray())
            {
                var n = ns.GetString()!;
                if (!cat._byNamespace.TryGetValue(n, out var l)) cat._byNamespace[n] = l = new();
                l.Add(name);
                var seg = n[(n.LastIndexOf('.') + 1)..];
                if (!cat._bySegment.TryGetValue(seg, out var sl)) cat._bySegment[seg] = sl = new();
                if (!sl.Contains(name)) sl.Add(name);
            }
        }
        return cat;
    }

    public bool Has(string assembly) => _size.ContainsKey(assembly);
    public long SizeOf(string assembly) => _size.TryGetValue(assembly, out var s) ? s : 0;
    /// <summary>Assemblies defining a namespace given in full ("System.Net.Http") or by its last segment ("Http").</summary>
    public IReadOnlyList<string> ForNamespaceOrSegment(string word) => ForNamespace(word).Count > 0 ? ForNamespace(word) : _bySegment.TryGetValue(word, out var l) ? l : Array.Empty<string>();
    public IReadOnlyList<string> ForNamespace(string ns) => _byNamespace.TryGetValue(ns, out var l) ? l : Array.Empty<string>();
    public int Count => _size.Count;
}

/// <summary>#r handling: finds the directives of a submission and blanks them (same length, so positions stay valid) for the compiler.</summary>
public static class Directives
{
    public static (string Code, IReadOnlyList<string> References) Extract(string code)
    {
        if (!code.Contains("#r", StringComparison.Ordinal)) return (code, Array.Empty<string>());
        var tree = CSharpSyntaxTree.ParseText(code, new CSharpParseOptions(LanguageVersion.Latest, kind: SourceCodeKind.Script));
        var dirs = tree.GetCompilationUnitRoot().GetReferenceDirectives();
        if (dirs.Count == 0) return (code, Array.Empty<string>());
        var chars = code.ToCharArray();
        var refs = new List<string>();
        foreach (var d in dirs)
        {
            refs.Add(d.File.ValueText);
            for (var i = d.Span.Start; i < d.Span.End; i++) if (chars[i] != '\n' && chars[i] != '\r') chars[i] = ' ';
        }
        return (new string(chars), refs);
    }
}

/// <summary>
/// Loads reference assemblies when they are needed: for a `using` namespace, a `#r "System.Foo"`, or a name the compiler could not
/// find (CS0246/CS0103/CS0234 resolved through the type index, CS0012 through the assembly named in the message).
/// </summary>
public sealed class RefResolver
{
    private readonly RefCatalog _catalog;
    private readonly ReferenceStore _store;
    private readonly AssetFetcher _fetch;
    private Dictionary<string, string[]>? _types;
    private readonly HashSet<string> _loaded = new(StringComparer.OrdinalIgnoreCase);
    public int TypeIndexFetches { get; private set; }

    public RefResolver(RefCatalog catalog, ReferenceStore store, AssetFetcher fetch)
    {
        _catalog = catalog; _store = store; _fetch = fetch;
        foreach (var c in catalog.Core) _loaded.Add(c);
    }

    public IReadOnlyCollection<string> Loaded => _loaded;

    public async Task<bool> EnsureAsync(string assembly, List<string>? log = null)
    {
        if (!assembly.EndsWith(".dll", StringComparison.OrdinalIgnoreCase)) assembly += ".dll";
        if (_loaded.Contains(assembly)) return false;
        if (!_catalog.Has(assembly)) return false;
        var bytes = await _fetch("ref/a/" + assembly);
        if (bytes is null || !_store.TryAdd(assembly, bytes)) return false;
        _loaded.Add(assembly);
        log?.Add($"reference {assembly} ({bytes.Length / 1024} KB)");
        return true;
    }

    /// <summary>Syntax-only: assemblies for the namespaces in `using` directives.</summary>
    public async Task<bool> LoadForUsingsAsync(string code, List<string>? log = null)
    {
        var any = false;
        var tree = CSharpSyntaxTree.ParseText(code, new CSharpParseOptions(LanguageVersion.Latest, kind: SourceCodeKind.Script));
        foreach (var u in tree.GetCompilationUnitRoot().DescendantNodes().OfType<UsingDirectiveSyntax>())
        {
            if (u.Name is null) continue;
            foreach (var a in _catalog.ForNamespace(u.Name.ToString())) any |= await EnsureAsync(a, log);
        }
        return any;
    }

    /// <summary>Error-driven: assemblies that would resolve the given compile errors. Returns true when something was loaded (retry the compile).</summary>
    public async Task<bool> LoadForErrorsAsync(IEnumerable<Diagnostic> errors, List<string>? log = null)
    {
        var any = false;
        foreach (var d in errors.Where(e => e.Severity == DiagnosticSeverity.Error))
        {
            switch (d.Id)
            {
                case "CS0012":   // type defined in an assembly that is not referenced: "...assembly 'X, Version=...'"
                    var m = Regex.Match(d.GetMessage(), "assembly '([^',]+)");
                    if (m.Success) any |= await EnsureAsync(m.Groups[1].Value, log);
                    break;
                case "CS1969":   // dynamic needs Microsoft.CSharp
                    any |= await EnsureAsync("Microsoft.CSharp.dll", log);
                    break;
                case "CS0246": case "CS0103": case "CS0234": case "CS0400": case "CS0433": case "CS1061": case "CS0117":
                    if (d.Location.SourceTree is not { } st) break;
                    var word = st.GetText().ToString(d.Location.SourceSpan);
                    var gen = word.IndexOf('<'); if (gen > 0) word = word[..gen];
                    if (word.Contains('.'))   // a qualified name: the whole thing may be a namespace, else its last segment
                    {
                        var whole = _catalog.ForNamespace(word);
                        if (whole.Count > 0) { foreach (var a in whole) any |= await EnsureAsync(a, log); break; }
                        word = word[(word.LastIndexOf('.') + 1)..];
                    }
                    if (word.Length == 0 || !SyntaxFacts.IsValidIdentifier(word)) break;
                    // a namespace segment ("Http" in System.Net.Http)?
                    foreach (var a in _catalog.ForNamespaceOrSegment(word)) any |= await EnsureAsync(a, log);
                    if (d.Id is "CS1061" or "CS0117") break;   // member lookups: only the namespace/type rule below is cheap enough to skip
                    foreach (var a in await TypeAssembliesAsync(word)) any |= await EnsureAsync(a, log);
                    break;
            }
        }
        return any;
    }

    public async Task<IReadOnlyList<string>> TypeAssembliesAsync(string simpleName)
    {
        if (_types is null)
        {
            var bytes = await _fetch("ref/types.json");
            TypeIndexFetches++;
            _types = bytes is null ? new() : JsonSerializer.Deserialize<Dictionary<string, string[]>>(bytes) ?? new();
        }
        return _types.TryGetValue(simpleName, out var l) ? l : Array.Empty<string>();
    }
}
