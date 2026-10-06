using System.Text.Json;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace WebBox.Intellisense;

/// <summary>
/// What the Roslyn workspace is configured like, so completions and diagnostics match what the host app compiles.
/// The defaults are the C# REPL's: script submissions, latest language version, the REPL's default usings.
/// SharpLab passes its option bar: a regular document, the language version, Release/Debug (preprocessor symbols and optimization), exe/dll.
/// </summary>
public sealed record IntelliOptions
{
    private static readonly string[] ReplUsings = { "System", "System.IO", "System.Linq", "System.Collections.Generic", "System.Threading.Tasks", "System.Text" };

    /// <summary>"script" (a chain of submissions, top-level code is a script) or "regular" (one .cs file).</summary>
    public string Kind { get; init; } = "script";
    /// <summary>"latest", "preview", "default" or a number (7.3, 8 ... 14).</summary>
    public string LangVersion { get; init; } = "latest";
    /// <summary>"debug" (defines DEBUG, TRACE), "release" (TRACE, RELEASE) or "" (no symbols).</summary>
    public string Configuration { get; init; } = "";
    public bool Optimize { get; init; } = true;
    /// <summary>Regular documents only: "exe", "dll" or "auto" (exe when there are top-level statements or a static Main, as the SharpLab compiler decides).</summary>
    public string Output { get; init; } = "auto";
    public bool AllowUnsafe { get; init; }
    /// <summary>Global usings of the compilation; null = the REPL's default imports for scripts and none for regular documents.</summary>
    public string[]? Usings { get; init; }

    public bool IsScript => string.Equals(Kind, "script", StringComparison.OrdinalIgnoreCase);

    public static IntelliOptions Parse(string? json) =>
        string.IsNullOrWhiteSpace(json) ? new IntelliOptions() : JsonSerializer.Deserialize<IntelliOptions>(json, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase }) ?? new IntelliOptions();

    public LanguageVersion ParseLanguageVersion() => LanguageVersionFacts.TryParse(LangVersion, out var v) ? v : LanguageVersion.Latest;

    public CSharpParseOptions ToParseOptions()
    {
        string[]? symbols = Configuration.ToLowerInvariant() switch
        {
            "debug" => new[] { "DEBUG", "TRACE" },
            "release" => new[] { "TRACE", "RELEASE" },
            _ => null
        };
        return new CSharpParseOptions(ParseLanguageVersion(), DocumentationMode.Parse, IsScript ? SourceCodeKind.Script : SourceCodeKind.Regular, symbols);
    }

    public CSharpCompilationOptions ToCompilationOptions(OutputKind outputKind) =>
        new CSharpCompilationOptions(outputKind, usings: Usings ?? (IsScript ? ReplUsings : Array.Empty<string>()),
            optimizationLevel: Optimize ? OptimizationLevel.Release : OptimizationLevel.Debug, allowUnsafe: AllowUnsafe,
            concurrentBuild: false /* single thread in the browser */).WithMetadataImportOptions(MetadataImportOptions.All);

    /// <summary>Console app when the text has top-level statements or a static Main, else a library (the same rule as SharpLab's compiler).</summary>
    public OutputKind ResolveOutput(string code)
    {
        if (IsScript) return OutputKind.DynamicallyLinkedLibrary;
        switch (Output.ToLowerInvariant())
        {
            case "exe": return OutputKind.ConsoleApplication;
            case "dll": return OutputKind.DynamicallyLinkedLibrary;
        }
        var root = CSharpSyntaxTree.ParseText(code, ToParseOptions()).GetRoot();
        var exe = (root is CompilationUnitSyntax cu && cu.Members.OfType<GlobalStatementSyntax>().Any())
            || root.DescendantNodes().OfType<MethodDeclarationSyntax>().Any(m => m.Identifier.ValueText == "Main" && m.Modifiers.Any(SyntaxKind.StaticKeyword));
        return exe ? OutputKind.ConsoleApplication : OutputKind.DynamicallyLinkedLibrary;
    }
}
