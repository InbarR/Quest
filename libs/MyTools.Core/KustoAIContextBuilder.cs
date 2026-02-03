using Kusto.Cloud.Platform.Utils;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;

namespace MyTools.Core
{
    /// <summary>
    /// Builds and manages AI context for Kusto query generation.
    /// Combines schema information, past queries, cluster context, and result samples.
    /// </summary>
    public class KustoAIContextBuilder
    {
        private readonly KustoSchemaManager _schemaManager;
        private List<KustoPreset> _presets;
        private KustoCluster[] _selectedClusters;
        private Dictionary<string, List<string>> _liveSchemaCache;
        private DateTime _schemaCacheTime;
        private const int SchemaCacheMinutes = 30;
        private KustoResult _lastQueryResult;
        private string _currentCluster;
        private string _currentDatabase;
        private string _currentQuery;

        public KustoAIContextBuilder(KustoSchemaManager schemaManager)
        {
            _schemaManager = schemaManager ?? throw new ArgumentNullException(nameof(schemaManager));
            _liveSchemaCache = new Dictionary<string, List<string>>();
            _schemaCacheTime = DateTime.MinValue;
        }

        /// <summary>
        /// Updates the last query result for context building.
        /// </summary>
        public void UpdateLastQueryResult(KustoResult result)
        {
            _lastQueryResult = result;
        }

        /// <summary>
        /// Updates the current context (cluster, database, query).
        /// </summary>
        public void SetContext(string cluster, string database, string query)
        {
            _currentCluster = cluster;
            _currentDatabase = database;
            _currentQuery = query;
        }

        /// <summary>
        /// Updates the preset context for query pattern learning.
        /// </summary>
        public void UpdatePresets(List<KustoPreset> presets)
        {
            _presets = presets ?? new List<KustoPreset>();
        }

        /// <summary>
        /// Builds context from favorite queries to help AI understand common patterns.
        /// </summary>
        private string BuildFavoriteQueriesContext()
        {
            if (_presets == null || _presets.Count == 0)
            {
                return string.Empty;
            }

            var favorites = _presets
                .Where(p => !p.AutoSaved && !string.IsNullOrWhiteSpace(p.Query))
                .OrderBy(p => p.PresetName)
                .Take(10) // Limit to top 10 favorites to avoid token overflow
                .ToList();

            if (!favorites.Any())
            {
                return string.Empty;
            }

            var sb = new StringBuilder();
            sb.AppendLine();
            sb.AppendLine("## FAVORITE QUERIES");
            sb.AppendLine("User's favorite saved queries for reference and pattern learning:");
            sb.AppendLine();

            foreach (var fav in favorites)
            {
                sb.AppendLine($"### {fav.PresetName}");
                
                // Add cluster/database context if available
                if (fav.Clusters != null && fav.Clusters.Length > 0)
                {
                    var clusterInfo = fav.Clusters[0];
                    var clusterName = FormatClusterDisplayName(clusterInfo.Cluster);
                    sb.AppendLine($"*Context: cluster('{clusterName}').database('{clusterInfo.DB}')*");
                }
                
                sb.AppendLine("```kql");
                
                // Build full query with cluster/database prefix if available
                var fullQuery = BuildFullQueryWithPrefix(fav);
                
                // Truncate very long queries to prevent token overflow
                var query = fullQuery.Length > 500 ? fullQuery.Substring(0, 500) + "\n... (truncated)" : fullQuery;
                sb.AppendLine(query);
                sb.AppendLine("```");
                sb.AppendLine();
            }

            return sb.ToString();
        }

