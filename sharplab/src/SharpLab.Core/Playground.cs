using System.Text.Json;

namespace SharpLab;

/// <summary>
/// The one object the page talks to (through JSExport methods in SharpLab.Wasm): Compile() remembers the last successful assembly, then the
/// views (IL, C#, Run, Verify) are produced from it on demand, so only the visible tab costs time. All results are JSON/text strings.
/// </summary>
public sealed class Playground
{
    public static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    public ReferenceStore Refs { get; } = new();
    public RefResolver? Resolver { get; set; }
    private CompileResult? _last;
    private Settings _settings = new();

    public static Settings ParseSettings(string? json) =>
        string.IsNullOrWhiteSpace(json) ? new Settings() : JsonSerializer.Deserialize<Settings>(json, Json) ?? new Settings();

    public async Task<string> CompileAsync(string code, string settingsJson)
    {
        _settings = ParseSettings(settingsJson);
        _last = await Compiler.CompileAsync(code, _settings, Refs, Resolver);
        return JsonSerializer.Serialize(new { success = _last.Success, isExe = _last.IsExe, ms = _last.Milliseconds, loaded = _last.Loaded, diagnostics = _last.Diagnostics, size = _last.Assembly?.Length ?? 0 }, Json);
    }

    public async Task<string> DiagnoseAsync(string code, string settingsJson) =>
        JsonSerializer.Serialize(await Compiler.DiagnoseAsync(code, ParseSettings(settingsJson), Refs, Resolver), Json);

    public string Syntax(string code, string settingsJson) => SyntaxTreeModel.ToJson(code, ParseSettings(settingsJson));

    private byte[]? Assembly => _last?.Assembly;
    private const string NoAssembly = "// Fix the compile errors first: there is no assembly to show.";

    public string Il() => Assembly is { } a ? IlView.Disassemble(a) : NoAssembly;

    public string Decompile(int level) => Assembly is { } a ? DecompiledView.Decompile(a, Refs, level) : NoAssembly;

    public async Task<string> RunAsync()
    {
        if (_last?.Assembly is not { } a) return JsonSerializer.Serialize(new RunResult(false, "", "Fix the compile errors first: there is no program to run.", null, 0), Json);
        return JsonSerializer.Serialize(await Runner.RunAsync(a, _last.IsExe), Json);
    }

    public string Verify() => JsonSerializer.Serialize(Assembly is { } a ? IlVerifier.Verify(a, Refs)
        : new VerifyResult(true, false, Array.Empty<string>(), "Fix the compile errors first.", 0), Json);

    public string AssemblyBase64() => Assembly is { } a ? Convert.ToBase64String(a) : "";

    /// <summary>Plain-text size of what the page can offer: assembly bytes of the last compile (for the status line).</summary>
    public int LastAssemblySize => Assembly?.Length ?? 0;
}
