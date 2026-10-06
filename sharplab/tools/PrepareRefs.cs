// Splits the Microsoft.NETCore.App.Ref reference assemblies for on-demand loading. Writes into the site's ref/ folder:
//   core.bin            the always-needed assemblies in one bundle (ReferenceBundle format), + .br/.gz
//   a/<name>.dll        every assembly on its own (+ .br/.gz), fetched when a using / type name / #r needs it
//   manifest.json       { version, core[], assemblies[{name,size,br,ns[]}] }   (small; fetched at startup)
//   types.json          public type simple name -> assemblies defining it       (fetched the first time a name is unresolved)
// Usage: dotnet run tools/PrepareRefs.cs [outDir]   (cross-platform, no shell needed)
using System.Diagnostics;
using System.IO.Compression;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Text;

var outDir = args.Length > 0 ? args[0] : Path.Combine("src", "SharpLab.Wasm", "wwwroot", "ref");
var dotnetRoot = Environment.GetEnvironmentVariable("DOTNET_ROOT");
if (string.IsNullOrEmpty(dotnetRoot)) dotnetRoot = Path.GetDirectoryName(Process.GetCurrentProcess().MainModule!.FileName)!;
// The SDK's packs/ folder if it has the ref pack, else the NuGet cache (the tests restore Microsoft.NETCore.App.Ref there).
var roots = new[] { Path.Combine(dotnetRoot, "packs", "Microsoft.NETCore.App.Ref"),
    Path.Combine(Environment.GetEnvironmentVariable("NUGET_PACKAGES") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".nuget", "packages"), "microsoft.netcore.app.ref") };
var best = roots.Where(Directory.Exists).SelectMany(Directory.GetDirectories).Where(d => Path.GetFileName(d).StartsWith("10."))
    .OrderBy(d => Version.Parse(Path.GetFileName(d).Split('-')[0])).LastOrDefault()
    ?? throw new Exception("No Microsoft.NETCore.App.Ref 10.x pack under " + string.Join(" or ", roots) + " (run 'dotnet test tests/SharpLab.Tests' once to restore it)");
var refDir = Path.Combine(best, "ref", "net10.0");
if (Directory.Exists(outDir)) Directory.Delete(outDir, true);
Directory.CreateDirectory(Path.Combine(outDir, "a"));

// What every session starts with (needed by the default usings and ordinary scripts). Everything else loads on demand.
var core = new[] { "System.Runtime.dll", "System.Console.dll", "System.Linq.dll", "System.Collections.dll", "System.Threading.dll",
    "System.Threading.Tasks.dll", "System.Memory.dll", "System.Runtime.Extensions.dll", "System.Runtime.InteropServices.dll" };

void Compress(string path)
{
    var raw = File.ReadAllBytes(path);
    using (var o = File.Create(path + ".br")) using (var br = new BrotliStream(o, CompressionLevel.SmallestSize)) br.Write(raw);
    using (var o = File.Create(path + ".gz")) using (var gz = new GZipStream(o, CompressionLevel.SmallestSize)) gz.Write(raw);
}
string J(string s) => "\"" + s.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";

var files = Directory.EnumerateFiles(refDir, "*.dll").OrderBy(f => f, StringComparer.Ordinal).ToList();
var types = new SortedDictionary<string, List<string>>(StringComparer.Ordinal);
var asmJson = new List<string>();
foreach (var f in files)
{
    var name = Path.GetFileName(f);
    var bytes = File.ReadAllBytes(f);
    File.WriteAllBytes(Path.Combine(outDir, "a", name), bytes);
    Compress(Path.Combine(outDir, "a", name));
    var br = new FileInfo(Path.Combine(outDir, "a", name + ".br")).Length;
    var nss = new SortedSet<string>(StringComparer.Ordinal);
    using (var pe = new PEReader(new MemoryStream(bytes)))
    {
        var md = pe.GetMetadataReader();
        foreach (var h in md.TypeDefinitions)
        {
            var t = md.GetTypeDefinition(h);
            if (!t.GetDeclaringType().IsNil) continue;
            var vis = t.Attributes & System.Reflection.TypeAttributes.VisibilityMask;
            if (vis != System.Reflection.TypeAttributes.Public) continue;
            var ns = md.GetString(t.Namespace); var tn = md.GetString(t.Name);
            if (ns.Length > 0) nss.Add(ns);
            var tick = tn.IndexOf('`'); if (tick > 0) tn = tn[..tick];
            if (tn.StartsWith("<")) continue;
            if (!types.TryGetValue(tn, out var l)) types[tn] = l = new();
            if (!l.Contains(name)) l.Add(name);
        }
    }
    asmJson.Add($"{{\"name\":{J(name)},\"size\":{bytes.Length},\"br\":{br},\"ns\":[{string.Join(",", nss.Select(J))}]}}");
}
// core bundle (single request at startup)
var bundle = new MemoryStream();
using (var w = new BinaryWriter(bundle, Encoding.UTF8, true))
{
    w.Write("CSRB"u8.ToArray()); w.Write(core.Length);
    foreach (var n in core) { var nb = Encoding.UTF8.GetBytes(n); w.Write((ushort)nb.Length); w.Write(nb); w.Write((int)new FileInfo(Path.Combine(refDir, n)).Length); }
    foreach (var n in core) w.Write(File.ReadAllBytes(Path.Combine(refDir, n)));
}
File.WriteAllBytes(Path.Combine(outDir, "core.bin"), bundle.ToArray());
Compress(Path.Combine(outDir, "core.bin"));
File.WriteAllText(Path.Combine(outDir, "types.json"), "{" + string.Join(",", types.Select(kv => J(kv.Key) + ":[" + string.Join(",", kv.Value.Select(J)) + "]")) + "}");
Compress(Path.Combine(outDir, "types.json"));
var version = Path.GetFileName(best);
File.WriteAllText(Path.Combine(outDir, "manifest.json"),
    $"{{\"version\":{J(version)},\"coreSize\":{bundle.Length},\"core\":[{string.Join(",", core.Select(J))}],\"assemblies\":[{string.Join(",", asmJson)}]}}");
Compress(Path.Combine(outDir, "manifest.json"));
Console.WriteLine($"{files.Count} reference assemblies from {best}; core.bin {bundle.Length} bytes ({core.Length} assemblies), types.json {new FileInfo(Path.Combine(outDir, "types.json")).Length} bytes, br {new FileInfo(Path.Combine(outDir, "core.bin.br")).Length}");
