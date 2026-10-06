using System.IO.Compression;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Text;
using System.Text.Json;
using System.Xml.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace CsRepl.Tests;

/// <summary>A catalog + fetcher over the real ref pack, built the same way tools/PrepareRefs.cs builds the site's manifest.</summary>
public sealed class OnDemandRig
{
    public static readonly string[] Core = { "System.Runtime.dll", "System.Console.dll", "System.Linq.dll", "System.Collections.dll",
        "System.Threading.dll", "System.Threading.Tasks.dll", "System.Memory.dll", "System.Runtime.Extensions.dll" };
    public List<string> Fetched { get; } = new();
    public Dictionary<string, byte[]> Extra { get; } = new();
    public ReferenceStore Store { get; } = new();
    public RefCatalog Catalog { get; }
    public RefResolver Resolver { get; }
    public NuGetResolver NuGet { get; }

    public OnDemandRig()
    {
        var dir = Fixture.RefDir();
        var asm = new List<string>(); var types = new SortedDictionary<string, List<string>>();
        foreach (var f in Directory.EnumerateFiles(dir, "*.dll").OrderBy(x => x, StringComparer.Ordinal))
        {
            var name = Path.GetFileName(f);
            using var pe = new PEReader(File.OpenRead(f));
            var md = pe.GetMetadataReader();
            var nss = new SortedSet<string>();
            foreach (var h in md.TypeDefinitions)
            {
                var t = md.GetTypeDefinition(h);
                if (!t.GetDeclaringType().IsNil || (t.Attributes & System.Reflection.TypeAttributes.VisibilityMask) != System.Reflection.TypeAttributes.Public) continue;
                var ns = md.GetString(t.Namespace); var tn = md.GetString(t.Name); var tick = tn.IndexOf('`'); if (tick > 0) tn = tn[..tick];
                if (ns.Length > 0) nss.Add(ns);
                if (!types.TryGetValue(tn, out var l)) types[tn] = l = new(); if (!l.Contains(name)) l.Add(name);
            }
            asm.Add(JsonSerializer.Serialize(new Dictionary<string, object> { ["name"] = name, ["size"] = new FileInfo(f).Length, ["ns"] = nss }));
        }
        Catalog = RefCatalog.Parse("{\"version\":\"t\",\"core\":" + JsonSerializer.Serialize(Core) + ",\"assemblies\":[" + string.Join(",", asm) + "]}");
        _types = JsonSerializer.SerializeToUtf8Bytes(types);
        foreach (var c in Core) Store.TryAdd(c, File.ReadAllBytes(Path.Combine(dir, c)));
        AssetFetcher fetch = path =>
        {
            Fetched.Add(path);
            if (Extra.TryGetValue(path, out var b)) return Task.FromResult<byte[]?>(b);
            if (path == "ref/types.json") return Task.FromResult<byte[]?>(_types);
            if (path.StartsWith("ref/a/")) { var f = Path.Combine(dir, path[6..]); return Task.FromResult(File.Exists(f) ? File.ReadAllBytes(f) : null); }
            return Task.FromResult<byte[]?>(null);
        };
        Resolver = new RefResolver(Catalog, Store, fetch);
        NuGet = new NuGetResolver(fetch, id => Catalog.Has(id + ".dll"));
    }
    private readonly byte[] _types;
    public ReplSession Session() => new(Store, Resolver, NuGet);

