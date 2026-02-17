using MyTools.Core;
using Quest.Server.Protocol;

namespace Quest.Server.Handlers;

public class PresetHandler
{
    private readonly PresetManager _presetManager;
    private readonly Action<string>? _log;
    private List<KustoPreset> _presets = new();

    public PresetHandler(PresetManager presetManager, Action<string>? log = null)
    {
        _presetManager = presetManager;
        _log = log;
        LoadPresets();
    }

    private void LoadPresets()
    {
        _presets = _presetManager.LoadPresets();
    }

    public PresetInfo[] GetPresets()
    {
        LoadPresets();
        var presets = _presets
            .Where(p => !p.AutoSaved)
            .Select(p => ToPresetInfo(p, _log))
            .ToArray();
        _log?.Invoke($"GetPresets returning {presets.Length} presets");
        return presets;
    }

    public PresetInfo[] GetHistory(int limit)
    {
        LoadPresets();
        var history = _presets
            .Where(p => p.AutoSaved)
            .OrderByDescending(p => p.Time)
            .Take(limit)
            .Select(p => ToPresetInfo(p, _log))
            .ToArray();
        _log?.Invoke($"GetHistory returning {history.Length} items");
        return history;
    }

    public void SavePreset(PresetInfo preset)
    {
        // Reload from disk to ensure we have the latest list
        LoadPresets();

        var kustoPreset = new KustoPreset
        {
            PresetName = preset.Name,
            Query = preset.Query,
            Description = preset.Description,
            AutoSaved = preset.IsAutoSaved,
            Time = DateTime.Parse(preset.CreatedAt),
            Mode = preset.Type switch { "ado" => PresetMode.ADO, "outlook" => PresetMode.Outlook, "mcp" => PresetMode.MCP, _ => PresetMode.Kusto },
            Clusters = !string.IsNullOrEmpty(preset.ClusterUrl) ? new[]
            {
                new KustoCluster
                {
                    Cluster = preset.ClusterUrl,
                    DB = preset.Database ?? "",
                    Org = preset.Type == "ado" ? "ADO" : "Kusto"
                }
            } : Array.Empty<KustoCluster>()
        };

        // For non-autosaved presets, remove any existing preset with the same name (case-insensitive)
        if (!preset.IsAutoSaved)
        {
            _presets.RemoveAll(p => !p.AutoSaved &&
                string.Equals(p.PresetName, preset.Name, StringComparison.OrdinalIgnoreCase));
        }

        _presets.Add(kustoPreset);
        _presetManager.SavePresets(_presets);
    }

    public void DeletePreset(string id)
    {
        var preset = _presets.FirstOrDefault(p => GetPresetId(p) == id);
        if (preset != null)
        {
            _presets.Remove(preset);
            _presetManager.SavePresets(_presets);
        }
    }

    public int ClearHistory()
    {
        LoadPresets();
        var historyCount = _presets.Count(p => p.AutoSaved);
        _presets.RemoveAll(p => p.AutoSaved);
        _presetManager.SavePresets(_presets);
        _log?.Invoke($"Cleared {historyCount} history items");
        return historyCount;
    }

    private static PresetInfo ToPresetInfo(KustoPreset p, Action<string>? log)
    {
        var cluster = p.Clusters?.FirstOrDefault();
        var clusterUrl = cluster?.Cluster;
        var database = cluster?.DB;

        return new PresetInfo(
            Id: GetPresetId(p),
            Name: p.PresetName ?? "Untitled",
            Query: p.Query ?? "",
            Description: p.Description,
            ClusterUrl: clusterUrl,
            Database: database,
            Type: p.Mode switch { PresetMode.ADO => "ado", PresetMode.Outlook => "outlook", PresetMode.MCP => "mcp", _ => "kusto" },
            CreatedAt: p.Time.ToString("O"),
            IsAutoSaved: p.AutoSaved
        );
    }

    private static string GetPresetId(KustoPreset p)
    {
        return $"{p.PresetName}_{p.Time.Ticks}".GetHashCode().ToString();
    }
}
