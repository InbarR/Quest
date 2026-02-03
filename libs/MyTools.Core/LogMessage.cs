using System;

namespace MyTools.Core
{
    public class LogMessage
    {
        public string Time { get; set; }
        public string Message { get; set; }
        public string ForeColor { get; set; } // Changed to string for cross-platform compatibility (e.g., hex code or name)
    }
}