using Xunit;

namespace Fuget.Tests;

public class PackageTests
{
    [Fact]
    public void Lists_frameworks_assemblies_docs_and_ignores_culture_folders()
    {
        var p = new Package(Fixture.WidgetsPackage("1.0.0", Fixture.V1));
        Assert.Equal("Acme.Widgets", p.Nuspec.Id);
        Assert.Equal("1.0.0", p.Nuspec.Version);
        Assert.Equal(new[] { "lib/net6.0", "lib/netstandard2.0" }, p.Frameworks.Select(f => f.Dir));
        Assert.Equal(new[] { "Acme.Widgets.dll" }, p.Frameworks[0].Assemblies);
        Assert.Equal(new[] { "Acme.Widgets.xml" }, p.Frameworks[0].DocFiles);
        Assert.Equal("lib/net6.0/Acme.Widgets.xml", p.FindDocPath(p.Frameworks[1], "Acme.Widgets.dll"));   // netstandard has no xml: falls back to net6.0's
    }

    [Fact]
    public void Reads_dependency_groups_per_framework()
    {
        var p = new Package(Fixture.WidgetsPackage("1.0.0", Fixture.V1));
        Assert.Equal(2, p.Nuspec.DependencyGroups.Count);
        var net6 = p.DependenciesFor("net6.0")!;
        Assert.Equal("Acme.Core", Assert.Single(net6.Dependencies).Id);
        Assert.Equal("[1.2.0, )", net6.Dependencies[0].Range);
        var std = p.DependenciesFor("netstandard2.0")!;
        Assert.Equal(new[] { "Acme.Core", "Other.Lib" }, std.Dependencies.Select(d => d.Id));
        Assert.Equal("netstandard2.0", std.Tfm);                         // ".NETStandard2.0" normalized
        Assert.Equal("netstandard2.0", p.DependenciesFor("net48")!.Tfm); // compatible fallback
    }

    [Theory]
    [InlineData(".NETStandard2.0", "netstandard2.0")]
    [InlineData(".NETFramework4.7.2", "net472")]
    [InlineData(".NETCoreApp3.1", "netcoreapp3.1")]
    [InlineData("net6.0", "net6.0")]
    public void Normalizes_target_frameworks(string raw, string expected) => Assert.Equal(expected, Tfm.Normalize(raw));

    [Fact]
    public void Picks_best_compatible_framework()
    {
        var avail = new[] { "net462", "netstandard2.0", "net6.0", "netcoreapp3.1" };
        Assert.Equal("net6.0", Tfm.Best(avail, "net8.0"));
        Assert.Equal("netcoreapp3.1", Tfm.Best(avail, "net5.0"));
        Assert.Equal("net462", Tfm.Best(avail, "net472"));
        Assert.Equal("netstandard2.0", Tfm.Best(avail, "netstandard2.1"));
        Assert.Null(Tfm.Best(new[] { "net6.0" }, "net48"));
    }

    [Fact]
    public void Orders_modern_frameworks_first()
    {
        var order = new[] { "net462", "netstandard2.0", "net8.0", "netcoreapp3.1", "net6.0" }.OrderBy(Tfm.Order).ToArray();
        Assert.Equal(new[] { "net8.0", "net6.0", "netcoreapp3.1", "netstandard2.0", "net462" }, order);
    }

    [Theory]
    [InlineData("[1.2.3, )", "1.2.3")] [InlineData("1.2.3", "1.2.3")] [InlineData("(,2.0]", null)] [InlineData("", null)]
    public void Min_version(string range, string? expected) => Assert.Equal(expected, NuGetUrls.MinVersion(range));

    [Fact] public void Urls_are_lowercase_flat_container() =>
        Assert.Equal("https://api.nuget.org/v3-flatcontainer/newtonsoft.json/13.0.3/newtonsoft.json.13.0.3.nupkg", NuGetUrls.Nupkg("Newtonsoft.Json", "13.0.3"));
}

