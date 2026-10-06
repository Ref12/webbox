using System.Text.Json.Serialization;

namespace Fuget;

/// <summary>One public (or protected) member of a type, as shown in the member list.</summary>
public sealed class MemberApi
{
    public string Kind { get; set; } = "";          // constructor | method | operator | property | field | const | event
    public string Name { get; set; } = "";
    public string Id { get; set; } = "";            // XML-doc id, e.g. M:Ns.Type.Name(System.Int32)
    public string Signature { get; set; } = "";     // C#-style, short type names
    public int Token { get; set; }                  // metadata token (used to decompile just this member)
    public string? Obsolete { get; set; }           // message ("" when none given); null when not obsolete
    public bool ObsoleteError { get; set; }
    public List<string> Attributes { get; set; } = new();
    public string? Summary { get; set; }
    /// <summary>Fully-qualified signature; used for diffing only (a namespace-only change is a change).</summary>
    [JsonIgnore] public string FullSignature { get; set; } = "";
}

public sealed class TypeApi
{
    public string Namespace { get; set; } = "";
    public string Name { get; set; } = "";          // display: Outer.Inner<T>
    public string FullName { get; set; } = "";      // Ns.Outer.Inner`1 (metadata names joined by '.'); unique, used in deep links
    public string Id { get; set; } = "";            // T:Ns.Outer.Inner`1
    public string Kind { get; set; } = "class";     // class | struct | interface | enum | delegate
    public string Declaration { get; set; } = "";   // public sealed class Foo<T> : Base, IFoo
    public int Token { get; set; }
    public string? Obsolete { get; set; }
    public bool ObsoleteError { get; set; }
    public List<string> Attributes { get; set; } = new();
    public string? Summary { get; set; }
    public List<MemberApi> Members { get; set; } = new();
    [JsonIgnore] public string FullDeclaration { get; set; } = "";
}

public sealed class AssemblyApi
{
    public string Name { get; set; } = "";
    public string Version { get; set; } = "";
    public List<string> Attributes { get; set; } = new();
    public List<TypeApi> Types { get; set; } = new();
    public List<string> References { get; set; } = new();
}
