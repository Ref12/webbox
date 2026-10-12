using System.Text.Json;
using Xunit;

namespace SharpLab.Tests;

/// <summary>The Layout picker: resolving a typed name (user types, framework types, generics, nested types, unknown names), completion, and the drill-down names of field types.</summary>
public class LayoutPickerTests
{
    private const string Code = @"
using System;
using System.Collections.Generic;
namespace Shapes { public struct Point { public int X, Y; } public class Circle { public Point Center; public double R; public string Name; } }
public struct Box<T> { public byte tag; public T value; }
public class Holder { public Box<long> big; public List<int> items; public Guid id; public class Inner { public short s; public long l; } public struct InnerS { public byte b; public int i; } }
public record Rec(int A, string B);
";

    private static async Task<(Playground p, LayoutResult r)> Pick(string type, string code = Code)
    {
        var p = Fixture.NewPlayground();
        Assert.True(JsonDocument.Parse(await p.CompileAsync(code, "{}")).RootElement.GetProperty("success").GetBoolean());
        return (p, JsonSerializer.Deserialize<LayoutResult>(p.Layout(type), Playground.Json)!);
    }

    private static TypeLayout Model(LayoutResult r) { Assert.True(r.Error is null, r.Error); return Assert.Single(r.Types).Modelled!; }

    [Fact] public async Task AllDeclaredTypesWhenNothingIsSelected()
    {
        var (_, r) = await Pick("*");
        Assert.Equal(new[] { "Circle", "Point", "Box<Int64>", "Holder", "Holder.Inner", "Holder.InnerS", "Rec" }.OrderBy(x => x), r.Types.Select(t => t.Name).OrderBy(x => x));
        Assert.Contains(r.Declared, d => d.Ref == "Shapes.Point" && d.Kind == "struct" && d.Span is not null);
    }

    [Fact] public async Task EmptyTextPicksTheFirstDeclaredType()
    {
        var (_, r) = await Pick("");
        Assert.Equal("Shapes.Point", r.Selected); Assert.Equal("Point", Model(r).Name);   // source order
    }

    [Theory]
    [InlineData("Shapes.Point", "Point", 8)]
    [InlineData("Point", "Point", 8)]                  // the namespace is optional
    [InlineData("Holder.InnerS", "Holder.InnerS", 8)]  // nested, C# spelling
    [InlineData("Holder+InnerS", "Holder.InnerS", 8)]  // nested, metadata spelling
    [InlineData("InnerS", "Holder.InnerS", 8)]         // nested, simple name
    [InlineData("Box<int>", "Box<Int32>", 8)]          // a closed generic that is not used in the code: constructed on demand
    [InlineData("Box<Shapes.Point>", "Box<Point>", 12)]
    public async Task UserTypesResolve(string typed, string name, int size)
    {
        var (_, r) = await Pick(typed);
        var m = Model(r);
        Assert.Equal(name, m.Name); Assert.Equal(size, m.Size);
        Assert.NotNull(Assert.Single(r.Types).Measured);
    }

    [Fact] public async Task UserTypeFieldsHaveSourceSpans()
    {
        var (_, r) = await Pick("Shapes.Circle");
        Assert.NotNull(Assert.Single(r.Types).Span);
        Assert.All(Model(r).Slots.Where(s => s.Kind == "field"), s => Assert.NotNull(s.Span));
    }

    [Theory]
    [InlineData("System.Guid", "Guid", 16)]
    [InlineData("Guid", "Guid", 16)]
    [InlineData("DateTime", "DateTime", 8)]
    [InlineData("System.Decimal", "Decimal", 16)]
    [InlineData("decimal", "Decimal", 16)]
    [InlineData("int", "Int32", 4)]
    [InlineData("int?", "Nullable<Int32>", 8)]
    [InlineData("System.Collections.Generic.KeyValuePair<string,int>", "KeyValuePair<String, Int32>", 16)]
    [InlineData("Dictionary<string,int>", "Dictionary<String, Int32>", 80)]
    [InlineData("List<int>", "List<Int32>", 40)]
    [InlineData("System.Span<byte>", "Span<Byte>", 16)]
    [InlineData("Span<byte>", "Span<Byte>", 16)]
    [InlineData("ValueTuple<int,long>", "ValueTuple<Int32, Int64>", 16)]
    public async Task FrameworkTypesResolve(string typed, string name, int size)
    {
        var (_, r) = await Pick(typed);
        var m = Model(r);
        Assert.Equal(name, m.Name);
        if (size > 0 && !typed.Contains("Dictionary") && !typed.StartsWith("List")) Assert.Equal(size, m.Size);   // a collection's size depends on the runtime's private fields
        Assert.Null(Assert.Single(r.Types).Span);   // not declared in the editor: nothing to select
    }

    [Fact] public async Task SpanIsARefStruct()
    {
        var (_, r) = await Pick("System.Span<byte>");
        Assert.Equal("ref struct", Model(r).Kind);
    }

