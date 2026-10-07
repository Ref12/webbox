using System.Text.Json;
using Xunit;

namespace SharpLab.Tests;

/// <summary>Layout view: cases with known answers, checked on the model (CoreCLR x64) and, because the tests run on CoreCLR x64, on the runtime measurement too (the browser measures Mono wasm32 the same way).</summary>
public class LayoutTests
{
    private static async Task<LayoutResult> Layout(string code)
    {
        var p = Fixture.NewPlayground();
        var json = await p.CompileAsync(code, "{}");
        Assert.True(JsonDocument.Parse(json).RootElement.GetProperty("success").GetBoolean(), json);
        return JsonSerializer.Deserialize<LayoutResult>(p.Layout(), Playground.Json)!;
    }

    private static string Rows(TypeLayout l) => string.Join(" ", l.Slots.Select(s => s.Kind == "padding" ? $"pad@{s.Offset}/{s.Size}" : $"{s.Name}@{s.Offset}/{s.Size}"));

    private static async Task<(LayoutEntry e, TypeLayout model, TypeLayout? meas)> One(string code, string name)
    {
        var r = await Layout(code);
        var e = r.Types.Single(t => t.Name == name);
        Assert.NotNull(e.Modelled);
        return (e, e.Modelled!, e.Measured);
    }

    private static void Both(string code, string name, string rows, int size, int paddings)
    {
        var (e, m, meas) = One(code, name).GetAwaiter().GetResult();
        Assert.Equal(rows, Rows(m)); Assert.Equal(size, m.Size); Assert.Equal(paddings, m.Paddings);
        if (OperatingSystem.IsBrowser() || IntPtr.Size != 8) return;
        Assert.NotNull(meas);
        Assert.Equal(rows, Rows(meas!)); Assert.Equal(size, meas!.Size); Assert.Equal(paddings, meas.Paddings);
    }

    [Fact] public void BoolThenLongHasSevenBytesOfPadding() =>
        Both("struct S { public bool b; public long l; }", "S", "b@0/1 pad@1/7 l@8/8", 16, 7);

    [Fact] public void ExplicitLayoutUsesTheWrittenOffsets() =>
        Both("using System.Runtime.InteropServices; [StructLayout(LayoutKind.Explicit)] struct E { [FieldOffset(0)] public int a; [FieldOffset(2)] public short b; [FieldOffset(8)] public byte c; }",
             "E", "a@0/4 b@2/2 pad@4/4 c@8/1 pad@9/3", 12, 7);

    [Fact] public void PackOneRemovesPadding() =>
        Both("using System.Runtime.InteropServices; [StructLayout(LayoutKind.Sequential, Pack = 1)] struct P { public byte a; public long l; public int i; }", "P", "a@0/1 l@1/8 i@9/4", 13, 0);

    [Fact] public void ClassHasHeaderAndMethodTable() =>
        Both("class C { public long l; public int i; }", "C", "l@0/8 i@8/4 pad@12/4", 32, 4);

    [Fact] public void ClassFieldsAreReorderedByTheRuntime() =>
        Both("class C { public byte a; public long l; public string s; public byte c; }", "C", "s@0/8 l@8/8 a@16/1 c@17/1 pad@18/6", 40, 6);

    [Fact] public void StructInsideAStructIsExpanded()
    {
        var (e, m, meas) = One("struct In { public byte b; public long l; } struct Out { public byte x; public In i; }", "Out").GetAwaiter().GetResult();
        Assert.Equal("x@0/1 pad@1/7 i@8/16", Rows(m));
        var field = m.Slots.Single(s => s.Name == "i");
        Assert.Equal("b@8/1 pad@9/7 l@16/8", Rows(new TypeLayout { Slots = field.Nested! }));
        Assert.Equal(24, m.Size); Assert.Equal(7, m.Paddings);   // the outer gaps only; the inner struct's own padding is shown in its nested rows

    }

    [Fact] public void GenericStructIsInstantiated()
    {
        var r = Layout("struct G<T> { public byte b; public T t; }").GetAwaiter().GetResult();
        var names = r.Types.Select(t => t.Name).ToList();
        Assert.Contains("G<Int32>", names); Assert.Contains("G<String>", names);
        Assert.Equal("b@0/1 pad@1/3 t@4/4", Rows(r.Types.Single(t => t.Name == "G<Int32>").Modelled!));
        Assert.Equal("t@0/8 b@8/1 pad@9/7", Rows(r.Types.Single(t => t.Name == "G<String>").Modelled!));   // the reference moves first
    }

