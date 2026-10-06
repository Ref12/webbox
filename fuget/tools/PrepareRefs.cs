// Splits the Microsoft.NETCore.App.Ref reference assemblies for on-demand loading (adapted from csharp/tools/PrepareRefs.cs: no core bundle, no types.json).
// Writes into the site's ref/ folder:
//   a/<name>.dll   every reference assembly on its own (+ .br/.gz), fetched when the decompiler needs it (netstandard, System.Runtime, ...)
//   manifest.json  { version, assemblies[{name,size,br}] }   (small; fetched at startup)
// Usage: dotnet run tools/PrepareRefs.cs [outDir]   (cross-platform, no shell needed)
using System.IO.Compression;

var outDir = args.Length > 0 ? args[0] : Path.Combine("src", "Fuget.Wasm", "wwwroot", "ref");
var dotnetRoot = Environment.GetEnvironmentVariable("DOTNET_ROOT");
// <root>/shared/Microsoft.NETCore.App/<ver>/System.Private.CoreLib.dll -> <root>
if (string.IsNullOrEmpty(dotnetRoot)) dotnetRoot = Path.GetFullPath(Path.Combine(System.Runtime.InteropServices.RuntimeEnvironment.GetRuntimeDirectory(), "..", "..", ".."));
var roots = new[] { Path.Combine(dotnetRoot, "packs", "Microsoft.NETCore.App.Ref"),
    Path.Combine(Environment.GetEnvironmentVariable("NUGET_PACKAGES") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".nuget", "packages"), "microsoft.netcore.app.ref") };
var best = roots.Where(Directory.Exists).SelectMany(Directory.GetDirectories).Where(d => Path.GetFileName(d).StartsWith("10."))
    .OrderBy(d => Version.Parse(Path.GetFileName(d).Split('-')[0])).LastOrDefault()
    ?? throw new Exception("No Microsoft.NETCore.App.Ref 10.x pack under " + string.Join(" or ", roots));
var refDir = Path.Combine(best, "ref", "net10.0");
if (Directory.Exists(outDir)) Directory.Delete(outDir, true);
Directory.CreateDirectory(Path.Combine(outDir, "a"));

void Compress(string path)
{
    var raw = File.ReadAllBytes(path);
    using (var o = File.Create(path + ".br")) using (var br = new BrotliStream(o, CompressionLevel.SmallestSize)) br.Write(raw);
    using (var o = File.Create(path + ".gz")) using (var gz = new GZipStream(o, CompressionLevel.SmallestSize)) gz.Write(raw);
}
string J(string s) => "\"" + s.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";

var items = new List<string>();
foreach (var f in Directory.EnumerateFiles(refDir, "*.dll").OrderBy(f => f, StringComparer.Ordinal))
{
    var name = Path.GetFileName(f);
    var target = Path.Combine(outDir, "a", name);
    File.Copy(f, target);
    Compress(target);
    items.Add($"{{\"name\":{J(name)},\"size\":{new FileInfo(f).Length},\"br\":{new FileInfo(target + ".br").Length}}}");
}
File.WriteAllText(Path.Combine(outDir, "manifest.json"), $"{{\"version\":{J(Path.GetFileName(best))},\"assemblies\":[{string.Join(",", items)}]}}");
Compress(Path.Combine(outDir, "manifest.json"));
Console.WriteLine($"{items.Count} reference assemblies from {best}");
