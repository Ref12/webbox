using System.Collections.Immutable;
using System.Globalization;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using System.Text;

namespace Fuget;

/// <summary>Reads the public API of a managed assembly with System.Reflection.Metadata (no loading, works on any platform).</summary>
public sealed class ApiReader
{
    private readonly MetadataReader _md;
    private readonly TypeNamer _short, _full, _doc;
    private readonly DocFile? _docs;
    private readonly Dictionary<MethodDefinitionHandle, (string Kind, string Name)> _accessors = new();

    private ApiReader(MetadataReader md, DocFile? docs)
    {
        _md = md; _docs = docs;
        _short = new TypeNamer(md, NameMode.Short); _full = new TypeNamer(md, NameMode.Full); _doc = new TypeNamer(md, NameMode.Doc);
    }

    public static AssemblyApi Read(byte[] dll, DocFile? docs = null)
    {
        using var pe = new PEReader(ImmutableArray.Create(dll));
        return Read(pe.GetMetadataReader(), docs);
    }

    public static AssemblyApi Read(MetadataReader md, DocFile? docs = null) => new ApiReader(md, docs).ReadAssembly();

    /// <summary>Referenced assemblies (simple names) of a PE image.</summary>
    public static List<string> ReferencedAssemblies(MetadataReader md) =>
        md.AssemblyReferences.Select(h => md.GetString(md.GetAssemblyReference(h).Name)).ToList();

    private AssemblyApi ReadAssembly()
    {
        var md = _md;
        var def = md.GetAssemblyDefinition();
        var asm = new AssemblyApi { Name = md.GetString(def.Name), Version = def.Version.ToString(), References = ReferencedAssemblies(md) };
        asm.Attributes = Attrs(def.GetCustomAttributes(), out _, out _, assemblyLevel: true);
        foreach (var th in md.TypeDefinitions)
        {
            if (!IsApiVisible(th)) continue;
            var t = ReadType(th);
            if (t != null) asm.Types.Add(t);
        }
        asm.Types.Sort((a, b) => string.CompareOrdinal(a.FullName, b.FullName));
        return asm;
    }

    // ---------------------------------------------------------------- visibility
    private bool IsApiVisible(TypeDefinitionHandle h)
    {
        var td = _md.GetTypeDefinition(h);
        var name = _md.GetString(td.Name);
        if (name.Length == 0 || name[0] == '<') return false;
        if (HasAttr(td.GetCustomAttributes(), "System.Runtime.CompilerServices", "CompilerGeneratedAttribute")) return false;
        var vis = td.Attributes & TypeAttributes.VisibilityMask;
        switch (vis)
        {
            case TypeAttributes.Public: return true;
            case TypeAttributes.NestedPublic: case TypeAttributes.NestedFamily: case TypeAttributes.NestedFamORAssem:
                return IsApiVisible(td.GetDeclaringType());
            default: return false;
        }
    }

    private static bool IsApiAccess(MethodAttributes a) { var v = a & MethodAttributes.MemberAccessMask; return v is MethodAttributes.Public or MethodAttributes.Family or MethodAttributes.FamORAssem; }
    private static bool IsApiAccess(FieldAttributes a) { var v = a & FieldAttributes.FieldAccessMask; return v is FieldAttributes.Public or FieldAttributes.Family or FieldAttributes.FamORAssem; }
    private static string Access(MethodAttributes a) => (a & MethodAttributes.MemberAccessMask) switch
    { MethodAttributes.Public => "public", MethodAttributes.Family => "protected", MethodAttributes.FamORAssem => "protected internal", MethodAttributes.Assembly => "internal", _ => "private" };
    private static int Rank(MethodAttributes a) => (a & MethodAttributes.MemberAccessMask) switch
    { MethodAttributes.Public => 4, MethodAttributes.FamORAssem => 3, MethodAttributes.Family => 2, _ => 0 };

