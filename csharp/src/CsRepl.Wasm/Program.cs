using System.Reflection;
using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Loader;
using System.Runtime.Versioning;
using System.Text.Json;
using CsRepl;

Console.WriteLine("CsRepl runtime started");

[SupportedOSPlatform("browser")]
public static partial class Interop
{
    private static readonly ReferenceStore Refs = new();
    private static ReplSession? _session;
    private static RefResolver? _resolver;
    private static NuGetResolver? _nuget;
    private static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    // ---- host (JS) callbacks: fetch a site asset or URL; JS caches in the Cache API and reports what it loaded ----
    [JSImport("fetchAsset", "host")]
    private static partial Task FetchAssetJs(string path);          // fetches (cache first) and parks the bytes on the JS side
    [JSImport("takeAsset", "host")]
    private static partial byte[] TakeAssetJs(string path);         // hands them over (Task<byte[]> is not marshalled)

    private static async Task<byte[]?> FetchAsset(string path)
    {
        await FetchAssetJs(path);
        var b = TakeAssetJs(path);
        return b is null || b.Length == 0 ? null : b;   // JS returns an empty array for "not found"
    }

    /// <summary>JS hands over the whole core bundle (refs of the always-loaded assemblies); returns the number accepted.</summary>
    [JSExport] public static int AddReferenceBundle(byte[] bundle) => Refs.AddBundle(bundle);

    /// <summary>JS hands over ref/manifest.json: enables on-demand reference assemblies and NuGet.</summary>
    [JSExport]
    public static void Configure(string manifestJson)
    {
        var catalog = RefCatalog.Parse(manifestJson);
        _resolver = new RefResolver(catalog, Refs, FetchAsset);
        _nuget = new NuGetResolver(FetchAsset, id => catalog.Has(id + ".dll"));
        _session = null;
    }

    [JSExport] public static int ReferenceCount() => Refs.Count;
    [JSExport] public static bool IsComplete(string code) => ReplSession.IsCompleteSubmission(code);

    [JSExport]
    public static void Reset()
    {
        _session?.Reset(); _committed.Clear();
        Bridge("Reset");
    }

    /// <summary>Runs one submission; returns a JSON SubmissionResult.</summary>
    [JSExport]
    public static async Task<string> Submit(string code)
    {
        _session ??= new ReplSession(Refs, _resolver, _nuget);
        var r = await _session.SubmitAsync(code);
        if (r.Success)
        {
            var clean = Directives.Extract(code).Code;
            _committed.Add(clean);
            if (_intelliReady)
            {
                if (r.Loaded is { Count: > 0 }) Bridge("SetReferences", Refs.References);
                Bridge("Commit", clean);
            }
        }
        return JsonSerializer.Serialize(r, Json);
    }

    // ---- IntelliSense: Microsoft.CodeAnalysis.Features & co. arrive after first paint, as plain assemblies ----
    private static readonly Dictionary<string, byte[]> Lazy = new(StringComparer.OrdinalIgnoreCase);
    private static readonly List<string> _committed = new();
    private static bool _intelliReady, _resolverHooked;
    private static Assembly? _intelliAsm;

    [JSExport]
    public static void AddLazyAssembly(string fileName, byte[] bytes)
    {
        Lazy[fileName] = bytes;
        if (_resolverHooked) return;
        _resolverHooked = true;
        AssemblyLoadContext.Default.Resolving += (ctx, name) =>
            Lazy.TryGetValue(name.Name + ".dll", out var b) ? ctx.LoadFromStream(new MemoryStream(b)) : null;
    }

    /// <summary>Loads the IntelliSense assembly (and, through the resolver above, Features/Workspaces) and replays the submissions so far.</summary>
    [JSExport]
    public static void StartIntellisense(string entry)
    {
        _intelliAsm = AssemblyLoadContext.Default.LoadFromStream(new MemoryStream(Lazy[entry]));
        Bridge("Init", Refs.References);
        _intelliReady = true;
        foreach (var c in _committed) Bridge("Commit", c);
    }

    [JSExport] public static bool IntellisenseReady() => _intelliReady;

    private static object? Bridge(string method, params object[] args)
    {
        var t = _intelliAsm?.GetType("CsRepl.Intellisense.Bridge");
        if (t is null) return null;
        return t.GetMethod(method)!.Invoke(null, args);
    }

    /// <summary>
    /// op: Complete | Change | QuickInfo | Signature | Diagnostics | Classify | ClassifyCommitted. Returns JSON ("null" when not ready).
    /// `#r` lines are blanked first (same length), as for compilation.
    /// </summary>
    [JSExport]
    public static async Task<string> Intelli(string op, string text, int pos, string extra)
    {
        if (!_intelliReady) return "null";
        var clean = Directives.Extract(text).Code;
        if (op != "ClassifyCommitted" && _resolver is not null && await _resolver.LoadForUsingsAsync(clean))
            Bridge("SetReferences", Refs.References);
        var task = op switch
        {
            "Complete" => Bridge("Complete", clean, pos, extra),
            "Change" => Bridge("Change", clean, pos, extra),
            "QuickInfo" => Bridge("QuickInfo", clean, pos),
            "Signature" => Bridge("Signature", clean, pos),
            "Diagnostics" => Bridge("Diagnostics", clean),
            "Classify" => Bridge("Classify", clean),
            "ClassifyCommitted" => Bridge("ClassifyCommitted", pos),
            _ => null
        };
        return task is null ? "null" : await (Task<string>)task;
    }
}
