using System.Reflection;
using System.Runtime.InteropServices;

namespace SharpLab;

/// <summary>
/// A static model of how CoreCLR (x64) lays out the instance fields of a type, computed from metadata only (StructLayout, FieldOffset, Pack, Size, field types), not from a running instance.
/// The rules were derived by measuring CoreCLR and are checked against it in the unit tests (hand-written cases and a random-type generator comparing this model with the real runtime):
/// * Sequential structs (the C# default) keep declaration order, every field aligned to min(its alignment, Pack); the size is rounded up to the struct's alignment; Size can only enlarge it.
/// * Auto layout (classes, LayoutKind.Auto) and every struct that contains an object reference (Pack is ignored then) are reordered: object references first, then 8, 4, 2 and 1 byte primitives
///   (declaration order within a group), then struct-typed fields in declaration order. A derived class starts right after its base class's last field; small fields fill the gap in front of an aligned one.
/// * Explicit layout takes the offsets as written; the size is the end of the last field rounded up to the largest alignment.
/// * A class instance is the 8-byte object header, the 8-byte method table pointer and the fields, rounded up to 8 bytes (at least 24 bytes in total).
/// Field types from the framework are read from the types the page's runtime loaded; their layout may differ from the real CoreCLR's (the result says so).
/// </summary>
public sealed class ClrLayout
{
    public const int Ptr = 8;
    public static string RuntimeLabel => "CoreCLR x64 (modelled)";

    public readonly record struct Info(int Size, int Align, bool HasObjRef);

    private sealed class Placement
    {
        public List<Placed> Fields = new();
        public int End;          // end of the last field, not rounded
        public int Size;         // struct size / class data size (rounded)
        public int Align = 1;
        public bool HasObjRef;
        public string Layout = "sequential";
        public int Pack;
        public bool Reordered;
        public string? SizeNote;
        public List<string> Notes = new();
    }
    public sealed record Placed(FieldInfo Field, Type Declaring, Type FieldType, int Offset, int Size, int Align, bool IsRef, string? Note);

    private readonly Dictionary<Type, Placement> _cache = new();
    private readonly HashSet<Type> _framework = new();

    public static TypeLayout Compute(Type t) => new ClrLayout().Layout(t);

    public TypeLayout Layout(Type t)
    {
        var p = PlaceOf(t);
        bool isClass = !t.IsValueType;
        var placed = p.Fields.Select(f => new SlotBuilder.Placed(f.Field.Name, TypeNames.Of(f.FieldType), TypeNames.Full(f.Declaring), f.Offset, f.Size, f.Align, f.IsRef, NestedRows(f), f.Note)).ToList();
        int area = isClass ? Math.Max(AlignUp(p.End, Ptr), Ptr) : p.Size;
        var (slots, pad) = SlotBuilder.Build(placed, area, p.Layout == "explicit", isClass, t.Name,
            isClass ? (p.Fields.Count == 0 ? "the minimum object size is 24 bytes" : null) : p.SizeNote, isClass ? Ptr : p.Align, Ptr);
        var notes = new List<string>(p.Notes);
        if (p.Reordered) notes.Add("The runtime reorders these fields (" + (p.Layout == "auto" ? "auto layout" : "a struct with object references is laid out like auto") + "): references first, then by size, so the order differs from the source.");
        if (_framework.Count > 0) notes.Add("Uses framework types (" + string.Join(", ", _framework.Select(x => x.Name).Take(4)) + (_framework.Count > 4 ? ", …" : "") + ") whose fields are read from this browser runtime; their layout on CoreCLR may differ.");
        return new TypeLayout
        {
            Name = TypeNames.Of(t), FullName = TypeNames.Full(t), Kind = KindOf(t), Runtime = RuntimeLabel, PointerSize = Ptr,
            Size = isClass ? 2 * Ptr + area : p.Size, Paddings = pad, Overhead = isClass ? 2 * Ptr : 0,
            LayoutKind = p.Layout, Pack = p.Pack, Align = p.Align, Slots = slots, Notes = notes,
        };
    }