    // ---------------------------------------------------------------- types
    private TypeApi? ReadType(TypeDefinitionHandle h)
    {
        var td = _md.GetTypeDefinition(h);
        var chain = new List<TypeDefinition>(); var cur = td;
        while (true) { chain.Insert(0, cur); var d = cur.GetDeclaringType(); if (d.IsNil) break; cur = _md.GetTypeDefinition(d); }
        var ns = _md.GetString(chain[0].Namespace);
        var meta = string.Join(".", chain.Select(c => _md.GetString(c.Name)));
        var fullName = ns.Length > 0 ? ns + "." + meta : meta;

        var gps = td.GetGenericParameters().Select(g => _md.GetString(_md.GetGenericParameter(g).Name)).ToArray();
        var outerArity = td.GetDeclaringType().IsNil ? 0 : _md.GetTypeDefinition(td.GetDeclaringType()).GetGenericParameters().Count;
        var ctx = new GenCtx { Type = gps };
        var own = gps.Skip(outerArity).ToArray();

        var displayName = string.Join(".", chain.Select((c, i) =>
        {
            var outer = i == 0 ? 0 : chain[i - 1].GetGenericParameters().Count;
            var names = c.GetGenericParameters().Skip(outer).Select(g => _md.GetString(_md.GetGenericParameter(g).Name)).ToArray();
            return TypeNamer.StripArity(_md.GetString(c.Name)) + (names.Length > 0 ? "<" + string.Join(", ", names) + ">" : "");
        }));
        var t = new TypeApi
        {
            Namespace = ns, Name = displayName, FullName = fullName, Id = "T:" + fullName,
            Token = MetadataTokens.GetToken(h),
        };
        t.Attributes = Attrs(td.GetCustomAttributes(), out var obs, out var obsErr);
        t.Obsolete = obs; t.ObsoleteError = obsErr;
        t.Summary = _docs?.Find(t.Id)?.Summary;

        var attrs = td.Attributes;
        var baseName = td.BaseType.IsNil ? null : _full.Entity(td.BaseType, ctx);
        var isInterface = (attrs & TypeAttributes.Interface) != 0;
        if (isInterface) t.Kind = "interface";
        else if (baseName == "System.Enum") t.Kind = "enum";
        else if (baseName == "System.ValueType") t.Kind = "struct";
        else if (baseName is "System.MulticastDelegate" or "System.Delegate") t.Kind = "delegate";
        else t.Kind = "class";

        string Decl(TypeNamer n)
        {
            var sb = new StringBuilder();
            sb.Append((attrs & TypeAttributes.VisibilityMask) switch
            { TypeAttributes.Public or TypeAttributes.NestedPublic => "public ", TypeAttributes.NestedFamily => "protected ", TypeAttributes.NestedFamORAssem => "protected internal ", _ => "" });
            var sealedT = (attrs & TypeAttributes.Sealed) != 0; var abstractT = (attrs & TypeAttributes.Abstract) != 0;
            if (t.Kind == "class") { if (abstractT && sealedT) sb.Append("static "); else if (abstractT) sb.Append("abstract "); else if (sealedT) sb.Append("sealed "); }
            else if (t.Kind == "struct" && HasAttr(td.GetCustomAttributes(), "System.Runtime.CompilerServices", "IsReadOnlyAttribute")) sb.Append("readonly ");
            sb.Append(t.Kind == "delegate" ? "delegate " : t.Kind + " ");
            var gen = own.Length > 0 ? "<" + string.Join(", ", own) + ">" : "";
            if (t.Kind == "delegate")
            {
                var inv = td.GetMethods().Select(m => _md.GetMethodDefinition(m)).First(m => _md.GetString(m.Name) == "Invoke");
                var sig = inv.DecodeSignature(n, ctx);
                sb.Append(sig.ReturnType).Append(' ').Append(displayNameLeaf(td)).Append(gen).Append('(').Append(ParamList(inv, sig, n, false)).Append(')');
                return sb.ToString();
            }
            sb.Append(displayNameLeaf(td)).Append(gen);
            var bases = new List<string>();
            if (t.Kind == "class" && baseName != null && baseName != "System.Object") bases.Add(n.Entity(td.BaseType, ctx));
            if (t.Kind == "enum")
            {
                var vf = td.GetFields().Select(f => _md.GetFieldDefinition(f)).FirstOrDefault(f => _md.GetString(f.Name) == "value__");
                if (!vf.Name.IsNil) { var ft = vf.DecodeSignature(n, ctx); if (ft != "int") bases.Add(ft); }
            }
            foreach (var ih in td.GetInterfaceImplementations()) bases.Add(n.Entity(_md.GetInterfaceImplementation(ih).Interface, ctx));
            if (bases.Count > 0) sb.Append(" : ").Append(string.Join(", ", bases));
            return sb.ToString();
        }
        string displayNameLeaf(TypeDefinition d) => TypeNamer.StripArity(_md.GetString(d.Name));
        t.Declaration = Decl(_short); t.FullDeclaration = Decl(_full);

        // accessor methods are not listed on their own
        foreach (var ph in td.GetProperties()) { var a = _md.GetPropertyDefinition(ph).GetAccessors(); if (!a.Getter.IsNil) _accessors[a.Getter] = ("p", ""); if (!a.Setter.IsNil) _accessors[a.Setter] = ("p", ""); }
        foreach (var eh in td.GetEvents()) { var a = _md.GetEventDefinition(eh).GetAccessors(); if (!a.Adder.IsNil) _accessors[a.Adder] = ("e", ""); if (!a.Remover.IsNil) _accessors[a.Remover] = ("e", ""); if (!a.Raiser.IsNil) _accessors[a.Raiser] = ("e", ""); }

        var typeIdPrefix = fullName;   // doc ids use the dotted metadata names
        var isEnum = t.Kind == "enum";
        var members = new List<MemberApi>();
        foreach (var fh in td.GetFields())
        {
            var f = _md.GetFieldDefinition(fh);
            if (!(IsApiAccess(f.Attributes) || isInterface)) continue;
            var fname = _md.GetString(f.Name);
            if (isEnum && fname == "value__") continue;
            if ((f.Attributes & FieldAttributes.SpecialName) != 0 && !isEnum) continue;
            members.Add(BuildField(fh, f, fname, typeIdPrefix, ctx, isEnum));
        }
        foreach (var mh in td.GetMethods())
        {
            var m = _md.GetMethodDefinition(mh);
            if (!IsApiAccess(m.Attributes) || _accessors.ContainsKey(mh)) continue;
            var mname = _md.GetString(m.Name);
            if (mname == ".cctor") continue;
            if (t.Kind == "delegate") continue;   // Invoke/BeginInvoke/EndInvoke are the delegate itself
            if (mname == "Finalize" && (m.Attributes & MethodAttributes.Virtual) != 0 && _md.GetBlobReader(m.Signature).Length > 0 && IsFinalizer(m)) continue;
            members.Add(BuildMethod(mh, m, mname, typeIdPrefix, ctx, isInterface, t));
        }
        foreach (var ph in td.GetProperties())
        {
            var p = _md.GetPropertyDefinition(ph); var acc = p.GetAccessors();
            var getter = acc.Getter.IsNil ? (MethodDefinition?)null : _md.GetMethodDefinition(acc.Getter);
            var setter = acc.Setter.IsNil ? (MethodDefinition?)null : _md.GetMethodDefinition(acc.Setter);
            if (!((getter != null && IsApiAccess(getter.Value.Attributes)) || (setter != null && IsApiAccess(setter.Value.Attributes)))) continue;
            members.Add(BuildProperty(ph, p, getter, setter, typeIdPrefix, ctx, isInterface));
        }
        foreach (var eh in td.GetEvents())
        {
            var e = _md.GetEventDefinition(eh); var acc = e.GetAccessors();
            var adder = acc.Adder.IsNil ? (MethodDefinition?)null : _md.GetMethodDefinition(acc.Adder);
            if (adder == null || !IsApiAccess(adder.Value.Attributes)) continue;
            members.Add(BuildEvent(eh, e, adder.Value, typeIdPrefix, ctx, isInterface));
        }
        var order = new[] { "constructor", "const", "field", "property", "event", "method", "operator" };
        t.Members = t.Kind == "enum" ? members : members.OrderBy(m => Array.IndexOf(order, m.Kind)).ThenBy(m => m.Name, StringComparer.Ordinal).ThenBy(m => m.Id, StringComparer.Ordinal).ToList();
        foreach (var m in t.Members) m.Summary = _docs?.Find(m.Id)?.Summary;
        return t;
    }

