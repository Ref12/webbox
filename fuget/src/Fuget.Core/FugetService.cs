namespace Fuget;

public sealed class PackageSummary
{
    public string Id { get; set; } = ""; public string Version { get; set; } = "";
    public long Size { get; set; }
    public NuspecInfo Nuspec { get; set; } = new();
    public List<FrameworkInfo> Frameworks { get; set; } = new();
}

/// <summary>The app's non-UI logic: open a package, read an assembly's API with docs, diff two versions, decompile. UI-free so it is unit-tested on Linux and Windows.</summary>
public sealed class FugetService
{
    private readonly Dictionary<string, AssemblyApi> _apis = new();
    private readonly Dictionary<string, DocFile?> _docs = new();
    private DecompilerService? _decompiler;
    public PackageStore Store { get; }

    public FugetService(Fetcher fetch) { Store = new PackageStore(fetch); }

    /// <summary>Names of the reference assemblies the site hosts under ref/a/ (from ref/manifest.json); enables decompiling against them.</summary>
    public void ConfigureReferencePack(IEnumerable<string> names) => _decompiler = new DecompilerService(Store, Store.Fetch, names);

    public async Task<PackageSummary> OpenAsync(string id, string? version)
    {
        var p = await Store.GetAsync(id, version);
        return new PackageSummary { Id = p.Nuspec.Id, Version = p.Nuspec.Version, Size = p.Bytes.Length, Nuspec = p.Nuspec, Frameworks = p.Frameworks };
    }

    private async Task<(Package P, FrameworkInfo Fw)> Locate(string id, string version, string dir)
    {
        var p = await Store.GetAsync(id, version);
        var fw = p.FindFramework(dir) ?? throw new InvalidOperationException($"{id} {version} has no {dir}");
        return (p, fw);
    }

    public async Task<AssemblyApi> ReadAssemblyAsync(string id, string version, string dir, string assembly)
    {
        var key = $"{id}/{version}/{dir}/{assembly}".ToLowerInvariant();
        if (_apis.TryGetValue(key, out var cached)) return cached;
        var (p, fw) = await Locate(id, version, dir);
        var file = fw.Assemblies.FirstOrDefault(a => a.Equals(assembly, StringComparison.OrdinalIgnoreCase) || Path.GetFileNameWithoutExtension(a).Equals(assembly, StringComparison.OrdinalIgnoreCase))
            ?? throw new InvalidOperationException($"{dir} has no assembly {assembly}");
        var bytes = p.Read(dir + "/" + file)!;
        var docs = LoadDocs(p, fw, file);
        _docs[key] = docs;
        return _apis[key] = ApiReader.Read(bytes, docs);
    }

    private static DocFile? LoadDocs(Package p, FrameworkInfo fw, string file)
    {
        var path = p.FindDocPath(fw, file);
        var bytes = path == null ? null : p.Read(path);
        return bytes == null ? null : DocFile.Parse(System.Text.Encoding.UTF8.GetString(bytes).TrimStart('\uFEFF'));
    }

    public async Task<DocEntry?> DocAsync(string id, string version, string dir, string assembly, string docId)
    {
        await ReadAssemblyAsync(id, version, dir, assembly);
        var key = $"{id}/{version}/{dir}/{assembly}".ToLowerInvariant();
        return _docs.TryGetValue(key, out var d) ? d?.Find(docId) : null;
    }

    public async Task<DiffResult> DiffAsync(string id, string oldVersion, string newVersion, string dir, string assembly)
    {
        var np = await Store.GetAsync(id, newVersion);
        var op = await Store.GetAsync(id, oldVersion);
        var nfw = np.FindFramework(dir) ?? throw new InvalidOperationException($"{id} {newVersion} has no {dir}");
        string Name(string a) => Path.GetFileNameWithoutExtension(a);
        var oldCandidates = op.Frameworks.Where(f => f.Kind == nfw.Kind && f.Assemblies.Any(a => Name(a).Equals(assembly, StringComparison.OrdinalIgnoreCase))).ToList();
        var oldTfm = oldCandidates.Any(f => f.Dir == dir) ? nfw.Tfm : Tfm.Best(oldCandidates.Select(f => f.Tfm), nfw.Tfm);
        var ofw = oldCandidates.FirstOrDefault(f => f.Tfm == oldTfm);
        var newApi = await ReadAssemblyAsync(id, newVersion, dir, assembly);
        var oldApi = ofw == null ? null : await ReadAssemblyAsync(id, oldVersion, ofw.Dir, assembly);
        var res = ApiDiff.Compare(oldApi, newApi);
        res.OldDir = ofw?.Dir; res.NewDir = dir; res.Assembly = assembly;
        return res;
    }

    public async Task<DecompileResult> DecompileAsync(string id, string version, string dir, string assembly, int token)
    {
        if (_decompiler == null) throw new InvalidOperationException("decompiler is not configured (ConfigureReferencePack)");
        var (p, fw) = await Locate(id, version, dir);
        var file = fw.Assemblies.First(a => a.Equals(assembly, StringComparison.OrdinalIgnoreCase) || Path.GetFileNameWithoutExtension(a).Equals(assembly, StringComparison.OrdinalIgnoreCase));
        return await _decompiler.DecompileAsync(p, fw, file, token);
    }
}
