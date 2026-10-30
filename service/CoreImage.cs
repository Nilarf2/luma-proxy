using System.Security.Cryptography;
using System.Text.RegularExpressions;

static class CoreImage {
    const long MaximumBytes = 200L * 1024 * 1024;
    public static void NoLinks(string path) {
        var file = new FileInfo(path);
        if (file.Exists && file.Attributes.HasFlag(FileAttributes.ReparsePoint)) throw new IOException("Reparse points are not allowed");
        for (var dir = file.Directory; dir != null; dir = dir.Parent)
            if (dir.Exists && dir.Attributes.HasFlag(FileAttributes.ReparsePoint)) throw new IOException("Reparse points are not allowed");
    }
    public static string Hash(string path) {
        NoLinks(path); using var input = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        return Convert.ToHexString(SHA256.HashData(input)).ToLowerInvariant();
    }
    public static void Stage(string source, string staged, string expectedHash) {
        if (!Regex.IsMatch(expectedHash, "^[a-fA-F0-9]{64}$")) throw new IOException("Invalid core hash");
        NoLinks(source); NoLinks(staged);
        using var input = new FileStream(source, FileMode.Open, FileAccess.Read, FileShare.Read);
        if (input.Length < 256 || input.Length > MaximumBytes) throw new IOException("Core image size is invalid");
        if (!Convert.ToHexString(SHA256.HashData(input)).Equals(expectedHash, StringComparison.OrdinalIgnoreCase)) throw new IOException("Selected core changed before approval");
        input.Position = 0; using (var reader = new BinaryReader(input, System.Text.Encoding.UTF8, true)) {
            if (reader.ReadUInt16() != 0x5a4d) throw new IOException("Core is not a Windows image");
            input.Position = 0x3c; var header = reader.ReadInt32();
            if (header < 64 || header > input.Length - 26) throw new IOException("Invalid PE header");
            input.Position = header;
            if (reader.ReadUInt32() != 0x00004550 || reader.ReadUInt16() != 0x8664) throw new IOException("Core must target Windows x64");
            input.Position = header + 22; var flags = reader.ReadUInt16();
            if ((flags & 2) == 0 || (flags & 0x2000) != 0 || reader.ReadUInt16() != 0x20b) throw new IOException("Core must be an executable x64 image");
        }
        input.Position = 0;
        // The same handle is hashed, inspected and copied; Windows forbids concurrent writes/deletes.
        using var output = new FileStream(staged, FileMode.CreateNew, FileAccess.Write, FileShare.None);
        input.CopyTo(output); output.Flush(true);
    }
    public static void Replace(string source, string target, string expectedHash, Action stop, Action start) {
        NoLinks(target); if (!File.Exists(target)) throw new IOException("Protected core is missing");
        var staged = target + ".pending-" + Guid.NewGuid().ToString("N");
        var previous = target + ".previous-" + Guid.NewGuid().ToString("N");
        var movedOld = false; var stopped = false; var success = false;
        try {
            Stage(source, staged, expectedHash);
            stopped = true; stop(); NoLinks(target); File.Move(target, previous); movedOld = true;
            File.Move(staged, target); start(); success = true;
        } catch {
            if (stopped) {
                try { stop(); } catch { }
                if (movedOld) { NoLinks(target); if (File.Exists(target)) File.Delete(target); File.Move(previous, target); }
                start();
            }
            throw;
        } finally {
            if (File.Exists(staged)) File.Delete(staged);
            if (success && File.Exists(previous)) File.Delete(previous);
        }
    }
}