public class ApiReaderTests
{
    private static AssemblyApi Read(string src = Fixture.V1)
    {
        var (dll, xml) = Fixture.Compile(src);
        return ApiReader.Read(dll, DocFile.Parse(xml));
    }
    private static TypeApi Type(AssemblyApi a, string full) => a.Types.Single(t => t.FullName == full);

    [Fact]
    public void Lists_only_public_api_types_with_kinds()
    {
        var a = Read();
        Assert.Equal("Acme.Widgets", a.Name);
        Assert.Equal("1.0.0.0", a.Version);
        Assert.Equal(new[] { "Acme.Widgets.Color", "Acme.Widgets.Handler", "Acme.Widgets.IThing", "Acme.Widgets.Pt", "Acme.Widgets.Widget`1", "Acme.Widgets.Widget`1.Nested" }, a.Types.Select(t => t.FullName));
        Assert.Equal("enum", Type(a, "Acme.Widgets.Color").Kind);
        Assert.Equal("delegate", Type(a, "Acme.Widgets.Handler").Kind);
        Assert.Equal("interface", Type(a, "Acme.Widgets.IThing").Kind);
        Assert.Equal("struct", Type(a, "Acme.Widgets.Pt").Kind);
        Assert.DoesNotContain(a.Types, t => t.Name == "Secret");
    }

    [Fact]
    public void Type_declarations_read_like_csharp()
    {
        var a = Read();
        Assert.Equal("public class Widget<T> : IDisposable", Type(a, "Acme.Widgets.Widget`1").Declaration);
        Assert.Equal("public enum Color", Type(a, "Acme.Widgets.Color").Declaration);
        Assert.Equal("public delegate void Handler(object sender, int code)", Type(a, "Acme.Widgets.Handler").Declaration);
        Assert.Equal("Widget<T>.Nested", Type(a, "Acme.Widgets.Widget`1.Nested").Name);
        Assert.Equal("public class Nested", Type(a, "Acme.Widgets.Widget`1.Nested").Declaration);
    }

    [Fact]
    public void Member_signatures_ids_and_visibility()
    {
        var w = Type(Read(), "Acme.Widgets.Widget`1");
        string Sig(string kind, string name) => w.Members.Single(m => m.Kind == kind && m.Name == name).Signature;
        Assert.Equal("public Widget(string name, int size = 3);", w.Members.Single(m => m.Kind == "constructor").Signature);
        Assert.Equal("public string Name { get; set; }", Sig("property", "Name"));
        Assert.Equal("public int Size { get; protected set; }", Sig("property", "Size"));
        Assert.Equal("public T this[int i] { get; }", Sig("property", "Item"));
        Assert.Equal("public static readonly int Max;", Sig("field", "Max"));
        Assert.Equal("public const string Tag = \"w\";", Sig("const", "Tag"));
        Assert.Equal("public event EventHandler Changed;", Sig("event", "Changed"));
        Assert.Equal("public virtual int Compute(int a, params string[] rest);", Sig("method", "Compute"));
        Assert.Equal("public Dictionary<string, List<int>> Map();", Sig("method", "Map"));
        Assert.Equal("public void Gen<U>(U u, ref int r, out string s);", Sig("method", "Gen"));
        Assert.Equal("protected void Prot();", Sig("method", "Prot"));
        Assert.Equal("public static Widget<T> operator +(Widget<T> a, Widget<T> b);", w.Members.Single(m => m.Kind == "operator").Signature);
        Assert.DoesNotContain(w.Members, m => m.Name == "Hidden");
        Assert.DoesNotContain(w.Members, m => m.Name.StartsWith("get_") || m.Name.StartsWith("add_"));
        Assert.Equal("M:Acme.Widgets.Widget`1.Compute(System.Int32,System.String[])", w.Members.Single(m => m.Name == "Compute").Id);
        Assert.Equal("M:Acme.Widgets.Widget`1.Gen``1(``0,System.Int32@,System.String@)", w.Members.Single(m => m.Name == "Gen").Id);
        Assert.Equal("M:Acme.Widgets.Widget`1.Map", w.Members.Single(m => m.Name == "Map").Id);
        Assert.Equal("P:Acme.Widgets.Widget`1.Item(System.Int32)", w.Members.Single(m => m.Name == "Item").Id);
        Assert.Equal("M:Acme.Widgets.Widget`1.#ctor(System.String,System.Int32)", w.Members.Single(m => m.Kind == "constructor").Id);
    }

