using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using ILVerify;

namespace SharpLab;

public sealed record VerifyResult(bool Available, bool Ok, IReadOnlyList<string> Errors, string Note, double Milliseconds);

/// <summary>Verify view: ILVerify (the ECMA-335 verifier behind dotnet-ilverify) over the compiled assembly, resolving references from the loaded ref pack.</summary>
public static class IlVerifier
{
    private sealed class Resolver : IResolver
    {
        private readonly ReferenceStore _store; private readonly Dictionary<string, PEReader?> _readers = new(StringComparer.OrdinalIgnoreCase);
        public Resolver(ReferenceStore store, byte[] self) { _store = store; _readers["SharpLabApp"] = new PEReader(new MemoryStream(self)); }
        public PEReader Self => _readers["SharpLabApp"]!;
        // One PEReader per assembly: ILVerify compares types by the module instance they came from, so the verified assembly must be the one it resolves too.
        public PEReader? ResolveAssembly(AssemblyNameInfo name)
        {
            var key = name.Name ?? "";
            if (!_readers.TryGetValue(key, out var r))
            {
                var bytes = _store.GetImage(key);
                _readers[key] = r = bytes is null ? null : new PEReader(new MemoryStream(bytes));
            }
            return r;
        }
        public PEReader? ResolveModule(AssemblyNameInfo referencingAssembly, string fileName) => null;
    }

    public static VerifyResult Verify(byte[] assembly, ReferenceStore store, string systemModule = "System.Runtime")
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();
        try
        {
            var resolver = new Resolver(store, assembly);
            var verifier = new Verifier(resolver, new VerifierOptions { IncludeMetadataTokensInErrorMessages = false, SanityChecks = false });
            verifier.SetSystemModuleName(new AssemblyNameInfo(systemModule));
            var pe = resolver.Self;
            var md = pe.GetMetadataReader();
            var errors = new List<string>();
            foreach (var r in verifier.Verify(pe))
            {
                var where = r.Method.IsNil ? (r.Type.IsNil ? "" : md.GetString(md.GetTypeDefinition(r.Type).Name) + ": ")
                    : Qualify(md, r.Method);
                errors.Add(where + r.Message);
            }
            return new(true, errors.Count == 0, errors, errors.Count == 0 ? "All methods verified." : errors.Count + " problem(s).", sw.Elapsed.TotalMilliseconds);
        }
        catch (Exception e)
        {
            return new(false, false, Array.Empty<string>(), "ILVerify could not run here: " + e.GetType().Name + ": " + e.Message, sw.Elapsed.TotalMilliseconds);
        }
    }

    private static string Qualify(MetadataReader md, MethodDefinitionHandle h)
    {
        var m = md.GetMethodDefinition(h);
        var t = md.GetTypeDefinition(m.GetDeclaringType());
        return md.GetString(t.Name) + "." + md.GetString(m.Name) + ": ";
    }
}
