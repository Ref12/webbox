using System.Reflection;
using SharpLab;

namespace SharpLab.Tests;

/// <summary>References for tests: the Microsoft.NETCore.App.Ref pack (NuGet), the same set the browser app ships. Path APIs only (Windows and Linux).</summary>
public static class Fixture
{
    public static string RefDir()
    {
        var root = typeof(Fixture).Assembly.GetCustomAttributes<AssemblyMetadataAttribute>().First(a => a.Key == "RefPackDir").Value!;
        return Path.Combine(root, "ref", "net10.0");
    }

    public static ReferenceStore Store { get; } = Build();
    private static ReferenceStore Build() { var s = new ReferenceStore(); s.AddDirectory(RefDir()); return s; }

    public static Playground NewPlayground() { var p = new Playground(); p.Refs.AddDirectory(RefDir()); return p; }

    public const string Hello = "System.Console.WriteLine(\"hello \" + (1 + 2));";
    public const string Async = @"
using System; using System.Threading.Tasks;
class C { public static async Task<int> M(int x) { await Task.Yield(); return x + 1; } }
class P { static async Task Main() { Console.WriteLine(await C.M(41)); } }";
}
