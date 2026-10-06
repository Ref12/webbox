using System.Reflection;
using System.Runtime.Loader;

namespace WebBox.Intellisense;

/// <summary>
/// Lazy loading and invocation of WebBox.Intellisense inside a Wasm app (used by the "intelli" worker of csharp/ and sharplab/).
/// The page fetches the IntelliSense assemblies as plain PE files and hands them over one by one (AddLazy); Start loads the entry assembly,
/// whose dependencies (Features, Workspaces, System.Composition...) are resolved from the same set.
/// </summary>
public static class IntelliHost
{
    private static readonly Dictionary<string, byte[]> Lazy = new(StringComparer.OrdinalIgnoreCase);
    private static bool _hooked;
    private static Assembly? _asm;
    private static string? _optionsJson;

    public static bool Ready { get; private set; }

    public static void AddLazy(string fileName, byte[] bytes)
    {
        Lazy[fileName] = bytes;
        if (_hooked) return;
        _hooked = true;
        AssemblyLoadContext.Default.Resolving += (ctx, name) =>
            Lazy.TryGetValue(name.Name + ".dll", out var b) ? ctx.LoadFromStream(new MemoryStream(b)) : null;
    }

    /// <summary>Loads the entry assembly and initialises the workspace with the app's metadata references (an IEnumerable of MetadataReference).</summary>
    public static void Start(string entry, object references)
    {
        _asm = AssemblyLoadContext.Default.LoadFromStream(new MemoryStream(Lazy[entry]));
        Invoke("Init", references);
        Ready = true;
    }

    /// <summary>Runs a static Bridge method; null when IntelliSense is not loaded.</summary>
    public static object? Invoke(string method, params object[] args) =>
        _asm?.GetType("WebBox.Intellisense.Bridge")?.GetMethod(method)!.Invoke(null, args);

    /// <summary>The Bridge for an op: Complete | Describe | Change | QuickInfo | Signature | Diagnostics | Classify | ClassifyCommitted. JSON, "null" when not ready.</summary>
    public static async Task<string> Call(string op, string text, int pos, string extra)
    {
        if (!Ready) return "null";
        var task = op switch
        {
            "Complete" => Invoke("Complete", text, pos, extra),
            "Describe" => Invoke("Describe", text, pos, extra),
            "Change" => Invoke("Change", text, pos, extra),
            "QuickInfo" => Invoke("QuickInfo", text, pos),
            "Signature" => Invoke("Signature", text, pos),
            "Diagnostics" => Invoke("Diagnostics", text),
            "Classify" => Invoke("Classify", text),
            "ClassifyCommitted" => Invoke("ClassifyCommitted", pos),
            _ => null
        };
        return task is null ? "null" : await (Task<string>)task;
    }

    /// <summary>Apply workspace options (JSON, see IntelliOptions) when they differ from the ones in force.</summary>
    public static async Task Configure(string optionsJson)
    {
        if (!Ready || optionsJson == _optionsJson) return;
        _optionsJson = optionsJson;
        await (Task)Invoke("Configure", optionsJson)!;
    }
}