    /// <summary>A tiny library compiled against the ref pack, as bytes.</summary>
    public static byte[] Compile(string asmName, string source, byte[]? extraRef = null)
    {
        var refs = extraRef is null ? Fixture.Refs : Fixture.Refs.Append(AssemblyMetadata.CreateFromImage(extraRef).GetReference()).ToList();
        var c = CSharpCompilation.Create(asmName, new[] { CSharpSyntaxTree.ParseText(source) }, refs, new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        using var ms = new MemoryStream(); var r = c.Emit(ms);
        Assert.True(r.Success, string.Join("\n", r.Diagnostics));
        return ms.ToArray();
    }

    public static byte[] Nupkg(string id, string version, string? depId, string? depVersion, byte[] dll, string dllName)
    {
        using var ms = new MemoryStream();
        using (var z = new ZipArchive(ms, ZipArchiveMode.Create, true))
        {
            var deps = depId is null ? "" : $"<dependencies><group targetFramework=\".NETStandard2.0\"><dependency id=\"{depId}\" version=\"[{depVersion}, )\" /></group><group targetFramework=\"net10.0\"><dependency id=\"{depId}\" version=\"[{depVersion}, )\" /><dependency id=\"System.Runtime\" version=\"4.3.0\" /></group></dependencies>";
            var e = z.CreateEntry(id + ".nuspec"); using (var w = new StreamWriter(e.Open()))
                w.Write($"<?xml version=\"1.0\"?><package xmlns=\"http://schemas.microsoft.com/packaging/2013/05/nuspec.xsd\"><metadata><id>{id}</id><version>{version}</version>{deps}</metadata></package>");
            var d = z.CreateEntry("lib/net10.0/" + dllName); using (var s = d.Open()) s.Write(dll);
            var old = z.CreateEntry("lib/netstandard2.0/" + dllName); using (var s = old.Open()) s.Write(dll);
            z.CreateEntry("lib/net10.0/de/" + id + ".resources.dll");
        }
        return ms.ToArray();
    }
}

public class OnDemandTests
{
    [Fact]
    public async Task Core_only_session_runs_ordinary_code_without_fetching_anything()
    {
        var rig = new OnDemandRig(); var s = rig.Session();
        var r = await s.SubmitAsync("new List<int>{1,2,3}.Select(x => x * 2).Sum()");
        Assert.True(r.Success, string.Join("\n", r.Diagnostics)); Assert.Equal("12", r.Value);
        Assert.Empty(rig.Fetched);
    }

    [Fact]
    public async Task Using_directive_loads_the_assembly_once()
    {
        var rig = new OnDemandRig(); var s = rig.Session();
        var r = await s.SubmitAsync("using System.Text.RegularExpressions;\nRegex.IsMatch(\"abc\", \"b\")");
        Assert.True(r.Success, string.Join("\n", r.Diagnostics)); Assert.Equal("true", r.Value.ToLowerInvariant());
        Assert.Contains("ref/a/System.Text.RegularExpressions.dll", rig.Fetched);
        Assert.Contains(r.Loaded!, l => l.Contains("System.Text.RegularExpressions.dll"));
        var n = rig.Fetched.Count;
        await s.SubmitAsync("Regex.IsMatch(\"x\", \"x\")");
        Assert.Equal(n, rig.Fetched.Count);   // nothing fetched twice
    }

    [Fact]
    public async Task Unresolved_type_name_is_found_through_the_type_index_and_fetched()
    {
        var rig = new OnDemandRig(); var s = rig.Session();
        var r = await s.SubmitAsync("System.Text.RegularExpressions.Regex.Escape(\"a.b\")");
        Assert.True(r.Success, string.Join("\n", r.Diagnostics)); Assert.Equal("\"a\\\\.b\"", r.Value);
        var rig2 = new OnDemandRig(); var s2 = rig2.Session();
        var r2 = await s2.SubmitAsync("Regex.Escape(\"a.b\")");   // no using at all: CS0103 -> types.json -> assembly
        Assert.False(r2.Success);                                    // a name is found but the namespace is not imported: still an error...
        Assert.Contains("ref/types.json", rig2.Fetched);             // ...yet the index was consulted once, and the assembly loaded for the next try
        Assert.Contains("ref/a/System.Text.RegularExpressions.dll", rig2.Fetched);
        var r3 = await s2.SubmitAsync("using System.Text.RegularExpressions; Regex.Escape(\"a.b\")");
        Assert.True(r3.Success);
        Assert.Equal(1, rig2.Resolver.TypeIndexFetches);
    }

    [Fact]
    public async Task Missing_transitive_assembly_is_fetched_from_CS0012()
    {
        var rig = new OnDemandRig(); var s = rig.Session();
        var r = await s.SubmitAsync("using System.Net.Http;\nnew HttpClient().GetType().Name");
        Assert.True(r.Success, string.Join("\n", r.Diagnostics)); Assert.Equal("\"HttpClient\"", r.Value);
        Assert.Contains("ref/a/System.Net.Http.dll", rig.Fetched);
    }

    [Fact]
    public async Task Hash_r_with_assembly_name_and_unknown_name()
    {
        var rig = new OnDemandRig(); var s = rig.Session();
        var ok = await s.SubmitAsync("#r \"System.Net.Http\"\n1 + 1");
        Assert.True(ok.Success, string.Join("\n", ok.Diagnostics)); Assert.Equal("2", ok.Value);
        var bad = await s.SubmitAsync("#r \"Nope.Nothing\"\n1");
        Assert.False(bad.Success); Assert.Contains("Nope.Nothing", bad.Diagnostics[0]);
    }