    [Fact]
    public void Obsolete_attribute_is_detected()
    {
        var old = Type(Read(), "Acme.Widgets.Widget`1").Members.Single(m => m.Name == "Old");
        Assert.Equal("Use Compute", old.Obsolete);
        Assert.False(old.ObsoleteError);
        Assert.DoesNotContain("Obsolete", string.Join(",", old.Attributes));
    }

    [Fact]
    public void Enum_members_have_values_and_interface_members_have_no_modifiers()
    {
        var a = Read();
        Assert.Equal(new[] { "Red = 1", "Green = 2" }, Type(a, "Acme.Widgets.Color").Members.Select(m => m.Signature));
        Assert.Equal(new[] { "void Do();", "int P { get; }" }, Type(a, "Acme.Widgets.IThing").Members.OrderBy(m => m.Kind == "property").Select(m => m.Signature));
    }

    [Fact]
    public void Doc_ids_match_the_compilers_xml_so_every_documented_member_gets_its_summary()
    {
        var a = Read();
        var w = Type(a, "Acme.Widgets.Widget`1");
        Assert.Equal("A widget.", w.Summary);
        Assert.Equal("Does it.", w.Members.Single(m => m.Name == "Compute").Summary);
        Assert.Equal("The name.", w.Members.Single(m => m.Name == "Name").Summary);
        Assert.Equal("Creates it.", w.Members.Single(m => m.Kind == "constructor").Summary);
    }
}

public class DocFileTests
{
    [Fact]
    public void Parses_sections_and_flattens_markup()
    {
        var (_, xml) = Fixture.Compile(Fixture.V1);
        var d = DocFile.Parse(xml);
        var w = d.Find("T:Acme.Widgets.Widget`1")!;
        Assert.Equal("A widget.", w.Summary);
        Assert.Equal("Remarks about `Widget.Name` and `x`.", w.Remarks);
        var m = d.Find("M:Acme.Widgets.Widget`1.Compute(System.Int32,System.String[])")!;
        Assert.Equal("The result.", m.Returns);
        Assert.Equal("The a.", m.Params["a"]);
        var ex = Assert.Single(m.Exceptions);
        Assert.Equal(("ArgumentException", "When bad."), (ex.Type, ex.Text));
        Assert.Null(d.Find("M:Nope"));
    }

    [Fact]
    public void Handles_lists_code_and_garbage()
    {
        var d = DocFile.Parse("<doc><members><member name=\"T:A\"><summary>Hi <c>x</c><list type=\"bullet\"><item><description>one</description></item><item><description>two</description></item></list></summary><remarks><para>P1</para><para>P2 <see langword=\"null\"/></para></remarks></member></members></doc>");
        var e = d.Find("T:A")!;
        Assert.Equal("Hi `x`\n\n- one\n- two", e.Summary);
        Assert.Equal("P1\n\nP2 `null`", e.Remarks);
        Assert.Equal(0, DocFile.Parse("<not xml").Count);
    }

    [Theory]
    [InlineData("T:System.Collections.Generic.List{System.Int32}", "List<Int32>")]
    [InlineData("M:Ns.Type.Method(System.Int32)", "Type.Method")]
    [InlineData("T:Ns.Type", "Type")]
    public void Short_cref(string cref, string expected) => Assert.Equal(expected, DocFile.ShortCref(cref));
}

public class DiffTests
{
    private static DiffResult Diff()
    {
        var (d1, x1) = Fixture.Compile(Fixture.V1); var (d2, x2) = Fixture.Compile(Fixture.V2);
        return ApiDiff.Compare(ApiReader.Read(d1, DocFile.Parse(x1)), ApiReader.Read(d2, DocFile.Parse(x2)));
    }

