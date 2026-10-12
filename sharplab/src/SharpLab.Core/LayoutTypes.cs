using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.Loader;
using System.Text.RegularExpressions;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace SharpLab;

public sealed record ResolveResult(Type? Type, string? Error, string? Note);
public sealed record TypeCompletion(string Label, string Insert, string Detail, string Kind);
/// <summary>Completions for the text typed so far: each item's Insert replaces the text from index From on.</summary>
public sealed record CompletionResult(int From, List<TypeCompletion> Items);

/// <summary>
/// Turns a type name typed in the Layout picker into a <see cref="Type"/> of the running runtime: types declared in the user's code (simple, qualified or nested names),
/// framework types (System.Guid, Guid, Dictionary&lt;string,int&gt;, Span&lt;byte&gt;, int?) and closed generics of the user's own generic types; and completes names while typing.
/// A generic name without arguments stands for the first construction found in the code.
/// </summary>
public static class TypeResolver
{
    private static readonly Dictionary<string, Type> Aliases = new()
    {
        ["bool"] = typeof(bool), ["byte"] = typeof(byte), ["sbyte"] = typeof(sbyte), ["short"] = typeof(short), ["ushort"] = typeof(ushort), ["int"] = typeof(int), ["uint"] = typeof(uint),
        ["long"] = typeof(long), ["ulong"] = typeof(ulong), ["char"] = typeof(char), ["float"] = typeof(float), ["double"] = typeof(double), ["decimal"] = typeof(decimal),
        ["string"] = typeof(string), ["object"] = typeof(object), ["nint"] = typeof(nint), ["nuint"] = typeof(nuint),
    };

    private static readonly string[] DefaultNamespaces =
    {
        "", "System", "System.Collections.Generic", "System.Collections", "System.Collections.Concurrent", "System.Collections.Immutable", "System.Collections.ObjectModel", "System.Linq", "System.Text",
        "System.IO", "System.Threading", "System.Threading.Tasks", "System.Numerics", "System.Runtime.InteropServices", "System.Runtime.CompilerServices", "System.Runtime.Intrinsics",
        "System.Diagnostics", "System.Globalization", "System.Buffers", "System.Reflection", "System.Text.Json",
    };

    // ---------------- the type-name grammar ----------------

    private sealed record Node(string[] Parts, List<Node>? Args, int Open, List<string> Suffix);

    private sealed class Parser
    {
        private readonly string _s; private int _i;
        public Parser(string s) { _s = s; }
        private void Ws() { while (_i < _s.Length && char.IsWhiteSpace(_s[_i])) _i++; }
        private char Cur => _i < _s.Length ? _s[_i] : '\0';
        public Node Parse() { var n = Type(); Ws(); if (_i < _s.Length) throw new FormatException("unexpected '" + _s[_i] + "' at position " + (_i + 1)); return n; }

        private Node Type()
        {
            Ws();
            if (string.CompareOrdinal(_s, _i, "global::", 0, 8) == 0) _i += 8;
            var parts = new List<string>();
            while (true)
            {
                Ws(); int st = _i;
                while (_i < _s.Length && (char.IsLetterOrDigit(_s[_i]) || _s[_i] == '_')) _i++;
                if (_i == st) throw new FormatException("a type name is expected at position " + (_i + 1));
                parts.Add(_s[st.._i]); Ws();
                if (Cur == '.' || Cur == '+') { _i++; continue; }
                break;
            }
            List<Node>? args = null; int open = 0;
            if (Cur == '<')
            {
                _i++; Ws();
                if (Cur == ',' || Cur == '>')
                {
                    open = 1;
                    while (Cur == ',') { open++; _i++; Ws(); }
                }
                else
                {
                    args = new();
                    while (true) { args.Add(Type()); Ws(); if (Cur == ',') { _i++; continue; } break; }
                }
                if (Cur != '>') throw new FormatException("'>' is expected at position " + (_i + 1));
                _i++;
            }
            var suf = new List<string>();
            while (true)
            {
                Ws();
                if (Cur == '?') { suf.Add("?"); _i++; }
                else if (Cur == '[') { int j = _i + 1; while (j < _s.Length && (_s[j] == ',' || _s[j] == ' ')) j++; if (j >= _s.Length || _s[j] != ']') throw new FormatException("']' is expected"); suf.Add("[]"); _i = j + 1; }
                else if (Cur == '*') { suf.Add("*"); _i++; }
                else break;
            }
            return new Node(parts.ToArray(), args, open, suf);
        }
    }

    // ---------------- context ----------------

    private sealed class Ctx
    {
        public Assembly? User; public string Code = ""; public List<string> Namespaces = new(); public IEnumerable<string>? RefNames; public List<Type> UserTypes = new();
        public Dictionary<Type, List<Type>>? Used; public bool UseUsed = true;
    }