        /// <summary>
        /// Builds context from recent query history to help AI understand user patterns.
        /// </summary>
        private string BuildRecentHistoryContext()
        {
            if (_presets == null || _presets.Count == 0)
            {
                return string.Empty;
            }

            var recentQueries = _presets
                .Where(p => p.AutoSaved && !string.IsNullOrWhiteSpace(p.Query))
                .OrderByDescending(p => p.Time)
                .Take(5) // Limit to last 5 queries to avoid token overflow
                .ToList();

            if (!recentQueries.Any())
            {
                return string.Empty;
            }

            var sb = new StringBuilder();
            sb.AppendLine();
            sb.AppendLine("## RECENT QUERY HISTORY");
            sb.AppendLine("User's recent queries for context and pattern understanding:");
            sb.AppendLine();

            foreach (var query in recentQueries)
            {
                var timeAgo = DateTime.Now - query.Time;
                var timeDesc = timeAgo.TotalHours < 1 
                    ? $"{(int)timeAgo.TotalMinutes} minutes ago"
                    : timeAgo.TotalDays < 1 
                        ? $"{(int)timeAgo.TotalHours} hours ago"
                        : $"{(int)timeAgo.TotalDays} days ago";

                sb.AppendLine($"### Query from {timeDesc}");
                
                // Add cluster/database context if available
                if (query.Clusters != null && query.Clusters.Length > 0)
                {
                    var clusterInfo = query.Clusters[0];
                    var clusterName = FormatClusterDisplayName(clusterInfo.Cluster);
                    sb.AppendLine($"*Context: cluster('{clusterName}').database('{clusterInfo.DB}')*");
                }
                
                sb.AppendLine("```kql");
                
                // Build full query with cluster/database prefix if available
                var fullQuery = BuildFullQueryWithPrefix(query);
                
                // Truncate very long queries to prevent token overflow
                var queryText = fullQuery.Length > 300 ? fullQuery.Substring(0, 300) + "\n... (truncated)" : fullQuery;
                sb.AppendLine(queryText);
                sb.AppendLine("```");
                sb.AppendLine();
            }

            return sb.ToString();
        }

        /// <summary>
        /// Updates the selected clusters context.
        /// </summary>
        public void UpdateSelectedClusters(KustoCluster[] clusters)
        {
            _selectedClusters = clusters ?? new KustoCluster[0];
        }

        /// <summary>
        /// Builds the complete system prompt for Kusto query generation.
        /// </summary>
        public string BuildSystemPrompt()
        {
            var sb = new StringBuilder();

            sb.AppendLine("You are a Kusto Query Language (KQL) expert assistant specialized in Azure Data Explorer queries and data analysis.");
            sb.AppendLine();
            sb.AppendLine("## YOUR ROLE");
            sb.AppendLine("You help with Kusto Query Language (KQL) generation and also general chat.");
            sb.AppendLine();
            sb.AppendLine("## INSTRUCTIONS");
            sb.AppendLine("1. If the user is asking for a KQL query (or query changes), generate a precise, efficient, and correct KQL query.");
            sb.AppendLine("   - Always provide complete, runnable queries with proper syntax.");
            sb.AppendLine("   - Wrap the KQL in triple backticks (```), with no extra text.");
            sb.AppendLine("2. If the user is NOT asking for KQL (e.g. greetings like \"hi\", small talk, clarifying questions), respond normally in plain text.");
            sb.AppendLine("   - Do NOT output KQL or code blocks unless explicitly requested.");
            sb.AppendLine("3. If a 'USER KQL' block is provided, treat it as the current query and modify it based on the request.");
            sb.AppendLine("4. Use schema/favorites/history as hints only when generating or modifying KQL.");
            sb.AppendLine();
            sb.AppendLine("## OUTPUT RULE");
            sb.AppendLine("- For KQL requests: output ONLY the final KQL query wrapped in triple backticks (```), with no surrounding prose.");
            sb.AppendLine("- For non-KQL requests: output plain text, no code fences.");
            sb.AppendLine();
            sb.AppendLine("## QUERY BEST PRACTICES");
            sb.AppendLine("1. Always include time filters (e.g., where Timestamp > ago(7d))");
            sb.AppendLine("2. Use 'project' to limit columns for better performance");
            sb.AppendLine("3. Use 'summarize' for aggregations with appropriate bin() for time series");

            return sb.ToString();
        }

        public string BuildUserQueryContext(string userQuery)
        {
            if (string.IsNullOrWhiteSpace(userQuery))
            {
                return string.Empty;
            }

            var sb = new StringBuilder();
            sb.AppendLine("## USER KQL");
            sb.AppendLine("```kql");
            sb.AppendLine(userQuery);
            sb.AppendLine("```");
            return sb.ToString();
        }