    public static string KindOf(Type t) => !t.IsValueType ? "class" : t.IsByRefLike ? "ref struct" : "struct";

    private List<LayoutSlot>? NestedRows(Placed f)
    {
        var ft = f.FieldType;
        if (!ft.IsValueType || ft.IsPrimitive || ft.IsEnum || ft.IsPointer || SpecialInfo(ft) is not null || PlaceOf(ft).Fields.Count == 0) return null;
        return Shift(Layout(ft).Slots, f.Offset);
    }

    public static List<LayoutSlot> Shift(List<LayoutSlot> slots, int by) =>
        slots.Select(s => s with { Offset = s.Offset + by, Nested = s.Nested is null ? null : Shift(s.Nested, by) }).ToList();

    // ---------------- sizes of field types ----------------

    private static Info? SpecialInfo(Type t) => (t.IsGenericType ? t.GetGenericTypeDefinition().FullName : t.FullName) switch
    {
        "System.Decimal" => new Info(16, 8, false),
        "System.Int128" or "System.UInt128" => new Info(16, 16, false),
        "System.IntPtr" or "System.UIntPtr" => new Info(8, 8, false),
        "System.Runtime.Intrinsics.Vector64`1" => new Info(8, 8, false),
        "System.Runtime.Intrinsics.Vector128`1" => new Info(16, 16, false),
        "System.Runtime.Intrinsics.Vector256`1" => new Info(32, 32, false),
        "System.Runtime.Intrinsics.Vector512`1" => new Info(64, 64, false),
        _ => null,
    };

    public static bool IsFramework(Type t)
    {
        var n = t.Assembly.GetName().Name;
        return n is not null && (n == "System.Private.CoreLib" || n.StartsWith("System.", StringComparison.Ordinal) || n.StartsWith("Microsoft.", StringComparison.Ordinal) || n == "mscorlib" || n == "netstandard");
    }

    public Info InfoOf(Type t)
    {
        if (t.IsByRef) return new(Ptr, Ptr, false);
        if (t.IsPointer || t.IsFunctionPointer) return new(Ptr, Ptr, false);
        if (t.IsEnum) return InfoOf(Enum.GetUnderlyingType(t));
        if (!t.IsValueType) return new(Ptr, Ptr, true);
        if (t.IsPrimitive)
        {
            int s = Type.GetTypeCode(t) switch
            {
                TypeCode.Boolean or TypeCode.Byte or TypeCode.SByte => 1,
                TypeCode.Char or TypeCode.Int16 or TypeCode.UInt16 => 2,
                TypeCode.Int32 or TypeCode.UInt32 or TypeCode.Single => 4,
                _ => 8,
            };
            return new(s, s, false);
        }
        if (SpecialInfo(t) is { } sp) return sp;
        if (IsFramework(t)) _framework.Add(t.IsGenericType ? t.GetGenericTypeDefinition() : t);
        var p = PlaceOf(t);
        return new(p.Size, p.Align, p.HasObjRef);
    }

    private static int AlignUp(int v, int a) => a <= 1 ? v : (v + a - 1) / a * a;

    // ---------------- placement ----------------

    private Placement PlaceOf(Type t)
    {
        if (_cache.TryGetValue(t, out var c)) return c;
        return _cache[t] = Place(t);
    }

