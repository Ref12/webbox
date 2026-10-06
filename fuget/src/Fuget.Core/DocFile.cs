using System.Text;
using System.Xml.Linq;

namespace Fuget;

public sealed record DocException(string Type, string Text);

public sealed class DocEntry
{
    public string Summary { get; set; } = "";
    public string Remarks { get; set; } = "";
    public string Returns { get; set; } = "";
    public string Value { get; set; } = "";
    public string Example { get; set; } = "";
    public Dictionary<string, string> Params { get; set; } = new();
    public Dictionary<string, string> TypeParams { get; set; } = new();
    public List<DocException> Exceptions { get; set; } = new();
    public List<string> SeeAlso { get; set; } = new();
}

/// <summary>The compiler-generated XML documentation file that ships next to an assembly in a package (lib/&lt;tfm&gt;/Name.xml).</summary>
public sealed class DocFile
{
    private readonly Dictionary<string, XElement> _members = new(StringComparer.Ordinal);
    private readonly Dictionary<string, DocEntry> _parsed = new(StringComparer.Ordinal);

    public int Count => _members.Count;

    public static DocFile Parse(string xml)
    {
        var f = new DocFile();
        try
        {
            var doc = XDocument.Parse(xml);
            foreach (var m in doc.Descendants("member"))
            {
                var name = (string?)m.Attribute("name");
                if (!string.IsNullOrEmpty(name)) f._members[name] = m;
            }
        }
        catch (System.Xml.XmlException) { }
        return f;
    }

    public DocEntry? Find(string id)
    {
        if (_parsed.TryGetValue(id, out var e)) return e;
        if (!_members.TryGetValue(id, out var m)) return null;
        e = new DocEntry
        {
            Summary = Text(m.Element("summary")), Remarks = Text(m.Element("remarks")), Returns = Text(m.Element("returns")),
            Value = Text(m.Element("value")), Example = Text(m.Element("example")),
        };
        foreach (var p in m.Elements("param")) e.Params[(string?)p.Attribute("name") ?? ""] = Text(p);
        foreach (var p in m.Elements("typeparam")) e.TypeParams[(string?)p.Attribute("name") ?? ""] = Text(p);
        foreach (var x in m.Elements("exception")) e.Exceptions.Add(new DocException(ShortCref((string?)x.Attribute("cref")), Text(x)));
        foreach (var x in m.Elements("seealso")) e.SeeAlso.Add(ShortCref((string?)x.Attribute("cref") ?? (string?)x.Attribute("href")));
        _parsed[id] = e;
        return e;
    }

    /// <summary>"M:Ns.Type`1.Method(System.Int32)" -> "Type.Method"; "T:Ns.List{System.Int32}" -> "List<Int32>". Keeps cref text readable.</summary>
    public static string ShortCref(string? cref)
    {
        if (string.IsNullOrEmpty(cref)) return "";
        var s = cref.Length > 1 && cref[1] == ':' ? cref[2..] : cref;
        var isType = cref.StartsWith("T:", StringComparison.Ordinal) || cref.StartsWith("N:", StringComparison.Ordinal);
        var brace = s.IndexOf('{');
        if (brace > 0 && s.EndsWith('}'))
            return ShortCref("T:" + s[..brace]) + "<" + string.Join(", ", SplitArgs(s[(brace + 1)..^1]).Select(x => ShortCref("T:" + x))) + ">";
        var paren = s.IndexOf('(');
        if (paren >= 0) s = s[..paren];
        s = System.Text.RegularExpressions.Regex.Replace(s, "`+\\d+", "");
        var parts = s.Split('.');
        return isType || parts.Length < 2 ? parts[^1] : parts[^2] + "." + parts[^1];
    }

    private static IEnumerable<string> SplitArgs(string s)
    {
        var depth = 0; var start = 0;
        for (var i = 0; i < s.Length; i++)
        {
            if (s[i] == '{') depth++; else if (s[i] == '}') depth--;
            else if (s[i] == ',' && depth == 0) { yield return s[start..i]; start = i + 1; }
        }
        yield return s[start..];
    }

    /// <summary>Flattens doc markup to text: `code` for inline code, blank-line separated paragraphs, "- " list items.</summary>
    public static string Text(XElement? e)
    {
        if (e == null) return "";
        var sb = new StringBuilder();
        Walk(e, sb);
        var lines = sb.ToString().Replace("\r", "").Split('\n').Select(l => l.TrimEnd()).ToList();
        // collapse the indentation XML docs carry
        var text = string.Join("\n", lines.Select(l => l.Trim().Length == 0 ? "" : (l.StartsWith("    ") || l.StartsWith("\t") ? l : l.Trim())));
        while (text.Contains("\n\n\n")) text = text.Replace("\n\n\n", "\n\n");
        return text.Trim();
    }

    private static string Inner(XElement el) { var b = new StringBuilder(); foreach (var c in el.Nodes()) Walk(c, b); return b.ToString().Trim(); }

    private static void Walk(XNode n, StringBuilder sb)
    {
        switch (n)
        {
            case XText t: sb.Append(System.Text.RegularExpressions.Regex.Replace(t.Value, @"\s+", " ")); break;
            case XElement el:
                switch (el.Name.LocalName)
                {
                    case "see": case "seealso":
                        var cref = (string?)el.Attribute("cref"); var lang = (string?)el.Attribute("langword"); var href = (string?)el.Attribute("href");
                        var label = el.Nodes().Any() ? Inner(el) : lang ?? (cref != null ? ShortCref(cref) : href ?? "");
                        sb.Append('`').Append(label).Append('`'); break;
                    case "paramref": case "typeparamref": sb.Append('`').Append((string?)el.Attribute("name")).Append('`'); break;
                    case "c": sb.Append('`'); foreach (var c in el.Nodes()) Walk(c, sb); sb.Append('`'); break;
                    case "code": sb.Append("\n\n").Append("```\n").Append(el.Value.Trim('\r', '\n').TrimEnd()).Append("\n```\n\n"); break;
                    case "para": sb.Append("\n\n"); foreach (var c in el.Nodes()) Walk(c, sb); sb.Append("\n\n"); break;
                    case "br": sb.Append('\n'); break;
                    case "list":
                        sb.Append('\n');
                        foreach (var item in el.Elements("item")) { sb.Append("\n- "); var d = item.Element("description") ?? item; foreach (var c in d.Nodes()) Walk(c, sb); }
                        sb.Append('\n'); break;
                    default: foreach (var c in el.Nodes()) Walk(c, sb); break;
                }
                break;
        }
    }
}