        public string BuildNaturalLanguageContext(string request)
        {
            if (string.IsNullOrWhiteSpace(request)) return string.Empty;
            
            var sb = new StringBuilder();
            sb.AppendLine("## USER REQUEST");
            sb.AppendLine(request);
            
            // Add favorite queries context
            var favoritesContext = BuildFavoriteQueriesContext();
            if (!string.IsNullOrEmpty(favoritesContext))
            {
                sb.Append(favoritesContext);
            }
            
            // Add recent history context
            var historyContext = BuildRecentHistoryContext();
            if (!string.IsNullOrEmpty(historyContext))
            {
                sb.Append(historyContext);
            }
            
            // Add current context (cluster, db, query)
            var currentContext = BuildCurrentContext();
            if (!string.IsNullOrEmpty(currentContext))
            {
                sb.Append(currentContext);
            }

            // Add result context if available
            if (_lastQueryResult != null)
            {
                sb.AppendLine();
                sb.AppendLine("## CURRENT RESULT CONTEXT");
                sb.Append(BuildResultContext(_lastQueryResult));
            }
            
            return sb.ToString();
        }

        private string BuildCurrentContext()
        {
            if (string.IsNullOrEmpty(_currentCluster) && string.IsNullOrEmpty(_currentDatabase) && string.IsNullOrEmpty(_currentQuery))
            {
                return string.Empty;
            }

            var sb = new StringBuilder();
            sb.AppendLine();
            sb.AppendLine("## CURRENT CONTEXT");
            
            if (!string.IsNullOrEmpty(_currentCluster))
            {
                sb.AppendLine($"Cluster: {_currentCluster}");
            }
            
            if (!string.IsNullOrEmpty(_currentDatabase))
            {
                sb.AppendLine($"Database: {_currentDatabase}");
            }
            
            if (!string.IsNullOrEmpty(_currentQuery))
            {
                sb.AppendLine("Current Query in Editor:");
                sb.AppendLine("```kql");
                sb.AppendLine(_currentQuery);
                sb.AppendLine("```");
            }
            
            return sb.ToString();
        }