    private Placement Place(Type t)
    {
        var p = new Placement();
        bool isClass = !t.IsValueType;
        var attr = t.StructLayoutAttribute;
        var kind = attr?.Value ?? (isClass ? LayoutKind.Auto : LayoutKind.Sequential);
        int pack = attr?.Pack ?? 0, declaredSize = attr?.Size ?? 0;
        if (pack is < 0 or > 128) pack = 0;
        p.Pack = pack;
        p.Layout = kind == LayoutKind.Explicit ? "explicit" : kind == LayoutKind.Auto ? "auto" : "sequential";

        var own = t.GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly).OrderBy(f => f.MetadataToken).ToList();
        // InlineArray: one element field standing for N elements
        var inline = t.GetCustomAttributesData().FirstOrDefault(a => a.AttributeType.FullName == "System.Runtime.CompilerServices.InlineArrayAttribute");
        if (inline is not null && own.Count == 1 && inline.ConstructorArguments.Count == 1)
        {
            int n = Convert.ToInt32(inline.ConstructorArguments[0].Value);
            var ei = InfoOf(own[0].FieldType);
            p.Fields.Add(new Placed(own[0], t, own[0].FieldType, 0, ei.Size * n, ei.Align, ei.HasObjRef, "InlineArray(" + n + "): " + n + " × " + ei.Size + " bytes"));
            p.End = ei.Size * n; p.Align = ei.Align; p.HasObjRef = ei.HasObjRef; p.Size = AlignUp(p.End, p.Align);
            return p;
        }

        // the base class's fields come first and its end is where ours start
        int pos = 0;
        if (isClass && t.BaseType is { } bt && bt != typeof(object))
        {
            var bp = PlaceOf(bt);
            p.Fields.AddRange(bp.Fields);
            pos = bp.End; p.HasObjRef = bp.HasObjRef;
            if (IsFramework(bt)) _framework.Add(bt.IsGenericType ? bt.GetGenericTypeDefinition() : bt);
        }
        var infos = own.Select(f => (f, info: InfoOf(f.FieldType))).ToList();
        foreach (var x in infos) p.HasObjRef |= x.info.HasObjRef;
        // a type with object references is laid out like Auto, whatever it asks for (CoreCLR ignores Sequential and Pack for non-blittable types)
        bool reorder = kind == LayoutKind.Auto || (kind == LayoutKind.Sequential && p.HasObjRef);   // p.HasObjRef includes the base class
        int maxAlign = 1;

