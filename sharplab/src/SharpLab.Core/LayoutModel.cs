using System.Text;

namespace SharpLab;

/// <summary>One row of a layout table: the object header / method table pointer (classes), a field (with the layout of a nested struct below it), or padding with the reason for it.</summary>
public sealed record LayoutSlot
{
    /// <summary>"header", "mt", "field" or "padding".</summary>
    public string Kind { get; init; } = "field";
    /// <summary>Offset of the first byte, counted from the first field (the start of the struct, or just after the method table pointer for a class). Nested fields carry the absolute offset.</summary>
    public int Offset { get; init; }
    public int Size { get; init; }
    public string? Name { get; init; }
    public string? Type { get; init; }
    /// <summary>The type that declares the field (differs from the laid-out type for inherited fields); <c>Namespace.Outer+Inner</c>.</summary>
    public string? Declaring { get; init; }
    public bool IsRef { get; init; }
    /// <summary>Padding only: why the runtime left this gap.</summary>
    public string? Cause { get; init; }
    /// <summary>Explicit layout: this field shares bytes with another one.</summary>
    public bool Overlap { get; init; }
    /// <summary>Alignment the type of the field asks for.</summary>
    public int Align { get; init; }
    /// <summary>A struct field's own layout (rows with absolute offsets).</summary>
    public List<LayoutSlot>? Nested { get; init; }
    /// <summary>Source span of the field (or of the declaring field/property), filled in by the page model for the editor selection.</summary>
    public int[]? Span { get; init; }
    public string? Note { get; init; }
}

/// <summary>The memory layout of one type on one runtime.</summary>
public sealed record TypeLayout
{
    public string Name { get; init; } = "";
    public string FullName { get; init; } = "";
    /// <summary>"class", "struct" or "ref struct".</summary>
    public string Kind { get; init; } = "class";
    /// <summary>"CoreCLR x64 (modelled)" or "Mono wasm32 (measured)": which runtime and how.</summary>
    public string Runtime { get; init; } = "";
    public int PointerSize { get; init; }
    /// <summary>Whole object for a class (header and method table pointer included), the value for a struct.</summary>
    public int Size { get; init; }
    public int Paddings { get; init; }
    /// <summary>Bytes before the first field of a class (header + method table / vtable pointer); 0 for structs.</summary>
    public int Overhead { get; init; }
    /// <summary>"auto", "sequential" or "explicit" as declared; the model says in Notes when the runtime reorders anyway.</summary>
    public string LayoutKind { get; init; } = "auto";
    public int Pack { get; init; }
    public int Align { get; init; }
    public List<LayoutSlot> Slots { get; init; } = new();
    public List<string> Notes { get; init; } = new();
    public string? Error { get; init; }
}

/// <summary>Builds the rows of a layout table from placed fields: finds gaps and says where each comes from.</summary>
public static class SlotBuilder
{
    public sealed record Placed(string Name, string TypeName, string Declaring, int Offset, int Size, int Align, bool IsRef, List<LayoutSlot>? Nested, string? Note = null);

    /// <summary>Rows (without the class header) and the padding total. <paramref name="size"/> is the size of the field area (struct size / data size of a class).</summary>
    public static (List<LayoutSlot> slots, int paddings) Build(IReadOnlyList<Placed> fields, int size, bool explicitLayout, bool isClass, string typeName, string? sizeNote, int tailAlign, int pointerSize)
    {
        var slots = new List<LayoutSlot>();
        int paddings = 0, end = 0;
        Placed? prev = null;
        void Gap(int from, int to, Placed? before, Placed? after, bool tail)
        {
            if (to <= from) return;
            paddings += to - from;
            string cause;
            if (tail)
                cause = sizeNote ?? (isClass ? "the object size is rounded up to " + tailAlign + " bytes" : "the struct size is a multiple of its alignment (" + tailAlign + ")");
            else if (explicitLayout)
                cause = after is null ? "gap in the explicit layout" : "gap before the explicit offset of '" + after.Name + "'";
            else if (after is not null && before is not null && before.Declaring != after.Declaring)
                cause = "the base class '" + Short(before.Declaring) + "' ends here; '" + after.Name + "' (" + after.TypeName + ") needs " + after.Align + "-byte alignment";
            else if (after is not null && after.Align > 1 && to % after.Align == 0)
                cause = "alignment: '" + after.Name + "' (" + after.TypeName + ") must start at a multiple of " + after.Align;
            else
                cause = "alignment";
            slots.Add(new LayoutSlot { Kind = "padding", Offset = from, Size = to - from, Cause = cause });
        }
        foreach (var f in fields.OrderBy(f => f.Offset).ThenBy(f => f.Size))
        {
            bool overlap = f.Offset < end;
            if (!overlap) Gap(end, f.Offset, prev, f, false);
            slots.Add(new LayoutSlot { Kind = "field", Offset = f.Offset, Size = f.Size, Name = f.Name, Type = f.TypeName, Declaring = f.Declaring, IsRef = f.IsRef, Overlap = overlap, Align = f.Align, Nested = f.Nested, Note = f.Note });
            end = Math.Max(end, f.Offset + f.Size);
            prev = f;
        }
        Gap(end, size, prev, null, true);
        return (slots, paddings);
    }

