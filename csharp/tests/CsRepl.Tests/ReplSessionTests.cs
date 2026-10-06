using CsRepl;
using Xunit;

namespace CsRepl.Tests;

public class ReplSessionTests
{
    private static async Task Ok(ReplSession s, string code)
    {
        var r = await s.SubmitAsync(code);
        Assert.True(r.Success, code + " => " + r.Error + string.Join("|", r.Diagnostics));
    }

    [Fact]
    public async Task ExpressionValueIsReturned()
    {
        var s = Fixture.NewSession();
        var r = await s.SubmitAsync("1 + 2");
        Assert.True(r.Success, string.Join("\n", r.Diagnostics));
        Assert.Equal("3", r.Value);
    }

    [Fact]
    public async Task VariablesMethodsAndUsingsCarryOver()
    {
        var s = Fixture.NewSession();
        var u = await s.SubmitAsync("using System.Text;");
        Assert.True(u.Success, u.Error + string.Join("|", u.Diagnostics));
        await Ok(s, "var x = 20;");
        await Ok(s, "int Twice(int n) => n * 2;");
        await Ok(s, "class P { public int V = 7; }");
        var r = await s.SubmitAsync("var sb = new StringBuilder(); sb.Append(Twice(x) + new P().V); sb.ToString()");
        Assert.True(r.Success, r.Error + string.Join("\n", r.Diagnostics));
        Assert.Equal("\"47\"", r.Value);
        Assert.Equal(5, s.SubmissionCount);
    }

    [Fact]
    public async Task ConsoleOutputIsCaptured()
    {
        var s = Fixture.NewSession();
        var r = await s.SubmitAsync("Console.WriteLine(\"hi\"); 5");
        Assert.Equal("hi" + Environment.NewLine, r.Output);
        Assert.Equal("5", r.Value);
    }

    [Fact]
    public async Task RuntimeExceptionShowsMessageAndSessionSurvives()
    {
        var s = Fixture.NewSession();
        await s.SubmitAsync("var a = 1;");
        var r = await s.SubmitAsync("throw new InvalidOperationException(\"boom\");");
        Assert.False(r.Success);
        Assert.Contains("boom", r.Error);
        Assert.Equal("2", (await s.SubmitAsync("a + 1")).Value);
    }

    [Fact]
    public async Task CompileErrorIsReportedAndStateKept()
    {
        var s = Fixture.NewSession();
        await s.SubmitAsync("var a = 1;");
        var r = await s.SubmitAsync("a +");
        Assert.False(r.Success);
        Assert.NotEmpty(r.Diagnostics);
        Assert.Equal("1", (await s.SubmitAsync("a")).Value);
    }

    [Fact]
    public async Task AsyncAwaitWorks()
    {
        var s = Fixture.NewSession();
        var r = await s.SubmitAsync("await Task.Delay(1); 42");
        Assert.Equal("42", r.Value);
    }

    [Theory]
    [InlineData("var x = 1;", true)]
    [InlineData("void F() {", false)]
    [InlineData("1 +", false)]
    public void CompletenessCheck(string code, bool complete) =>
        Assert.Equal(complete, ReplSession.IsCompleteSubmission(code));
}
