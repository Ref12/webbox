using System.Text.Json;
using Xunit;

namespace SharpLab.Tests;

public class ViewTests
{
    private static async Task<Playground> Compiled(string code, object? settings = null)
    {
        var p = Fixture.NewPlayground();
        var json = await p.CompileAsync(code, JsonSerializer.Serialize(settings ?? new { }));
        Assert.True(JsonDocument.Parse(json).RootElement.GetProperty("success").GetBoolean(), json);
        return p;
    }

    [Fact]
    public async Task IlHasMethodsAndOpcodes()
    {
        var p = await Compiled("class A { public static int Add(int a, int b) => a + b; }");
        var il = p.Il();
        Assert.Contains(".class", il); Assert.Matches(@"\.method public hidebysig static\s+int32 Add", il);
        Assert.Contains("ldarg.0", il); Assert.Contains("add", il); Assert.Contains("ret", il);
    }

    [Fact]
    public async Task AsyncMethodShowsAStateMachineInTheLoweredCSharp()
    {
        var p = await Compiled(Fixture.Async);
        var lowered = p.Decompile(2);
        Assert.Contains("IAsyncStateMachine", lowered);
        Assert.Contains("MoveNext", lowered);
        Assert.DoesNotContain("await ", lowered);
        var high = p.Decompile(3);
        Assert.Contains("await ", high);
        Assert.DoesNotContain("IAsyncStateMachine", high);
    }

    [Fact]
    public async Task LinqLambdasShowClosuresWhenLowered()
    {
        var p = await Compiled("using System.Linq; class A { public static int F(int k, int[] xs) => xs.Where(x => x > k).Sum(); }");
        Assert.Contains("DisplayClass", p.Decompile(2));
        Assert.DoesNotContain("DisplayClass", p.Decompile(3));
    }

    [Fact]
    public async Task RecordsAreExpandedWhenLowered()
    {
        var p = await Compiled("public record Person(string Name, int Age);");
        Assert.Contains("EqualityContract", p.Decompile(2));
        Assert.Contains("record Person", p.Decompile(3));
    }

    [Fact]
    public async Task LevelOneIsLowerThanLevelTwo()
    {
        var p = await Compiled("using System; using System.Collections.Generic; class A { static void F(List<string> a) { foreach (var s in a) Console.WriteLine($\"{s}!\"); } }");
        Assert.Contains("foreach", p.Decompile(3)); Assert.Contains("foreach", p.Decompile(2));
        Assert.DoesNotContain("foreach", p.Decompile(1));
        Assert.Contains("GetEnumerator", p.Decompile(1));
        Assert.True(DecompiledView.DisabledAt(1).Count > DecompiledView.DisabledAt(2).Count);
        Assert.Empty(DecompiledView.DisabledAt(3));
    }

    [Fact]
    public async Task RunCapturesConsoleOutput()
    {
        var p = await Compiled(Fixture.Hello);
        var r = JsonDocument.Parse(await p.RunAsync()).RootElement;
        Assert.True(r.GetProperty("success").GetBoolean());
        Assert.Equal("hello 3" + Environment.NewLine, r.GetProperty("output").GetString());
    }

    [Fact]
    public async Task RunSupportsAsyncMainAndExitCodes()
    {
        var p = await Compiled(Fixture.Async);
        Assert.Contains("42", JsonDocument.Parse(await p.RunAsync()).RootElement.GetProperty("output").GetString());
        var q = await Compiled("System.Console.Write(\"x\"); return 7;");
        Assert.Equal(7, JsonDocument.Parse(await q.RunAsync()).RootElement.GetProperty("exitCode").GetInt32());
    }

    [Fact]
    public async Task RunReportsExceptionsAndLibraries()
    {
        var p = await Compiled("System.Console.WriteLine(\"before\"); throw new System.InvalidOperationException(\"boom\");");
        var r = JsonDocument.Parse(await p.RunAsync()).RootElement;
        Assert.False(r.GetProperty("success").GetBoolean());
        Assert.Contains("before", r.GetProperty("output").GetString());
        Assert.Contains("InvalidOperationException: boom", r.GetProperty("error").GetString());
        var lib = await Compiled("class A { }");
        Assert.Contains("library", JsonDocument.Parse(await lib.RunAsync()).RootElement.GetProperty("error").GetString());
    }

    [Fact]
    public async Task VerifyAcceptsValidCodeAndRejectsBrokenIl()
    {
        var p = await Compiled(Fixture.Async);
        var ok = JsonDocument.Parse(p.Verify()).RootElement;
        Assert.True(ok.GetProperty("available").GetBoolean());
        Assert.True(ok.GetProperty("ok").GetBoolean(), ok.ToString());

        // unsafe code with a pointer deref is unverifiable
        var u = await Compiled("unsafe class A { public static int F(int* p) => *p; }");
        var bad = JsonDocument.Parse(u.Verify()).RootElement;
        Assert.False(bad.GetProperty("ok").GetBoolean());
        Assert.NotEmpty(bad.GetProperty("errors").EnumerateArray());
    }

    [Fact]
    public void SyntaxTreeHasNodesTokensAndTriviaWithSpans()
    {
        const string code = "// hi\nclass A { }";
        var root = JsonDocument.Parse(SyntaxTreeModel.ToJson(code, new Settings())).RootElement;
        Assert.Equal("CompilationUnit", root.GetProperty("k").GetString());
        Assert.Equal(code.Length, root.GetProperty("fe").GetInt32());
        var kinds = new List<(string k, string t, int s, int e)>();
        void Walk(JsonElement n) { kinds.Add((n.GetProperty("k").GetString()!, n.GetProperty("t").GetString()!, n.GetProperty("s").GetInt32(), n.GetProperty("e").GetInt32()));
            if (n.TryGetProperty("c", out var c)) foreach (var x in c.EnumerateArray()) Walk(x); }
        Walk(root);
        Assert.Contains(kinds, x => x is { k: "ClassDeclaration", t: "node", s: 6 });
        Assert.Contains(kinds, x => x is { k: "ClassKeyword", t: "token", s: 6, e: 11 });
        Assert.Contains(kinds, x => x is { k: "SingleLineCommentTrivia", t: "trivia", s: 0, e: 5 });
        Assert.Contains(kinds, x => x.k == "EndOfLineTrivia");
        Assert.Contains(kinds, x => x.k == "EndOfFileToken");
    }

    [Fact]
    public async Task ModelFailureAndDiagnoseOnBrokenCodeDoNotThrow()
    {
        var p = Fixture.NewPlayground();
        var json = await p.CompileAsync("class {", "{}");
        Assert.False(JsonDocument.Parse(json).RootElement.GetProperty("success").GetBoolean());
        Assert.Contains("no assembly", p.Il());
        Assert.NotEmpty(SyntaxTreeModel.ToJson("class {", new Settings()));
    }
}
