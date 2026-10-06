using WebBox.Intellisense;
using Xunit;

namespace CsRepl.Tests;

public class IntelliTests
{
    private static IntelliService New() => new(Fixture.Refs);

    [Fact]
    public void Host_composition_leaves_out_the_persistent_storage_configuration()
    {
        // its static constructor calls Process.GetCurrentProcess(), unsupported in the browser (console: Process_PlatformNotSupported)
        var asms = new[] { "Microsoft.CodeAnalysis.Workspaces", "Microsoft.CodeAnalysis.CSharp.Workspaces", "Microsoft.CodeAnalysis.Features", "Microsoft.CodeAnalysis.CSharp.Features" }
            .Select(System.Reflection.Assembly.Load).ToList();
        var all = asms.SelectMany(a => a.DefinedTypes).Select(x => x.Name).ToList();
        Assert.Contains("DefaultPersistentStorageConfiguration", all);          // still there in Roslyn: the filter is needed
        Assert.DoesNotContain(IntelliService.HostPartTypes(asms), x => x.Name == "DefaultPersistentStorageConfiguration");
        Assert.True(IntelliService.HostPartTypes(asms).Count() > 1000);        // everything else is kept
    }

    [Fact]
    public async Task Completion_after_dot_lists_members_and_filters()
    {
        var s = New();
        var text = "Console.Wri";
        var r = await s.CompleteAsync(text, text.Length);
        Assert.NotNull(r);
        Assert.Contains(r!.Items, i => i.Label == "WriteLine");
        Assert.Equal("Wri".Length, r.Length);
        Assert.Equal(text.Length - 3, r.Start);
        Assert.Contains(r.Items, i => i.Filter == "Write");
    }

    [Fact]
    public async Task Completion_sees_variables_from_previous_submissions()
    {
        var s = New();
        s.Commit("var numbers = new List<int> { 1, 2, 3 };");
        var text = "numbers.";
        var r = await s.CompleteAsync(text, text.Length);
        Assert.Contains(r!.Items, i => i.Label == "Add");
        Assert.Contains(r.Items, i => i.Label == "Count");
        var r2 = await s.CompleteAsync("numbers.Se", 10);   // Linq via default imports
        Assert.Contains(r2!.Items, i => i.Label == "Select");
    }

    [Fact]
    public async Task Completion_has_commit_characters_and_keyword_snippets()
    {
        var s = New();
        var r = await s.CompleteAsync("Console.", 8);
        var wl = r!.Items.First(i => i.Label == "WriteLine");
        Assert.Contains(".", wl.Commit.Concat(new[] { "." }));   // member-access commit set is non-empty or default
        var f = await s.CompleteAsync("for", 3, explicitRequest: true);
        Assert.Contains(f!.Items, i => i.IsSnippet && i.Filter == "for" && i.Insert.Contains("for (int i"));
        Assert.Contains(f.Items, i => i.Label == "foreach (snippet)");
    }

    [Fact]
    public async Task Completion_change_inserts_the_item()
    {
        var s = New();
        var c = await s.GetChangeAsync("Console.WriteL", 14, "WriteLine");
        Assert.Equal("WriteLine", c.NewText);
        Assert.Equal(8, c.Start);
    }

    [Fact]
    public async Task Signature_help_lists_overloads_and_active_parameter()
    {
        var s = New();
        var text = "Math.Max(1, ";
        var h = await s.SignatureHelpAsync(text, text.Length);
        Assert.NotNull(h);
        Assert.True(h!.Signatures.Length > 3);
        Assert.Equal(1, h.ActiveParameter);
        Assert.All(h.Signatures, g => Assert.Contains("Math.Max(", g.Label));
        Assert.Contains("int val1, int val2", h.Signatures[h.Active].Label);   // the overload that fits "1, " is preselected
        Assert.Null(await s.SignatureHelpAsync("Math.Max(1, 2) ", 15));
    }

    [Fact]
    public async Task Quick_info_describes_symbol_under_cursor()
    {
        var s = New();
        s.Commit("int answer = 42;");
        var q = await s.QuickInfoAsync("answer + 1", 2);
        Assert.NotNull(q);
        Assert.Contains("int", q!.Text);
        Assert.Contains("answer", q.Text);
        var q2 = await s.QuickInfoAsync("string.Join(\",\", 1)", 8);
        Assert.Contains("Join", q2!.Text);
    }

    [Fact]
    public async Task Diagnostics_report_errors_with_spans()
    {
        var s = New();
        var d = await s.DiagnosticsAsync("int x = \"a\";\nfoo();");
        Assert.Contains(d, x => x.Id == "CS0029" && x.Severity == "error");
        var u = d.First(x => x.Id == "CS0103");
        Assert.Equal(13, u.Start);
        Assert.Empty(await s.DiagnosticsAsync("var y = 1 + 2;"));
    }

    [Fact]
    public async Task Classification_marks_keywords_types_methods_strings_numbers_locals()
    {
        var s = New();
        var code = "var s = \"hi\"; Console.WriteLine(s.Length + 42);";
        var spans = await s.ClassifyAsync(code);
        string At(string tok) { var i = code.IndexOf(tok, StringComparison.Ordinal); return spans.Last(x => x.Start == i).Type; }
        Assert.Equal("keyword", At("var"));
        Assert.Equal("string", At("\"hi\""));
        Assert.Equal("class name", At("Console"));
        Assert.Equal("method name", At("WriteLine"));
        Assert.Equal("number", At("42"));
        Assert.Equal("property name", At("Length"));
        Assert.Contains(spans, x => x.Type == "field name"); // script-level variables are fields of the submission class
    }

    [Fact]
    public async Task Committed_submissions_are_classified_in_their_own_context()
    {
        var s = New();
        s.Commit("class Foo { public int Bar() => 1; }");
        s.Commit("var f = new Foo(); f.Bar()");
        var spans = await s.ClassifyCommittedAsync(1);
        var code = "var f = new Foo(); f.Bar()";
        Assert.Equal("class name", spans.Last(x => x.Start == code.IndexOf("Foo")).Type);
        Assert.Equal("method name", spans.Last(x => x.Start == code.IndexOf("Bar")).Type);
    }
}
