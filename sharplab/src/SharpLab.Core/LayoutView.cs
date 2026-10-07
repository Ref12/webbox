using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.Loader;
using System.Text.Json;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace SharpLab;

/// <summary>One type in the Layout view: the layout measured on the runtime that executes the page (Mono wasm32 in the browser) and the modelled CoreCLR x64 layout, with ObjectLayoutInspector-style text for both.</summary>
public sealed record LayoutEntry
{
    public string Name { get; init; } = "";
    public int[]? Span { get; init; }
    public TypeLayout? Measured { get; init; }
    public string? MeasuredText { get; init; }
    public TypeLayout? Modelled { get; init; }
    public string? ModelledText { get; init; }
    public string? Error { get; init; }
}

public sealed record LayoutResult(bool Available, string Note, string RuntimeName, int PointerSize, List<LayoutEntry> Types);

/// <summary>
/// Layout view: loads the compiled assembly (as Run does), lists the instance types declared in it (generic ones instantiated with int / string where the constraints allow),
/// measures each on this runtime (<see cref="LayoutMeasure"/>) and models CoreCLR x64 (<see cref="ClrLayout"/>). Idea and output format after ObjectLayoutInspector (MIT, Sergey Teplyakov).
/// </summary>
public static class LayoutView
{
    public static string Runtime => LayoutMeasure.RuntimeName + " " + (LayoutMeasure.PointerSize * 8 == 32 ? "wasm32" : "x" + LayoutMeasure.PointerSize * 8);

    public static LayoutResult Build(byte[]? assembly, string code)
    {
        string rt = LayoutMeasure.RuntimeName;
        if (assembly is null) return new(false, "Fix the compile errors first.", rt, LayoutMeasure.PointerSize, new());
        Assembly asm;
        try
        {
            AssemblyLoadContext alc;
            try { alc = new AssemblyLoadContext("sharplab-layout-" + Guid.NewGuid().ToString("N")); } catch (PlatformNotSupportedException) { alc = AssemblyLoadContext.Default; }
            asm = alc.LoadFromStream(new MemoryStream(assembly));
        }
        catch (Exception e) { return new(false, "Could not load the assembly: " + e.Message, rt, LayoutMeasure.PointerSize, new()); }

        var spans = SpanIndex.Build(code);
        Type[] types;
        try { types = asm.GetTypes(); } catch (ReflectionTypeLoadException e) { types = e.Types.Where(t => t is not null).ToArray()!; }
        var list = new List<LayoutEntry>();
        foreach (var def in types.OrderBy(t => t.MetadataToken))
        {
            if (!Wanted(def)) continue;
            foreach (var t in Instances(def)) list.Add(Entry(t, spans));
        }
        return new(true, list.Count == 0 ? "No class or struct with instance fields is declared in this code." : "", rt, LayoutMeasure.PointerSize, list);
    }

    public static string Json(byte[]? assembly, string code) => JsonSerializer.Serialize(Build(assembly, code), Playground.Json);

    private static bool Wanted(Type t)
    {
        if (t.IsInterface || t.IsEnum || t.IsPointer || t.IsByRef || t.IsAbstract && t.IsSealed) return false;   // static classes are abstract sealed
        if (typeof(Delegate).IsAssignableFrom(t)) return false;
        if (t.Name.StartsWith('<') || t.IsDefined(typeof(CompilerGeneratedAttribute), false)) return false;
        if (t.IsNested && !Wanted(t.DeclaringType!)) return false;
        if (t.Name == "Program" && LayoutMeasure.InstanceFields(t).Count == 0) return false;
        return true;
    }

    private static IEnumerable<Type> Instances(Type def)
    {
        if (!def.IsGenericTypeDefinition) { yield return def; yield break; }
        var tried = new HashSet<string>();
        foreach (var arg in new[] { typeof(int), typeof(string), typeof(object) })
        {
            Type? t = null;
            try { t = def.MakeGenericType(Enumerable.Repeat(arg, def.GetGenericArguments().Length).ToArray()); } catch { }
            if (t is not null && tried.Add(TypeNames.Of(t)) && tried.Count <= 2 && (arg != typeof(object) || tried.Count == 1)) yield return t;
        }
    }