    private bool IsFinalizer(MethodDefinition m) => m.GetParameters().Count == 0 && (m.Attributes & MethodAttributes.Family) != 0;

    // ---------------------------------------------------------------- members
    private MemberApi BuildField(FieldDefinitionHandle h, FieldDefinition f, string name, string typeId, GenCtx ctx, bool isEnum)
    {
        var m = new MemberApi { Name = name, Token = MetadataTokens.GetToken(h), Id = "F:" + typeId + "." + name };
        m.Attributes = Attrs(f.GetCustomAttributes(), out var obs, out var err); m.Obsolete = obs; m.ObsoleteError = err;
        var lit = (f.Attributes & FieldAttributes.Literal) != 0;
        m.Kind = lit ? "const" : "field";
        string Build(TypeNamer n)
        {
            var type = f.DecodeSignature(n, ctx);
            var value = lit ? ConstantText(f.GetDefaultValue()) : null;
            if (isEnum) return value != null ? name + " = " + value : name;
            var mods = (f.Attributes & FieldAttributes.FieldAccessMask) switch { FieldAttributes.Public => "public ", FieldAttributes.Family => "protected ", FieldAttributes.FamORAssem => "protected internal ", _ => "" };
            if (lit) mods += "const ";
            else { if ((f.Attributes & FieldAttributes.Static) != 0) mods += "static "; if ((f.Attributes & FieldAttributes.InitOnly) != 0) mods += "readonly "; }
            return mods + type + " " + name + (value != null ? " = " + value : "") + ";";
        }
        m.Signature = Build(_short); m.FullSignature = Build(_full);
        return m;
    }

