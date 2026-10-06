using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.Loader;

// Loads an assembly and forces the JIT to compile its methods (RuntimeHelpers.PrepareMethod), without running any of its code.
// The caller sets DOTNET_JitDisasm (method filter), DOTNET_TieredCompilation=0 etc. in the environment; the JIT writes the listing to stdout.
// Usage: dotnet JitRunner.dll <assembly.dll> [typesFile]   (typesFile: the full names of the assembly's types are written there so the caller can
// drop the listings of runtime methods that the JIT also compiled while this program ran: reflection, the loader...)
var path = Path.GetFullPath(args[0]);
var alc = new AssemblyLoadContext("jit", isCollectible: false);
var asm = alc.LoadFromAssemblyPath(path);
Type[] types;
try { types = asm.GetTypes(); } catch (ReflectionTypeLoadException e) { types = e.Types.Where(t => t is not null).ToArray()!; }
const BindingFlags All = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly;
if (args.Length > 1) File.WriteAllLines(args[1], types.Select(t => t.FullName ?? t.Name));
var failed = 0;
foreach (var t in types)
{
    if (t.ContainsGenericParameters) continue;   // open generics have no code until instantiated
    foreach (MethodBase m in t.GetMethods(All).Cast<MethodBase>().Concat(t.GetConstructors(All)))
    {
        if (m.IsAbstract || m.ContainsGenericParameters || (m.GetMethodImplementationFlags() & MethodImplAttributes.InternalCall) != 0) continue;
        try { RuntimeHelpers.PrepareMethod(m.MethodHandle); } catch (Exception e) { failed++; Console.Error.WriteLine($"; could not prepare {t.FullName}::{m.Name}: {e.GetType().Name}"); }
    }
}
return 0;
