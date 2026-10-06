namespace Fuget;

/// <summary>Target framework names: parsing, ordering and a compatibility search for "which lib folder serves framework X".</summary>
public static class Tfm
{
    public static string Normalize(string tf)
    {
        tf = tf.Trim().ToLowerInvariant();
        if (tf.StartsWith(".netstandard")) return "netstandard" + tf[".netstandard".Length..];
        if (tf.StartsWith(".netcoreapp")) return "netcoreapp" + tf[".netcoreapp".Length..];
        if (tf.StartsWith(".netframework")) return "net" + tf[".netframework".Length..].Replace(".", "");
        if (tf.StartsWith(".netportable")) return "portable-" + tf[".netportable".Length..].Replace(",", "+");
        return tf;
    }

    /// <summary>Splits "net6.0-android31.0" -> (family "net", version 6.0, platform "android31.0"). Version null when unparseable.</summary>
    public static (string Family, Version? Version, string Platform) Parse(string tfm)
    {
        tfm = Normalize(tfm);
        var dash = tfm.IndexOf('-');
        var platform = dash >= 0 ? tfm[(dash + 1)..] : "";
        var core = dash >= 0 ? tfm[..dash] : tfm;
        var i = 0; while (i < core.Length && !char.IsDigit(core[i])) i++;
        var family = core[..i]; var ver = core[i..];
        if (ver.Length == 0) return (family, null, platform);
        if (!ver.Contains('.') && ver.Length > 1) ver = string.Join(".", ver.ToCharArray());   // net472 -> 4.7.2, net48 -> 4.8
        else if (!ver.Contains('.')) ver += ".0";
        return (family, Version.TryParse(ver, out var v) ? v : null, platform);
    }

    private static string Canonical(string family) => family switch { "net" => "net", "netcoreapp" => "netcoreapp", "netstandard" => "netstandard", _ => family };

    /// <summary>Sort key, newest/most modern first: net5+ &gt; netcoreapp &gt; netstandard &gt; .NET Framework &gt; others.</summary>
    public static int Order(string tfm)
    {
        var (f, v, p) = Parse(tfm);
        var major = v?.Major ?? 0;
        var group = f == "net" && major >= 5 ? 4 : f == "netcoreapp" ? 3 : f == "netstandard" ? 2 : f == "net" ? 1 : 0;
        return -(group * 100000 + major * 1000 + (v?.Minor ?? 0) * 10 + (p.Length > 0 ? 0 : 5));
    }

    /// <summary>The target frameworks a package folder can serve for <paramref name="target"/>, best first (the folder itself, then older .NET, then netstandard).</summary>
    public static IEnumerable<string> Compatible(string target)
    {
        var (f, v, _) = Parse(target);
        if (v == null) { yield return Normalize(target); yield break; }
        var ns = new[] { "2.1", "2.0", "1.6", "1.5", "1.4", "1.3", "1.2", "1.1", "1.0" };
        IEnumerable<string> Std(string max) => ns.Where(x => Version.Parse(x) <= Version.Parse(max));
        yield return Normalize(target);
        if (f == "net" && v.Major >= 5)
        {
            for (var m = v.Major; m >= 5; m--) for (var mi = (m == v.Major ? v.Minor : 0); mi >= 0; mi--) yield return $"net{m}.{mi}";
            foreach (var s in new[] { "netcoreapp3.1", "netcoreapp3.0", "netcoreapp2.2", "netcoreapp2.1", "netcoreapp2.0" }) yield return s;
            foreach (var s in Std("2.1")) yield return "netstandard" + s;
        }
        else if (f == "netcoreapp")
        {
            foreach (var s in new[] { "3.1", "3.0", "2.2", "2.1", "2.0", "1.1", "1.0" }.Where(x => Version.Parse(x) <= v)) yield return "netcoreapp" + s;
            foreach (var s in Std(v >= new Version(3, 0) ? "2.1" : "2.0")) yield return "netstandard" + s;
        }
        else if (f == "netstandard") foreach (var s in Std($"{v.Major}.{v.Minor}")) yield return "netstandard" + s;
        else if (f == "net")
        {
            foreach (var s in new[] { "48", "472", "471", "47", "462", "461", "46", "452", "451", "45", "40", "35", "20" }) if (Parse("net" + s).Version! <= v) yield return "net" + s;
            foreach (var s in Std(v >= new Version(4, 6, 2) ? "2.0" : v >= new Version(4, 5) ? "1.1" : "1.0")) yield return "netstandard" + s;
        }
    }

    /// <summary>Picks the best folder tfm among <paramref name="available"/> for <paramref name="target"/>; null when none is compatible.</summary>
    public static string? Best(IEnumerable<string> available, string target)
    {
        var set = available.Select(a => (Orig: a, Norm: Normalize(a))).ToList();
        foreach (var c in Compatible(target))
        {
            var hit = set.FirstOrDefault(x => x.Norm == c);
            if (hit.Orig != null) return hit.Orig;
        }
        return null;
    }
}