    private MemberApi BuildMethod(MethodDefinitionHandle h, MethodDefinition m, string name, string typeId, GenCtx tctx, bool inInterface, TypeApi owner)
    {
        var gps = m.GetGenericParameters().Select(g => _md.GetString(_md.GetGenericParameter(g).Name)).ToArray();
        var ctx = new GenCtx { Type = tctx.Type, Method = gps };
        var api = new MemberApi { Token = MetadataTokens.GetToken(h) };
        api.Attributes = Attrs(m.GetCustomAttributes(), out var obs, out var err); api.Obsolete = obs; api.Obsolete = obs; api.ObsoleteError = err;
        var isExt = HasAttr(m.GetCustomAttributes(), "System.Runtime.CompilerServices", "ExtensionAttribute");
        var isCtor = name == ".ctor";
        var opName = !isCtor && name.StartsWith("op_", StringComparison.Ordinal) && (m.Attributes & MethodAttributes.SpecialName) != 0 ? OperatorSymbol(name) : null;
        var sigDoc = m.DecodeSignature(_doc, ctx);
        // doc id
        var docName = isCtor ? "#ctor" : name.Replace('<', '{').Replace('>', '}');
        var id = "M:" + typeId + "." + docName + (gps.Length > 0 ? "``" + gps.Length : "");
        if (sigDoc.ParameterTypes.Length > 0) id += "(" + string.Join(",", sigDoc.ParameterTypes) + ")";
        if (name is "op_Implicit" or "op_Explicit") id += "~" + sigDoc.ReturnType;
        api.Id = id;
        api.Kind = isCtor ? "constructor" : opName != null ? "operator" : "method";
        api.Name = isCtor ? TypeNamer.StripArity(owner.Name.Split('<')[0].Split('.').Last()) : name;

        string Build(TypeNamer n)
        {
            var sig = m.DecodeSignature(n, ctx);
            var sb = new StringBuilder();
            if (!inInterface) sb.Append(Access(m.Attributes)).Append(' ');
            var a = m.Attributes;
            if ((a & MethodAttributes.Static) != 0) sb.Append("static ");
            else if (!inInterface && (a & MethodAttributes.Virtual) != 0)
            {
                if ((a & MethodAttributes.Abstract) != 0) sb.Append("abstract ");
                else if ((a & MethodAttributes.NewSlot) != 0) { if ((a & MethodAttributes.Final) == 0) sb.Append("virtual "); }
                else sb.Append((a & MethodAttributes.Final) != 0 ? "sealed override " : "override ");
            }
            var ps = ParamList(m, sig, n, isExt);
            var gen = gps.Length > 0 ? "<" + string.Join(", ", gps) + ">" : "";
            if (isCtor) return sb.Append(api.Name).Append('(').Append(ps).Append(");").ToString();
            if (name is "op_Implicit" or "op_Explicit") return sb.Append("static ").Replace("static static ", "static ").Append(name == "op_Implicit" ? "implicit" : "explicit").Append(" operator ").Append(sig.ReturnType).Append('(').Append(ps).Append(");").ToString();
            if (opName != null) return sb.Append(sig.ReturnType).Append(" operator ").Append(opName).Append('(').Append(ps).Append(");").ToString();
            return sb.Append(sig.ReturnType).Append(' ').Append(name).Append(gen).Append('(').Append(ps).Append(");").ToString();
        }
        api.Signature = Build(_short); api.FullSignature = Build(_full);
        if (opName != null) api.Name = "operator " + opName;
        return api;
    }

