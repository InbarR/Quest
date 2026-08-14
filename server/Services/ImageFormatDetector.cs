namespace Quest.Server.Services;

/// <summary>
/// Identifies image formats from their magic bytes.
/// <para>
/// The media type reported by the clipboard or inferred from a file extension is
/// not always accurate, and the vision API validates the actual bytes and rejects
/// the whole request when they disagree. Detecting the real format lets us send
/// the correct type, or fail with a useful message when the format isn't
/// supported at all.
/// </para>
/// </summary>
public static class ImageFormatDetector
{
    /// <summary>
    /// Returns the media type for a base64-encoded image, or null when the format
    /// is not one the vision API accepts.
    /// </summary>
    public static string? DetectMediaType(string? base64)
    {
        if (string.IsNullOrWhiteSpace(base64))
            return null;

        var header = DecodeHeader(base64);
        if (header == null)
            return null;

        return DetectMediaType(header);
    }

    /// <summary>
    /// Returns the media type for raw image bytes, or null when unsupported.
    /// </summary>
    public static string? DetectMediaType(byte[] header)
    {
        if (header == null)
            return null;

        if (header.Length >= 8 &&
            header[0] == 0x89 && header[1] == 0x50 && header[2] == 0x4E && header[3] == 0x47 &&
            header[4] == 0x0D && header[5] == 0x0A && header[6] == 0x1A && header[7] == 0x0A)
            return "image/png";

        if (header.Length >= 3 && header[0] == 0xFF && header[1] == 0xD8 && header[2] == 0xFF)
            return "image/jpeg";

        if (header.Length >= 6 &&
            header[0] == (byte)'G' && header[1] == (byte)'I' && header[2] == (byte)'F' &&
            header[3] == (byte)'8' && (header[4] == (byte)'7' || header[4] == (byte)'9') &&
            header[5] == (byte)'a')
            return "image/gif";

        if (header.Length >= 12 &&
            header[0] == (byte)'R' && header[1] == (byte)'I' && header[2] == (byte)'F' && header[3] == (byte)'F' &&
            header[8] == (byte)'W' && header[9] == (byte)'E' && header[10] == (byte)'B' && header[11] == (byte)'P')
            return "image/webp";

        return null;
    }

    /// <summary>
    /// Decodes just enough of the base64 payload to inspect the file signature.
    /// </summary>
    private static byte[]? DecodeHeader(string base64)
    {
        try
        {
            // 4 base64 characters decode to 3 bytes, so 32 characters covers the
            // 12 bytes needed by the longest signature we check.
            var prefix = base64.Length > 32 ? base64.Substring(0, 32) : base64;
            prefix = prefix.Substring(0, prefix.Length - (prefix.Length % 4));
            if (prefix.Length == 0)
                return null;

            return Convert.FromBase64String(prefix);
        }
        catch (FormatException)
        {
            return null;
        }
    }
}
