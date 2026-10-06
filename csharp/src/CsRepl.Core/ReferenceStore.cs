using System.Reflection.Metadata;
using Microsoft.CodeAnalysis;

namespace CsRepl;

/// <summary>
/// Reference-assembly bookkeeping. Browser-loaded assemblies are Webcil so Roslyn cannot read metadata
/// from them; references come from plain ref-pack DLL bytes instead (fetched by JS, cached in Cache API).
/// </summary>
public sealed class ReferenceStore
{
    private readonly Dictionary<string, MetadataReference> _refs = new(StringComparer.OrdinalIgnoreCase);

    public int Count => _refs.Count;
    public long TotalBytes { get; private set; }
    public IReadOnlyCollection<MetadataReference> References => _refs.Values;

    /// <summary>Add one assembly by file name. Later adds with the same name replace earlier ones. Non-assemblies are rejected.</summary>
    public bool TryAdd(string fileName, byte[] bytes)
    {
        var name = Path.GetFileName(fileName.Replace('\\', '/'));
        if (!name.EndsWith(".dll", StringComparison.OrdinalIgnoreCase)) return false;
        try
        {
            using (var pe = new System.Reflection.PortableExecutable.PEReader(System.Collections.Immutable.ImmutableArray.Create(bytes)))
            {
                // Garbage / Webcil / netmodules are refused here rather than at first compile.
                if (!pe.HasMetadata || !System.Reflection.Metadata.PEReaderExtensions.GetMetadataReader(pe).IsAssembly) return false;
            }
            var r = AssemblyMetadata.CreateFromImage(bytes).GetReference(display: name);
            _refs[name] = r;
            TotalBytes += bytes.Length;
            return true;
        }
        catch (Exception e) when (e is BadImageFormatException or ArgumentException or InvalidOperationException or IOException) { return false; }
    }

    /// <summary>Add every assembly from a refs.bin bundle; returns how many were accepted.</summary>
    public int AddBundle(byte[] bundle) => ReferenceBundle.Read(bundle).Count(f => TryAdd(f.Name, f.Bytes));

    /// <summary>Parse a manifest: one "file.dll" per line, blank lines and '#' comments ignored.</summary>
    public static IReadOnlyList<string> ParseManifest(string text) =>
        text.Split('\n').Select(l => l.Trim()).Where(l => l.Length > 0 && !l.StartsWith('#')).ToList();

    /// <summary>Load every *.dll from a directory (desktop/tests: ref pack folder).</summary>
    public int AddDirectory(string dir, IEnumerable<string>? only = null)
    {
        var n = 0;
        var wanted = only?.ToHashSet(StringComparer.OrdinalIgnoreCase);
        foreach (var f in Directory.EnumerateFiles(dir, "*.dll"))
        {
            if (wanted != null && !wanted.Contains(Path.GetFileName(f))) continue;
            if (TryAdd(Path.GetFileName(f), File.ReadAllBytes(f))) n++;
        }
        return n;
    }
}
