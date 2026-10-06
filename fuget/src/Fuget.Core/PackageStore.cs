using System.Text.Json;

namespace Fuget;

public static class NuGetUrls
{
    public const string FlatContainer = "https://api.nuget.org/v3-flatcontainer/";
    public const string Search = "https://azuresearch-usnc.nuget.org/query";
    public const string Autocomplete = "https://azuresearch-usnc.nuget.org/autocomplete";
    public static string Nupkg(string id, string version) { var l = id.ToLowerInvariant(); var v = version.ToLowerInvariant(); return $"{FlatContainer}{l}/{v}/{l}.{v}.nupkg"; }
    public static string Index(string id) => $"{FlatContainer}{id.ToLowerInvariant()}/index.json";

    /// <summary>Lower bound of a NuGet version range: "[1.2.3, )" -> 1.2.3, "1.2.3" -> 1.2.3, "(,2.0]" -> null (latest).</summary>
    public static string? MinVersion(string? range)
    {
        if (string.IsNullOrWhiteSpace(range)) return null;
        var first = range.Trim().TrimStart('[', '(').TrimEnd(']', ')').Split(',')[0].Trim();
        return first.Length == 0 ? null : first;
    }
}

/// <summary>Downloads (through the injected fetcher, which caches) and keeps opened packages.</summary>
public sealed class PackageStore
{
    private readonly Fetcher _fetch;
    private readonly Dictionary<string, Package> _open = new(StringComparer.OrdinalIgnoreCase);
    private readonly LinkedList<string> _lru = new();
    public int Capacity { get; set; } = 8;

    public PackageStore(Fetcher fetch) { _fetch = fetch; }

    public Fetcher Fetch => _fetch;

    public async Task<Package> GetAsync(string id, string? version)
    {
        version ??= await LatestStableAsync(id) ?? throw new InvalidOperationException($"package '{id}' not found");
        var key = id + "/" + version;
        if (_open.TryGetValue(key, out var p)) { _lru.Remove(key); _lru.AddFirst(key); return p; }
        var bytes = await _fetch(NuGetUrls.Nupkg(id, version)) ?? throw new InvalidOperationException($"package {id} {version} not found on nuget.org");
        p = new Package(bytes);
        _open[key] = p; _lru.AddFirst(key);
        while (_lru.Count > Capacity) { _open.Remove(_lru.Last!.Value); _lru.RemoveLast(); }
        return p;
    }

    public async Task<List<string>> VersionsAsync(string id)
    {
        var bytes = await _fetch(NuGetUrls.Index(id));
        if (bytes == null) return new();
        using var doc = JsonDocument.Parse(bytes);
        return doc.RootElement.GetProperty("versions").EnumerateArray().Select(v => v.GetString()!).ToList();
    }

    public async Task<string?> LatestStableAsync(string id)
    {
        var v = await VersionsAsync(id);
        return v.LastOrDefault(x => !x.Contains('-')) ?? v.LastOrDefault();
    }
}
