using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Versioning;
using SharpLab;

Console.WriteLine("SharpLab runtime started");

[SupportedOSPlatform("browser")]
public static partial class Interop
{
    private static readonly Playground Pg = new();

    // ---- host (JS) callbacks: fetch a site asset (cache first) and hand the bytes over (same pattern as csharp/) ----
    [JSImport("fetchAsset", "host")]
    private static partial Task FetchAssetJs(string path);
    [JSImport("takeAsset", "host")]
    private static partial byte[] TakeAssetJs(string path);

    private static async Task<byte[]?> FetchAsset(string path)
    {
        await FetchAssetJs(path);
        var b = TakeAssetJs(path);
        return b is null || b.Length == 0 ? null : b;
    }

    /// <summary>JS hands over the core reference bundle; returns the number of assemblies accepted.</summary>
    [JSExport] public static int AddReferenceBundle(byte[] bundle) => Pg.Refs.AddBundle(bundle);

    /// <summary>JS hands over ref/manifest.json: enables on-demand reference assemblies.</summary>
    [JSExport] public static void Configure(string manifestJson) => Pg.Resolver = new RefResolver(RefCatalog.Parse(manifestJson), Pg.Refs, FetchAsset);

    [JSExport] public static int ReferenceCount() => Pg.Refs.Count;

    /// <summary>Compile (and remember the assembly); JSON { success, isExe, ms, loaded, diagnostics[], size }.</summary>
    [JSExport] public static Task<string> Compile(string code, string settingsJson) => Pg.CompileAsync(code, settingsJson);
    [JSExport] public static string Syntax(string code, string settingsJson) => Pg.Syntax(code, settingsJson);
    [JSExport] public static string Il() => Pg.Il();
    [JSExport] public static string Decompile(int level) => Pg.Decompile(level);
    [JSExport] public static Task<string> Run() => Pg.RunAsync();
    [JSExport] public static string Verify() => Pg.Verify();
    /// <summary>The last compiled assembly, base64 (for the JIT tab's remote endpoint).</summary>
    [JSExport] public static string AssemblyBase64() => Pg.AssemblyBase64();
}
