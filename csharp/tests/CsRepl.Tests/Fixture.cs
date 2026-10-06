using System.Reflection;
using Microsoft.CodeAnalysis;
using CsRepl;

namespace CsRepl.Tests;

/// <summary>References for tests: the Microsoft.NETCore.App.Ref pack (NuGet), the same set the browser app ships. Path APIs only.</summary>
public static class Fixture
{
    public static IReadOnlyCollection<MetadataReference> Refs { get; } = Build();

    public static string RefDir()
    {
        var root = typeof(Fixture).Assembly.GetCustomAttributes<AssemblyMetadataAttribute>()
            .First(a => a.Key == "RefPackDir").Value!;
        return Path.Combine(root, "ref", "net10.0");
    }

    private static IReadOnlyCollection<MetadataReference> Build()
    {
        var store = new ReferenceStore();
        store.AddDirectory(RefDir());
        return store.References;
    }

    public static ReplSession NewSession() => new(Refs);
}
