using System;

namespace MyTools.Core
{
    public class SavedResult
    {
        public string FilePath { get; set; } = "";
        public string Title { get; set; } = "";
        public DateTime Timestamp { get; set; }
        public int RowCount { get; set; }
        public string Cluster { get; set; } = "";
        public string Database { get; set; } = "";
        public string Query { get; set; } = "";
        public long FileSizeBytes { get; set; }
        
        public string DisplayText => $"{Title} ({RowCount} rows) - {Timestamp:MM/dd HH:mm}";
        public string FileSizeFormatted => FormatFileSize(FileSizeBytes);
        
        private static string FormatFileSize(long bytes)
        {
            string[] sizes = { "B", "KB", "MB", "GB" };
            double len = bytes;
            int order = 0;
            while (len >= 1024 && order < sizes.Length - 1)
            {
                order++;
                len = len / 1024;
            }
            return $"{len:0.##} {sizes[order]}";
        }
    }
}
