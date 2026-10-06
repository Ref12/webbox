using System.IO.Compression;
using System.Text.Json;
using System.Xml.Linq;

namespace CsRepl;

public sealed record NuGetPackage(string Id, string Version, IReadOnlyList<(string Name, byte[] Bytes)> Assemblies, long DownloadBytes);

/// <summary>
/// `#r "nuget: Id, Version"` for the browser: downloads .nupkg files from nuget.org's flat container (CORS-enabled), picks the
/// best lib/ target framework for a .NET 10 browser-wasm runtime, follows nuspec dependencies (skipping packages the
/// framework already provides) and hands back plain assemblies. Native assets, analyzers and content are ignored.
/// </summary>
public sealed class NuGetResolver
{
    public const string FlatContainer = "https://api.nuget.org/v3-flatcontainer/";
    // Most specific first. runtimes/browser/lib/<tfm> is checked before lib/<tfm>.
    public static readonly string[] Tfms =
    {
        "net10.0", "net9.0", "net8.0", "net7.0", "net6.0", "net5.0", "netcoreapp3.1", "netcoreapp3.0", "netcoreapp2.1",
        "netstandard2.1", "netstandard2.0", "netstandard1.6", "netstandard1.5", "netstandard1.4", "netstandard1.3", "netstandard1.2", "netstandard1.1", "netstandard1.0",
    };

    private readonly AssetFetcher _fetch;
    private readonly Func<string, bool> _providedByFramework;
    private readonly Dictionary<string, NuGetPackage> _packages = new(StringComparer.OrdinalIgnoreCase);

    /// <param name="providedByFramework">true for an assembly/package id the runtime already ships (e.g. "System.Runtime"); not downloaded.</param>
    public NuGetResolver(AssetFetcher fetch, Func<string, bool>? providedByFramework = null)
    {
        _fetch = fetch;
        _providedByFramework = providedByFramework ?? (_ => false);
    }

    public IReadOnlyCollection<NuGetPackage> Packages => _packages.Values;

    /// <summary>Parses "nuget: Id, Version" / "nuget:Id" / "nuget: Id/Version"; version null = latest stable.</summary>
    public static (string Id, string? Version)? ParseDirective(string text)
    {
        text = text.Trim();
        if (!text.StartsWith("nuget:", StringComparison.OrdinalIgnoreCase)) return null;
        var rest = text[6..].Trim();
        var parts = rest.Split(new[] { ',', '/' }, 2, StringSplitOptions.TrimEntries);
        return parts[0].Length == 0 ? null : (parts[0], parts.Length > 1 && parts[1].Length > 0 ? parts[1] : null);
    }

    /// <summary>Resolves a package and its dependency closure; returns the packages newly loaded by this call, root first.</summary>
    public async Task<IReadOnlyList<NuGetPackage>> ResolveAsync(string id, string? version)
    {
        var added = new List<NuGetPackage>();
        await ResolveInto(id, version, added, 0);
        return added;
    }

    private async Task ResolveInto(string id, string? version, List<NuGetPackage> added, int depth)
    {
        if (_packages.ContainsKey(id) || depth > 8) return;
        var lower = id.ToLowerInvariant();
        version ??= await LatestStable(lower) ?? throw new InvalidOperationException($"NuGet package '{id}' not found on nuget.org");
        var nupkg = await _fetch($"{FlatContainer}{lower}/{version.ToLowerInvariant()}/{lower}.{version.ToLowerInvariant()}.nupkg")
            ?? throw new InvalidOperationException($"NuGet package {id} {version} not found on nuget.org");
        using var zip = new ZipArchive(new MemoryStream(nupkg), ZipArchiveMode.Read);
        var dlls = PickAssemblies(zip.Entries.Select(e => e.FullName).ToList());
        var list = new List<(string, byte[])>();
        foreach (var path in dlls)
        {
            using var s = zip.GetEntry(path)!.Open(); using var ms = new MemoryStream(); s.CopyTo(ms);
            list.Add((Path.GetFileName(path), ms.ToArray()));
        }
        var pkg = new NuGetPackage(id, version, list, nupkg.Length);
        _packages[id] = pkg; added.Add(pkg);

        var nuspec = zip.Entries.FirstOrDefault(e => e.FullName.EndsWith(".nuspec", StringComparison.OrdinalIgnoreCase));
        if (nuspec is null) return;
        using var ns = nuspec.Open();
        foreach (var (depId, depRange) in Dependencies(XDocument.Load(ns)))
        {
            if (_providedByFramework(depId) || depId.StartsWith("Microsoft.NETCore.", StringComparison.OrdinalIgnoreCase)
                || depId.Equals("NETStandard.Library", StringComparison.OrdinalIgnoreCase)) continue;
            await ResolveInto(depId, MinVersion(depRange), added, depth + 1);
        }
    }

