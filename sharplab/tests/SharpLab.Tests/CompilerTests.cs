using System.Text.Json;
using Xunit;

namespace SharpLab.Tests;

public class CompilerTests
{
    [Fact]
    public async Task CompilesTopLevelStatementsAsAnExecutable()
    {
        var r = await Compiler.CompileAsync(Fixture.Hello, new Settings(), Fixture.Store);
        Assert.True(r.Success, string.Join("; ", r.Diagnostics.Select(d => d.Message)));
        Assert.True(r.IsExe);
        Assert.NotEmpty(r.Assembly!);
    }

    [Fact]
    public async Task LibraryWithoutMainIsADll()
    {
        var r = await Compiler.CompileAsync("public class A { public int F(int x) => x * 2; }", new Settings(), Fixture.Store);
        Assert.True(r.Success);
        Assert.False(r.IsExe);
    }

    [Fact]
    public async Task ReportsErrorsWithPositions()
    {
        var code = "class A {\n  int F() { return \"x\"; }\n}";
        var r = await Compiler.CompileAsync(code, new Settings(), Fixture.Store);
        Assert.False(r.Success);
        var d = Assert.Single(r.Diagnostics, d => d.Id == "CS0029");
        Assert.Equal(2, d.StartLine);
        Assert.Equal("x", code.Substring(d.Start + 1, d.End - d.Start - 2));
        Assert.Equal("error", d.Severity);
    }

    [Fact]
    public async Task DiagnoseGivesWarningsToo()
    {
        var d = await Compiler.DiagnoseAsync("class A { void M() { int unused = 1; } }", new Settings(), Fixture.Store);
        Assert.Contains(d, x => x.Id == "CS0219" && x.Severity == "warning");
    }

    [Fact]
    public async Task LanguageVersionIsHonoured()
    {
        const string code = "record R(int A); class P { static void Main() { } }";
        Assert.False((await Compiler.CompileAsync(code, new Settings { LangVersion = "8" }, Fixture.Store)).Success);
        Assert.True((await Compiler.CompileAsync(code, new Settings { LangVersion = "9" }, Fixture.Store)).Success);
        Assert.True((await Compiler.CompileAsync(code, new Settings { LangVersion = "latest" }, Fixture.Store)).Success);
    }

    [Fact]
    public async Task DebugDefinesDebugSymbol()
    {
        const string code = "class P { static void Main() {\n#if DEBUG\n System.Console.WriteLine(\"dbg\");\n#endif\n } }";
        var dbg = await Playground2(code, "debug");
        var rel = await Playground2(code, "release");
        Assert.Contains("dbg", dbg);
        Assert.DoesNotContain("dbg", rel);
    }

    private static async Task<string> Playground2(string code, string cfg)
    {
        var p = Fixture.NewPlayground();
        await p.CompileAsync(code, JsonSerializer.Serialize(new { configuration = cfg, optimize = cfg == "release" }));
        return p.Il();
    }

    [Fact]
    public async Task OptimizeToggleChangesTheIl()
    {
        const string code = "class A { public static int F(int x) { int y = x + 1; return y; } }";
        string Il(bool opt) { var p = Fixture.NewPlayground(); p.CompileAsync(code, JsonSerializer.Serialize(new { configuration = "release", optimize = opt })).GetAwaiter().GetResult(); return p.Il(); }
        var on = Il(true); var off = Il(false);
        Assert.NotEqual(on, off);
        Assert.Contains(".locals", off);      // debug codegen keeps the local, release does not
        Assert.DoesNotContain(".locals", on);
    }

    [Fact]
    public async Task OnDemandReferencesAreLoadedForUsings()
    {
        var store = new ReferenceStore();
        foreach (var n in new[] { "System.Runtime.dll", "System.Console.dll" }) store.TryAdd(n, File.ReadAllBytes(Path.Combine(Fixture.RefDir(), n)));
        var asked = new List<string>();
        var manifest = System.Text.Json.JsonSerializer.Serialize(new
        {
            version = "t", core = new[] { "System.Runtime.dll", "System.Console.dll" },
            assemblies = new[] { new { name = "System.Runtime.dll", size = 1, ns = new[] { "System" } }, new { name = "System.Console.dll", size = 1, ns = new[] { "System" } },
                new { name = "System.Collections.dll", size = 1, ns = new[] { "System.Collections.Generic" } } }
        });
        var resolver = new RefResolver(RefCatalog.Parse(manifest), store, p => { asked.Add(p); return Task.FromResult<byte[]?>(File.ReadAllBytes(Path.Combine(Fixture.RefDir(), Path.GetFileName(p)))); });
        var r = await Compiler.CompileAsync("using System.Collections.Generic; class A { List<int> L = new(); }", new Settings(), store, resolver);
        Assert.True(r.Success, string.Join("; ", r.Diagnostics.Select(d => d.Message)));
        Assert.Contains("ref/a/System.Collections.dll", asked);
    }
}
