// Publishes src/CsRepl.Intellisense and copies the assemblies the browser app does NOT already ship (Features, Workspaces,
// System.Composition, ...) as plain PE files into wwwroot/lazy/, with lazy/manifest.json and .br/.gz copies.
// These are fetched after first paint (see main.js) and loaded with AssemblyLoadContext, so the REPL is usable before they arrive.
// Usage: dotnet run tools/PrepareLazy.cs [outDir]
using System.Diagnostics;
using System.IO.Compression;

var outDir = args.Length > 0 ? args[0] : Path.Combine("src", "CsRepl.Wasm", "wwwroot", "lazy");
var tmp = Path.Combine(Path.GetTempPath(), "csrepl-lazy-" + Guid.NewGuid().ToString("N"));
var psi = new ProcessStartInfo("dotnet", $"publish src/CsRepl.Intellisense -c Release -o \"{tmp}\" --nologo -v q") { RedirectStandardOutput = true, RedirectStandardError = true };
using (var p = Process.Start(psi)!) { var o = p.StandardOutput.ReadToEnd() + p.StandardError.ReadToEnd(); p.WaitForExit(); if (p.ExitCode != 0) throw new Exception(o); }
// Already in the app's own boot payload (do not ship twice): the compiler core and the repl core.
var inApp = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "Microsoft.CodeAnalysis.dll", "Microsoft.CodeAnalysis.CSharp.dll", "CsRepl.Core.dll" };
if (Directory.Exists(outDir)) Directory.Delete(outDir, true);
Directory.CreateDirectory(outDir);
var entries = new List<string>();
long total = 0;
foreach (var f in Directory.EnumerateFiles(tmp, "*.dll").OrderBy(f => f, StringComparer.Ordinal))
{
    var name = Path.GetFileName(f);
    if (inApp.Contains(name)) continue;
    var bytes = File.ReadAllBytes(f);
    File.WriteAllBytes(Path.Combine(outDir, name), bytes);
    using (var o = File.Create(Path.Combine(outDir, name + ".br"))) using (var br = new BrotliStream(o, CompressionLevel.SmallestSize)) br.Write(bytes);
    using (var o = File.Create(Path.Combine(outDir, name + ".gz"))) using (var gz = new GZipStream(o, CompressionLevel.SmallestSize)) gz.Write(bytes);
    var brLen = new FileInfo(Path.Combine(outDir, name + ".br")).Length;
    entries.Add($"{{\"name\":\"{name}\",\"size\":{bytes.Length},\"br\":{brLen}}}");
    total += bytes.Length;
}
// version = hash of names+sizes, so the browser cache entry changes when the set changes
var filesJson = "[" + string.Join(",", entries) + "]";
var version = Convert.ToHexString(System.Security.Cryptography.SHA1.HashData(System.Text.Encoding.UTF8.GetBytes(filesJson)))[..10].ToLowerInvariant();
File.WriteAllText(Path.Combine(outDir, "manifest.json"), $"{{\"version\":\"{version}\",\"entry\":\"CsRepl.Intellisense.dll\",\"files\":{filesJson}}}");
Directory.Delete(tmp, true);
Console.WriteLine($"{entries.Count} lazy assemblies, {total} bytes -> {outDir}");