    [Fact]
    public void Groups_added_removed_and_changed_by_type()
    {
        var r = Diff();
        Assert.Equal(new[] { "Acme.Widgets.Gadget" }, r.Types.Where(t => t.Status == "added").Select(t => t.FullName));
        Assert.Equal(new[] { "Acme.Widgets.Pt" }, r.Types.Where(t => t.Status == "removed").Select(t => t.FullName));
        Assert.Equal(new[] { "Acme.Widgets.Color", "Acme.Widgets.Widget`1" }, r.Types.Where(t => t.Status == "changed").Select(t => t.FullName));
        Assert.Equal((1, 1, 2), (r.AddedTypes, r.RemovedTypes, r.ChangedTypes));
    }

    [Fact]
    public void Member_level_changes()
    {
        var w = Diff().Types.Single(t => t.FullName == "Acme.Widgets.Widget`1");
        string Id(string status) => string.Join("|", w.Members.Where(m => m.Status == status).Select(m => m.Name).OrderBy(x => x));
        Assert.Equal("Extra", Id("added"));
        Assert.Equal("Old", Id("removed"));
        Assert.Equal("Size", Id("changed").Split('|').Contains("Size") ? "Size" : Id("changed"));
        var size = w.Members.Single(m => m.Name == "Size");
        Assert.Equal("public int Size { get; protected set; }", size.Old);
        Assert.Equal("public int Size { get; set; }", size.New);
        var compute = w.Members.Single(m => m.Name == "Compute");
        Assert.Equal("changed", compute.Status);
        Assert.Contains("int Compute", compute.Old); Assert.Contains("long Compute", compute.New);
        Assert.True(compute.Breaking);
        Assert.Equal("added", Diff().Types.Single(t => t.FullName == "Acme.Widgets.Color").Members.Single().Status);
    }

    [Fact]
    public void Identical_assemblies_have_no_changes()
    {
        var (d, x) = Fixture.Compile(Fixture.V1);
        var a = ApiReader.Read(d, DocFile.Parse(x));
        var r = ApiDiff.Compare(a, ApiReader.Read(d, null));
        Assert.Empty(r.Types); Assert.Equal(0, r.Breaking);
    }
}

public class ServiceTests
{
    private static FugetService Create(Dictionary<string, byte[]> web, List<string>? log = null)
    {
        var svc = new FugetService(url => { log?.Add(url); return Task.FromResult(web.TryGetValue(url, out var b) ? b : null); });
        svc.ConfigureReferencePack(Fixture.RuntimeAssemblyNames);
        return svc;
    }

    private static Dictionary<string, byte[]> Web()
    {
        var web = new Dictionary<string, byte[]>
        {
            [NuGetUrls.Nupkg("Acme.Widgets", "1.0.0")] = Fixture.WidgetsPackage("1.0.0", Fixture.V1),
            [NuGetUrls.Nupkg("Acme.Widgets", "2.0.0")] = Fixture.WidgetsPackage("2.0.0", Fixture.V2),
            [NuGetUrls.Index("Acme.Widgets")] = System.Text.Encoding.UTF8.GetBytes("{\"versions\":[\"1.0.0\",\"2.0.0\",\"3.0.0-beta\"]}"),
        };
        foreach (var n in Fixture.RuntimeAssemblyNames) web["ref/a/" + n + ".dll"] = Fixture.RuntimeAssembly(n)!;
        return web;
    }

