using System.Text;

namespace CsRepl;

/// <summary>
/// Single-file container for the reference assemblies (ref/refs.bin), so a slow link needs one request, not 167.
/// Layout (little endian): "CSRB" | int32 count | count x { uint16 nameLen | utf8 name | int32 length } | blobs in the same order.
/// </summary>
public static class ReferenceBundle
{
    private static readonly byte[] Magic = "CSRB"u8.ToArray();

    public static byte[] Write(IEnumerable<(string Name, byte[] Bytes)> files)
    {
        var list = files.ToList();
        using var ms = new MemoryStream();
        using var w = new BinaryWriter(ms, Encoding.UTF8, leaveOpen: true);
        w.Write(Magic);
        w.Write(list.Count);
        foreach (var (name, bytes) in list)
        {
            var n = Encoding.UTF8.GetBytes(name);
            w.Write((ushort)n.Length); w.Write(n); w.Write(bytes.Length);
        }
        foreach (var (_, bytes) in list) w.Write(bytes);
        w.Flush();
        return ms.ToArray();
    }

    /// <summary>Parses a bundle; throws InvalidDataException on truncation or bad magic.</summary>
    public static List<(string Name, byte[] Bytes)> Read(byte[] data)
    {
        try
        {
            using var ms = new MemoryStream(data, writable: false);
            using var r = new BinaryReader(ms, Encoding.UTF8);
            if (!r.ReadBytes(4).AsSpan().SequenceEqual(Magic)) throw new InvalidDataException("not a reference bundle (bad magic)");
            var count = r.ReadInt32();
            if (count < 0 || count > 100_000) throw new InvalidDataException("bad entry count");
            var entries = new List<(string, int)>(count);
            for (var i = 0; i < count; i++)
            {
                var name = Encoding.UTF8.GetString(r.ReadBytes(r.ReadUInt16()));
                var len = r.ReadInt32();
                if (len < 0) throw new InvalidDataException("bad length for " + name);
                entries.Add((name, len));
            }
            var result = new List<(string, byte[])>(count);
            foreach (var (name, len) in entries)
            {
                var b = r.ReadBytes(len);
                if (b.Length != len) throw new InvalidDataException("bundle truncated at " + name);
                result.Add((name, b));
            }
            return result;
        }
        catch (EndOfStreamException) { throw new InvalidDataException("bundle truncated"); }
    }
}
