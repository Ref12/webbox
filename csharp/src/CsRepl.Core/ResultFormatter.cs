using System.Collections;
using System.Globalization;
using System.Text;

namespace CsRepl;

/// <summary>csi-like value formatting: strings quoted, collections as { a, b }, exceptions with message.</summary>
public static class ResultFormatter
{
    private const int MaxItems = 20;

    public static string Format(object? value, int depth = 0)
    {
        switch (value)
        {
            case null: return "null";
            case string s: return "\"" + Escape(s) + "\"";
            case char c: return "'" + Escape(c.ToString()) + "'";
            case bool b: return b ? "true" : "false";
            case IFormattable f when value is not Enum: return f.ToString(null, CultureInfo.InvariantCulture);
            case Type t: return "typeof(" + t.Name + ")";
            case IDictionary d when depth < 3:
                return FormatSeq(Entries(d, depth), depth);
            case IEnumerable e when depth < 3:
                return FormatSeq(e.Cast<object?>().Select(x => Format(x, depth + 1)), depth);
            default: return value.ToString() ?? "";
        }
    }

    private static IEnumerable<string> Entries(IDictionary d, int depth)
    {
        var en = d.GetEnumerator();
        while (en.MoveNext())
            yield return Format(en.Key, depth + 1) + " = " + Format(en.Value, depth + 1);
    }

    private static string FormatSeq(IEnumerable<string> items, int depth)
    {
        var list = items.Take(MaxItems + 1).ToList();
        var more = list.Count > MaxItems;
        if (more) list.RemoveAt(list.Count - 1);
        return "{ " + string.Join(", ", list) + (more ? ", ..." : "") + " }";
    }

    public static string Escape(string s)
    {
        var sb = new StringBuilder();
        foreach (var ch in s)
            sb.Append(ch switch { '\\' => "\\\\", '"' => "\\\"", '\n' => "\\n", '\r' => "\\r", '\t' => "\\t", _ => ch.ToString() });
        return sb.ToString();
    }

    /// <summary>"Type: message" for the exception, unwrapping reflection/aggregate wrappers, with inner chain.</summary>
    public static string FormatException(Exception e)
    {
        while ((e is System.Reflection.TargetInvocationException || e is AggregateException { InnerExceptions.Count: 1 }) && e.InnerException != null)
            e = e.InnerException;
        var sb = new StringBuilder(e.GetType().FullName + ": " + e.Message);
        for (var i = e.InnerException; i != null; i = i.InnerException)
            sb.Append("\n ---> " + i.GetType().FullName + ": " + i.Message);
        return sb.ToString();
    }
}
