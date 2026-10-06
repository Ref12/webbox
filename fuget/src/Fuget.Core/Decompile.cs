using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using ICSharpCode.Decompiler;
using ICSharpCode.Decompiler.CSharp;
using ICSharpCode.Decompiler.Metadata;

namespace Fuget;

/// <summary>Fetches bytes by absolute URL or site-relative path; null = not found (HTTP 404). Implemented by JS (Cache API) in the browser.</summary>
public delegate Task<byte[]?> Fetcher(string url);

public sealed record LoadedReference(string Name, string Source, int Bytes);
public sealed class DecompileResult
{
    public string Code { get; set; } = "";
    public List<LoadedReference> Loaded { get; set; } = new();
    public List<string> Missing { get; set; } = new();
    public double Ms { get; set; }
}

/// <summary>Assembly resolver over in-memory images: the decompiler resolves the assembly's references through this.</summary>
public sealed class MemoryResolver : IAssemblyResolver
{
    private readonly Dictionary<string, byte[]> _images;
    private readonly Dictionary<string, MetadataFile?> _files = new(StringComparer.OrdinalIgnoreCase);
    public MemoryResolver(Dictionary<string, byte[]> images) { _images = images; }

    public bool IsGacAssembly(IAssemblyReference reference) => false;
    public MetadataFile? Resolve(IAssemblyReference reference)
    {
        if (_files.TryGetValue(reference.Name, out var f)) return f;
        if (!_images.TryGetValue(reference.Name, out var bytes)) return _files[reference.Name] = null;
        return _files[reference.Name] = new PEFile(reference.Name + ".dll", new MemoryStream(bytes), PEStreamOptions.PrefetchEntireImage);
    }
    public MetadataFile? ResolveModule(MetadataFile mainModule, string moduleName) => null;
    public Task<MetadataFile?> ResolveAsync(IAssemblyReference reference) => Task.FromResult(Resolve(reference));
    public Task<MetadataFile?> ResolveModuleAsync(MetadataFile mainModule, string moduleName) => Task.FromResult<MetadataFile?>(null);
}

/// <summary>
/// ILSpy's decompiler (ICSharpCode.Decompiler) on top of on-demand reference loading. The decompiler resolves synchronously, so everything
/// it may ask for is fetched first: (1) sibling assemblies of the same lib folder, (2) the reference pack (site ref/a/&lt;name&gt;.dll, the REPL's
/// layout) for framework names, (3) the package's own nuspec dependencies (downloaded from the flat container) for the rest.
/// Type forwarders (netstandard, mscorlib -> System.*) are followed using the actual type references, so only the assemblies that are used are fetched.
/// </summary>
public sealed class DecompilerService
{
    private readonly PackageStore _store;
    private readonly Fetcher _site;
    private readonly HashSet<string> _refNames;
    public const string RefPath = "ref/a/";

    public DecompilerService(PackageStore store, Fetcher siteFetch, IEnumerable<string> refPackAssemblies)
    {
        _store = store; _site = siteFetch;
        _refNames = new HashSet<string>(refPackAssemblies.Select(n => n.EndsWith(".dll", StringComparison.OrdinalIgnoreCase) ? n[..^4] : n), StringComparer.OrdinalIgnoreCase);
    }

    private sealed class Index { public HashSet<string> Types = new(StringComparer.Ordinal); public Dictionary<string, string> Forwards = new(StringComparer.Ordinal); }

    private sealed class Run
    {
        public Dictionary<string, byte[]> Images = new(StringComparer.OrdinalIgnoreCase);
        public Dictionary<string, Index> Indexes = new(StringComparer.OrdinalIgnoreCase);
        public HashSet<string> Tried = new(StringComparer.OrdinalIgnoreCase);
        public List<LoadedReference> Loaded = new();
        public List<string> Missing = new();
        public bool DepsLoaded;
    }

    public async Task<DecompileResult> DecompileAsync(Package pkg, FrameworkInfo fw, string assemblyFile, int token)
    {
        var started = DateTime.UtcNow;
        var run = new Run();
        var main = pkg.Read(fw.Dir + "/" + assemblyFile) ?? throw new FileNotFoundException(assemblyFile);
        var mainName = Path.GetFileNameWithoutExtension(assemblyFile);
        run.Images[mainName] = main;
        foreach (var other in fw.Assemblies)
        {
            var n = Path.GetFileNameWithoutExtension(other);
            if (run.Images.ContainsKey(n)) continue;
            var b = pkg.Read(fw.Dir + "/" + other);
            if (b != null) { run.Images[n] = b; run.Loaded.Add(new LoadedReference(n, "package", b.Length)); }
        }
        await LoadReferencesAsync(run, pkg, fw, main);

        var file = new PEFile(assemblyFile, new MemoryStream(main), PEStreamOptions.PrefetchEntireImage);
        var settings = new DecompilerSettings(LanguageVersion.Latest) { ThrowOnAssemblyResolveErrors = false, ShowXmlDocumentation = false };
        var decompiler = new CSharpDecompiler(file, new MemoryResolver(run.Images), settings);
        var handle = MetadataTokens.EntityHandle(token);
        var code = decompiler.DecompileAsString(new[] { handle });
        return new DecompileResult { Code = code, Loaded = run.Loaded, Missing = run.Missing, Ms = (DateTime.UtcNow - started).TotalMilliseconds };
    }

