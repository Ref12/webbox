using System.Reflection.PortableExecutable;
using ICSharpCode.Decompiler;
using ICSharpCode.Decompiler.CSharp;
using ICSharpCode.Decompiler.Disassembler;
using ICSharpCode.Decompiler.Metadata;

namespace SharpLab;

/// <summary>Resolves assembly references of the compiled assembly from the reference pack the page has loaded.</summary>
public sealed class StoreResolver : IAssemblyResolver
{
    private readonly ReferenceStore _store;
    private readonly Dictionary<string, PEFile?> _cache = new(StringComparer.OrdinalIgnoreCase);
    public StoreResolver(ReferenceStore store) => _store = store;

    public IDisposable BeginSnapshot() => new Snapshot();
    private sealed class Snapshot : IDisposable { public void Dispose() { } }

    public MetadataFile? Resolve(IAssemblyReference reference)
    {
        if (!_cache.TryGetValue(reference.Name, out var f))
        {
            var bytes = _store.GetImage(reference.Name);
            _cache[reference.Name] = f = bytes is null ? null : new PEFile(reference.Name + ".dll", new MemoryStream(bytes), PEStreamOptions.PrefetchEntireImage);
        }
        return f;
    }
    public Task<MetadataFile?> ResolveAsync(IAssemblyReference reference) => Task.FromResult(Resolve(reference));
    public MetadataFile? ResolveModule(MetadataFile mainModule, string moduleName) => null;
    public Task<MetadataFile?> ResolveModuleAsync(MetadataFile mainModule, string moduleName) => Task.FromResult<MetadataFile?>(null);
}

/// <summary>IL view: the module disassembled with ICSharpCode.Decompiler's ReflectionDisassembler (ildasm-style text).</summary>
public static class IlView
{
    public static string Disassemble(byte[] assembly)
    {
        using var pe = new PEFile("SharpLabApp.dll", new MemoryStream(assembly), PEStreamOptions.PrefetchEntireImage);
        var output = new PlainTextOutput();
        var dis = new ReflectionDisassembler(output, CancellationToken.None) { DetectControlStructure = true, ShowSequencePoints = false };
        var md = pe.Metadata;
        foreach (var h in md.TypeDefinitions)
        {
            var t = md.GetTypeDefinition(h);
            if (!t.GetDeclaringType().IsNil) continue;               // nested types are written inside their parent
            if (md.GetString(t.Name) == "<Module>") continue;
            dis.DisassembleType(pe, h);
            output.WriteLine();
        }
        return output.ToString();
    }
}

/// <summary>C# view: the compiled assembly decompiled back with ICSharpCode.Decompiler, so lowering shows. Level controls how many of the decompiler's high-level patterns run.</summary>
public static class DecompiledView
{
    public static DecompilerSettings SettingsFor(int level)
    {
        var s = new DecompilerSettings(ICSharpCode.Decompiler.CSharp.LanguageVersion.Latest) { ThrowOnAssemblyResolveErrors = false, LoadInMemory = true, ShowXmlDocumentation = false };
        if (level >= 3) return s;
        // level 2: statement-level sugar stays, anything that hides a compiler-generated class or state machine goes
        s.AnonymousMethods = false; s.UseLambdaSyntax = false; s.AnonymousTypes = false; s.ExpressionTrees = false;
        s.YieldReturn = false; s.AsyncAwait = false; s.AwaitInCatchFinally = false; s.AsyncEnumerator = false; s.AsyncUsingAndForEachStatement = false;
        s.QueryExpressions = false; s.LocalFunctions = false; s.StaticLocalFunctions = false;
        s.RecordClasses = false; s.RecordStructs = false; s.UsePrimaryConstructorSyntax = false; s.UsePrimaryConstructorSyntaxForNonRecordTypes = false;
        s.WithExpressions = false; s.AutomaticEvents = false; s.TupleTypes = false; s.TupleConversions = false; s.TupleComparisons = false; s.Deconstruction = false;
        s.ExtensionMembers = false; s.FieldKeyword = false; s.InlineArrays = false; s.ParamsCollections = false;
        if (level >= 2) return s;
        // level 1: nearly what the IL says
        s.ForEachStatement = false; s.UsingStatement = false; s.UsingDeclarations = false; s.LockStatement = false; s.SwitchStatementOnString = false;
        s.StringInterpolation = false; s.ObjectOrCollectionInitializers = false; s.DictionaryInitializers = false; s.ExtensionMethodsInCollectionInitializers = false;
        s.NullPropagation = false; s.LiftNullables = false; s.AutomaticProperties = false; s.GetterOnlyAutomaticProperties = false; s.SwitchExpressions = false;
        s.PatternMatching = false; s.RecursivePatternMatching = false; s.PatternCombinators = false; s.RelationalPatterns = false; s.ThrowExpressions = false;
        s.OutVariables = false; s.Discards = false; s.Ranges = false; s.ForStatement = false; s.DoWhileStatement = false; s.ArrayInitializers = false;
        s.IntroduceIncrementAndDecrement = false; s.MakeAssignmentExpressions = false; s.NamedArguments = false; s.OptionalArguments = false; s.ExtensionMethods = false;
        s.UseExpressionBodyForCalculatedGetterOnlyProperties = false; s.NullableReferenceTypes = false;
        return s;
    }

    public static string Decompile(byte[] assembly, ReferenceStore store, int level)
    {
        using var pe = new PEFile("SharpLabApp.dll", new MemoryStream(assembly), PEStreamOptions.PrefetchEntireImage);
        var decompiler = new CSharpDecompiler(pe, new StoreResolver(store), SettingsFor(level));
        return decompiler.DecompileWholeModuleAsString();
    }

    /// <summary>The names of the decompiler options a level switches off (for the UI tooltip and the tests).</summary>
    public static IReadOnlyList<string> DisabledAt(int level)
    {
        var full = SettingsFor(3); var cur = SettingsFor(level);
        return typeof(DecompilerSettings).GetProperties().Where(p => p.PropertyType == typeof(bool) && p.CanWrite
            && (bool)p.GetValue(full)! && !(bool)p.GetValue(cur)!).Select(p => p.Name).ToList();
    }
}
