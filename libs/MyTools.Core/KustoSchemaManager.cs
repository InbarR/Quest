using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Newtonsoft.Json;

namespace MyTools.Core
{
    /// <summary>
    /// Represents one table schema entry (static / preloaded).
    /// </summary>
    public class KustoTableSchema
    {
        public string Name { get; set; }
        public List<string> Columns { get; set; } = new List<string>();
    }

    /// <summary>
    /// Cached schema for a specific cluster/database combination with timestamp.
    /// </summary>
    public class DatabaseSchemaCache
    {
        public string ClusterUrl { get; set; }
        public string Database { get; set; }
        public List<KustoTableSchema> Tables { get; set; } = new List<KustoTableSchema>();
        public DateTime LastFetched { get; set; }

        /// <summary>
        /// Creates a unique cache key for this cluster/database combination.
        /// </summary>
        public string CacheKey => $"{ClusterUrl?.ToLowerInvariant()}|{Database?.ToLowerInvariant()}";
    }

    /// <summary>
    /// Root configuration object for static schemas.
    /// JSON format example:
    /// {
    ///   "tables": [
    ///     { "name": "DeviceEvents", "columns": ["DeviceId","EventTime","ReportTimeUtc"] },
    ///     { "name": "DeviceInfo", "columns": ["DeviceId","OSPlatform","MachineName"] }
    ///   ],
    ///   "keywords": ["let", "where", "project", ...],
    ///   "functions": ["ago", "bin", "strlen", ...],
    ///   "aggregationFunctions": ["sum", "count", "avg", ...],
    ///   "databaseSchemas": { "cluster|db": { ... }, ... }
    /// }
    /// </summary>
    public class KustoSchemaConfig
    {
        public List<KustoTableSchema> Tables { get; set; } = new List<KustoTableSchema>();
        public List<string> Keywords { get; set; } = new List<string>();
        public List<string> Functions { get; set; } = new List<string>();
        public List<string> AggregationFunctions { get; set; } = new List<string>();

        /// <summary>
        /// Per-database schema cache, keyed by "cluster|database".
        /// </summary>
        public Dictionary<string, DatabaseSchemaCache> DatabaseSchemas { get; set; } = new Dictionary<string, DatabaseSchemaCache>();

        /// <summary>
        /// Cache validity duration in hours. Default is 24 hours.
        /// </summary>
        public int CacheValidityHours { get; set; } = 24;
    }

    /// <summary>
    /// Manages loading and accessing static table schemas for autocomplete.
    /// </summary>
    public class KustoSchemaManager
    {
        private readonly string _schemaFile;
        private KustoSchemaConfig _config = new KustoSchemaConfig();

        public KustoSchemaManager(string schemaFile)
        {
            _schemaFile = schemaFile;
        }

        /// <summary>
        /// Load schema file or create a default skeleton if missing.
        /// </summary>
        public void Load()
        {
            try
            {
                if (!File.Exists(_schemaFile))
                {
                    CreateDefaultFile();
                }

                var json = File.ReadAllText(_schemaFile);
                if (string.IsNullOrWhiteSpace(json))
                {
                    _config = new KustoSchemaConfig();
                    EnsureKeywordsLoaded();
                    return;
                }

                _config = JsonConvert.DeserializeObject<KustoSchemaConfig>(json) ?? new KustoSchemaConfig();
                EnsureKeywordsLoaded();
            }
            catch (Exception)
            {
                // On failure fall back to empty config.
                _config = new KustoSchemaConfig();
                EnsureKeywordsLoaded();
            }
        }
        public KustoSchemaConfig GetConfig()
        {
            return _config;
        }

        /// <summary>
        /// Ensures that keywords, functions, and aggregation functions are loaded from KustoKeywords class
        /// if they're not already in the config.
        /// </summary>
        private void EnsureKeywordsLoaded()
        {
            if (_config.Keywords == null || _config.Keywords.Count == 0)
            {
                _config.Keywords = new List<string>(KustoKeywords.Keywords);
            }

            if (_config.Functions == null || _config.Functions.Count == 0)
            {
                _config.Functions = new List<string>(KustoKeywords.Functions);
            }

            if (_config.AggregationFunctions == null || _config.AggregationFunctions.Count == 0)
            {
                _config.AggregationFunctions = new List<string>(KustoKeywords.AggregationFunctions);
            }
        }
     
        /// <summary>
        /// Returns all distinct columns across all tables.
        /// </summary>
        public IEnumerable<string> GetAllColumns()
        {
            return _config.Tables
                .SelectMany(t => t.Columns ?? Enumerable.Empty<string>())
                .Where(c => !string.IsNullOrWhiteSpace(c))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .OrderBy(c => c, StringComparer.OrdinalIgnoreCase);
        }

        /// <summary>
        /// Returns columns for a specific table (case-insensitive), or empty if not found.
        /// </summary>
        public IEnumerable<string> GetColumnsForTable(string table)
        {
            if (string.IsNullOrWhiteSpace(table))
                return Enumerable.Empty<string>();

            var match = _config.Tables.FirstOrDefault(t => string.Equals(t.Name, table, StringComparison.OrdinalIgnoreCase));
            return match?.Columns ?? Enumerable.Empty<string>();
        }