    private async Task LoadReferencesAsync(Run run, Package pkg, FrameworkInfo fw, byte[] main)
    {
        using var pe = new PEReader(System.Collections.Immutable.ImmutableArray.Create(main));
        var md = pe.GetMetadataReader();
        // every distinct (assembly, type) the code refers to
        var refs = new HashSet<(string Scope, string Type)>();
        foreach (var h in md.TypeReferences)
        {
            var tr = md.GetTypeReference(h);
            if (tr.ResolutionScope.Kind != HandleKind.AssemblyReference) continue;
            var scope = md.GetString(md.GetAssemblyReference((AssemblyReferenceHandle)tr.ResolutionScope).Name);
            refs.Add((scope, QualifiedName(md.GetString(tr.Namespace), md.GetString(tr.Name))));
        }
        foreach (var name in ApiReader.ReferencedAssemblies(md)) refs.Add((name, ""));   // referenced but maybe only through attributes/forwarders
        foreach (var (scope, type) in refs.OrderBy(r => r.Scope, StringComparer.Ordinal))
        {
            var cur = scope;
            for (var depth = 0; depth < 6; depth++)
            {
                if (!await EnsureLoadedAsync(run, pkg, fw, cur)) break;
                if (type.Length == 0) break;
                var idx = IndexOf(run, cur);
                if (idx.Types.Contains(type)) break;
                if (idx.Forwards.TryGetValue(type, out var next)) cur = next; else break;
            }
        }
    }

    private static string QualifiedName(string ns, string name) => ns.Length == 0 ? name : ns + "." + name;

    private static Index IndexOf(Run run, string name)
    {
        if (run.Indexes.TryGetValue(name, out var idx)) return idx;
        idx = new Index();
        try
        {
            using var pe = new PEReader(System.Collections.Immutable.ImmutableArray.Create(run.Images[name]));
            var md = pe.GetMetadataReader();
            foreach (var h in md.TypeDefinitions)
            {
                var t = md.GetTypeDefinition(h);
                if (t.GetDeclaringType().IsNil) idx.Types.Add(QualifiedName(md.GetString(t.Namespace), md.GetString(t.Name)));
            }
            foreach (var h in md.ExportedTypes)
            {
                var e = md.GetExportedType(h);
                if (e.Implementation.Kind != HandleKind.AssemblyReference) continue;
                idx.Forwards[QualifiedName(md.GetString(e.Namespace), md.GetString(e.Name))] = md.GetString(md.GetAssemblyReference((AssemblyReferenceHandle)e.Implementation).Name);
            }
        }
        catch (BadImageFormatException) { }
        return run.Indexes[name] = idx;
    }

    private async Task<bool> EnsureLoadedAsync(Run run, Package pkg, FrameworkInfo fw, string name)
    {
        if (run.Images.ContainsKey(name)) return true;
        if (!run.Tried.Add(name)) return false;
        if (_refNames.Contains(name))
        {
            var bytes = await _site(RefPath + name + ".dll");
            if (bytes is { Length: > 0 }) { run.Images[name] = bytes; run.Loaded.Add(new LoadedReference(name, "reference pack", bytes.Length)); return true; }
        }
        if (!run.DepsLoaded)
        {
            run.DepsLoaded = true;
            await LoadDependenciesAsync(run, pkg, fw);
            if (run.Images.ContainsKey(name)) return true;
        }
        run.Missing.Add(name);
        return false;
    }

    private async Task LoadDependenciesAsync(Run run, Package pkg, FrameworkInfo fw)
    {
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { pkg.Nuspec.Id };
        var queue = new Queue<(Package P, int Depth)>(); queue.Enqueue((pkg, 0));
        var budget = 40;
        while (queue.Count > 0 && budget > 0)
        {
            var (p, depth) = queue.Dequeue();
            var group = p.DependenciesFor(fw.Tfm);
            if (group == null || depth >= 3) continue;
            foreach (var dep in group.Dependencies)
            {
                if (!seen.Add(dep.Id) || dep.Id.StartsWith("Microsoft.NETCore.", StringComparison.OrdinalIgnoreCase) || dep.Id.Equals("NETStandard.Library", StringComparison.OrdinalIgnoreCase)) continue;
                if (budget-- <= 0) break;
                Package dp;
                try { dp = await _store.GetAsync(dep.Id, NuGetUrls.MinVersion(dep.Range)); } catch (Exception e) when (e is InvalidOperationException or InvalidDataException or HttpRequestException) { continue; }
                var libs = dp.Frameworks.Where(f => f.Kind == "lib" && f.Assemblies.Count > 0).ToList();
                var best = Tfm.Best(libs.Select(f => f.Tfm), fw.Tfm);
                var chosen = libs.FirstOrDefault(f => f.Tfm == best);
                if (chosen != null)
                    foreach (var a in chosen.Assemblies)
                    {
                        var n = Path.GetFileNameWithoutExtension(a);
                        if (run.Images.ContainsKey(n)) continue;
                        var bytes = dp.Read(chosen.Dir + "/" + a);
                        if (bytes != null) { run.Images[n] = bytes; run.Loaded.Add(new LoadedReference(n, dp.Nuspec.Id + " " + dp.Nuspec.Version, bytes.Length)); }
                    }
                queue.Enqueue((dp, depth + 1));
            }
        }
    }
}
