using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Xml.Serialization;

namespace MyTools.Core
{
    public class PresetManager
    {
        private readonly string _presetFile;
        private readonly RemoteContentLoader? _remoteLoader;
        private const int LastQueriesSize = 100;

        public PresetManager(string presetFile, RemoteContentLoader? remoteLoader = null)
        {
            _presetFile = presetFile;
            _remoteLoader = remoteLoader;
        }

        public List<KustoPreset> LoadPresets()
        {
            return LoadLocalPresets();
        }

        public async System.Threading.Tasks.Task<List<KustoPreset>> LoadPresetsWithRemoteAsync(string? remotePath, int cacheMinutes = 30)
        {
            var localPresets = LoadLocalPresets();

            if (_remoteLoader != null && !string.IsNullOrEmpty(remotePath))
            {
                try
                {
                    var remotePresets = await _remoteLoader.LoadQueriesFromRemoteAsync(remotePath, cacheMinutes);
                    
                    // Add remote presets to the beginning of the list
                    // Mark them as remote so they can be distinguished in UI
                    foreach (var preset in remotePresets)
                    {
                        preset.PresetName = $"[Remote] {preset.PresetName}";
                    }
                    
                    remotePresets.AddRange(localPresets);
                    return remotePresets;
                }
                catch (Exception)
                {
                    // If remote fails, return local presets
                    return localPresets;
                }
            }

            return localPresets;
        }

        private List<KustoPreset> LoadLocalPresets()
        {
            // Try to load from JSON first
            var jsonFile = Path.ChangeExtension(_presetFile, ".json");
            if (File.Exists(jsonFile))
            {
                return LoadFromJson(jsonFile);
            }

            // If JSON doesn't exist, try XML and migrate
            if (File.Exists(_presetFile))
            {
                var presets = LoadFromXml(_presetFile);
                
                // Migrate to JSON
                try
                {
                    SavePresets(presets);
                    
                    // Backup the old XML file
                    var backupFile = _presetFile + ".backup";
                    if (!File.Exists(backupFile))
                    {
                        File.Copy(_presetFile, backupFile);
                    }
                }
                catch (Exception)
                {
                    // If migration fails, continue with XML data
                }
                
                return presets;
            }

            return new List<KustoPreset>();
        }

        private List<KustoPreset> LoadFromJson(string jsonFile)
        {
            try
            {
                var json = File.ReadAllText(jsonFile);
                var options = new JsonSerializerOptions
                {
                    PropertyNameCaseInsensitive = true,
                    Converters = { new JsonStringEnumConverter() }
                };
                
                var allPresets = JsonSerializer.Deserialize<List<KustoPreset>>(json, options) ?? new List<KustoPreset>();

                var presets = allPresets
                    .Where(p => !p.AutoSaved && !string.IsNullOrEmpty(p.PresetName))
                    .OrderBy(p => p.PresetName)
                    .ToList();

                var lastQueries = allPresets
                    .Where(p => p.AutoSaved)
                    .OrderByDescending(p => p.Time)
                    .Take(LastQueriesSize)
                    .ToList();

                presets.AddRange(lastQueries);
                return presets;
            }
            catch (Exception)
            {
                return new List<KustoPreset>();
            }
        }

        private List<KustoPreset> LoadFromXml(string xmlFile)
        {
            try
            {
                using (var stream = File.OpenRead(xmlFile))
                {
                    List<KustoPreset> allPresets;

                    // Try to load as KustoPreset list first
                    try
                    {
                        var serializer = new XmlSerializer(typeof(List<KustoPreset>));
                        allPresets = (List<KustoPreset>)serializer.Deserialize(stream);
                    }
                    catch
                    {
                        // If that fails, try loading as legacy ADO "Preset" format
                        stream.Position = 0;
                        var legacySerializer = new XmlSerializer(typeof(List<LegacyPreset>), new XmlRootAttribute("ArrayOfPreset"));
                        var legacyPresets = (List<LegacyPreset>)legacySerializer.Deserialize(stream);
                        allPresets = legacyPresets.Select(p => new KustoPreset
                        {
                            PresetName = p.PresetName,
                            Query = p.Query,
                            AutoSaved = p.AutoSaved,
                            Time = p.Time,
                            Mode = PresetMode.ADO // Legacy ADO presets are always ADO mode
                        }).ToList();
                    }

                    // Migrate Mode based on Org field (for KustoPreset format)
                    foreach (var preset in allPresets)
                    {
                        // Only auto-detect if Mode is not already set to ADO
                        if (preset.Mode != PresetMode.ADO)
                        {
                            var org = preset.Clusters?.FirstOrDefault()?.Org;
                            if (!string.IsNullOrEmpty(org))
                            {
                                if (org.Equals("ADO", StringComparison.OrdinalIgnoreCase))
                                {
                                    preset.Mode = PresetMode.ADO;
                                }
                                else if (org.Equals("Kusto", StringComparison.OrdinalIgnoreCase))
                                {
                                    preset.Mode = PresetMode.Kusto;
                                }
                            }
                            else
                            {
                                // Fallback: detect from cluster URL
                                var cluster = preset.Clusters?.FirstOrDefault()?.Cluster ?? "";
                                if (cluster.Contains("dev.azure.com") || cluster.Contains("visualstudio.com"))
                                {
                                    preset.Mode = PresetMode.ADO;
                                }
                                else
                                {
                                    preset.Mode = PresetMode.Kusto;
                                }
                            }
                        }
                    }

                    var presets = allPresets
                        .Where(p => !p.AutoSaved && !string.IsNullOrEmpty(p.PresetName))
                        .OrderBy(p => p.PresetName)
                        .ToList();

                    var lastQueries = allPresets
                        .Where(p => p.AutoSaved)
                        .OrderByDescending(p => p.Time)
                        .Take(LastQueriesSize)
                        .ToList();

                    presets.AddRange(lastQueries);
                    return presets;
                }
            }
            catch (Exception)
            {
                return new List<KustoPreset>();
            }
        }

        /// <summary>
        /// Legacy preset format used by MyAdo application
        /// </summary>
        [XmlType("Preset")]
        public class LegacyPreset
        {
            public string PresetName { get; set; }
            public string Query { get; set; }
            public bool AutoSaved { get; set; }
            public DateTime Time { get; set; }
        }

        public void SavePresets(List<KustoPreset> presets)
        {
            var jsonFile = Path.ChangeExtension(_presetFile, ".json");
            
            var options = new JsonSerializerOptions
            {
                WriteIndented = true,
                Converters = { new JsonStringEnumConverter() }
            };
            
            var json = JsonSerializer.Serialize(presets, options);
            File.WriteAllText(jsonFile, json);
        }
    }
}