    private static readonly Regex UsingRx = new(@"^\s*(?:global\s+)?using\s+(?!static\b)(?:\w+\s*=\s*)?([\w.]+)\s*;", RegexOptions.Multiline);

    private static Ctx MakeCtx(Assembly? user, string code, IEnumerable<string>? refNames, bool useUsed = true)
    {
        var c = new Ctx { User = user, Code = code ?? "", RefNames = refNames, UseUsed = useUsed };
        var ns = new List<string>(DefaultNamespaces);
        foreach (Match m in UsingRx.Matches(c.Code)) if (!ns.Contains(m.Groups[1].Value)) ns.Add(m.Groups[1].Value);
        c.Namespaces = ns;
        if (user is not null) c.UserTypes = UserTypes(user);
        return c;
    }

    public static List<Type> UserTypes(Assembly asm)
    {
        Type[] types;
        try { types = asm.GetTypes(); } catch (ReflectionTypeLoadException e) { types = e.Types.Where(t => t is not null).ToArray()!; }
        return types.Where(t => !t.Name.StartsWith('<') && !t.IsDefined(typeof(CompilerGeneratedAttribute), false) && !(t.IsNested && t.DeclaringType!.Name.StartsWith('<'))).OrderBy(t => t.MetadataToken).ToList();
    }

    public static bool IsFrameworkAssembly(Assembly a)
    {
        var n = a.GetName().Name;
        return n is not null && !a.IsDynamic && (n == "System.Private.CoreLib" || n.StartsWith("System.", StringComparison.Ordinal) || n.StartsWith("Microsoft.", StringComparison.Ordinal) || n == "mscorlib" || n == "netstandard");
    }

    private static List<Assembly> Frameworks() => AppDomain.CurrentDomain.GetAssemblies().Where(IsFrameworkAssembly).ToList();

    private static readonly HashSet<string> TriedLoad = new();
    private static bool LoadRefs(IEnumerable<string>? names)
    {
        bool any = false;
        if (names is null) return false;
        foreach (var n in names)
        {
            if (string.IsNullOrEmpty(n) || !TriedLoad.Add(n)) continue;
            try { Assembly.Load(new AssemblyName(n)); any = true; } catch { }
        }
        return any;
    }

    private static string Dotted(Type t) => Regex.Replace(t.FullName ?? t.Name, "`\\d+", "").Replace('+', '.');

    // ---------------- closed generics used in the code ----------------

    /// <summary>Closed constructions of the user's generic types found in the code: in the source text (<c>Box&lt;int&gt;</c>) first, then in field and base types.</summary>
    public static Dictionary<Type, List<Type>> Used(Assembly user, string code)
    {
        var d = new Dictionary<Type, List<Type>>(); var seen = new HashSet<string>();
        void Add(Type t)
        {
            if (!t.IsGenericType || t.IsGenericTypeDefinition || t.ContainsGenericParameters) return;
            var def = t.GetGenericTypeDefinition();
            if (def.Assembly == user && seen.Add(t.ToString()!)) { if (!d.TryGetValue(def, out var l)) d[def] = l = new(); l.Add(t); }
        }
        var ctx = MakeCtx(user, code, null, useUsed: false);
        try
        {
            var root = CSharpSyntaxTree.ParseText(code ?? "").GetRoot();
            foreach (var g in root.DescendantNodes().OfType<GenericNameSyntax>())
            {
                if (g.TypeArgumentList.Arguments.Count == 0 || g.TypeArgumentList.Arguments.Any(a => a is OmittedTypeArgumentSyntax)) continue;
                SyntaxNode text = g.Parent is QualifiedNameSyntax q && q.Right == g ? q : g;
                var r = Resolve(text.ToString(), user, code!, null, useUsed: false);
                if (r.Type is not null) Add(r.Type);
            }
        }
        catch { }
        void Visit(Type t) { Add(t); if (t.IsGenericType && !t.ContainsGenericParameters) foreach (var a in t.GetGenericArguments()) Visit(a); else if (t.HasElementType) Visit(t.GetElementType()!); }
        foreach (var t in ctx.UserTypes)
        {
            if (t.ContainsGenericParameters) continue;
            try
            {
                if (t.BaseType is { } b) Visit(b);
                foreach (var f in t.GetFields(BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly)) Visit(f.FieldType);
            }
            catch { }
        }
        return d;
    }

    // ---------------- resolving ----------------