    private async Task<string?> LatestStable(string lowerId)
    {
        var bytes = await _fetch($"{FlatContainer}{lowerId}/index.json");
        if (bytes is null) return null;
        using var doc = JsonDocument.Parse(bytes);
        var versions = doc.RootElement.GetProperty("versions").EnumerateArray().Select(v => v.GetString()!).ToList();
        return versions.LastOrDefault(v => !v.Contains('-')) ?? versions.LastOrDefault();
    }

    /// <summary>Lower bound of a NuGet version range: "[1.2.3, )" -> 1.2.3, "1.2.3" -> 1.2.3, "(,2.0]" -> null (latest).</summary>
    public static string? MinVersion(string? range)
    {
        if (string.IsNullOrWhiteSpace(range)) return null;
        var r = range.Trim().TrimStart('[', '(').TrimEnd(']', ')');
        var first = r.Split(',')[0].Trim();
        return first.Length == 0 ? null : first;
    }

    /// <summary>Dependencies of the best matching dependency group.</summary>
    public static IReadOnlyList<(string Id, string? Range)> Dependencies(XDocument nuspec)
    {
        var groups = nuspec.Descendants().Where(e => e.Name.LocalName == "group" && e.Parent?.Name.LocalName == "dependencies").ToList();
        var flat = nuspec.Descendants().Where(e => e.Name.LocalName == "dependency" && e.Parent?.Name.LocalName == "dependencies").ToList();
        IEnumerable<XElement> deps = flat;
        if (groups.Count > 0)
        {
            XElement? best = null; var bestRank = int.MaxValue;
            foreach (var g in groups)
            {
                var tf = NormalizeTfm((string?)g.Attribute("targetFramework") ?? "");
                var rank = Array.IndexOf(Tfms, tf);
                if (tf.Length == 0) rank = Tfms.Length;           // unconditional group: last resort
                if (rank >= 0 && rank < bestRank) { best = g; bestRank = rank; }
            }
            deps = best?.Elements().Where(e => e.Name.LocalName == "dependency") ?? Enumerable.Empty<XElement>();
        }
        return deps.Select(d => ((string)d.Attribute("id")!, (string?)d.Attribute("version"))).ToList();
    }

    /// <summary>".NETStandard2.0" -> "netstandard2.0", ".NETCoreApp3.1" -> "netcoreapp3.1", "net6.0" stays.</summary>
    public static string NormalizeTfm(string tf)
    {
        tf = tf.Trim().ToLowerInvariant();
        if (tf.StartsWith(".netstandard")) return "netstandard" + tf[".netstandard".Length..];
        if (tf.StartsWith(".netcoreapp")) return "netcoreapp" + tf[".netcoreapp".Length..];
        if (tf.StartsWith(".netframework")) return "net" + tf[".netframework".Length..].Replace(".", "");
        return tf;
    }

    /// <summary>Assemblies (lib/ or runtimes/browser/lib/) of the best target framework among the package entries.</summary>
    public static IReadOnlyList<string> PickAssemblies(IReadOnlyList<string> entries)
    {
        foreach (var prefix in new[] { "runtimes/browser/lib/", "lib/" })
            foreach (var tfm in Tfms)
            {
                var dir = prefix + tfm + "/";
                var hit = entries.Where(e => e.StartsWith(dir, StringComparison.OrdinalIgnoreCase) && e.EndsWith(".dll", StringComparison.OrdinalIgnoreCase)
                    && e.IndexOf('/', dir.Length) < 0).ToList();   // direct children only: no culture sub-folders
                if (hit.Count > 0) return hit;
            }
        return Array.Empty<string>();
    }
}
