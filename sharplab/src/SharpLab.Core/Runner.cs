using System.Reflection;
using System.Runtime.Loader;

namespace SharpLab;

public sealed record RunResult(bool Success, string Output, string? Error, int? ExitCode, double Milliseconds);

/// <summary>Run view: loads the compiled assembly into a collectible AssemblyLoadContext and invokes its entry point with Console redirected.</summary>
public static class Runner
{
    private static readonly SemaphoreSlim Gate = new(1, 1);

    public static async Task<RunResult> RunAsync(byte[] assembly, bool isExe)
    {
        if (!isExe) return new(false, "", "This is a library (no Main and no top-level statements), so there is nothing to run. Add a Main method or top-level statements.", null, 0);
        await Gate.WaitAsync();
        var sw = System.Diagnostics.Stopwatch.StartNew();
        var output = new StringWriter();
        var oldOut = Console.Out; var oldErr = Console.Error; var oldIn = Console.In;
        // Collectible contexts are not supported by the browser runtime (PlatformNotSupported); a plain one per run leaks the (small) assembly until reload.
        var alc = CreateContext();
        try
        {
            Console.SetOut(output); Console.SetError(output); Console.SetIn(new StringReader(""));
            var asm = alc.LoadFromStream(new MemoryStream(assembly));
            var entry = asm.EntryPoint ?? throw new InvalidOperationException("the assembly has no entry point");
            var args = entry.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() };
            int? exit = null;
            try
            {
                var result = entry.Invoke(null, args);
                if (result is Task t) { await t; result = t.GetType().IsGenericType ? t.GetType().GetProperty("Result")!.GetValue(t) : null; }
                if (result is int code) exit = code;
            }
            catch (TargetInvocationException e) when (e.InnerException is not null) { return new(false, output.ToString(), FormatException(e.InnerException), null, sw.Elapsed.TotalMilliseconds); }
            catch (Exception e) { return new(false, output.ToString(), FormatException(e), null, sw.Elapsed.TotalMilliseconds); }
            return new(true, output.ToString(), null, exit, sw.Elapsed.TotalMilliseconds);
        }
        finally
        {
            Console.SetOut(oldOut); Console.SetError(oldErr); Console.SetIn(oldIn);
            if (alc.IsCollectible) try { alc.Unload(); } catch (InvalidOperationException) { }
            Gate.Release();
        }
    }

    public static string FormatException(Exception e)
    {
        var sb = new System.Text.StringBuilder();
        for (Exception? x = e; x is not null; x = x.InnerException)
        {
            if (sb.Length > 0) sb.Append("\n ---> ");
            sb.Append("Unhandled exception. ").Append(x.GetType().FullName).Append(": ").Append(x.Message);
        }
        var trace = e.StackTrace;
        if (!string.IsNullOrWhiteSpace(trace)) sb.Append('\n').Append(string.Join('\n', trace.Split('\n').Where(l => !l.Contains("System.Reflection.") && !l.Contains("SharpLab.Runner")).Take(12)));
        return sb.ToString();
    }
}