    private static LayoutEntry Entry(Type t, SpanIndex spans)
    {
        var span = spans.TypeSpan(t);
        TypeLayout? meas = null, model = null; string? err = null;
        try { meas = Measure(t, spans); } catch (Exception e) { err = "Measuring on this runtime failed: " + e.GetType().Name + ": " + e.Message; }
        try
        {
            model = ClrLayout.Compute(t);
            model = model with { Slots = Annotate(model.Slots, t, spans) };
        }
        catch (Exception e) { err = (err is null ? "" : err + " ") + "Modelling CoreCLR failed: " + e.GetType().Name + ": " + e.Message; }
        return new LayoutEntry
        {
            Name = TypeNames.Of(t), Span = span, Error = err,
            Measured = meas, MeasuredText = meas is null ? null : LayoutText.Render(meas),
            Modelled = model, ModelledText = model is null ? null : LayoutText.Render(model),
        };
    }

    private static List<LayoutSlot> Annotate(List<LayoutSlot> slots, Type owner, SpanIndex spans) =>
        slots.Select(s => s with
        {
            Span = s.Kind == "field" && s.Name is not null ? spans.FieldSpan(s.Declaring, s.Name) : null,
            Nested = s.Nested is null ? null : Annotate(s.Nested, owner, spans),
        }).ToList();

    /// <summary>The layout of a type as the running runtime has it.</summary>
    public static TypeLayout Measure(Type t, SpanIndex spans)
    {
        bool isClass = !t.IsValueType;
        int start = isClass ? LayoutMeasure.DataStart : 0;
        var fields = LayoutMeasure.InstanceFields(t);
        int ptr = LayoutMeasure.PointerSize;
        var placed = new List<SlotBuilder.Placed>();
        int end = 0;
        foreach (var f in fields)
        {
            int off = LayoutMeasure.OffsetOf(t, f) - start, size = LayoutMeasure.SizeOf(f.FieldType);
            var ft = f.FieldType;
            List<LayoutSlot>? nested = null;
            if (ft.IsValueType && !ft.IsPrimitive && !ft.IsEnum && LayoutMeasure.InstanceFields(ft).Count > 0 && ft.Assembly == t.Assembly)
                nested = ClrLayout.Shift(Measure(ft, spans).Slots, off);
            bool isRef = !ft.IsValueType && !ft.IsPointer;
            placed.Add(new SlotBuilder.Placed(f.Name, TypeNames.Of(ft), TypeNames.Full(f.DeclaringType!), off, size, Math.Min(Math.Max(size, 1), isRef ? ptr : 8), isRef, nested));
            end = Math.Max(end, off + size);
        }
        int overhead = isClass ? LayoutMeasure.ObjectOverhead : 0;
        int size2, area;
        if (isClass)
        {
            int alloc = LayoutMeasure.InstanceSize(t) ?? (overhead + (end + ptr - 1) / ptr * ptr);
            size2 = alloc; area = Math.Max(alloc - overhead, end);
        }
        else { size2 = LayoutMeasure.SizeOf(t); area = size2; }
        var (slots, pad) = SlotBuilder.Build(placed, area, false, isClass, t.Name, null, isClass ? ptr : Math.Max(1, placed.Select(p => p.Align).DefaultIfEmpty(1).Max()), ptr);
        slots = Annotate(slots, t, spans);
        var attr = t.StructLayoutAttribute;
        var notes = new List<string>();
        notes.Add("Measured on the runtime that executes this page (" + LayoutMeasure.RuntimeName + ", " + ptr * 8 + "-bit): offsets come from ldflda/sizeof in dynamic IL" + (isClass ? ", the object size from the allocator" : "") + ".");
        return new TypeLayout
        {
            Name = TypeNames.Of(t), FullName = TypeNames.Full(t), Kind = ClrLayout.KindOf(t), Runtime = Runtime + " (measured)", PointerSize = ptr,
            Size = size2, Paddings = pad, Overhead = overhead,
            LayoutKind = attr?.Value == System.Runtime.InteropServices.LayoutKind.Explicit ? "explicit" : attr?.Value == System.Runtime.InteropServices.LayoutKind.Auto || isClass ? "auto" : "sequential",
            Pack = attr?.Pack ?? 0, Align = 0, Slots = slots, Notes = notes,
        };
    }
}

