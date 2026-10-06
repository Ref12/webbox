using System.Text;
using System.Text.Json;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

namespace SharpLab;

/// <summary>
/// The syntax tree as JSON for the Syntax view. Every element: k = kind, t = "node" | "token" | "trivia", s/e = span (what selecting it in
/// the editor highlights), fs/fe = full span (including trivia; used to find the element under the caret), v = text (tokens, trivia),
/// l = "lead" | "trail" for trivia, c = children. Child order is source order (leading trivia, token, trailing trivia).
/// </summary>
public static class SyntaxTreeModel
{
    public static string ToJson(string code, Settings settings, int maxElements = 60000)
    {
        var tree = CSharpSyntaxTree.ParseText(code, Compiler.ParseOptions(settings));
        using var ms = new MemoryStream();
        using (var w = new Utf8JsonWriter(ms))
        {
            var count = 0;
            WriteNode(w, tree.GetRoot(), ref count, maxElements);
        }
        return Encoding.UTF8.GetString(ms.ToArray());
    }

    private static void WriteNode(Utf8JsonWriter w, SyntaxNodeOrToken x, ref int count, int max)
    {
        count++;
        w.WriteStartObject();
        w.WriteString("k", x.Kind().ToString());
        w.WriteString("t", x.IsToken ? "token" : "node");
        w.WriteNumber("s", x.Span.Start); w.WriteNumber("e", x.Span.End);
        w.WriteNumber("fs", x.FullSpan.Start); w.WriteNumber("fe", x.FullSpan.End);
        if (x.IsToken)
        {
            var t = x.AsToken();
            w.WriteString("v", t.Text);
            if (t.IsMissing) w.WriteBoolean("missing", true);
            if (t.HasLeadingTrivia || t.HasTrailingTrivia)
            {
                w.WriteStartArray("c");
                foreach (var tr in t.LeadingTrivia) WriteTrivia(w, tr, "lead", ref count);
                foreach (var tr in t.TrailingTrivia) WriteTrivia(w, tr, "trail", ref count);
                w.WriteEndArray();
            }
        }
        else
        {
            var n = x.AsNode()!;
            if (n.ContainsDiagnostics && n.GetDiagnostics().Any()) w.WriteBoolean("err", true);
            w.WriteStartArray("c");
            foreach (var child in n.ChildNodesAndTokens())
            {
                if (count >= max) { w.WriteStartObject(); w.WriteString("k", "…truncated"); w.WriteString("t", "node"); w.WriteNumber("s", 0); w.WriteNumber("e", 0); w.WriteNumber("fs", 0); w.WriteNumber("fe", 0); w.WriteEndObject(); break; }
                WriteNode(w, child, ref count, max);
            }
            w.WriteEndArray();
        }
        w.WriteEndObject();
    }

    // Leading trivia sits before the token in source order and trailing trivia after it; the token object itself holds both as children
    // (JS orders them by position), so a token row expands to its trivia.
    private static void WriteTrivia(Utf8JsonWriter w, SyntaxTrivia tr, string side, ref int count)
    {
        count++;
        w.WriteStartObject();
        w.WriteString("k", tr.Kind().ToString());
        w.WriteString("t", "trivia");
        w.WriteString("l", side);
        w.WriteNumber("s", tr.Span.Start); w.WriteNumber("e", tr.Span.End);
        w.WriteNumber("fs", tr.FullSpan.Start); w.WriteNumber("fe", tr.FullSpan.End);
        w.WriteString("v", tr.ToString());
        if (tr.HasStructure)
        {
            w.WriteStartArray("c");
            var structure = tr.GetStructure()!;
            var c2 = 0;
            WriteNode(w, structure, ref c2, int.MaxValue);
            count += c2;
            w.WriteEndArray();
        }
        w.WriteEndObject();
    }
}
