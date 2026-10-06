using Xunit;

namespace WebBox.Intellisense.Tests;

/// <summary>SharpLab's mode: one regular document, configured like the compile.</summary>
public class RegularDocumentTests
{
    private const string Prog = "using System;\nclass P { static void Main() { Console.Wri } }";

    [Fact]
    public async Task Completion_lists_members_in_a_regular_document()
    {
        var s = Fixture.Regular();
        var pos = Prog.IndexOf("Wri") + 3;
        var r = await s.CompleteAsync(Prog, pos);
        Assert.NotNull(r);
        Assert.Contains(r!.Items, i => i.Label == "WriteLine" && i.Kind == "Method");
        Assert.DoesNotContain(r.Items, i => i.IsSnippet);   // snippets only on explicit trigger-less requests with a prefix
    }

    [Fact]
    public async Task Regular_documents_have_no_default_usings()
    {
        var s = Fixture.Regular();
        var d = await s.DiagnosticsAsync("class P { void M() { var l = new List<int>(); } }");
        Assert.Contains(d, x => x.Id == "CS0246");   // List<> needs a using in a regular file, unlike in the REPL
        var script = new IntelliService(Fixture.Refs);
        Assert.DoesNotContain(await script.DiagnosticsAsync("var l = new List<int>();"), x => x.Id == "CS0246");
    }

    [Fact]
    public async Task Top_level_statements_make_an_exe_in_auto_mode_and_are_an_error_for_dll()
    {
        var code = "System.Console.WriteLine(1);";
        Assert.Empty(await Fixture.Regular().DiagnosticsAsync(code));
        var dll = Fixture.Regular(new IntelliOptions { Kind = "regular", Output = "dll" });
        Assert.Contains(await dll.DiagnosticsAsync(code), x => x.Id == "CS8805");
    }

    [Fact]
    public async Task Language_version_changes_the_diagnostics()
    {
        var code = "namespace N;\nclass C { }";
        var latest = Fixture.Regular();
        Assert.Empty(await latest.DiagnosticsAsync(code));
        latest.Configure(new IntelliOptions { Kind = "regular", LangVersion = "9" });
        var d = await latest.DiagnosticsAsync(code);
        Assert.Contains(d, x => x.Id == "CS8773" && x.Severity == "error");
    }

    [Fact]
    public async Task Debug_and_release_define_different_symbols()
    {
        var code = "using System;\nclass P { static void Main() {\n#if DEBUG\nConsole.\n#endif\n} }";
        var pos = code.IndexOf("Console.") + 8;
        var s = Fixture.Regular(new IntelliOptions { Kind = "regular", Configuration = "release" });
        var release = await s.CompleteAsync(code, pos, '.');
        Assert.True(release is null || !release.Items.Any(i => i.Label == "WriteLine"));
        s.Configure(new IntelliOptions { Kind = "regular", Configuration = "debug" });
        var debug = await s.CompleteAsync(code, pos, '.');
        Assert.Contains(debug!.Items, i => i.Label == "WriteLine");
    }

    [Fact]
    public async Task Editing_the_text_reuses_the_project_and_answers_for_the_new_text()
    {
        var s = Fixture.Regular();
        var a = "class P { void M() { int x = \"s\"; } }";
        Assert.Contains(await s.DiagnosticsAsync(a), x => x.Id == "CS0029");
        var b = "class P { void M() { int x = 1; _ = x; } }";
        Assert.Empty(await s.DiagnosticsAsync(b));
        Assert.Contains(await s.DiagnosticsAsync(a), x => x.Id == "CS0029");
    }

    [Fact]
    public async Task Describe_returns_the_documentation_of_a_completion_item()
    {
        var s = Fixture.Regular();
        var pos = Prog.IndexOf("Wri") + 3;
        await s.CompleteAsync(Prog, pos);
        var d = await s.DescribeAsync(Prog, pos, "WriteLine");
        Assert.NotNull(d);
        Assert.Contains("WriteLine", d);
    }

    [Fact]
    public async Task Hover_signature_and_classification_work_for_a_regular_document()
    {
        var s = Fixture.Regular();
        var code = "using System;\nclass P { static void Main() { Console.WriteLine(\"hi\", 1); } }";
        var q = await s.QuickInfoAsync(code, code.IndexOf("Console") + 2);
        Assert.NotNull(q);
        Assert.Contains("Console", q!.Text);
        var sig = await s.SignatureHelpAsync(code, code.IndexOf("(\"hi") + 1);
        Assert.NotNull(sig);
        Assert.Contains(sig!.Signatures, x => x.Label.Contains("WriteLine"));
        var spans = await s.ClassifyAsync(code);
        Assert.Equal("class name", spans.Last(x => x.Start == code.IndexOf("Console")).Type);
        Assert.Equal("string", spans.Last(x => x.Start == code.IndexOf("\"hi\"")).Type);
    }

    [Fact]
    public void Options_parse_from_json_with_defaults_of_the_repl()
    {
        var d = IntelliOptions.Parse("");
        Assert.True(d.IsScript);
        Assert.Equal("latest", d.LangVersion);
        var o = IntelliOptions.Parse("{\"kind\":\"regular\",\"langVersion\":\"10\",\"configuration\":\"debug\",\"optimize\":false,\"output\":\"exe\"}");
        Assert.False(o.IsScript);
        Assert.Equal(Microsoft.CodeAnalysis.CSharp.LanguageVersion.CSharp10, o.ToParseOptions().LanguageVersion);
        Assert.Contains("DEBUG", o.ToParseOptions().PreprocessorSymbolNames);
        Assert.Equal(Microsoft.CodeAnalysis.OptimizationLevel.Debug, o.ToCompilationOptions(Microsoft.CodeAnalysis.OutputKind.ConsoleApplication).OptimizationLevel);
    }

    [Fact]
    public async Task Script_mode_still_chains_submissions_after_configure()
    {
        var s = new IntelliService(Fixture.Refs);
        s.Commit("var xs = new List<int>();");
        s.Configure(new IntelliOptions { LangVersion = "12" });   // replays the committed submission
        var r = await s.CompleteAsync("xs.", 3, '.');
        Assert.Contains(r!.Items, i => i.Label == "Add");
    }
}