    private MemberApi BuildProperty(PropertyDefinitionHandle h, PropertyDefinition p, MethodDefinition? getter, MethodDefinition? setter, string typeId, GenCtx ctx, bool inInterface)
    {
        var name = _md.GetString(p.Name);
        var api = new MemberApi { Kind = "property", Name = name, Token = MetadataTokens.GetToken(h) };
        api.Attributes = Attrs(p.GetCustomAttributes(), out var obs, out var err); api.Obsolete = obs; api.ObsoleteError = err;
        var sigDoc = p.DecodeSignature(_doc, ctx);
        api.Id = "P:" + typeId + "." + name + (sigDoc.ParameterTypes.Length > 0 ? "(" + string.Join(",", sigDoc.ParameterTypes) + ")" : "");
        var main = getter != null && (setter == null || Rank(getter.Value.Attributes) >= Rank(setter.Value.Attributes)) ? getter.Value : setter!.Value;
        string Build(TypeNamer n)
        {
            n.SawInit = false;
            var sig = p.DecodeSignature(n, ctx);
            var sb = new StringBuilder();
            if (!inInterface) sb.Append(Access(main.Attributes)).Append(' ');
            var a = main.Attributes;
            if ((a & MethodAttributes.Static) != 0) sb.Append("static ");
            else if (!inInterface && (a & MethodAttributes.Virtual) != 0)
            {
                if ((a & MethodAttributes.Abstract) != 0) sb.Append("abstract ");
                else if ((a & MethodAttributes.NewSlot) != 0) { if ((a & MethodAttributes.Final) == 0) sb.Append("virtual "); }
                else sb.Append((a & MethodAttributes.Final) != 0 ? "sealed override " : "override ");
            }
            sb.Append(sig.ReturnType).Append(' ');
            if (sig.ParameterTypes.Length > 0)
            {
                var names = (getter ?? setter!.Value).GetParameters().Select(x => _md.GetParameter(x)).Where(x => x.SequenceNumber > 0).OrderBy(x => x.SequenceNumber).Select(x => _md.GetString(x.Name)).ToList();
                sb.Append("this[").Append(string.Join(", ", sig.ParameterTypes.Select((t, i) => t + " " + (i < names.Count ? names[i] : "p" + i)))).Append(']');
            }
            else sb.Append(name);
            sb.Append(" { ");
            string Acc(MethodDefinition? mth, string kw, bool init = false)
            {
                if (mth == null || !IsApiAccess(mth.Value.Attributes)) return "";
                var r = Rank(mth.Value.Attributes);
                var prefix = r < Rank(main.Attributes) ? Access(mth.Value.Attributes) + " " : "";
                return prefix + (init ? "init" : kw) + "; ";
            }
            var initOnly = false;
            if (setter != null) { n.SawInit = false; setter.Value.DecodeSignature(n, ctx); initOnly = n.SawInit; }
            sb.Append(Acc(getter, "get")).Append(Acc(setter, "set", initOnly)).Append('}');
            return sb.ToString();
        }
        api.Signature = Build(_short); api.FullSignature = Build(_full);
        return api;
    }