    public static ResolveResult Resolve(string? text, Assembly? user, string code, IEnumerable<string>? refNames = null, bool useUsed = true)
    {
        text = (text ?? "").Trim();
        if (text.Length == 0) return new(null, "Type a type name, for example System.Guid or Dictionary<string,int>.", null);
        Node n;
        try { n = new Parser(text).Parse(); }
        catch (FormatException e) { return new(null, "Cannot read '" + text + "': " + e.Message + ".", null); }
        var c = MakeCtx(user, code, refNames, useUsed);
        var notes = new List<string>();
        var t = Make(n, c, notes, out var err);
        if (t is null && err is not null && err.StartsWith("No type named", StringComparison.Ordinal) && LoadRefs(refNames))
            t = Make(n, c, notes, out err);   // the type may live in a referenced assembly that was not loaded yet
        return new(t, t is null ? err : null, notes.Count == 0 ? null : string.Join(" ", notes));
    }

    private static Type? Make(Node n, Ctx c, List<string> notes, out string? err)
    {
        err = null;
        string name = string.Join(".", n.Parts);
        Type? t;
        if (n.Parts.Length == 1 && n.Args is null && n.Open == 0 && Aliases.TryGetValue(n.Parts[0], out var al)) t = al;
        else
        {
            int arity = n.Args?.Count ?? n.Open;
            var def = Find(n.Parts, arity, c, false) ?? (arity == 0 ? Find(n.Parts, 0, c, true) : Find(n.Parts, 0, c, false));
            if (def is null)
            {
                err = "No type named '" + name + "' found in your code or the referenced assemblies" + (arity > 0 ? " with " + arity + " type parameter" + (arity > 1 ? "s" : "") : "") + ".";
                return null;
            }
            if (def.IsGenericTypeDefinition)
            {
                if (n.Args is not null)
                {
                    var args = new List<Type>();
                    foreach (var a in n.Args) { var at = Make(a, c, notes, out err); if (at is null) return null; args.Add(at); }
                    try { t = def.MakeGenericType(args.ToArray()); }
                    catch (Exception e) { err = "'" + TypeNames.Of(def) + "' cannot be constructed with <" + string.Join(", ", args.Select(TypeNames.Of)) + ">: " + FirstLine(e.Message); return null; }
                }
                else
                {
                    Type? used = null;
                    if (c.User is not null && c.UseUsed) { c.Used ??= Used(c.User, c.Code); if (c.Used.TryGetValue(def, out var l) && l.Count > 0) used = l[0]; }
                    if (used is null)
                    {
                        err = "'" + TypeNames.Of(def) + "' is generic: give type arguments, for example " + Hint(def) + ".";
                        return null;
                    }
                    t = used;
                    notes.Add("'" + TypeNames.Of(def) + "' is generic: showing " + TypeNames.Of(used) + ", the first construction found in your code. Type other arguments to inspect another one, for example " + Hint(def) + ".");
                }
            }
            else if (n.Args is not null || n.Open > 0) { err = "'" + TypeNames.Of(def) + "' is not generic."; return null; }
            else t = def;
        }
        foreach (var s in n.Suffix)
        {
            if (s == "?")
            {
                if (t.IsValueType && !(t.IsGenericType && t.GetGenericTypeDefinition() == typeof(Nullable<>)))
                {
                    try { t = typeof(Nullable<>).MakeGenericType(t); } catch (Exception e) { err = "Nullable<" + TypeNames.Of(t) + "> is not valid: " + FirstLine(e.Message); return null; }
                }
            }
            else { err = "Arrays and pointers have no field layout: inspect the element type (" + name + ") instead."; return null; }
        }
        return t;
    }

    private static string FirstLine(string s) { int i = s.IndexOf('\n'); return (i >= 0 ? s[..i] : s).Trim(); }
    private static string Hint(Type def) => TypeNames.Of(def).Split('<')[0] + "<" + string.Join(", ", Enumerable.Repeat("int", def.GetGenericArguments().Length)) + ">";

    private static bool ArityOk(Type t, int arity, bool any)
    {
        int a = t.IsGenericTypeDefinition ? t.GetGenericArguments().Length : 0;
        return any ? a > 0 : a == arity;
    }

    private static Type? Find(string[] parts, int arity, Ctx c, bool any)
    {
        string dotted = string.Join(".", parts);
        if (c.User is not null)
        {
            Type? best = null; int bestScore = int.MaxValue;
            foreach (var t in c.UserTypes)
            {
                if (!ArityOk(t, arity, any) || t.IsGenericParameter) continue;
                string d = Dotted(t);
                int score = d == dotted ? 0 : d.EndsWith("." + dotted, StringComparison.Ordinal) ? 1 + d.Length : -1;
                if (score >= 0 && score < bestScore) { best = t; bestScore = score; }
            }
            if (best is not null) return best;
        }
        var asms = Frameworks();
        int dots = dotted.Count(ch => ch == '.');
        foreach (var ns in c.Namespaces)
        {
            string baseName = ns.Length == 0 ? dotted : ns + "." + dotted;
            for (int k = 0; k <= dots; k++)
            {
                string meta = baseName;
                for (int r = 0; r < k; r++) { int i = meta.LastIndexOf('.'); meta = meta[..i] + "+" + meta[(i + 1)..]; }
                foreach (var ar in any ? new[] { 1, 2, 3, 4 } : new[] { arity })
                {
                    string full = ar > 0 ? meta + "`" + ar : meta;
                    foreach (var a in asms)
                    {
                        Type? t = null;
                        try { t = a.GetType(full, false); } catch { }
                        if (t is not null && t.IsVisible || t is not null && t.IsPublic) return t;
                    }
                }
            }
        }
        return null;
    }