    [Fact] public void ReferenceFieldsComeFirstInAClass() =>
        Both("class R { public byte b; public string s; public object o; public int i; }", "R", "s@0/8 o@8/8 i@16/4 b@20/1 pad@21/3", 40, 3);

    [Fact] public void StructWithAReferenceIsReordered() =>
        Both("struct S { public byte a; public string r; public short s; }", "S", "r@0/8 s@8/2 a@10/1 pad@11/5", 16, 5);

    [Fact] public void DerivedClassStartsAfterItsBase() =>
        Both("class B { public long l; public byte x; } class D : B { public byte y; public int i; }", "D", "l@0/8 x@8/1 y@9/1 pad@10/2 i@12/4", 32, 2);   // y fills the gap behind the base class

    [Fact] public async Task TextFollowsObjectLayoutInspector()
    {
        var (e, _, _) = await One("struct MyStruct { public bool b; public long l; }", "MyStruct");
        var expected = string.Join("\n", new[]
        {
            "Type layout for 'MyStruct'",
            "Size: 16 bytes. Paddings: 7 bytes (%43 of empty space)",
            "|===========================|",
            "|   0: Boolean b (1 byte)   |",
            "|---------------------------|",
            "|   1-7: padding (7 bytes)  |",
            "|---------------------------|",
            "|  8-15: Int64 l (8 bytes)  |",
            "|===========================|",
        }) + "\n";
        Assert.Equal(expected, e.ModelledText);
    }

    [Fact] public async Task FieldsCarryTheirSourceSpan()
    {
        const string code = "struct S { public bool flag; public long big; }";
        var (e, m, _) = await One(code, "S");
        var f = m.Slots.Single(s => s.Name == "big");
        Assert.Equal("big", code[f.Span![0]..f.Span[1]]);
        Assert.Equal("S", code[e.Span![0]..e.Span[1]]);
    }

    [Fact] public async Task NoAssemblyMeansNoTypes()
    {
        var p = Fixture.NewPlayground();
        await p.CompileAsync("class { ", "{}");
        var r = JsonSerializer.Deserialize<LayoutResult>(p.Layout(), Playground.Json)!;
        Assert.False(r.Available); Assert.Empty(r.Types);
    }

    // ---- edge types ----
    [Fact] public async Task RefStructIsListedAsRefStruct()
    {
        var (e, m, _) = await One("using System; ref struct R { public Span<byte> s; public int i; }", "R");
        Assert.Equal("ref struct", m.Kind);
        Assert.Equal("s@0/16 i@16/4 pad@20/4", Rows(m)); Assert.Equal(24, m.Size);
    }

    [Fact] public void PointerFieldsAreEightBytesAndNotReferences() =>
        Both("unsafe struct P { public byte b; public byte* p; public delegate*<void> f; }", "P", "b@0/1 pad@1/7 p@8/8 f@16/8", 24, 7);

    [Fact] public void FrameworkStructsKeepTheirSize()
    {
        var r = Layout("using System; struct F { public byte b; public DateTime d; public Guid g; public int? n; public (byte, long) t; public decimal m; }").GetAwaiter().GetResult();
        var m = r.Types.Single(x => x.Name == "F").Modelled!;
        var sizes = m.Slots.Where(s => s.Kind == "field").ToDictionary(s => s.Name!, s => s.Size);
        Assert.Equal(8, sizes["d"]); Assert.Equal(16, sizes["g"]); Assert.Equal(8, sizes["n"]); Assert.Equal(16, sizes["t"]); Assert.Equal(16, sizes["m"]);
        Assert.Contains(m.Slots, s => s.Name == "g" && s.Offset == 16);   // DateTime (8-aligned) comes first, Guid (4-aligned) follows it
        if (IntPtr.Size == 8) { var meas = r.Types.Single(x => x.Name == "F").Measured!; Assert.Equal(Rows(m), Rows(meas)); Assert.Equal(m.Size, meas.Size); }
    }

    [Fact] public void NullableAndTupleAreExpandedOnlyWhenDeclaredInTheCode()
    {
        var r = Layout("struct N { public int? a; public (int, int) b; }").GetAwaiter().GetResult();
        var m = r.Types.Single(x => x.Name == "N").Modelled!;
        Assert.Equal(16, m.Size);
        Assert.Contains(m.Notes, n => n.Contains("framework", StringComparison.OrdinalIgnoreCase));
    }
}
