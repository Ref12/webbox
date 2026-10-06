namespace Fuget;

public sealed class MemberChange
{
    public string Status { get; set; } = "";   // added | removed | changed
    public string Kind { get; set; } = "";
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string? Old { get; set; }
    public string? New { get; set; }
    public bool Breaking { get; set; }
}

public sealed class TypeChange
{
    public string Status { get; set; } = "";   // added | removed | changed
    public string FullName { get; set; } = "";
    public string Namespace { get; set; } = "";
    public string Name { get; set; } = "";
    public string Kind { get; set; } = "";
    public string? OldDeclaration { get; set; }
    public string? NewDeclaration { get; set; }
    public bool Breaking { get; set; }
    public List<MemberChange> Members { get; set; } = new();
}

public sealed class DiffResult
{
    public string Assembly { get; set; } = "";
    public string? OldDir { get; set; }
    public string? NewDir { get; set; }
    public int AddedTypes { get; set; }
    public int RemovedTypes { get; set; }
    public int ChangedTypes { get; set; }
    public int AddedMembers { get; set; }
    public int RemovedMembers { get; set; }
    public int ChangedMembers { get; set; }
    public int Breaking { get; set; }
    public List<TypeChange> Types { get; set; } = new();
}

/// <summary>Public API diff between two reads of the same assembly: added, removed and changed types and members, grouped by type.</summary>
public static class ApiDiff
{
    public static DiffResult Compare(AssemblyApi? oldApi, AssemblyApi? newApi)
    {
        var res = new DiffResult { Assembly = (newApi ?? oldApi)?.Name ?? "" };
        var olds = (oldApi?.Types ?? new()).ToDictionary(t => t.FullName);
        var news = (newApi?.Types ?? new()).ToDictionary(t => t.FullName);
        foreach (var name in olds.Keys.Union(news.Keys).OrderBy(n => n, StringComparer.Ordinal))
        {
            olds.TryGetValue(name, out var o); news.TryGetValue(name, out var n);
            if (o == null)
            {
                res.AddedTypes++;
                res.Types.Add(Whole("added", n!, n!.Members.Select(m => Member("added", m, null, m)).ToList(), false));
                res.AddedMembers += n.Members.Count;
            }
            else if (n == null)
            {
                res.RemovedTypes++; res.Breaking++;
                res.Types.Add(Whole("removed", o, o.Members.Select(m => Member("removed", m, m, null)).ToList(), true));
                res.RemovedMembers += o.Members.Count;
            }
            else
            {
                var changes = new List<MemberChange>();
                var om = o.Members.GroupBy(m => m.Id).ToDictionary(g => g.Key, g => g.First());
                var nm = n.Members.GroupBy(m => m.Id).ToDictionary(g => g.Key, g => g.First());
                foreach (var id in om.Keys.Union(nm.Keys).OrderBy(i => i, StringComparer.Ordinal))
                {
                    om.TryGetValue(id, out var a); nm.TryGetValue(id, out var b);
                    if (a == null) { changes.Add(Member("added", b!, null, b)); res.AddedMembers++; }
                    else if (b == null) { changes.Add(Member("removed", a, a, null)); res.RemovedMembers++; }
                    else if (a.FullSignature != b.FullSignature || (a.Obsolete != null) != (b.Obsolete != null))
                    {
                        var c = Member("changed", b, a, b);
                        c.Breaking = a.FullSignature != b.FullSignature;
                        changes.Add(c); res.ChangedMembers++;
                    }
                }
                var declChanged = o.FullDeclaration != n.FullDeclaration || (o.Obsolete != null) != (n.Obsolete != null);
                if (changes.Count > 0 || declChanged)
                {
                    var t = Whole("changed", n, changes, declChanged && o.FullDeclaration != n.FullDeclaration);
                    t.OldDeclaration = o.Declaration; t.NewDeclaration = n.Declaration;
                    t.Breaking = changes.Any(c => c.Breaking) || t.Breaking;
                    res.ChangedTypes++; res.Types.Add(t);
                }
            }
        }
        res.Breaking += res.Types.Where(t => t.Status != "removed").SelectMany(t => t.Members).Count(m => m.Breaking);
        res.Breaking += res.Types.Count(t => t.Status == "changed" && t.Breaking && t.Members.All(m => !m.Breaking));
        return res;
    }

    private static TypeChange Whole(string status, TypeApi t, List<MemberChange> members, bool breaking) => new()
    {
        Status = status, FullName = t.FullName, Namespace = t.Namespace, Name = t.Name, Kind = t.Kind, Breaking = breaking,
        NewDeclaration = status == "removed" ? null : t.Declaration, OldDeclaration = status == "added" ? null : t.Declaration, Members = members,
    };

    private static MemberChange Member(string status, MemberApi shown, MemberApi? o, MemberApi? n) => new()
    {
        Status = status, Kind = shown.Kind, Id = shown.Id, Name = shown.Name, Old = o?.Signature, New = n?.Signature, Breaking = status == "removed",
    };
}
