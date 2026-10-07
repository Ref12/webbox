using System.Reflection;
using System.Reflection.Emit;
using System.Runtime.CompilerServices;

namespace SharpLab;

/// <summary>
/// What a type's fields really look like on the runtime that executes this code (Mono in the browser, CoreCLR in the unit tests): the offset of every instance field,
/// the size of every field type and of the type itself, read with unverifiable IL in DynamicMethods (<c>ldflda</c> minus the base address, <c>sizeof</c>). No instance of the type is needed:
/// for classes the address is taken on a throw-away object, so nothing is read. This is the same idea as ObjectLayoutInspector, which also reads real field addresses at run time.
/// </summary>
public static class LayoutMeasure
{
    public static bool IsMono { get; } = typeof(object).Assembly.GetType("Mono.RuntimeStructs") is not null;
    public static string RuntimeName => IsMono ? "Mono" : "CoreCLR";
    public static int PointerSize => IntPtr.Size;

    /// <summary>Bytes from the object reference to the first field of a class (Mono: vtable + sync word = 2 pointers; CoreCLR: the method table pointer = 1 pointer; the object header sits before the reference).</summary>
    public static int DataStart { get; } = IsMono ? 2 * IntPtr.Size : IntPtr.Size;
    /// <summary>Total bytes of a class instance before its first field (CoreCLR: header + method table pointer).</summary>
    public static int ObjectOverhead { get; } = IsMono ? 2 * IntPtr.Size : 2 * IntPtr.Size;

    /// <summary>The instance fields of a type in declaration order, base class fields first.</summary>
    public static List<FieldInfo> InstanceFields(Type t)
    {
        var chain = new List<Type>();
        for (var b = t; b is not null && b != typeof(object) && b != typeof(ValueType) && b != typeof(Enum); b = b.BaseType) chain.Add(b);
        chain.Reverse();
        var list = new List<FieldInfo>();
        foreach (var c in chain)
            list.AddRange(c.GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly)
                .OrderBy(f => f.MetadataToken));
        return list;
    }

    private static readonly object Dummy = new();

    /// <summary>Offset of a field from the start of the struct (value types) or from the object reference (classes: includes the method table/vtable pointer).</summary>
    public static int OffsetOf(Type owner, FieldInfo f)
    {
        var dm = new DynamicMethod("off", typeof(int), new[] { typeof(object) }, typeof(LayoutMeasure).Module, true);
        var il = dm.GetILGenerator();
        if (owner.IsValueType)
        {
            var loc = il.DeclareLocal(owner);
            il.Emit(OpCodes.Ldloca, loc); il.Emit(OpCodes.Ldflda, f); il.Emit(OpCodes.Ldloca, loc);
        }
        else
        {
            // the field address is computed against a real object (the instance itself when it can be created); only the address arithmetic matters, the field is never read
            il.Emit(OpCodes.Ldarg_0); il.Emit(OpCodes.Ldflda, f); il.Emit(OpCodes.Ldarg_0);
        }
        il.Emit(OpCodes.Sub); il.Emit(OpCodes.Conv_I4); il.Emit(OpCodes.Ret);
        object? target = null;
        if (!owner.IsValueType) { try { target = owner.IsAbstract || owner.IsInterface ? null : RuntimeHelpers.GetUninitializedObject(owner); } catch { } target ??= Dummy; }
        return ((Func<object?, int>)dm.CreateDelegate(typeof(Func<object?, int>)))(target);
    }

    /// <summary>The runtime's own <c>sizeof</c> of a type used as a field or array element (references: pointer size).</summary>
    public static int SizeOf(Type t)
    {
        var dm = new DynamicMethod("size", typeof(int), Type.EmptyTypes, typeof(LayoutMeasure).Module, true);
        var il = dm.GetILGenerator();
        il.Emit(OpCodes.Sizeof, t); il.Emit(OpCodes.Ret);
        return ((Func<int>)dm.CreateDelegate(typeof(Func<int>)))();
    }

    /// <summary>Bytes of a class instance as the allocator counts them (smallest of a few allocations; null when the class cannot be created, e.g. abstract).</summary>
    public static int? InstanceSize(Type t)
    {
        if (t.IsValueType || t.IsAbstract || t.IsInterface || t.ContainsGenericParameters) return null;
        try
        {
            long best = long.MaxValue;
            for (int i = 0; i < 4; i++)
            {
                long a = GC.GetAllocatedBytesForCurrentThread();
                var o = RuntimeHelpers.GetUninitializedObject(t);
                long b = GC.GetAllocatedBytesForCurrentThread();
                GC.KeepAlive(o);
                if (b - a > 0) best = Math.Min(best, b - a);
            }
            return best == long.MaxValue ? null : (int)best;
        }
        catch { return null; }
    }
}
