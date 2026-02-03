using System.Text.Json;
using Quest.Server.Protocol;

namespace Quest.Server.Handlers;

public class ResultsHistoryHandler
{
    private readonly string _historyDir;
    private readonly Action<string>? _log;
    private readonly int _maxItems;
    private readonly int _retentionDays;
    private readonly JsonSerializerOptions _jsonOptions = new()
    {
        WriteIndented = true,
        PropertyNameCaseInsensitive = true
    };

    public ResultsHistoryHandler(string dataPath, Action<string>? log = null, int maxItems = 100, int retentionDays = 14)
    {
        _historyDir = Path.Combine(dataPath, "ResultsHistory");
        _log = log;
        _maxItems = maxItems;
        _retentionDays = retentionDays;

        // Ensure directory exists
        Directory.CreateDirectory(_historyDir);

        // Apply retention on startup
        ApplyRetention();
    }

    private string GetFilePath(string id) => Path.Combine(_historyDir, $"{id}.json");

    private void ApplyRetention()
    {
        try
        {
            var cutoffDate = DateTime.UtcNow.AddDays(-_retentionDays);
            var files = Directory.GetFiles(_historyDir, "*.json")
                .Select(f => new FileInfo(f))
                .ToList();

            var removedCount = 0;

            // Remove files older than retention period
            foreach (var file in files.Where(f => f.LastWriteTimeUtc < cutoffDate))
            {
                try
                {
                    file.Delete();
                    removedCount++;
                }
                catch { }
            }

            // If still over max items, remove oldest
            var remainingFiles = Directory.GetFiles(_historyDir, "*.json")
                .Select(f => new FileInfo(f))
                .OrderByDescending(f => f.LastWriteTimeUtc)
                .ToList();

            if (remainingFiles.Count > _maxItems)
            {
                foreach (var file in remainingFiles.Skip(_maxItems))
                {
                    try
                    {
                        file.Delete();
                        removedCount++;
                    }
                    catch { }
                }
            }

            if (removedCount > 0)
            {
                _log?.Invoke($"Retention cleanup: removed {removedCount} old result files");
            }
        }
        catch (Exception ex)
        {
            _log?.Invoke($"Failed to apply retention: {ex.Message}");
        }
    }

    public ResultHistoryItem[] GetHistory(int limit)
    {
        try
        {
            var files = Directory.GetFiles(_historyDir, "*.json")
                .Select(f => new FileInfo(f))
                .OrderByDescending(f => f.LastWriteTimeUtc)
                .Take(limit)
                .ToList();

            var items = new List<ResultHistoryItem>();
            foreach (var file in files)
            {
                try
                {
                    var json = File.ReadAllText(file.FullName);
                    var item = JsonSerializer.Deserialize<ResultHistoryItem>(json, _jsonOptions);
                    if (item != null)
                    {
                        items.Add(item);
                    }
                }
                catch (Exception ex)
                {
                    _log?.Invoke($"Failed to read result file {file.Name}: {ex.Message}");
                }
            }

            _log?.Invoke($"GetResultHistory returning {items.Count} items");
            return items.ToArray();
        }
        catch (Exception ex)
        {
            _log?.Invoke($"Failed to get result history: {ex.Message}");
            return Array.Empty<ResultHistoryItem>();
        }
    }

    public void SaveResult(ResultHistoryItem item)
    {
        try
        {
            _log?.Invoke($"Saving result: {item.Title} ({item.RowCount} rows, success={item.Success})");

            var filePath = GetFilePath(item.Id);
            var json = JsonSerializer.Serialize(item, _jsonOptions);
            File.WriteAllText(filePath, json);

            _log?.Invoke($"Saved result to {filePath}");

            // Apply retention after saving
            ApplyRetention();
        }
        catch (Exception ex)
        {
            _log?.Invoke($"Failed to save result: {ex.Message}");
        }
    }

    public void DeleteResult(string id)
    {
        try
        {
            var filePath = GetFilePath(id);
            if (File.Exists(filePath))
            {
                File.Delete(filePath);
                _log?.Invoke($"Deleted result: {id}");
            }
        }
        catch (Exception ex)
        {
            _log?.Invoke($"Failed to delete result {id}: {ex.Message}");
        }
    }

    public int ClearHistory()
    {
        try
        {
            var files = Directory.GetFiles(_historyDir, "*.json");
            var count = files.Length;

            foreach (var file in files)
            {
                try
                {
                    File.Delete(file);
                }
                catch { }
            }

            _log?.Invoke($"Cleared {count} result history items");
            return count;
        }
        catch (Exception ex)
        {
            _log?.Invoke($"Failed to clear history: {ex.Message}");
            return 0;
        }
    }
}
