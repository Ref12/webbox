using CsRepl;
using Xunit;

namespace CsRepl.Tests;

public class FormatterTests
{
    [Fact] public void Null() => Assert.Equal("null", ResultFormatter.Format(null));
    [Fact] public void StringIsQuotedAndEscaped() => Assert.Equal("\"a\\n\\\"b\"", ResultFormatter.Format("a\n\"b"));
    [Fact] public void Char() => Assert.Equal("'x'", ResultFormatter.Format('x'));
    [Fact] public void Bool() => Assert.Equal("true", ResultFormatter.Format(true));
    [Fact] public void DoubleIsInvariant() => Assert.Equal("1.5", ResultFormatter.Format(1.5));
    [Fact] public void Sequence() => Assert.Equal("{ 1, 2, 3 }", ResultFormatter.Format(new[] { 1, 2, 3 }));
    [Fact] public void LongSequenceTruncated() =>
        Assert.EndsWith(", ... }", ResultFormatter.Format(Enumerable.Range(0, 100)));
    [Fact] public void Dictionary() =>
        Assert.Equal("{ \"a\" = 1 }", ResultFormatter.Format(new Dictionary<string, int> { ["a"] = 1 }));
    [Fact] public void ExceptionHasTypeAndMessage() =>
        Assert.Equal("System.InvalidOperationException: bad",
            ResultFormatter.FormatException(new InvalidOperationException("bad")));
    [Fact] public void ExceptionUnwrapsAggregateAndShowsInner()
    {
        var e = new AggregateException(new ArgumentException("inner"));
        Assert.StartsWith("System.ArgumentException: inner", ResultFormatter.FormatException(e));
    }
}

public class ReferenceStoreTests
{
    [Fact] public void ManifestSkipsBlanksAndComments() =>
        Assert.Equal(new[] { "a.dll", "b.dll" }, ReferenceStore.ParseManifest("# c\r\n\r\na.dll\n  b.dll \n"));

    [Fact] public void RejectsNonAssemblies()
    {
        var s = new ReferenceStore();
        Assert.False(s.TryAdd("x.dll", new byte[] { 1, 2, 3 }));
        Assert.False(s.TryAdd("x.xml", new byte[] { 1 }));
        Assert.Equal(0, s.Count);
    }

    [Fact] public void AddsRealAssemblyAndUsesFileNameOnly()
    {
        var path = typeof(object).Assembly.Location;
        var s = new ReferenceStore();
        Assert.True(s.TryAdd(Path.Combine("some", "dir", Path.GetFileName(path)), File.ReadAllBytes(path)));
        Assert.Equal(1, s.Count);
        Assert.True(s.TotalBytes > 1000);
    }

    [Fact] public void SameNameReplaces()
    {
        var path = typeof(object).Assembly.Location; var b = File.ReadAllBytes(path);
        var s = new ReferenceStore();
        s.TryAdd("a.dll", b); s.TryAdd("A.dll", b);
        Assert.Equal(1, s.Count);
    }
}

public class ReferenceBundleTests
{
    [Fact] public void RoundTrips()
    {
        var input = new List<(string, byte[])> { ("a.dll", new byte[] { 1, 2, 3 }), ("ü.dll", Array.Empty<byte>()), ("c.dll", new byte[1000]) };
        var back = ReferenceBundle.Read(ReferenceBundle.Write(input));
        Assert.Equal(3, back.Count);
        Assert.Equal("ü.dll", back[1].Name);
        Assert.Equal(new byte[] { 1, 2, 3 }, back[0].Bytes);
        Assert.Equal(1000, back[2].Bytes.Length);
    }

    [Fact] public void RejectsBadMagicAndTruncation()
    {
        Assert.Throws<InvalidDataException>(() => ReferenceBundle.Read(new byte[] { 1, 2, 3, 4, 5, 6, 7, 8 }));
        var good = ReferenceBundle.Write(new[] { ("a.dll", new byte[50]) });
        Assert.Throws<InvalidDataException>(() => ReferenceBundle.Read(good[..^10]));
        Assert.Throws<InvalidDataException>(() => ReferenceBundle.Read(Array.Empty<byte>()));
    }

    [Fact] public void RealRefPackBundleLoadsAndCompiles()
    {
        var files = Directory.EnumerateFiles(Fixture.RefDir(), "*.dll")
            .Select(f => (Path.GetFileName(f), File.ReadAllBytes(f))).ToList();
        var store = new ReferenceStore();
        Assert.Equal(files.Count, store.AddBundle(ReferenceBundle.Write(files)));
        var r = new ReplSession(store.References).SubmitAsync("Enumerable.Range(1, 4).Sum()").GetAwaiter().GetResult();
        Assert.Equal("10", r.Value);
    }
}