    [Fact]
    public void Directive_extraction_keeps_positions()
    {
        var code = "#r \"nuget: A, 1.0\"\nvar x = 1;";
        var (clean, refs) = Directives.Extract(code);
        Assert.Equal(new[] { "nuget: A, 1.0" }, refs);
        Assert.Equal(code.Length, clean.Length);
        Assert.StartsWith(" ", clean); Assert.EndsWith("var x = 1;", clean);
    }

    [Fact]
    public async Task Nuget_package_with_dependency_is_resolved_loaded_and_usable()
    {
        var rig = new OnDemandRig();
        var bar = OnDemandRig.Compile("Bar", "namespace Bar { public static class B { public static string Name => \"bar\"; } }");
        var foo = OnDemandRig.Compile("Foo", "namespace Foo { public static class F { public static string Hello(string n) => \"hello \" + n + \" from \" + Bar.B.Name; } }", bar);
        rig.Extra[NuGetResolver.FlatContainer + "foo/2.0.0/foo.2.0.0.nupkg"] = OnDemandRig.Nupkg("Foo", "2.0.0", "Bar", "1.5.0", foo, "Foo.dll");
        rig.Extra[NuGetResolver.FlatContainer + "bar/1.5.0/bar.1.5.0.nupkg"] = OnDemandRig.Nupkg("Bar", "1.5.0", null, null, bar, "Bar.dll");
        var s = rig.Session();
        var r = await s.SubmitAsync("#r \"nuget: Foo, 2.0.0\"\nFoo.F.Hello(\"web\")");
        Assert.True(r.Success, string.Join("\n", r.Diagnostics) + r.Error);
        Assert.Equal("\"hello web from bar\"", r.Value);
        Assert.Contains(r.Loaded!, l => l.StartsWith("nuget Foo 2.0.0")); Assert.Contains(r.Loaded!, l => l.StartsWith("nuget Bar 1.5.0"));
        Assert.DoesNotContain(rig.Fetched, f => f.Contains("system.runtime"));   // framework-provided dependency skipped
    }

    [Fact]
    public async Task Nuget_unknown_package_reports_an_error_and_latest_version_is_looked_up()
    {
        var rig = new OnDemandRig(); var s = rig.Session();
        var r = await s.SubmitAsync("#r \"nuget: Does.Not.Exist\"\n1");
        Assert.False(r.Success); Assert.Contains("not found", r.Diagnostics[0]);
        Assert.Contains(NuGetResolver.FlatContainer + "does.not.exist/index.json", rig.Fetched);
    }

    [Fact]
    public void Nuget_parsing_and_selection_helpers()
    {
        Assert.Equal(("Newtonsoft.Json", "13.0.3"), NuGetResolver.ParseDirective("nuget: Newtonsoft.Json, 13.0.3"));
        Assert.Equal(("Humanizer", (string?)null), NuGetResolver.ParseDirective("nuget:Humanizer"));
        Assert.Null(NuGetResolver.ParseDirective("System.Linq"));
        Assert.Equal("1.2.3", NuGetResolver.MinVersion("[1.2.3, )"));
        Assert.Equal("1.2.3", NuGetResolver.MinVersion("1.2.3"));
        Assert.Null(NuGetResolver.MinVersion("(,2.0]"));
        Assert.Equal(new[] { "lib/netstandard2.0/A.dll" }, NuGetResolver.PickAssemblies(new[] { "lib/net462/A.dll", "lib/netstandard2.0/A.dll", "lib/netstandard2.0/de/A.resources.dll" }));
        Assert.Equal(new[] { "lib/net8.0/A.dll" }, NuGetResolver.PickAssemblies(new[] { "lib/netstandard2.0/A.dll", "lib/net8.0/A.dll", "lib/net6.0/A.dll" }));
        Assert.Equal(new[] { "runtimes/browser/lib/net9.0/A.dll" }, NuGetResolver.PickAssemblies(new[] { "lib/net10.0/A.dll", "runtimes/browser/lib/net9.0/A.dll" }));
        var spec = XDocument.Parse("<package><metadata><dependencies><group targetFramework=\".NETFramework4.6.2\"><dependency id=\"Old\" version=\"1.0\"/></group><group targetFramework=\".NETStandard2.0\"><dependency id=\"New\" version=\"[2.0.0, )\"/></group></dependencies></metadata></package>");
        Assert.Equal(new[] { ("New", (string?)"[2.0.0, )") }, NuGetResolver.Dependencies(spec));
    }
}