        /// <summary>
        /// Builds context from the last query result including schema and sample data.
        /// </summary>
        private string BuildResultContext(KustoResult result)
        {
            var sb = new StringBuilder();
            const int maxColumns = 20; // Limit columns to prevent token overflow
            const int maxCellLength = 50; // Max characters per cell
            const int maxSampleRows = 3; // Max sample rows
            const int maxValueExampleLength = 30; // Max length for example values
            const int maxTotalContextLength = 4000; // Max total characters for result context
            
            // Add table schema
            if (result.Columns != null && result.Columns.Length > 0)
            {
                var columnsToShow = Math.Min(maxColumns, result.Columns.Length);
                var columnList = string.Join(", ", result.Columns.Take(columnsToShow));
                
                sb.AppendLine("### Table Schema");
                sb.AppendLine($"Available columns ({columnsToShow} of {result.Columns.Length}):");
                sb.AppendLine(columnList);
                if (result.Columns.Length > maxColumns)
                {
                    sb.AppendLine($"... and {result.Columns.Length - maxColumns} more columns");
                }
                sb.AppendLine();
            }
            
            // Add sample data (first few rows)
            if (result.Rows != null && result.Rows.Count > 0 && result.Columns != null)
            {
                var sampleSize = Math.Min(maxSampleRows, result.Rows.Count);
                var columnsToShow = Math.Min(maxColumns, result.Columns.Length);
                
                sb.AppendLine($"### Sample Data ({sampleSize} of {result.Rows.Count} rows, {columnsToShow} of {result.Columns.Length} columns)");
                
                // Create a formatted table with limited columns
                var columnWidths = result.Columns.Take(columnsToShow).Select(c => Math.Min(c.Length, maxCellLength)).ToArray();
                
                // Calculate max widths based on sample data
                for (int i = 0; i < sampleSize && i < result.Rows.Count; i++)
                {
                    var row = result.Rows[i];
                    for (int j = 0; j < Math.Min(row.Length, columnWidths.Length); j++)
                    {
                        var cellValue = row[j]?.ToString() ?? "";
                        var displayValue = cellValue.Length > maxCellLength ? cellValue.Substring(0, maxCellLength - 3) + "..." : cellValue;
                        columnWidths[j] = Math.Max(columnWidths[j], Math.Min(displayValue.Length, maxCellLength));
                    }
                }
                
                // Build header row
                sb.Append("| ");
                for (int i = 0; i < columnsToShow; i++)
                {
                    var columnName = result.Columns[i];
                    var truncatedName = columnName.Length > maxCellLength ? columnName.Substring(0, maxCellLength - 3) + "..." : columnName;
                    sb.Append(truncatedName.PadRight(columnWidths[i]));
                    sb.Append(" | ");
                }
                sb.AppendLine();
                
                // Build separator row
                sb.Append("|");
                for (int i = 0; i < columnsToShow; i++)
                {
                    sb.Append(new string('-', columnWidths[i] + 2));
                    sb.Append("|");
                }
                sb.AppendLine();
                
                // Build data rows
                for (int i = 0; i < sampleSize && i < result.Rows.Count; i++)
                {
                    var row = result.Rows[i];
                    sb.Append("| ");
                    for (int j = 0; j < columnsToShow; j++)
                    {
                        var cellValue = j < row.Length ? (row[j]?.ToString() ?? "") : "";
                        var displayValue = cellValue.Length > maxCellLength ? cellValue.Substring(0, maxCellLength - 3) + "..." : cellValue;
                        sb.Append(displayValue.PadRight(columnWidths[j]));
                        sb.Append(" | ");
                    }
                    sb.AppendLine();
                }
                sb.AppendLine();
                
                // Add data type hints
                sb.AppendLine($"### Column Value Examples ({columnsToShow} of {result.Columns.Length} columns)");
                for (int colIdx = 0; colIdx < columnsToShow; colIdx++)
                {
                    var distinctValues = result.Rows
                        .Take(10)
                        .Where(r => colIdx < r.Length && r[colIdx] != null)
                        .Select(r => r[colIdx]?.ToString() ?? "")
                        .Where(v => !string.IsNullOrWhiteSpace(v))
                        .Distinct()
                        .Take(3) // Reduced from 5 to 3
                        .ToList();
                    
                    if (distinctValues.Any())
                    {
                        var examples = string.Join(", ", distinctValues.Select(v => 
                        {
                            var truncated = v.Length > maxValueExampleLength ? v.Substring(0, maxValueExampleLength - 3) + "..." : v;
                            return $"\"{truncated}\"";
                        }));
                        sb.AppendLine($"- {result.Columns[colIdx]}: {examples}");
                    }
                    
                    // Check if we're approaching the limit
                    if (sb.Length > maxTotalContextLength)
                    {
                        sb.AppendLine($"... (truncated to prevent token overflow)");
                        break;
                    }
                }
            }
            
            // Final safety check - truncate if still too long
            var resultContext = sb.ToString();
            if (resultContext.Length > maxTotalContextLength)
            {
                resultContext = resultContext.Substring(0, maxTotalContextLength - 50) + "\n... (context truncated due to size)";
            }
            
            return resultContext;
        }

        /// <summary>
        /// Returns the last query result context including schema and sample data.
        /// </summary>
        public string GetResultContext()
        {
            if (_lastQueryResult == null)
            {
                return string.Empty;
            }

            return BuildResultContext(_lastQueryResult);
        }

        /// <summary>
        /// Returns schema information sourced from the schema manager.
        /// </summary>
        public string GetSchemaContext()
        {
            return BuildSchemaContext();
        }