    [Fact]
    public async Task Opens_package_reads_assembly_and_docs()
    {
        var svc = Create(Web());
        var s = await svc.OpenAsync("Acme.Widgets", "2.0.0");
        Assert.Equal("2.0.0", s.Version);
        var api = await svc.ReadAssemblyAsync("Acme.Widgets", "2.0.0", "lib/net6.0", "Acme.Widgets");
        Assert.Contains(api.Types, t => t.Name == "Gadget");
        var doc = await svc.DocAsync("Acme.Widgets", "1.0.0", "lib/net6.0", "Acme.Widgets", "M:Acme.Widgets.Widget`1.Compute(System.Int32,System.String[])");
        Assert.Equal("The result.", doc!.Returns);
        Assert.Equal("2.0.0", (await svc.OpenAsync("Acme.Widgets", null) is var latest ? latest.Version : ""));   // latest stable skips the prerelease
    }

    [Fact]
    public async Task Diffs_two_versions_of_an_assembly_and_falls_back_to_a_compatible_framework()
    {
        var svc = Create(Web());
        var r = await svc.DiffAsync("Acme.Widgets", "1.0.0", "2.0.0", "lib/netstandard2.0", "Acme.Widgets");
        Assert.Equal("lib/netstandard2.0", r.OldDir);
        Assert.Equal(1, r.AddedTypes); Assert.True(r.Breaking > 0);
    }

    [Fact]
    public async Task Decompiles_a_type_and_a_member_resolving_references_on_demand()
    {
        var log = new List<string>();
        var svc = Create(Web(), log);
        var api = await svc.ReadAssemblyAsync("Acme.Widgets", "2.0.0", "lib/net6.0", "Acme.Widgets");
        var gadget = api.Types.Single(t => t.Name == "Gadget");
        var r = await svc.DecompileAsync("Acme.Widgets", "2.0.0", "lib/net6.0", "Acme.Widgets", gadget.Token);
        Assert.Contains("public class Gadget", r.Code);
        Assert.Contains("\"three\"", r.Code);
        Assert.Contains(log, u => u.StartsWith("ref/a/System."));
        var run = gadget.Members.Single(m => m.Name == "Run");
        var one = await svc.DecompileAsync("Acme.Widgets", "2.0.0", "lib/net6.0", "Acme.Widgets", run.Token);
        Assert.Contains("public string Run(int times)", one.Code);
        Assert.DoesNotContain("class Gadget", one.Code);
        Assert.Empty(r.Missing);
    }

    [Fact]
    public async Task Unknown_package_is_a_clear_error()
    {
        var svc = Create(Web());
        var e = await Assert.ThrowsAsync<InvalidOperationException>(() => svc.OpenAsync("No.Such", "1.0.0"));
        Assert.Contains("not found", e.Message);
    }
}

/// <summary>Real packages from nuget.org; runs only with FUGET_NETWORK=1 (CI runs it once).</summary>
public class NetworkTests
{
    private static readonly HttpClient Http = new();
    private static async Task<byte[]?> Get(string url)
    {
        if (!url.StartsWith("http")) { var n = Path.GetFileNameWithoutExtension(url); return Fixture.RuntimeAssembly(n); }
        var r = await Http.GetAsync(url);
        return r.IsSuccessStatusCode ? await r.Content.ReadAsByteArrayAsync() : null;
    }

    [Fact]
    public async Task Newtonsoft_Json_13_0_3_reads_and_decompiles()
    {
        if (Environment.GetEnvironmentVariable("FUGET_NETWORK") != "1") return;
        var svc = new FugetService(Get);
        svc.ConfigureReferencePack(Fixture.RuntimeAssemblyNames);
        var s = await svc.OpenAsync("Newtonsoft.Json", "13.0.3");
        Assert.Contains(s.Frameworks, f => f.Dir == "lib/net6.0");
        var api = await svc.ReadAssemblyAsync("Newtonsoft.Json", "13.0.3", "lib/net6.0", "Newtonsoft.Json");
        var jobject = api.Types.Single(t => t.FullName == "Newtonsoft.Json.Linq.JObject");
        Assert.Contains("JContainer", jobject.Declaration);
        Assert.NotNull(jobject.Summary);
        var d = await svc.DecompileAsync("Newtonsoft.Json", "13.0.3", "lib/net6.0", "Newtonsoft.Json", jobject.Token);
        Assert.Contains("class JObject", d.Code);
    }
}