        if (kind == LayoutKind.Explicit)
        {
            p.End = pos;
            foreach (var (f, info) in infos)
            {
                var fo = f.GetCustomAttributesData().FirstOrDefault(a => a.AttributeType.FullName == "System.Runtime.InteropServices.FieldOffsetAttribute");
                int off = fo is null ? 0 : Convert.ToInt32(fo.ConstructorArguments[0].Value);
                int al = pack > 0 ? Math.Min(info.Align, pack) : info.Align;
                p.Fields.Add(new Placed(f, t, f.FieldType, off, info.Size, al, info.HasObjRef, null));
                p.End = Math.Max(p.End, off + info.Size); maxAlign = Math.Max(maxAlign, al);
            }
            if (p.HasObjRef) maxAlign = Math.Max(maxAlign, Ptr);
        }
        else if (!reorder)
        {
            p.End = pos;
            foreach (var (f, info) in infos)
            {
                int al = pack > 0 ? Math.Min(info.Align, pack) : info.Align;
                p.End = AlignUp(p.End, al);
                p.Fields.Add(new Placed(f, t, f.FieldType, p.End, info.Size, al, info.HasObjRef, null));
                p.End += info.Size; maxAlign = Math.Max(maxAlign, al);
            }
        }
        else
        {
            p.Reordered = true;
            if (pack > 0) p.Notes.Add("Pack = " + pack + " is ignored: the runtime lays out a type with object references (or auto layout) by its own rules.");
            p.End = PlaceReordered(t, p, infos, pos, ref maxAlign);
        }
        // CoreCLR caps the alignment of a reordered struct that holds object references at the pointer size (an Int128 inside still sits at 16)
        if (!isClass && reorder && p.HasObjRef) maxAlign = Math.Min(maxAlign, Ptr);
        // an auto-layout struct is rounded up to pointer size
        if (!isClass && kind == LayoutKind.Auto && infos.Any(x => x.f.FieldType.IsValueType && !x.f.FieldType.IsPrimitive && !x.f.FieldType.IsEnum && x.info.Size >= 8)) maxAlign = Math.Max(maxAlign, Ptr);
        p.Align = maxAlign;
        if (!isClass)
        {
            int natural = AlignUp(Math.Max(p.End, 1), p.Align);
            p.Size = natural;
            if (declaredSize > natural) { p.Size = declaredSize; p.SizeNote = "StructLayout(Size = " + declaredSize + ") makes the struct larger than its fields need"; }
        }
        else p.Size = AlignUp(p.End, Ptr);
        return p;
    }

    private int PlaceReordered(Type t, Placement p, List<(FieldInfo f, Info info)> infos, int pos, ref int maxAlign)
    {
        var groups = new Dictionary<int, List<(FieldInfo f, Info info)>> { [0] = new(), [8] = new(), [4] = new(), [2] = new(), [1] = new(), [-1] = new() };
        foreach (var x in infos)
        {
            var ft = x.f.FieldType;
            if (!ft.IsValueType && !ft.IsByRef && !ft.IsPointer && !ft.IsFunctionPointer) groups[0].Add(x);
            else if (ft.IsValueType && !ft.IsPrimitive && !ft.IsEnum && !(ft == typeof(IntPtr) || ft == typeof(UIntPtr))) groups[-1].Add(x);
            else groups[x.info.Size].Add(x);
        }
        int maxA = maxAlign, cur = pos;
        void Put((FieldInfo f, Info info) x)
        {
            int al = x.info.Align;
            cur = AlignUp(cur, al);
            p.Fields.Add(new Placed(x.f, t, x.f.FieldType, cur, x.info.Size, al, x.info.HasObjRef, null));
            cur += x.info.Size; maxA = Math.Max(maxA, x.info.Align);
        }
        foreach (var key in new[] { 0, 8, 4, 2, 1, -1 })
        {
            var g = groups[key];
            while (g.Count > 0)
            {
                var x = g[0];
                int target = AlignUp(cur, x.info.Align);
                while (cur < target)
                {
                    int fill = 0;
                    foreach (var s in new[] { 4, 2, 1 })
                        if (s < x.info.Align && s <= target - cur && cur % s == 0 && groups[s].Count > 0 && !ReferenceEquals(groups[s], g)) { fill = s; break; }
                    if (fill == 0) break;
                    var y = groups[fill][0]; groups[fill].RemoveAt(0);
                    Put(y);
                }
                g.RemoveAt(0);
                Put(x);
            }
        }
        maxAlign = maxA;
        return cur;
    }
}

/// <summary>Type names as ObjectLayoutInspector prints them: the .NET name (Int64, String), generics as Name&lt;Args&gt;, arrays as Name[].</summary>
public static class TypeNames
{
    public static string Of(Type t)
    {
        if (t.IsByRef) return Of(t.GetElementType()!) + "&";
        if (t.IsPointer) return Of(t.GetElementType()!) + "*";
        if (t.IsFunctionPointer) return "delegate*";
        if (t.IsArray) return Of(t.GetElementType()!) + "[" + new string(',', t.GetArrayRank() - 1) + "]";
        string n = t.Name;
        int tick = n.IndexOf((char)96);
        if (tick >= 0) n = n[..tick];
        if (t.IsGenericType && !t.IsGenericTypeDefinition) n += "<" + string.Join(", ", t.GetGenericArguments().Select(Of)) + ">";
        else if (t.IsGenericTypeDefinition) n += "<" + string.Join(", ", t.GetGenericArguments().Select(a => a.Name)) + ">";
        if (t.IsNested && !t.IsGenericParameter) n = Of(t.DeclaringType!).Split('<')[0] + "." + n;
        return n;
    }
    public static string Full(Type t) => (t.IsGenericType && !t.IsGenericTypeDefinition ? t.GetGenericTypeDefinition() : t).FullName ?? t.Name;
}