        /// <summary>
        /// Builds schema information from the schema manager.
        /// </summary>
        private string BuildSchemaContext()
        {
            var sb = new StringBuilder();

            // Load static schemas
            _schemaManager.Load();
            var allColumns = _schemaManager.GetAllColumns().ToList();

            if (allColumns.Any())
            {
                sb.AppendLine("Common table columns available:");
                
                // Group columns by likely table association
                var commonSecurityColumns = new[] { "DeviceId", "DeviceName", "Timestamp", "ActionType", "FileName", "FolderPath", 
                    "ProcessCommandLine", "AccountName", "AccountDomain", "InitiatingProcessFileName", "SHA256", "MD5" };
                var securityCols = allColumns.Where(c => commonSecurityColumns.Contains(c, StringComparer.OrdinalIgnoreCase)).ToList();
                
                if (securityCols.Any())
                {
                    sb.AppendLine($"- Security/Device: {string.Join(", ", securityCols)}");
                }

                var otherCols = allColumns.Except(securityCols, StringComparer.OrdinalIgnoreCase).Take(30).ToList();
                if (otherCols.Any())
                {
                    sb.AppendLine($"- Other: {string.Join(", ", otherCols)}");
                }
            }
            else
            {
                sb.AppendLine("No static schemas loaded. Schema will be fetched dynamically from the connected cluster.");
            }

            return sb.ToString();
        }

        /// <summary>
        /// Builds cluster context information.
        /// </summary>
        private string BuildClusterContext()
        {
            if (_selectedClusters == null || _selectedClusters.Length == 0)
            {
                return "No clusters currently selected.";
            }

            var sb = new StringBuilder();
            foreach (var cluster in _selectedClusters.Take(5))
            {
                sb.AppendLine($"- Cluster: {cluster.Cluster}, DB: {cluster.DB}");
            }

            if (_selectedClusters.Length > 5)
            {
                sb.AppendLine($"... and {_selectedClusters.Length - 5} more clusters");
            }

            return sb.ToString();
        }

        /// <summary>
        /// Checks if schema cache needs refresh.
        /// </summary>
        public bool SchemaCacheNeedsRefresh()
        {
            return (DateTime.Now - _schemaCacheTime).TotalMinutes > SchemaCacheMinutes;
        }

        /// <summary>
        /// Updates live schema cache from MCP server results.
        /// </summary>
        public void UpdateLiveSchemaCache(string database, List<string> tables)
        {
            _liveSchemaCache[database] = tables ?? new List<string>();
            _schemaCacheTime = DateTime.Now;
        }

        /// <summary>
        /// Gets cached schema information.
        /// </summary>
        public Dictionary<string, List<string>> GetLiveSchemaCache()
        {
            return _liveSchemaCache;
        }

        /// <summary>
        /// Formats a cluster URL to display name by removing protocol and suffix.
        /// </summary>
        private string FormatClusterDisplayName(string clusterUrl)
        {
            if (string.IsNullOrEmpty(clusterUrl)) return clusterUrl;

            var name = clusterUrl;

            if (name.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
                name = name.Substring(8);
            else if (name.StartsWith("http://", StringComparison.OrdinalIgnoreCase))
                name = name.Substring(7);

            if (name.EndsWith(".kusto.windows.net", StringComparison.OrdinalIgnoreCase))
                name = name.Substring(0, name.Length - 18);

            return name;
        }

        /// <summary>
        /// Builds a full query with cluster/database prefix if available.
        /// </summary>
        private string BuildFullQueryWithPrefix(KustoPreset preset)
        {
            if (preset.Clusters == null || preset.Clusters.Length == 0)
            {
                return preset.Query;
            }

            var clusterInfo = preset.Clusters[0];
            var clusterName = FormatClusterDisplayName(clusterInfo.Cluster);
            
            // Check if query already starts with cluster() or database()
            var trimmedQuery = preset.Query.TrimStart();
            if (trimmedQuery.StartsWith("cluster(", StringComparison.OrdinalIgnoreCase) ||
                trimmedQuery.StartsWith("database(", StringComparison.OrdinalIgnoreCase))
            {
                return preset.Query;
            }

            // Add cluster/database prefix
            return $"cluster('{clusterName}').database('{clusterInfo.DB}').\n{preset.Query}";
        }
    }
}
