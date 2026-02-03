using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;

namespace MyTools.Core
{
    public class ResultsManager
    {
        private readonly string _resultsFolder;
        private readonly string _metadataFile;

        public ResultsManager(string resultsFolder)
        {
            _resultsFolder = resultsFolder;
            _metadataFile = Path.Combine(_resultsFolder, "results_metadata.json");
            
            if (!Directory.Exists(_resultsFolder))
            {
                Directory.CreateDirectory(_resultsFolder);
            }
        }

        public string SaveResult(string title, string[] columns, List<object[]> rows, string cluster, string database, string query)
        {
            try
            {
                var timestamp = DateTime.Now;
                var safeTitle = MakeSafeFileName(title);
                var fileName = $"{safeTitle}_{timestamp:MM_dd__HH_mm_ss}.csv";
                var filePath = Path.Combine(_resultsFolder, fileName);
                var queryPath = Path.ChangeExtension(filePath, "query");

                // Write CSV file
                using (var writer = new StreamWriter(filePath))
                {
                    // Write header
                    writer.WriteLine(string.Join(",", columns.Select(c => EscapeCsv(c))));
                    
                    // Write rows
                    foreach (var row in rows)
                    {
                        var values = row.Select(v => EscapeCsv(v?.ToString() ?? ""));
                        writer.WriteLine(string.Join(",", values));
                    }
                }

                // Write query file
                File.WriteAllText(queryPath, query);

                // Save metadata
                var savedResult = new SavedResult
                {
                    FilePath = filePath,
                    Title = title,
                    Timestamp = timestamp,
                    RowCount = rows.Count,
                    Cluster = cluster,
                    Database = database,
                    Query = query,
                    FileSizeBytes = new FileInfo(filePath).Length
                };

                SaveMetadata(savedResult);

                return filePath;
            }
            catch (Exception ex)
            {
                throw new Exception($"Failed to save results: {ex.Message}", ex);
            }
        }

        public List<SavedResult> LoadSavedResults()
        {
            var results = new List<SavedResult>();

            if (!File.Exists(_metadataFile))
            {
                return results;
            }

            try
            {
                var json = File.ReadAllText(_metadataFile);
                results = JsonSerializer.Deserialize<List<SavedResult>>(json) ?? new List<SavedResult>();
                
                // Filter out results where files no longer exist
                results = results.Where(r => File.Exists(r.FilePath)).ToList();
                
                // Sort by timestamp descending
                results = results.OrderByDescending(r => r.Timestamp).ToList();
            }
            catch
            {
                // If metadata is corrupted, scan directory for CSV files
                results = ScanResultsDirectory();
            }

            return results;
        }

        public void DeleteResult(SavedResult result)
        {
            try
            {
                if (File.Exists(result.FilePath))
                {
                    File.Delete(result.FilePath);
                }

                var queryPath = Path.ChangeExtension(result.FilePath, "query");
                if (File.Exists(queryPath))
                {
                    File.Delete(queryPath);
                }

                // Remove from metadata
                var results = LoadSavedResults();
                results.RemoveAll(r => r.FilePath == result.FilePath);
                SaveAllMetadata(results);
            }
            catch (Exception ex)
            {
                throw new Exception($"Failed to delete result: {ex.Message}", ex);
            }
        }

        public (string[] columns, List<object[]> rows) LoadResultFile(string filePath)
        {
            try
            {
                var lines = File.ReadAllLines(filePath);
                if (lines.Length == 0)
                {
                    throw new Exception("Result file is empty");
                }

                // Use simple split like MyKusto to maintain compatibility
                // This matches the behavior in MyKusto/KustoTab.cs ShowResult method
                var columns = lines[0].Split(',');
                var rows = new List<object[]>();

                for (int i = 1; i < lines.Length; i++)
                {
                    // Split by comma and replace tabs back to commas (matching MyKusto behavior)
                    var values = lines[i].Split(',').Select(r => r.Replace("\t", ",")).ToArray();
                    rows.Add(values.Cast<object>().ToArray());
                }

                return (columns, rows);
            }
            catch (Exception ex)
            {
                throw new Exception($"Failed to load result file: {ex.Message}", ex);
            }
        }

        private void SaveMetadata(SavedResult result)
        {
            var results = LoadSavedResults();
            
            // Remove existing entry with same file path
            results.RemoveAll(r => r.FilePath == result.FilePath);
            
            // Add new entry
            results.Insert(0, result);
            
            // Keep only last 100 entries
            if (results.Count > 100)
            {
                results = results.Take(100).ToList();
            }

            SaveAllMetadata(results);
        }

        private void SaveAllMetadata(List<SavedResult> results)
        {
            var json = JsonSerializer.Serialize(results, new JsonSerializerOptions 
            { 
                WriteIndented = true 
            });
            File.WriteAllText(_metadataFile, json);
        }

        private List<SavedResult> ScanResultsDirectory()
        {
            var results = new List<SavedResult>();

            foreach (var file in Directory.GetFiles(_resultsFolder, "*.csv"))
            {
                try
                {
                    var fileInfo = new FileInfo(file);
                    var queryPath = Path.ChangeExtension(file, "query");
                    var query = File.Exists(queryPath) ? File.ReadAllText(queryPath) : "";
                    
                    var lines = File.ReadAllLines(file);
                    var rowCount = lines.Length > 0 ? lines.Length - 1 : 0;

                    results.Add(new SavedResult
                    {
                        FilePath = file,
                        Title = Path.GetFileNameWithoutExtension(file),
                        Timestamp = fileInfo.CreationTime,
                        RowCount = rowCount,
                        Cluster = "",
                        Database = "",
                        Query = query,
                        FileSizeBytes = fileInfo.Length
                    });
                }
                catch
                {
                    // Skip files that can't be read
                }
            }

            return results.OrderByDescending(r => r.Timestamp).ToList();
        }

        private static string MakeSafeFileName(string fileName)
        {
            var invalid = Path.GetInvalidFileNameChars();
            var safe = string.Join("_", fileName.Split(invalid, StringSplitOptions.RemoveEmptyEntries)).TrimEnd('.');
            
            // Limit length
            if (safe.Length > 50)
            {
                safe = safe.Substring(0, 50);
            }

            return string.IsNullOrWhiteSpace(safe) ? "result" : safe;
        }

        private static string EscapeCsv(string value)
        {
            if (value.Contains(",") || value.Contains("\"") || value.Contains("\n"))
            {
                return $"\"{value.Replace("\"", "\"\"")}\"";
            }
            return value;
        }

        private static string[] ParseCsvLine(string line)
        {
            var values = new List<string>();
            var current = "";
            var inQuotes = false;

            for (int i = 0; i < line.Length; i++)
            {
                var c = line[i];

                if (c == '"')
                {
                    if (inQuotes && i + 1 < line.Length && line[i + 1] == '"')
                    {
                        current += '"';
                        i++;
                    }
                    else
                    {
                        inQuotes = !inQuotes;
                    }
                }
                else if (c == ',' && !inQuotes)
                {
                    values.Add(current);
                    current = "";
                }
                else
                {
                    current += c;
                }
            }

            values.Add(current);
            return values.ToArray();
        }
    }
}
