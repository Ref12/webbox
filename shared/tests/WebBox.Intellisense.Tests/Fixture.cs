using System.Reflection;
using Microsoft.CodeAnalysis;

namespace WebBox.Intellisense.Tests;

public static class Fixture
{
    public static IReadOnlyList<MetadataReference> Refs { get; } = Build();

    private static List<MetadataReference> Build()
    {
        var root = typeof(Fixture).Assembly.GetCustomAttributes<AssemblyMetadataAttribute>().First(a => a.Key == "RefPackDir").Value!;
        return Directory.EnumerateFiles(Path.Combine(root, "ref", "net10.0"), "*.dll").Select(f => (MetadataReference)MetadataReference.CreateFromFile(f)).ToList();
    }

    public static IntelliService Regular(IntelliOptions? o = null) => new(Refs, o ?? new IntelliOptions { Kind = "regular", Configuration = "release", AllowUnsafe = true });
}