/// <summary>Maps types and fields of the compiled assembly back to the source text (by name) for the editor selection.</summary>
public sealed class SpanIndex
{
    private readonly Dictionary<string, int[]> _types = new(), _fields = new();

    public static SpanIndex Build(string code)
    {
        var ix = new SpanIndex();
        var root = CSharpSyntaxTree.ParseText(code).GetRoot();
        foreach (var d in root.DescendantNodes().OfType<BaseTypeDeclarationSyntax>())
        {
            string key = KeyOf(d);
            ix._types.TryAdd(key, new[] { d.Identifier.SpanStart, d.Identifier.Span.End });
            void Add(string name, SyntaxToken tok) => ix._fields.TryAdd(key + "::" + name, new[] { tok.SpanStart, tok.Span.End });
            foreach (var m in d.ChildNodes())
            {
                if (m is FieldDeclarationSyntax fd && !fd.Modifiers.Any(SyntaxKind.StaticKeyword) && !fd.Modifiers.Any(SyntaxKind.ConstKeyword))
                    foreach (var v in fd.Declaration.Variables) Add(v.Identifier.Text, v.Identifier);
                else if (m is PropertyDeclarationSyntax pd) Add("<" + pd.Identifier.Text + ">k__BackingField", pd.Identifier);
            }
            if (d is TypeDeclarationSyntax { ParameterList: { } pl }) foreach (var p in pl.Parameters) { Add(p.Identifier.Text, p.Identifier); Add("<" + p.Identifier.Text + ">P", p.Identifier); }
            if (d is RecordDeclarationSyntax rd && rd.ParameterList is { } rpl) foreach (var p in rpl.Parameters) Add("<" + p.Identifier.Text + ">k__BackingField", p.Identifier);
        }
        return ix;
    }

    private static string KeyOf(SyntaxNode d)
    {
        var parts = new List<string>();
        for (var n = d; n is not null; n = n.Parent) if (n is BaseTypeDeclarationSyntax b) parts.Add(b.Identifier.Text);
        parts.Reverse();
        return string.Join("+", parts);
    }

    private static string KeyOf(Type t)
    {
        t = t.IsGenericType && !t.IsGenericTypeDefinition ? t.GetGenericTypeDefinition() : t;
        var parts = new List<string>();
        for (var x = t; x is not null; x = x.DeclaringType) { var n = x.Name; int i = n.IndexOf((char)96); parts.Add(i >= 0 ? n[..i] : n); }
        parts.Reverse();
        return string.Join("+", parts);
    }

    public int[]? TypeSpan(Type t) => _types.GetValueOrDefault(KeyOf(t));

    public int[]? FieldSpan(string? declaringFull, string field)
    {
        if (declaringFull is null) return null;
        var key = declaringFull;
        int dot = key.LastIndexOf('.');
        // "Ns.Outer+Inner" -> "Outer+Inner"; nested types keep '+', the namespace is whatever precedes the first type
        string noNs = key;
        int plus = key.IndexOf('+');
        int nsEnd = (plus >= 0 ? key[..plus] : key).LastIndexOf('.');
        if (nsEnd >= 0) noNs = key[(nsEnd + 1)..];
        int tick;
        while ((tick = noNs.IndexOf((char)96)) >= 0)
        {
            int e = tick + 1; while (e < noNs.Length && char.IsDigit(noNs[e])) e++;
            noNs = noNs[..tick] + noNs[e..];
        }
        return _fields.GetValueOrDefault(noNs + "::" + field) ?? _fields.GetValueOrDefault(noNs + "::<" + field.Trim('<', '>') + ">k__BackingField");
    }
}