    private MemberApi BuildEvent(EventDefinitionHandle h, EventDefinition e, MethodDefinition adder, string typeId, GenCtx ctx, bool inInterface)
    {
        var name = _md.GetString(e.Name);
        var api = new MemberApi { Kind = "event", Name = name, Token = MetadataTokens.GetToken(h), Id = "E:" + typeId + "." + name };
        api.Attributes = Attrs(e.GetCustomAttributes(), out var obs, out var err); api.Obsolete = obs; api.ObsoleteError = err;
        string Build(TypeNamer n)
        {
            var sb = new StringBuilder();
            if (!inInterface) sb.Append(Access(adder.Attributes)).Append(' ');
            if ((adder.Attributes & MethodAttributes.Static) != 0) sb.Append("static ");
            else if (!inInterface && (adder.Attributes & MethodAttributes.Virtual) != 0 && (adder.Attributes & MethodAttributes.NewSlot) != 0 && (adder.Attributes & MethodAttributes.Final) == 0)
                sb.Append((adder.Attributes & MethodAttributes.Abstract) != 0 ? "abstract " : "virtual ");
            return sb.Append("event ").Append(n.Entity(e.Type, ctx)).Append(' ').Append(name).Append(';').ToString();
        }
        api.Signature = Build(_short); api.FullSignature = Build(_full);
        return api;
    }

    private string ParamList(MethodDefinition m, MethodSignature<string> sig, TypeNamer n, bool extension)
    {
        var ps = new Dictionary<int, Parameter>();
        foreach (var ph in m.GetParameters()) { var p = _md.GetParameter(ph); if (p.SequenceNumber > 0) ps[p.SequenceNumber] = p; }
        var parts = new List<string>();
        for (var i = 0; i < sig.ParameterTypes.Length; i++)
        {
            var type = sig.ParameterTypes[i];
            var sb = new StringBuilder();
            ps.TryGetValue(i + 1, out var p);
            var hasP = p.SequenceNumber > 0;
            if (i == 0 && extension) sb.Append("this ");
            if (hasP && HasAttr(p.GetCustomAttributes(), "System", "ParamArrayAttribute")) sb.Append("params ");
            if (type.StartsWith("ref ", StringComparison.Ordinal) && hasP)
            {
                if ((p.Attributes & ParameterAttributes.Out) != 0 && (p.Attributes & ParameterAttributes.In) == 0) type = "out " + type[4..];
                else if ((p.Attributes & ParameterAttributes.In) != 0 && (p.Attributes & ParameterAttributes.Out) == 0) type = "in " + type[4..];
            }
            sb.Append(type).Append(' ').Append(hasP ? _md.GetString(p.Name) : "arg" + i);
            if (hasP && (p.Attributes & ParameterAttributes.HasDefault) != 0)
            {
                var d = ConstantText(p.GetDefaultValue());
                sb.Append(" = ").Append(d ?? "default");
            }
            else if (hasP && (p.Attributes & ParameterAttributes.Optional) != 0) sb.Append(" = default");
            parts.Add(sb.ToString());
        }
        return string.Join(", ", parts);
    }