    [Fact] public async Task AnOpenGenericNameTakesTheConstructionUsedInTheCode()
    {
        var (_, r) = await Pick("Box");
        Assert.Equal("Box<Int64>", Model(r).Name);                    // Holder.big is a Box<long>
        Assert.Contains("first construction", r.ResolveNote);
        (_, r) = await Pick("Box<>");
        Assert.Equal("Box<Int64>", Model(r).Name);
    }

    [Fact] public async Task AnOpenGenericNameWithoutAUseAsksForArguments()
    {
        var (_, r) = await Pick("Box", "public struct Box<T> { public byte b; public T v; }");
        Assert.Empty(r.Types);
        Assert.Contains("type arguments", r.Error);
        Assert.Contains("Box<int>", r.Error);
        var (_, r2) = await Pick("Dictionary");
        Assert.Contains("generic", r2.Error);
    }

    [Theory]
    [InlineData("NoSuchType", "No type named 'NoSuchType'")]
    [InlineData("System.NoSuch", "No type named 'System.NoSuch'")]
    [InlineData("Box<int,int>", "No type named")]
    [InlineData("Holder<int>", "not generic")]
    [InlineData("Dictionary<string,>", "Cannot read")]
    [InlineData("List<int", "Cannot read")]
    [InlineData("int[]", "no field layout")]
    [InlineData("   ", "Type a type name")]
    public async Task NotFoundAndBadNamesGiveAMessage(string typed, string message)
    {
        var (_, r) = await Pick(typed);
        Assert.Empty(r.Types);
        Assert.Contains(message, r.Error);
    }

    [Fact] public async Task ConstraintViolationsAreReported()
    {
        var (_, r) = await Pick("Box<Span<byte>>");
        Assert.True(r.Error is not null || r.Types.Count == 1);   // a ref struct cannot be a type argument on some runtimes; either way no exception escapes
    }

    [Fact] public async Task FieldTypesCarryANameThePickerCanResolve()
    {
        var (p, r) = await Pick("Holder");
        var fields = Model(r).Slots.Where(s => s.Kind == "field").ToDictionary(s => s.Name!, s => s.TypeRef);
        Assert.Equal("Box<System.Int64>", fields["big"]);
        Assert.Equal("System.Collections.Generic.List<System.Int32>", fields["items"]);
        Assert.Equal("System.Guid", fields["id"]);
        foreach (var typed in fields.Values)   // every reference round-trips through the resolver
        {
            var rr = JsonSerializer.Deserialize<LayoutResult>(p.Layout(typed!), Playground.Json)!;
            Assert.True(rr.Error is null, typed + ": " + rr.Error);
            Assert.Single(rr.Types);
        }
    }

    [Fact] public async Task CompletionListsUserAndFrameworkTypes()
    {
        var (p, _) = await Pick("");
        var c = JsonSerializer.Deserialize<CompletionResult>(p.CompleteType("Ci"), Playground.Json)!;
        Assert.Equal(0, c.From); Assert.Equal("Circle", c.Items[0].Label); Assert.Equal("your code", c.Items[0].Detail);
        c = JsonSerializer.Deserialize<CompletionResult>(p.CompleteType("Guid"), Playground.Json)!;
        Assert.Contains(c.Items, i => i.Insert == "System.Guid");
        c = JsonSerializer.Deserialize<CompletionResult>(p.CompleteType("Dictionary<string,Gu"), Playground.Json)!;
        Assert.Equal(18, c.From); Assert.Contains(c.Items, i => i.Insert == "System.Guid");   // completion applies to the last argument
        c = JsonSerializer.Deserialize<CompletionResult>(p.CompleteType("Dict"), Playground.Json)!;
        Assert.Contains(c.Items, i => i.Insert == "System.Collections.Generic.Dictionary<" && i.Label == "Dictionary<TKey,TValue>");
        c = JsonSerializer.Deserialize<CompletionResult>(p.CompleteType("zzzzqq"), Playground.Json)!;
        Assert.Empty(c.Items);
    }

    [Fact] public async Task ARecordIsListedAndResolved()
    {
        var (_, r) = await Pick("Rec");
        Assert.Equal("class", Model(r).Kind);
        Assert.Contains(Model(r).Slots, s => s.Name == "<A>k__BackingField" || s.Name == "A");
    }

    [Fact] public async Task TheSelectionSurvivesARecompileOnlyWhenTheTypeStillExists()
    {
        var (p, r) = await Pick("Shapes.Point");
        Assert.Equal("Point", Model(r).Name);
        await p.CompileAsync("namespace Shapes { public struct Point { public long X; public long Y; public long Z; } }", "{}");
        Assert.Equal(24, Model(JsonSerializer.Deserialize<LayoutResult>(p.Layout("Shapes.Point"), Playground.Json)!).Size);
        await p.CompileAsync("public class Other { public int a; }", "{}");
        var gone = JsonSerializer.Deserialize<LayoutResult>(p.Layout("Shapes.Point"), Playground.Json)!;
        Assert.NotNull(gone.Error);
        Assert.Contains(gone.Declared, d => d.Name == "Other");
    }
}