        /// <summary>
        /// Adds tables to the schema (for dynamic schema loading from database).
        /// Tables are merged - existing tables are updated, new ones are added.
        /// </summary>
        public void AddTables(IEnumerable<string> tableNames)
        {
            foreach (var tableName in tableNames)
            {
                if (string.IsNullOrWhiteSpace(tableName)) continue;

                var existing = _config.Tables.FirstOrDefault(t =>
                    string.Equals(t.Name, tableName, StringComparison.OrdinalIgnoreCase));

                if (existing == null)
                {
                    _config.Tables.Add(new KustoTableSchema { Name = tableName, Columns = new List<string>() });
                }
            }

            Save();
        }

        /// <summary>
        /// Adds a table with columns to the schema.
        /// </summary>
        public void AddTableWithColumns(string tableName, IEnumerable<string> columns)
        {
            if (string.IsNullOrWhiteSpace(tableName)) return;

            var existing = _config.Tables.FirstOrDefault(t =>
                string.Equals(t.Name, tableName, StringComparison.OrdinalIgnoreCase));

            if (existing != null)
            {
                existing.Columns = columns.ToList();
            }
            else
            {
                _config.Tables.Add(new KustoTableSchema { Name = tableName, Columns = columns.ToList() });
            }

            Save();
        }

        /// <summary>
        /// Saves the current schema to file.
        /// </summary>
        public void Save()
        {
            try
            {
                var json = JsonConvert.SerializeObject(_config, Formatting.Indented);
                File.WriteAllText(_schemaFile, json);
            }
            catch (Exception)
            {
                // Ignore save errors
            }
        }

        private void CreateDefaultFile()
        {
            var skeleton = new KustoSchemaConfig
            {
                Tables = new List<KustoTableSchema>
                {
                    new KustoTableSchema
                    {
                        Name = "DeviceEvents",
                        Columns = new List<string>
                        {
                            "DeviceId","EventTime","ReportTimeUtc","ActionType","FileName","FolderPath","ProcessId","ParentProcessName"
                        }
                    },
                    new KustoTableSchema
                    {
                        Name = "DeviceInfo",
                        Columns = new List<string>
                        {
                            "DeviceId","MachineName","OSPlatform","OSVersion","AADDeviceId","OnboardingStatus","ProcessorArchitecture"
                        }
                    }
                }
            };

            var json = JsonConvert.SerializeObject(skeleton, Formatting.Indented);
            File.WriteAllText(_schemaFile, json);
        }

        #region Per-Database Schema Cache

        /// <summary>
        /// Creates a cache key for a cluster/database combination.
        /// </summary>
        private static string GetCacheKey(string clusterUrl, string database)
        {
            return $"{clusterUrl?.ToLowerInvariant()}|{database?.ToLowerInvariant()}";
        }

        /// <summary>
        /// Checks if cached schema exists and is still valid for the given cluster/database.
        /// </summary>
        public bool HasValidCache(string clusterUrl, string database)
        {
            var key = GetCacheKey(clusterUrl, database);
            if (!_config.DatabaseSchemas.TryGetValue(key, out var cache))
                return false;

            var validityHours = _config.CacheValidityHours > 0 ? _config.CacheValidityHours : 24;
            return (DateTime.UtcNow - cache.LastFetched).TotalHours < validityHours;
        }

        /// <summary>
        /// Gets the cached schema for a specific cluster/database, or null if not cached.
        /// </summary>
        public DatabaseSchemaCache GetCachedSchema(string clusterUrl, string database)
        {
            var key = GetCacheKey(clusterUrl, database);
            _config.DatabaseSchemas.TryGetValue(key, out var cache);
            return cache;
        }

        /// <summary>
        /// Sets/updates the cached schema for a specific cluster/database.
        /// </summary>
        public void SetCachedSchema(string clusterUrl, string database, List<KustoTableSchema> tables)
        {
            var key = GetCacheKey(clusterUrl, database);
            var cache = new DatabaseSchemaCache
            {
                ClusterUrl = clusterUrl,
                Database = database,
                Tables = tables ?? new List<KustoTableSchema>(),
                LastFetched = DateTime.UtcNow
            };

            _config.DatabaseSchemas[key] = cache;
            Save();
        }

        /// <summary>
        /// Clears the cached schema for a specific cluster/database.
        /// </summary>
        public void ClearCache(string clusterUrl, string database)
        {
            var key = GetCacheKey(clusterUrl, database);
            if (_config.DatabaseSchemas.Remove(key))
            {
                Save();
            }
        }

        /// <summary>
        /// Clears all cached schemas.
        /// </summary>
        public void ClearAllCache()
        {
            _config.DatabaseSchemas.Clear();
            Save();
        }

        /// <summary>
        /// Gets cache statistics.
        /// </summary>
        public (int totalCached, int validCached, DateTime? oldestCache) GetCacheStats()
        {
            var total = _config.DatabaseSchemas.Count;
            var validityHours = _config.CacheValidityHours > 0 ? _config.CacheValidityHours : 24;
            var valid = _config.DatabaseSchemas.Values
                .Count(c => (DateTime.UtcNow - c.LastFetched).TotalHours < validityHours);
            var oldest = _config.DatabaseSchemas.Values
                .OrderBy(c => c.LastFetched)
                .FirstOrDefault()?.LastFetched;

            return (total, valid, oldest);
        }

        /// <summary>
        /// Sets the active database context - loads cached schema into the main Tables collection.
        /// </summary>
        public void SetActiveDatabase(string clusterUrl, string database)
        {
            var cache = GetCachedSchema(clusterUrl, database);
            if (cache != null)
            {
                _config.Tables = new List<KustoTableSchema>(cache.Tables);
            }
            else
            {
                // Clear tables if no cache exists for this database
                _config.Tables.Clear();
            }
        }

        #endregion
    }
}