    // ---------------- completion ----------------

    private sealed record Bcl(string Simple, string Full, string Ns, int Arity, string Params, string Kind);
    private static List<Bcl>? _bcl; private static int _bclAssemblies = -1;

    private static List<Bcl> BclTypes()
    {
        var asms = Frameworks();
        if (_bcl is not null && _bclAssemblies == asms.Count) return _bcl;
        var l = new List<Bcl>(); var seen = new HashSet<string>();
        foreach (var a in asms)
        {
            Type[] ts; try { ts = a.GetTypes(); } catch (ReflectionTypeLoadException e) { ts = e.Types.Where(t => t is not null).ToArray()!; } catch { continue; }
            foreach (var t in ts)
            {
                if (!t.IsPublic || t.IsNested || t.IsInterface || t.IsAbstract && t.IsSealed || typeof(Delegate).IsAssignableFrom(t) || t.Name.Contains('<') || t.Name.Contains('$') || t.Namespace is null) continue;
                string simple = Regex.Replace(t.Name, "`\\d+", "");
                int ar = t.IsGenericTypeDefinition ? t.GetGenericArguments().Length : 0;
                string full = t.Namespace + "." + simple;
                if (!seen.Add(full + "`" + ar)) continue;
                l.Add(new Bcl(simple, full, t.Namespace, ar, ar > 0 ? string.Join(",", t.GetGenericArguments().Select(g => g.Name)) : "", t.IsEnum ? "enum" : t.IsValueType ? "struct" : "class"));
            }
        }
        _bclAssemblies = asms.Count;
        return _bcl = l;
    }

    public static CompletionResult Complete(string? text, Assembly? user, string code, int max = 30)
    {
        text ??= "";
        int from = text.LastIndexOfAny(new[] { '<', ',', ' ' }) + 1;
        string tail = text[from..];
        var items = new List<(int score, int rank, TypeCompletion item)>();
        if (user is not null)
            foreach (var t in UserTypes(user))
            {
                if (!LayoutView.Wanted(t)) continue;
                string d = Dotted(t); if (!string.IsNullOrEmpty(t.Namespace) && d.StartsWith(t.Namespace + ".", StringComparison.Ordinal)) d = d[(t.Namespace.Length + 1)..];
                bool gen = t.IsGenericTypeDefinition;
                string label = TypeNames.Of(t);
                int score = tail.Length == 0 ? 0 : d.StartsWith(tail, StringComparison.OrdinalIgnoreCase) || label.StartsWith(tail, StringComparison.OrdinalIgnoreCase) ? 0 : label.Contains(tail, StringComparison.OrdinalIgnoreCase) ? 2 : -1;
                if (score >= 0) items.Add((score, 0, new TypeCompletion(label, d + (gen ? "<" : ""), "your code", t.IsValueType ? "struct" : "class")));
            }
        if (tail.Length > 0 || from > 0)
            foreach (var kv in Aliases)
                if (tail.Length == 0 || kv.Key.StartsWith(tail, StringComparison.Ordinal)) items.Add((tail.Length == 0 ? 1 : 0, 2, new TypeCompletion(kv.Key, kv.Key, "C# keyword", "keyword")));
        if (tail.Length > 0)
            foreach (var b in BclTypes())
            {
                int score = b.Simple.StartsWith(tail, StringComparison.OrdinalIgnoreCase) ? 0 : b.Full.StartsWith(tail, StringComparison.OrdinalIgnoreCase) ? 1 : b.Simple.Contains(tail, StringComparison.OrdinalIgnoreCase) ? 2 : b.Full.Contains(tail, StringComparison.OrdinalIgnoreCase) ? 3 : -1;
                if (score < 0) continue;
                items.Add((score, 1, new TypeCompletion(b.Simple + (b.Arity > 0 ? "<" + b.Params + ">" : ""), b.Full + (b.Arity > 0 ? "<" : ""), b.Ns, b.Kind)));
            }
        var ordered = items.OrderBy(x => x.score).ThenBy(x => x.rank).ThenBy(x => x.item.Label.Length).ThenBy(x => x.item.Label, StringComparer.Ordinal).Select(x => x.item)
            .DistinctBy(i => i.Insert).Take(max).ToList();
        return new CompletionResult(from, ordered);
    }
}
