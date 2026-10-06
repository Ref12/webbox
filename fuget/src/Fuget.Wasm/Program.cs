using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Versioning;
using System.Text.Json;
using System.Text.Json.Serialization;
using Fuget;

Console.WriteLine("Fuget runtime started");

/// <summary>JS-callable surface. Every method returns a JSON string: the result, or { "error": "..." }.</summary>
[SupportedOSPlatform("browser")]
public static partial class Interop
{
    private static FugetService? _svc;
    private static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull };

    // JS side: fetch (Cache API first), park the bytes, hand them over (Task<byte[]> is not marshalled; same trick as the REPL).
    [JSImport("fetchAsset", "host")] private static partial Task FetchAssetJs(string url);
    [JSImport("takeAsset", "host")] private static partial byte[] TakeAssetJs(string url);

    private static async Task<byte[]?> Fetch(string url)
    {
        await FetchAssetJs(url);
        var b = TakeAssetJs(url);
        return b is null || b.Length == 0 ? null : b;   // an empty array means 404
    }

    private static FugetService Svc => _svc ??= new FugetService(Fetch);

    private static async Task<string> Run(Func<Task<object?>> body)
    {
        try { return JsonSerializer.Serialize(await body(), Json); }
        catch (Exception e) { return JsonSerializer.Serialize(new { error = e.GetType().Name + ": " + e.Message }, Json); }
    }

    /// <summary>JS passes ref/manifest.json (names of the reference assemblies hosted next to the app).</summary>
    [JSExport]
    public static void Configure(string manifestJson)
    {
        using var doc = JsonDocument.Parse(manifestJson);
        Svc.ConfigureReferencePack(doc.RootElement.GetProperty("assemblies").EnumerateArray().Select(a => a.GetProperty("name").GetString()!).ToList());
    }

    [JSExport] public static Task<string> Open(string id, string version) => Run(async () => await Svc.OpenAsync(id, version.Length == 0 ? null : version));
    [JSExport] public static Task<string> ReadAssembly(string id, string version, string dir, string assembly) => Run(async () => await Svc.ReadAssemblyAsync(id, version, dir, assembly));
    [JSExport] public static Task<string> Doc(string id, string version, string dir, string assembly, string docId) => Run(async () => (object?)await Svc.DocAsync(id, version, dir, assembly, docId) ?? new { });
    [JSExport] public static Task<string> Diff(string id, string oldVersion, string newVersion, string dir, string assembly) => Run(async () => await Svc.DiffAsync(id, oldVersion, newVersion, dir, assembly));
    [JSExport] public static Task<string> Decompile(string id, string version, string dir, string assembly, int token) => Run(async () => await Svc.DecompileAsync(id, version, dir, assembly, token));
}