    private string? ConstantText(ConstantHandle ch)
    {
        if (ch.IsNil) return null;
        var c = _md.GetConstant(ch);
        var r = _md.GetBlobReader(c.Value);
        try
        {
            switch (c.TypeCode)
            {
                case ConstantTypeCode.NullReference: return "null";
                case ConstantTypeCode.String: return "\"" + Escape(r.ReadUTF16(r.Length)) + "\"";
                case ConstantTypeCode.Boolean: return r.ReadBoolean() ? "true" : "false";
                case ConstantTypeCode.Char: return "'" + Escape(r.ReadChar().ToString()) + "'";
                case ConstantTypeCode.SByte: return r.ReadSByte().ToString(CultureInfo.InvariantCulture);
                case ConstantTypeCode.Byte: return r.ReadByte().ToString(CultureInfo.InvariantCulture);
                case ConstantTypeCode.Int16: return r.ReadInt16().ToString(CultureInfo.InvariantCulture);
                case ConstantTypeCode.UInt16: return r.ReadUInt16().ToString(CultureInfo.InvariantCulture);
                case ConstantTypeCode.Int32: return r.ReadInt32().ToString(CultureInfo.InvariantCulture);
                case ConstantTypeCode.UInt32: return r.ReadUInt32().ToString(CultureInfo.InvariantCulture);
                case ConstantTypeCode.Int64: return r.ReadInt64().ToString(CultureInfo.InvariantCulture);
                case ConstantTypeCode.UInt64: return r.ReadUInt64().ToString(CultureInfo.InvariantCulture);
                case ConstantTypeCode.Single: return r.ReadSingle().ToString("R", CultureInfo.InvariantCulture);
                case ConstantTypeCode.Double: return r.ReadDouble().ToString("R", CultureInfo.InvariantCulture);
            }
        }
        catch (BadImageFormatException) { }
        return null;
    }

    private static string Escape(string s) => s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\n", "\\n").Replace("\r", "\\r").Replace("\t", "\\t");

    private static string? OperatorSymbol(string name) => name switch
    {
        "op_Addition" => "+", "op_Subtraction" => "-", "op_Multiply" => "*", "op_Division" => "/", "op_Modulus" => "%",
        "op_UnaryPlus" => "+", "op_UnaryNegation" => "-", "op_LogicalNot" => "!", "op_OnesComplement" => "~",
        "op_Equality" => "==", "op_Inequality" => "!=", "op_LessThan" => "<", "op_GreaterThan" => ">",
        "op_LessThanOrEqual" => "<=", "op_GreaterThanOrEqual" => ">=", "op_BitwiseAnd" => "&", "op_BitwiseOr" => "|",
        "op_ExclusiveOr" => "^", "op_LeftShift" => "<<", "op_RightShift" => ">>", "op_Increment" => "++", "op_Decrement" => "--",
        "op_True" => "true", "op_False" => "false", "op_Implicit" => "implicit", "op_Explicit" => "explicit",
        _ => null,
    };

    // ---------------------------------------------------------------- attributes
    private static readonly HashSet<string> Hidden = new()
    {
        "CompilerGeneratedAttribute", "NullableAttribute", "NullableContextAttribute", "IsReadOnlyAttribute", "ExtensionAttribute", "ParamArrayAttribute",
        "DebuggerHiddenAttribute", "DebuggerStepThroughAttribute", "IsByRefLikeAttribute", "EmbeddedAttribute", "RefSafetyRulesAttribute",
        "DynamicAttribute", "TupleElementNamesAttribute", "IsUnmanagedAttribute", "NativeIntegerAttribute", "AsyncStateMachineAttribute",
        "IteratorStateMachineAttribute", "DefaultMemberAttribute", "TargetFrameworkAttribute", "CompilationRelaxationsAttribute",
        "RuntimeCompatibilityAttribute", "DebuggableAttribute", "AssemblyFileVersionAttribute", "AssemblyInformationalVersionAttribute",
        "ObsoleteAttribute", "InterpolatedStringHandlerAttribute", "ScopedRefAttribute", "RequiresLocationAttribute", "NullablePublicOnlyAttribute",
        "AsyncIteratorStateMachineAttribute", "PreserveBaseOverridesAttribute", "IsExternalInitAttribute", "AllowNullAttribute", "MaybeNullAttribute",
        "NotNullAttribute", "DisallowNullAttribute", "NotNullWhenAttribute", "MaybeNullWhenAttribute", "NotNullIfNotNullAttribute", "DoesNotReturnAttribute",
        "MemberNotNullAttribute", "MemberNotNullWhenAttribute", "SetsRequiredMembersAttribute",
    };

