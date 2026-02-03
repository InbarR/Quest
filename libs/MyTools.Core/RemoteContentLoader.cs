using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading.Tasks;

namespace MyTools.Core
{
    /// <summary>
    /// Service for loading content from remote paths (ADO Wiki, HTTP URLs, etc.)
    /// </summary>
    public class RemoteContentLoader
    {
        private readonly HttpClient _httpClient;
        private readonly string _cacheDirectory;

        public RemoteContentLoader(string cacheDirectory)
        {
            _httpClient = new HttpClient();
            _httpClient.DefaultRequestHeaders.Add("User-Agent", "MyKusto-Avalonia/1.0");
            _cacheDirectory = cacheDirectory;
            Directory.CreateDirectory(_cacheDirectory);
        }

        /// <summary>
        /// Load clusters/connections from a remote path
        /// </summary>
        public async Task<KustoCluster[]> LoadClustersFromRemoteAsync(string remotePath, int cacheMinutes = 30)
        {
            try
            {
                var cacheFile = Path.Combine(_cacheDirectory, "remote_clusters_cache.csv");
                
                // Check cache
                if (cacheMinutes > 0 && File.Exists(cacheFile))
                {
                    var cacheAge = DateTime.Now - File.GetLastWriteTime(cacheFile);
                    if (cacheAge.TotalMinutes < cacheMinutes)
                    {
                        return ParseClustersFromCsv(await File.ReadAllTextAsync(cacheFile));
                    }
                }

                // Fetch from remote
                var content = await FetchContentAsync(remotePath);
                if (string.IsNullOrEmpty(content))
                {
                    return Array.Empty<KustoCluster>();
                }

                // Save to cache
                await File.WriteAllTextAsync(cacheFile, content);

                return ParseClustersFromCsv(content);
            }
            catch (Exception ex)
            {
                throw new InvalidOperationException($"Failed to load clusters from remote: {ex.Message}", ex);
            }
        }

        /// <summary>
        /// Load queries/presets from a remote path
        /// </summary>
        public async Task<List<KustoPreset>> LoadQueriesFromRemoteAsync(string remotePath, int cacheMinutes = 30)
        {
            try
            {
                var cacheFile = Path.Combine(_cacheDirectory, "remote_queries_cache.json");
                
                // Check cache
                if (cacheMinutes > 0 && File.Exists(cacheFile))
                {
                    var cacheAge = DateTime.Now - File.GetLastWriteTime(cacheFile);
                    if (cacheAge.TotalMinutes < cacheMinutes)
                    {
                        var cachedContent = await File.ReadAllTextAsync(cacheFile);
                        return JsonSerializer.Deserialize<List<KustoPreset>>(cachedContent) ?? new List<KustoPreset>();
                    }
                }

                // Fetch from remote
                var content = await FetchContentAsync(remotePath);
                if (string.IsNullOrEmpty(content))
                {
                    return new List<KustoPreset>();
                }

                // Parse queries from content (supports Markdown format from ADO Wiki)
                var queries = ParseQueriesFromMarkdown(content);

                // Save to cache
                var jsonContent = JsonSerializer.Serialize(queries, new JsonSerializerOptions { WriteIndented = true });
                await File.WriteAllTextAsync(cacheFile, jsonContent);

                return queries;
            }
            catch (Exception ex)
            {
                throw new InvalidOperationException($"Failed to load queries from remote: {ex.Message}", ex);
            }
        }

        /// <summary>
        /// Fetch content from a remote URL (supports ADO Wiki, GitHub, raw URLs)
        /// </summary>
        private async Task<string> FetchContentAsync(string remotePath)
        {
            if (string.IsNullOrEmpty(remotePath))
            {
                return string.Empty;
            }

            // Handle ADO Wiki URLs - convert to raw content URL
            if (remotePath.Contains("dev.azure.com") && remotePath.Contains("_wiki"))
            {
                remotePath = ConvertAdoWikiToRawUrl(remotePath);
            }

            var response = await _httpClient.GetAsync(remotePath);
            response.EnsureSuccessStatusCode();
            return await response.Content.ReadAsStringAsync();
        }

