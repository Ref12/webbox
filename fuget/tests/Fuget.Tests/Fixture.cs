using System.IO.Compression;
using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

namespace Fuget.Tests;

/// <summary>Builds small real assemblies with Roslyn (plus their XML docs) and packs them into .nupkg files in memory: no network, same on Windows and Linux.</summary>
public static class Fixture
{
    public const string V1 = """
        using System;
        using System.Collections.Generic;
        [assembly: System.Reflection.AssemblyVersion("1.0.0.0")]
        namespace Acme.Widgets
        {
            /// <summary>A widget.</summary>
            /// <remarks>Remarks about <see cref="Name"/> and <paramref name="x"/>.</remarks>
            public class Widget<T> : IDisposable where T : class
            {
                /// <summary>Creates it.</summary>
                /// <param name="name">The name.</param>
                public Widget(string name, int size = 3) { Name = name; }
                /// <summary>The name.</summary>
                public string Name { get; set; }
                public int Size { get; protected set; }
                public static readonly int Max = 10;
                public const string Tag = "w";
                public event EventHandler Changed;
                /// <summary>Does it.</summary>
                /// <returns>The result.</returns>
                /// <param name="a">The a.</param>
                /// <exception cref="ArgumentException">When bad.</exception>
                public virtual int Compute(int a, params string[] rest) => a + rest.Length;
                [Obsolete("Use Compute")] public void Old() { }
                public static Widget<T> operator +(Widget<T> a, Widget<T> b) => a;
                public T this[int i] => default;
                public Dictionary<string, List<int>> Map() => null;
                public void Gen<U>(U u, ref int r, out string s) { s = "x"; }
                protected void Prot() { }
                internal void Hidden() { }
                public void Dispose() { }
                public class Nested { public int X; }
            }
            public enum Color { Red = 1, Green = 2 }
            public delegate void Handler(object sender, int code);
            public interface IThing { void Do(); int P { get; } }
            public struct Pt { public int X, Y; }
            internal class Secret { }
        }
        """;

    public const string V2 = """
        using System;
        using System.Collections.Generic;
        [assembly: System.Reflection.AssemblyVersion("2.0.0.0")]
        namespace Acme.Widgets
        {
            /// <summary>A widget.</summary>
            public class Widget<T> : IDisposable where T : class
            {
                public Widget(string name, int size = 3) { Name = name; }
                public string Name { get; set; }
                public int Size { get; set; }
                public static readonly int Max = 10;
                public const string Tag = "w";
                public event EventHandler Changed;
                /// <summary>Does it.</summary>
                public virtual long Compute(int a, params string[] rest) => a + rest.Length;
                public static Widget<T> operator +(Widget<T> a, Widget<T> b) => a;
                public T this[int i] => default;
                public Dictionary<string, List<int>> Map() => null;
                public void Gen<U>(U u, ref int r, out string s) { s = "x"; }
                protected void Prot() { }
                public void Extra() { }
                public void Dispose() { }
                public class Nested { public int X; }
            }
            public enum Color { Red = 1, Green = 2, Blue = 3 }
            public delegate void Handler(object sender, int code);
            public interface IThing { void Do(); int P { get; } }
            public class Gadget { public string Run(int times) { for (var i = 0; i < times; i++) { if (i == 3) return "three"; } return "none"; } }
        }
        """;

    private static readonly string[] Tpa = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!).Split(Path.PathSeparator);

    /// <summary>Path of a framework assembly by simple name (from the running runtime), for serving reference assemblies in tests.</summary>
    public static byte[]? RuntimeAssembly(string simpleName)
    {
        var p = Tpa.FirstOrDefault(x => Path.GetFileNameWithoutExtension(x).Equals(simpleName, StringComparison.OrdinalIgnoreCase));
        return p == null ? null : File.ReadAllBytes(p);
    }

    public static IEnumerable<string> RuntimeAssemblyNames => Tpa.Select(Path.GetFileNameWithoutExtension)!;

    public static (byte[] Dll, string Xml) Compile(string source, string assemblyName = "Acme.Widgets")
    {
        var refs = new[] { "System.Runtime", "System.Collections", "System.Private.CoreLib", "System.Linq" }
            .Select(n => MetadataReference.CreateFromFile(Tpa.First(x => Path.GetFileNameWithoutExtension(x) == n)));
        var tree = CSharpSyntaxTree.ParseText(source, new CSharpParseOptions(LanguageVersion.Latest, DocumentationMode.Diagnose));
        var comp = CSharpCompilation.Create(assemblyName, new[] { tree }, refs, new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, optimizationLevel: OptimizationLevel.Release));
        using var dll = new MemoryStream(); using var xml = new MemoryStream();
        var r = comp.Emit(dll, xmlDocumentationStream: xml);
        if (!r.Success) throw new InvalidOperationException(string.Join("\n", r.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error)));
        return (dll.ToArray(), Encoding.UTF8.GetString(xml.ToArray()));
    }

    public static byte[] Nupkg(string id, string version, IEnumerable<(string Path, byte[] Bytes)> files, string dependenciesXml = "")
    {
        using var ms = new MemoryStream();
        using (var zip = new ZipArchive(ms, ZipArchiveMode.Create, leaveOpen: true))
        {
            void Add(string path, byte[] bytes) { using var s = zip.CreateEntry(path).Open(); s.Write(bytes); }
            Add(id + ".nuspec", Encoding.UTF8.GetBytes($"""
                <?xml version="1.0"?><package xmlns="http://schemas.microsoft.com/packaging/2013/05/nuspec.xsd"><metadata>
                <id>{id}</id><version>{version}</version><authors>Acme</authors><description>Widgets for tests</description><tags>a b</tags>
                {dependenciesXml}</metadata></package>
                """));
            foreach (var (p, b) in files) Add(p, b);
        }
        return ms.ToArray();
    }

    /// <summary>A package with the same assembly under net6.0 and netstandard2.0 (docs only next to net6.0).</summary>
    public static byte[] WidgetsPackage(string version, string source)
    {
        var (dll, xml) = Compile(source);
        return Nupkg("Acme.Widgets", version, new (string, byte[])[]
        {
            ("lib/net6.0/Acme.Widgets.dll", dll), ("lib/net6.0/Acme.Widgets.xml", Encoding.UTF8.GetBytes(xml)),
            ("lib/netstandard2.0/Acme.Widgets.dll", dll),
            ("lib/net6.0/de/Acme.Widgets.resources.dll", new byte[] { 1 }),
        }, """
            <dependencies>
              <group targetFramework="net6.0"><dependency id="Acme.Core" version="[1.2.0, )" /></group>
              <group targetFramework=".NETStandard2.0"><dependency id="Acme.Core" version="1.0.0" /><dependency id="Other.Lib" version="2.0.0" /></group>
            </dependencies>
            """);
    }
}
