using System.Text.Json;
using Microsoft.CodeAnalysis;

namespace CsRepl.Intellisense;

/// <summary>
/// String-in/string-out entry points. The wasm app does not reference this assembly (it is loaded lazily after first paint,
/// together with Microsoft.CodeAnalysis.Features and friends) and calls these by reflection, so everything crossing the
/// boundary is plain JSON text.
/// </summary>
public static class Bridge
{
    private static IntelliService? _svc;
    private static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    private static readonly SemaphoreSlim Gate = new(1, 1);

    public static void Init(IEnumerable<MetadataReference> refs) => _svc = new IntelliService(refs);
    public static void SetReferences(IEnumerable<MetadataReference> refs) => _svc!.SetReferences(refs);
    public static void Commit(string code) => _svc!.Commit(code);
    public static void Reset() => _svc!.Reset();

    private static async Task<string> Run<T>(Func<IntelliService, Task<T>> f)
    {
        await Gate.WaitAsync();   // the workspace is single-threaded state
        try { return JsonSerializer.Serialize(await f(_svc!), Json); }
        finally { Gate.Release(); }
    }

    public static Task<string> Complete(string text, int pos, string trigger) => Run(s => s.CompleteAsync(text, pos, trigger.Length > 0 ? trigger[0] : null));
    public static Task<string> Change(string text, int pos, string label) => Run(async s => await s.GetChangeAsync(text, pos, label));
    public static Task<string> QuickInfo(string text, int pos) => Run(s => s.QuickInfoAsync(text, pos));
    public static Task<string> Signature(string text, int pos) => Run(s => s.SignatureHelpAsync(text, pos));
    public static Task<string> Diagnostics(string text) => Run(s => s.DiagnosticsAsync(text));
    public static Task<string> Classify(string text) => Run(s => s.ClassifyAsync(text));
    public static Task<string> ClassifyCommitted(int index) => Run(s => s.ClassifyCommittedAsync(index));
}
