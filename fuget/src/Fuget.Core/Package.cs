using System.IO.Compression;
using System.Xml.Linq;

namespace Fuget;

public sealed record DependencyInfo(string Id, string? Range);
public sealed record DependencyGroup(string TargetFramework, string Tfm, List<DependencyInfo> Dependencies);
public sealed record FrameworkInfo(string Kind, string Tfm, string Dir, List<string> Assemblies, List<string> DocFiles);

public sealed class NuspecInfo
{
    public string Id { get; set; } = ""; public string Version { get; set; } = "";
    public string? Authors { get; set; } public string? Description { get; set; } public string? Summary { get; set; }
    public string? ProjectUrl { get; set; } public string? License { get; set; } public string? LicenseUrl { get; set; }
    public string? Tags { get; set; } public string? Repository { get; set; } public string? Title { get; set; } public string? ReleaseNotes { get; set; }
    public List<DependencyGroup> DependencyGroups { get; set; } = new();
}

/// <summary>An opened .nupkg: nuspec, target frameworks (lib/ and ref/), and access to entries by path.</summary>
public sealed class Package
{
    private readonly ZipArchive _zip;
    private readonly Dictionary<string, ZipArchiveEntry> _entries = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, byte[]> _cache = new(StringComparer.OrdinalIgnoreCase);

    public byte[] Bytes { get; }
    public NuspecInfo Nuspec { get; }
    public List<FrameworkInfo> Frameworks { get; }

    public Package(byte[] nupkg)
    {
        Bytes = nupkg;
        _zip = new ZipArchive(new MemoryStream(nupkg), ZipArchiveMode.Read);
        foreach (var e in _zip.Entries) _entries[Uri.UnescapeDataString(e.FullName)] = e;
        var nuspecEntry = _entries.Values.FirstOrDefault(e => e.FullName.EndsWith(".nuspec", StringComparison.OrdinalIgnoreCase) && e.FullName.IndexOf('/') < 0)
            ?? throw new InvalidDataException("package has no .nuspec");
        using (var s = nuspecEntry.Open()) Nuspec = ParseNuspec(XDocument.Load(s));
        Frameworks = ListFrameworks(_entries.Keys);
    }

    public IEnumerable<string> EntryNames => _entries.Keys;
    public bool Has(string path) => _entries.ContainsKey(path);

    public byte[]? Read(string path)
    {
        if (_cache.TryGetValue(path, out var c)) return c;
        if (!_entries.TryGetValue(path, out var e)) return null;
        using var s = e.Open(); using var ms = new MemoryStream(); s.CopyTo(ms);
        return _cache[path] = ms.ToArray();
    }

    public FrameworkInfo? FindFramework(string dir) => Frameworks.FirstOrDefault(f => f.Dir.Equals(dir, StringComparison.OrdinalIgnoreCase));

    /// <summary>The XML doc file for an assembly: same folder first, then the same assembly in any other lib/ref folder.</summary>
    public string? FindDocPath(FrameworkInfo fw, string assemblyFile)
    {
        var xml = Path.ChangeExtension(assemblyFile, ".xml");
        var own = fw.Dir + "/" + xml;
        if (_entries.ContainsKey(own)) return own;
        foreach (var other in Frameworks.Where(f => f != fw))
            if (_entries.ContainsKey(other.Dir + "/" + xml)) return other.Dir + "/" + xml;
        return null;
    }

    public static NuspecInfo ParseNuspec(XDocument doc)
    {
        string? V(string n) => doc.Descendants().FirstOrDefault(e => e.Name.LocalName == n && e.Parent?.Name.LocalName == "metadata")?.Value.Trim();
        var info = new NuspecInfo
        {
            Id = V("id") ?? "", Version = V("version") ?? "", Authors = V("authors"), Description = V("description"), Summary = V("summary"),
            ProjectUrl = V("projectUrl"), LicenseUrl = V("licenseUrl"), Tags = V("tags"), Title = V("title"), ReleaseNotes = V("releaseNotes"),
        };
        var lic = doc.Descendants().FirstOrDefault(e => e.Name.LocalName == "license" && e.Parent?.Name.LocalName == "metadata");
        info.License = lic?.Value.Trim();
        var repo = doc.Descendants().FirstOrDefault(e => e.Name.LocalName == "repository");
        info.Repository = (string?)repo?.Attribute("url");
        var deps = doc.Descendants().FirstOrDefault(e => e.Name.LocalName == "dependencies");
        if (deps != null)
        {
            foreach (var g in deps.Elements().Where(e => e.Name.LocalName == "group"))
            {
                var tf = (string?)g.Attribute("targetFramework") ?? "";
                var list = g.Elements().Where(e => e.Name.LocalName == "dependency").Select(d => new DependencyInfo((string?)d.Attribute("id") ?? "", (string?)d.Attribute("version"))).ToList();
                info.DependencyGroups.Add(new DependencyGroup(tf, tf.Length == 0 ? "" : Tfm.Normalize(tf), list));
            }
            var flat = deps.Elements().Where(e => e.Name.LocalName == "dependency").Select(d => new DependencyInfo((string?)d.Attribute("id") ?? "", (string?)d.Attribute("version"))).ToList();
            if (flat.Count > 0) info.DependencyGroups.Add(new DependencyGroup("", "", flat));
        }
        return info;
    }

    public static List<FrameworkInfo> ListFrameworks(IEnumerable<string> entries)
    {
        var result = new Dictionary<string, FrameworkInfo>(StringComparer.OrdinalIgnoreCase);
        foreach (var e in entries)
        {
            var parts = e.Split('/');
            if (parts.Length != 3 || (parts[0] != "lib" && parts[0] != "ref")) continue;   // direct children of lib/<tfm>/ only: not culture sub-folders
            var file = parts[2];
            if (file == "_._") { GetOrAdd(); continue; }
            var isDll = file.EndsWith(".dll", StringComparison.OrdinalIgnoreCase) && !file.EndsWith(".resources.dll", StringComparison.OrdinalIgnoreCase);
            var isXml = file.EndsWith(".xml", StringComparison.OrdinalIgnoreCase);
            if (!isDll && !isXml) continue;
            var fw = GetOrAdd();
            (isDll ? fw.Assemblies : fw.DocFiles).Add(file);
            FrameworkInfo GetOrAdd()
            {
                var dir = parts[0] + "/" + parts[1];
                if (!result.TryGetValue(dir, out var f)) result[dir] = f = new FrameworkInfo(parts[0], Tfm.Normalize(parts[1]), dir, new(), new());
                return f;
            }
        }
        foreach (var f in result.Values) { f.Assemblies.Sort(StringComparer.OrdinalIgnoreCase); f.DocFiles.Sort(StringComparer.OrdinalIgnoreCase); }
        return result.Values.OrderBy(f => f.Kind == "lib" ? 0 : 1).ThenBy(f => Tfm.Order(f.Tfm)).ThenBy(f => f.Tfm, StringComparer.Ordinal).ToList();
    }

    /// <summary>Dependency group that applies to a lib folder: exact tfm, else best compatible, else the unconditional group.</summary>
    public DependencyGroup? DependenciesFor(string tfm)
    {
        var groups = Nuspec.DependencyGroups;
        var best = Tfm.Best(groups.Where(g => g.Tfm.Length > 0).Select(g => g.Tfm), tfm);
        return (best != null ? groups.FirstOrDefault(g => g.Tfm == best) : null) ?? groups.FirstOrDefault(g => g.Tfm.Length == 0);
    }
}