        /// <summary>
        /// Convert ADO Wiki URL to raw content URL
        /// Example: https://dev.azure.com/org/project/_wiki/wikis/wiki/123/Page
        /// To: https://dev.azure.com/org/project/_apis/wiki/wikis/wiki/pages/123?includeContent=true
        /// </summary>
        private string ConvertAdoWikiToRawUrl(string wikiUrl)
        {
            try
            {
                // For now, return as-is and let the user provide the raw URL
                // In production, this would use ADO REST API with authentication
                return wikiUrl;
            }
            catch
            {
                return wikiUrl;
            }
        }

        /// <summary>
        /// Parse clusters from CSV format
        /// Format: cluster,database,org or *cluster,database,org (favorite)
        /// </summary>
        private KustoCluster[] ParseClustersFromCsv(string content)
        {
            const string FavPrefix = "*";
            const string IgnorePrefix = "#";

            var lines = content.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
            
            return lines
                .Select(l => l.Split(','))
                .Where(s => s.Length >= 2)
                .Select(s => new KustoCluster
                {
                    Cluster = (s[0].StartsWith(IgnorePrefix) || s[0].StartsWith(FavPrefix) ? s[0].Substring(1) : s[0]).Trim(),
                    DB = s[1].Trim(),
                    Org = s.Length >= 3 ? s[2].Trim() : "",
                    ShowInUi = !s[0].StartsWith(IgnorePrefix),
                    Favorite = s[0].StartsWith(FavPrefix)
                })
                .Distinct()
                .ToArray();
        }

        /// <summary>
        /// Parse queries from Markdown content (ADO Wiki format)
        /// Supports code blocks with ```kql or ```kusto
        /// </summary>
        private List<KustoPreset> ParseQueriesFromMarkdown(string content)
        {
            var queries = new List<KustoPreset>();

            // Pattern to match: ## Query Name followed by ```kql or ```kusto code block
            var pattern = @"##\s*(.+?)\s*\n.*?```(?:kql|kusto)\s*\n([\s\S]*?)```";
            var matches = Regex.Matches(content, pattern, RegexOptions.Multiline);

            foreach (Match match in matches)
            {
                var queryName = match.Groups[1].Value.Trim();
                var queryText = match.Groups[2].Value.Trim();

                if (!string.IsNullOrEmpty(queryName) && !string.IsNullOrEmpty(queryText))
                {
                    queries.Add(new KustoPreset
                    {
                        PresetName = queryName,
                        Query = queryText,
                        AutoSaved = false,
                        Time = DateTime.Now,
                        Clusters = Array.Empty<KustoCluster>()
                    });
                }
            }

            // Also support simple format: just code blocks without headers
            if (queries.Count == 0)
            {
                var codeBlockPattern = @"```(?:kql|kusto)\s*\n([\s\S]*?)```";
                var codeMatches = Regex.Matches(content, codeBlockPattern, RegexOptions.Multiline);

                int index = 1;
                foreach (Match match in codeMatches)
                {
                    var queryText = match.Groups[1].Value.Trim();
                    if (!string.IsNullOrEmpty(queryText))
                    {
                        queries.Add(new KustoPreset
                        {
                            PresetName = $"Remote Query {index}",
                            Query = queryText,
                            AutoSaved = false,
                            Time = DateTime.Now,
                            Clusters = Array.Empty<KustoCluster>()
                        });
                        index++;
                    }
                }
            }

            return queries;
        }

        /// <summary>
        /// Clear cached remote content
        /// </summary>
        public void ClearCache()
        {
            try
            {
                var clusterCache = Path.Combine(_cacheDirectory, "remote_clusters_cache.csv");
                var queryCache = Path.Combine(_cacheDirectory, "remote_queries_cache.json");

                if (File.Exists(clusterCache))
                {
                    File.Delete(clusterCache);
                }

                if (File.Exists(queryCache))
                {
                    File.Delete(queryCache);
                }
            }
            catch
            {
                // Ignore errors when clearing cache
            }
        }
    }
}
