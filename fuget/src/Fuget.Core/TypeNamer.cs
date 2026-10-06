using System.Collections.Immutable;
using System.Reflection.Metadata;

namespace Fuget;

public enum NameMode { Short, Full, Doc }

/// <summary>Generic parameter names for the type/method being decoded.</summary>
public sealed class GenCtx
{
    public string[] Type = Array.Empty<string>();
    public string[] Method = Array.Empty<string>();
}

/// <summary>Turns signature blobs into C# type names (Short = no namespaces, Full) or XML-doc-id type strings (Doc).</summary>
public sealed class TypeNamer : ISignatureTypeProvider<string, GenCtx>, ICustomAttributeTypeProvider<string>
{
    private readonly MetadataReader _md;
    private readonly NameMode _mode;
    public bool SawInit;       // an IsExternalInit modifier went by (init-only setter)

    public TypeNamer(MetadataReader md, NameMode mode) { _md = md; _mode = mode; }

    private static readonly Dictionary<PrimitiveTypeCode, (string Cs, string Sys)> Prims = new()
    {
        [PrimitiveTypeCode.Boolean] = ("bool", "System.Boolean"), [PrimitiveTypeCode.Byte] = ("byte", "System.Byte"),
        [PrimitiveTypeCode.SByte] = ("sbyte", "System.SByte"), [PrimitiveTypeCode.Char] = ("char", "System.Char"),
        [PrimitiveTypeCode.Int16] = ("short", "System.Int16"), [PrimitiveTypeCode.UInt16] = ("ushort", "System.UInt16"),
        [PrimitiveTypeCode.Int32] = ("int", "System.Int32"), [PrimitiveTypeCode.UInt32] = ("uint", "System.UInt32"),
        [PrimitiveTypeCode.Int64] = ("long", "System.Int64"), [PrimitiveTypeCode.UInt64] = ("ulong", "System.UInt64"),
        [PrimitiveTypeCode.Single] = ("float", "System.Single"), [PrimitiveTypeCode.Double] = ("double", "System.Double"),
        [PrimitiveTypeCode.String] = ("string", "System.String"), [PrimitiveTypeCode.Object] = ("object", "System.Object"),
        [PrimitiveTypeCode.Void] = ("void", "System.Void"), [PrimitiveTypeCode.IntPtr] = ("nint", "System.IntPtr"),
        [PrimitiveTypeCode.UIntPtr] = ("nuint", "System.UIntPtr"), [PrimitiveTypeCode.TypedReference] = ("TypedReference", "System.TypedReference"),
    };

    public static string StripArity(string name) { var i = name.IndexOf('`'); return i < 0 ? name : name[..i]; }

    /// <summary>Name of a type definition: Short = Outer.Inner, Full/Doc = Ns.Outer.Inner (generic arity dropped).</summary>
    public string DefName(TypeDefinitionHandle h)
    {
        var td = _md.GetTypeDefinition(h);
        var name = StripArity(_md.GetString(td.Name));
        var decl = td.GetDeclaringType();
        if (!decl.IsNil) return DefName(decl) + "." + name;
        var ns = _md.GetString(td.Namespace);
        return _mode == NameMode.Short || ns.Length == 0 ? name : ns + "." + name;
    }

    public string RefName(TypeReferenceHandle h)
    {
        var tr = _md.GetTypeReference(h);
        var name = StripArity(_md.GetString(tr.Name));
        if (tr.ResolutionScope.Kind == HandleKind.TypeReference) return RefName((TypeReferenceHandle)tr.ResolutionScope) + "." + name;
        var ns = _md.GetString(tr.Namespace);
        return _mode == NameMode.Short || ns.Length == 0 ? name : ns + "." + name;
    }

    public string Entity(EntityHandle h, GenCtx ctx) => h.Kind switch
    {
        HandleKind.TypeDefinition => DefName((TypeDefinitionHandle)h),
        HandleKind.TypeReference => RefName((TypeReferenceHandle)h),
        HandleKind.TypeSpecification => _md.GetTypeSpecification((TypeSpecificationHandle)h).DecodeSignature(this, ctx),
        _ => "?",
    };

    public string GetPrimitiveType(PrimitiveTypeCode t) => Prims.TryGetValue(t, out var p) ? (_mode == NameMode.Doc ? p.Sys : p.Cs) : t.ToString();
    public string GetTypeFromDefinition(MetadataReader reader, TypeDefinitionHandle handle, byte rawTypeKind) => DefName(handle);
    public string GetTypeFromReference(MetadataReader reader, TypeReferenceHandle handle, byte rawTypeKind) => RefName(handle);
    public string GetTypeFromSpecification(MetadataReader reader, GenCtx ctx, TypeSpecificationHandle handle, byte rawTypeKind) =>
        reader.GetTypeSpecification(handle).DecodeSignature(this, ctx);

    public string GetSZArrayType(string element) => element + "[]";
    public string GetArrayType(string element, ArrayShape shape) =>
        _mode == NameMode.Doc
            ? element + "[" + string.Join(",", Enumerable.Range(0, shape.Rank).Select(_ => "0:")) + "]"
            : element + "[" + new string(',', shape.Rank - 1) + "]";
    public string GetByReferenceType(string element) => _mode == NameMode.Doc ? element + "@" : "ref " + element;
    public string GetPointerType(string element) => element + "*";
    public string GetPinnedType(string element) => element;
    public string GetModifiedType(string modifier, string unmodified, bool isRequired)
    {
        if (modifier.EndsWith("IsExternalInit", StringComparison.Ordinal)) SawInit = true;
        return unmodified;
    }
    public string GetFunctionPointerType(MethodSignature<string> signature) =>
        "delegate*<" + string.Join(", ", signature.ParameterTypes.Concat(new[] { signature.ReturnType })) + ">";
    public string GetGenericMethodParameter(GenCtx ctx, int index) =>
        _mode == NameMode.Doc ? "``" + index : index < ctx.Method.Length ? ctx.Method[index] : "!!" + index;
    public string GetGenericTypeParameter(GenCtx ctx, int index) =>
        _mode == NameMode.Doc ? "`" + index : index < ctx.Type.Length ? ctx.Type[index] : "!" + index;

    public string GetGenericInstantiation(string generic, ImmutableArray<string> args)
    {
        if (_mode == NameMode.Doc) return generic + "{" + string.Join(",", args) + "}";
        if ((generic == "Nullable" || generic == "System.Nullable") && args.Length == 1) return args[0] + "?";
        if ((generic == "ValueTuple" || generic == "System.ValueTuple") && args.Length > 1 && args.Length < 8) return "(" + string.Join(", ", args) + ")";
        return generic + "<" + string.Join(", ", args) + ">";
    }

    // ICustomAttributeTypeProvider
    public string GetSystemType() => "System.Type";
    public bool IsSystemType(string type) => type is "System.Type" or "Type";
    public string GetTypeFromSerializedName(string name) => name.Split(',')[0];
    public PrimitiveTypeCode GetUnderlyingEnumType(string type) => PrimitiveTypeCode.Int32;
}