    private bool HasAttr(CustomAttributeHandleCollection attrs, string ns, string name)
    {
        foreach (var h in attrs) { var (n, a) = AttrTypeName(_md.GetCustomAttribute(h)); if (a == name && n == ns) return true; }
        return false;
    }

    private (string Ns, string Name) AttrTypeName(CustomAttribute ca)
    {
        switch (ca.Constructor.Kind)
        {
            case HandleKind.MemberReference:
                var mr = _md.GetMemberReference((MemberReferenceHandle)ca.Constructor);
                return TypeNsName(mr.Parent);
            case HandleKind.MethodDefinition:
                var md = _md.GetMethodDefinition((MethodDefinitionHandle)ca.Constructor);
                return TypeNsName(md.GetDeclaringType());
        }
        return ("", "");
    }

    private (string, string) TypeNsName(EntityHandle h)
    {
        if (h.Kind == HandleKind.TypeReference) { var t = _md.GetTypeReference((TypeReferenceHandle)h); return (_md.GetString(t.Namespace), _md.GetString(t.Name)); }
        if (h.Kind == HandleKind.TypeDefinition) { var t = _md.GetTypeDefinition((TypeDefinitionHandle)h); return (_md.GetString(t.Namespace), _md.GetString(t.Name)); }
        return ("", "");
    }

    private List<string> Attrs(CustomAttributeHandleCollection attrs, out string? obsolete, out bool obsoleteError, bool assemblyLevel = false)
    {
        obsolete = null; obsoleteError = false;
        var list = new List<string>();
        foreach (var h in attrs)
        {
            var ca = _md.GetCustomAttribute(h);
            var (ns, name) = AttrTypeName(ca);
            if (name.Length == 0) continue;
            CustomAttributeValue<string>? val = null;
            try { val = ca.DecodeValue(_full); } catch (Exception e) when (e is BadImageFormatException or InvalidOperationException or NotSupportedException or ArgumentException) { }
            if (ns == "System" && name == "ObsoleteAttribute")
            {
                obsolete = val is { FixedArguments.Length: > 0 } v && v.FixedArguments[0].Value is string s ? s : "";
                obsoleteError = val is { FixedArguments.Length: > 1 } v2 && v2.FixedArguments[1].Value is true;
                continue;
            }
            if (Hidden.Contains(name) || (assemblyLevel && name is "AssemblyCompanyAttribute" or "AssemblyConfigurationAttribute" or "AssemblyProductAttribute" or "AssemblyTitleAttribute" or "InternalsVisibleToAttribute")) continue;
            var shown = name.EndsWith("Attribute", StringComparison.Ordinal) ? name[..^9] : name;
            var args = new List<string>();
            if (val != null)
            {
                foreach (var a in val.Value.FixedArguments) args.Add(ArgText(a.Value, a.Type));
                foreach (var a in val.Value.NamedArguments) args.Add(a.Name + " = " + ArgText(a.Value, a.Type));
            }
            list.Add(args.Count > 0 ? shown + "(" + string.Join(", ", args) + ")" : shown);
        }
        return list;
    }

    private static string ArgText(object? v, string type) => v switch
    {
        null => "null",
        string s => "\"" + Escape(s) + "\"",
        bool b => b ? "true" : "false",
        char c => "'" + c + "'",
        IFormattable f => (type is "int" or "long" or "short" or "byte" or "uint" or "ulong" or "ushort" or "sbyte" or "float" or "double" ? "" : "(" + type + ")") + f.ToString(null, CultureInfo.InvariantCulture),
        System.Collections.IEnumerable e => "{ " + string.Join(", ", e.Cast<object?>().Select(x => x is CustomAttributeTypedArgument<string> t ? ArgText(t.Value, t.Type) : ArgText(x, "object"))) + " }",
        _ => v.ToString() ?? "",
    };
}
