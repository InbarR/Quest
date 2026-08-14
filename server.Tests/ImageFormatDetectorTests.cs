using FluentAssertions;
using Quest.Server.Services;
using Xunit;

namespace Quest.Server.Tests;

public class ImageFormatDetectorTests
{
    private static string ToBase64(params byte[] bytes)
    {
        // Pad so the payload is long enough to look like a real image body.
        var buffer = new byte[System.Math.Max(bytes.Length, 24)];
        bytes.CopyTo(buffer, 0);
        return System.Convert.ToBase64String(buffer);
    }

    [Fact]
    public void DetectMediaType_Png_Detected()
    {
        var png = ToBase64(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A);
        ImageFormatDetector.DetectMediaType(png).Should().Be("image/png");
    }

    [Fact]
    public void DetectMediaType_Jpeg_Detected()
    {
        var jpeg = ToBase64(0xFF, 0xD8, 0xFF, 0xE0);
        ImageFormatDetector.DetectMediaType(jpeg).Should().Be("image/jpeg");
    }

    [Fact]
    public void DetectMediaType_Gif87a_Detected()
    {
        var gif = ToBase64((byte)'G', (byte)'I', (byte)'F', (byte)'8', (byte)'7', (byte)'a');
        ImageFormatDetector.DetectMediaType(gif).Should().Be("image/gif");
    }

    [Fact]
    public void DetectMediaType_Gif89a_Detected()
    {
        var gif = ToBase64((byte)'G', (byte)'I', (byte)'F', (byte)'8', (byte)'9', (byte)'a');
        ImageFormatDetector.DetectMediaType(gif).Should().Be("image/gif");
    }

    [Fact]
    public void DetectMediaType_Webp_Detected()
    {
        var webp = ToBase64(
            (byte)'R', (byte)'I', (byte)'F', (byte)'F',
            0x00, 0x00, 0x00, 0x00,
            (byte)'W', (byte)'E', (byte)'B', (byte)'P');
        ImageFormatDetector.DetectMediaType(webp).Should().Be("image/webp");
    }

    /// <summary>
    /// Windows screenshots are frequently BMP. The file picker infers the media
    /// type from the extension and falls back to image/png, so a BMP could
    /// previously be announced as PNG and get the whole request rejected.
    /// </summary>
    [Fact]
    public void DetectMediaType_Bmp_ReturnsNullSoCallerCanReportClearly()
    {
        var bmp = ToBase64((byte)'B', (byte)'M', 0x36, 0x00);
        ImageFormatDetector.DetectMediaType(bmp).Should().BeNull();
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("not valid base64 !!!")]
    public void DetectMediaType_InvalidInput_ReturnsNull(string? input)
    {
        ImageFormatDetector.DetectMediaType(input).Should().BeNull();
    }

    [Fact]
    public void DetectMediaType_ShortPayload_DoesNotThrow()
    {
        var action = () => ImageFormatDetector.DetectMediaType("iVBO");
        action.Should().NotThrow();
    }
}