    public static string Short(string full)
    {
        int i = Math.Max(full.LastIndexOf('.'), full.LastIndexOf('+'));
        return i >= 0 ? full[(i + 1)..] : full;
    }
}

/// <summary>ObjectLayoutInspector-style text for a layout (the format of that library's <c>TypeLayout.PrintLayout</c>), with nested structs indented and the cause of each padding.</summary>
public static class LayoutText
{
    public static string Render(TypeLayout l)
    {
        var rows = new List<(string text, bool sep)>();
        if (l.Kind == "class")
        {
            if (l.Overhead >= 2 * l.PointerSize && l.Runtime.StartsWith("CoreCLR", StringComparison.Ordinal))
            {
                rows.Add(("Object Header (" + l.PointerSize + " bytes)", true));
                rows.Add(("Method Table Ptr (" + l.PointerSize + " bytes)", true));
            }
            else
            {
                rows.Add(("VTable Ptr (" + l.PointerSize + " bytes)", true));
                rows.Add(("Sync Block (" + (l.Overhead - l.PointerSize) + " bytes)", true));
            }
            rows[^1] = (rows[^1].text, true);
        }
        int headerRows = rows.Count;
        void Add(LayoutSlot s, int depth)
        {
            string range = s.Size == 1 ? s.Offset.ToString() : s.Offset + "-" + (s.Offset + s.Size - 1);
            string indent = new string(' ', depth * 2);
            string unit = s.Size == 1 ? "byte" : "bytes";
            string text = s.Kind == "padding"
                ? indent + range + ": padding (" + s.Size + " " + unit + ")"
                : indent + range + ": " + s.Type + " " + s.Name + " (" + s.Size + " " + unit + ")";
            rows.Add((text, false));
            if (s.Nested is not null) foreach (var n in s.Nested) Add(n, depth + 1);
        }
        foreach (var s in l.Slots) Add(s, 0);
        int width = rows.Max(r => r.text.Length) + 4;
        var sb = new StringBuilder();
        sb.Append("Type layout for '").Append(l.Name).Append("'\n");
        int pct = l.Size == 0 ? 0 : l.Paddings * 100 / l.Size;
        sb.Append("Size: ").Append(l.Size).Append(l.Size == 1 ? " byte" : " bytes").Append(". Paddings: ").Append(l.Paddings).Append(l.Paddings == 1 ? " byte" : " bytes")
          .Append(" (%").Append(pct).Append(" of empty space)\n");
        string eq = "|" + new string('=', width) + "|", dash = "|" + new string('-', width) + "|";
        sb.Append(eq).Append('\n');
        for (int i = 0; i < rows.Count; i++)
        {
            var t = rows[i].text;
            bool header = i < headerRows;
            if (header) sb.Append("| ").Append(t.PadRight(width - 1)).Append("|\n");
            else
            {
                int spare = width - t.Length, left = (spare + 1) / 2;
                sb.Append('|').Append(new string(' ', left)).Append(t).Append(new string(' ', spare - left)).Append("|\n");
            }
            if (i == rows.Count - 1) sb.Append(eq).Append('\n');
            else sb.Append(i == headerRows - 1 ? eq : dash).Append('\n');
        }
        if (rows.Count == 0) sb.Append(eq).Append('\n');
        return sb.ToString();
    }
}
