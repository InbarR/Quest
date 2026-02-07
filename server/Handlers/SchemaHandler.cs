using MyTools.Core;
using Quest.Server.Protocol;

namespace Quest.Server.Handlers;

public class SchemaHandler
{
    private readonly KustoSchemaManager _schemaManager;
    private readonly KustoService _kustoService;
    private readonly Action<string>? _log;
    private Kusto.Data.KustoConnectionStringBuilder? _lastKcsb;

    public SchemaHandler(KustoSchemaManager schemaManager, KustoService? kustoService = null, Action<string>? log = null)
    {
        _schemaManager = schemaManager;
        _kustoService = kustoService ?? new KustoService();
        _log = log;
        _schemaManager.Load();
    }

    public async Task<FetchSchemaResult> FetchSchemaAsync(string clusterUrl, string database, CancellationToken ct, bool forceRefresh = false)
    {
        try
        {
            // Check if we have a valid cached schema (unless force refresh)
            if (!forceRefresh && _schemaManager.HasValidCache(clusterUrl, database))
            {
                var cached = _schemaManager.GetCachedSchema(clusterUrl, database);
                if (cached != null)
                {
                    _log?.Invoke($"Using cached schema for {clusterUrl}/{database} (cached {(DateTime.UtcNow - cached.LastFetched).TotalMinutes:F0} minutes ago)");
                    _schemaManager.SetActiveDatabase(clusterUrl, database);
                    return new FetchSchemaResult(true, cached.Tables.Count, null);
                }
            }

            _log?.Invoke($"Fetching schema for {clusterUrl}/{database}" + (forceRefresh ? " (force refresh)" : ""));

            // Format cluster URL
            var clusterUri = clusterUrl;
            if (!clusterUrl.StartsWith("http://", StringComparison.OrdinalIgnoreCase) &&
                !clusterUrl.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
            {
                if (!clusterUrl.Contains(".kusto.windows.net", StringComparison.OrdinalIgnoreCase) &&
                    !clusterUrl.Contains(".kusto.azure.com", StringComparison.OrdinalIgnoreCase))
                {
                    clusterUri = $"https://{clusterUrl}.kusto.windows.net";
                }
                else
                {
                    clusterUri = $"https://{clusterUrl}";
                }
            }

            var kcsb = MyTools.Core.KustoAuthProvider.CreateKcsb(clusterUri, database);
            _lastKcsb = kcsb;

            // Fetch table names only - fast single query
            var query = ".show tables | project TableName";
            var result = await _kustoService.RunQueryAsync(kcsb, query, ct, msg => _log?.Invoke(msg));

            if (result != null && result.Rows.Count > 0)
            {
                var tableNames = result.Rows
                    .Select(row => row[0]?.ToString())
                    .Where(name => !string.IsNullOrWhiteSpace(name))
                    .Cast<string>()
                    .ToList();

                _schemaManager.AddTables(tableNames);
                _log?.Invoke($"Added {tableNames.Count} tables to schema cache");

                // Save to cache
                var config = _schemaManager.GetConfig();
                _schemaManager.SetCachedSchema(clusterUrl, database, config.Tables.ToList());
                _log?.Invoke($"Schema cached for {clusterUrl}/{database}");

                return new FetchSchemaResult(true, tableNames.Count, null);
            }

            return new FetchSchemaResult(true, 0, "No tables found");
        }
        catch (Exception ex)
        {
            _log?.Invoke($"Failed to fetch schema: {ex.Message}");
            return new FetchSchemaResult(false, 0, ex.Message);
        }
    }

    public SchemaInfo GetSchema(string clusterUrl, string database)
    {
        // Try to get cached schema for this specific cluster/database
        var cached = _schemaManager.GetCachedSchema(clusterUrl, database);
        var tablesToUse = cached?.Tables ?? _schemaManager.GetConfig().Tables;

        var tables = tablesToUse
            .Select(t => new TableInfo(
                Name: t.Name,
                Columns: t.Columns.Select(c => new ColumnInfo(c, "string")).ToArray()
            ))
            .ToArray();

        return new SchemaInfo(Tables: tables);
    }

    /// <summary>
    /// Clears the schema cache for a specific cluster/database or all if both are empty.
    /// </summary>
    public void ClearCache(string clusterUrl, string database)
    {
        if (string.IsNullOrWhiteSpace(clusterUrl) && string.IsNullOrWhiteSpace(database))
        {
            _schemaManager.ClearAllCache();
            _log?.Invoke("Cleared all schema cache");
        }
        else
        {
            _schemaManager.ClearCache(clusterUrl, database);
            _log?.Invoke($"Cleared schema cache for {clusterUrl}/{database}");
        }
    }

    /// <summary>
    /// Gets cache statistics.
    /// </summary>
    public (int totalCached, int validCached, DateTime? oldestCache) GetCacheStats()
    {
        return _schemaManager.GetCacheStats();
    }

    public CompletionItem[] GetCompletions(string query, int position, string? clusterUrl = null, string? database = null)
    {
        var items = new List<CompletionItem>();

        List<KustoTableSchema> tablesToUse;
        if (!string.IsNullOrEmpty(clusterUrl) && !string.IsNullOrEmpty(database))
        {
            var cached = _schemaManager.GetCachedSchema(clusterUrl, database);
            tablesToUse = (cached != null && cached.Tables.Count > 0)
                ? cached.Tables
                : _schemaManager.GetConfig().Tables;
        }
        else
        {
            tablesToUse = _schemaManager.GetConfig().Tables;
        }

        var config = _schemaManager.GetConfig();
        var textBeforeCursor = position >= 0 && position <= query.Length
            ? query.Substring(0, position) : query;

        // Detect if we're in a column context (after | where, | project, etc.)
        var tableName = ExtractTableName(textBeforeCursor);
        var inColumnContext = IsColumnContext(textBeforeCursor);

        if (!string.IsNullOrEmpty(tableName) && inColumnContext)
        {
            // Find the table and fetch columns on-demand if needed
            var table = tablesToUse.FirstOrDefault(t =>
                string.Equals(t.Name, tableName, StringComparison.OrdinalIgnoreCase));

            if (table != null && table.Columns.Count == 0 && _lastKcsb != null)
            {
                FetchColumnsForTable(table);
            }

            if (table != null && table.Columns.Count > 0)
            {
                foreach (var col in table.Columns)
                    items.Add(new CompletionItem(Label: col, Kind: "column", Detail: $"{table.Name}"));
            }
        }

        // Always include keywords, functions, tables
        foreach (var keyword in config.Keywords)
            items.Add(new CompletionItem(Label: keyword, Kind: "keyword", Detail: "KQL Keyword"));

        foreach (var func in config.Functions)
            items.Add(new CompletionItem(Label: func, Kind: "function", Detail: "KQL Function", InsertText: $"{func}($1)"));

        foreach (var aggFunc in config.AggregationFunctions)
            items.Add(new CompletionItem(Label: aggFunc, Kind: "function", Detail: "Aggregation Function", InsertText: $"{aggFunc}($1)"));

        foreach (var table in tablesToUse)
            items.Add(new CompletionItem(Label: table.Name, Kind: "table", Detail: "Table"));

        return items.ToArray();
    }

    private void FetchColumnsForTable(KustoTableSchema table)
    {
        try
        {
            _log?.Invoke($"Fetching columns for {table.Name}...");
            var q = $"{table.Name} | getschema | project ColumnName";
            var result = _kustoService.RunQueryAsync(_lastKcsb!, q, CancellationToken.None, _ => { }).Result;
            if (result != null && result.Rows.Count > 0)
            {
                table.Columns = result.Rows
                    .Select(row => row[0]?.ToString())
                    .Where(c => !string.IsNullOrWhiteSpace(c))
                    .Cast<string>()
                    .ToList();
                _log?.Invoke($"{table.Name}: {table.Columns.Count} columns");
            }
        }
        catch (Exception ex)
        {
            _log?.Invoke($"Column fetch failed for {table.Name}: {ex.Message}");
        }
    }

    private static string? ExtractTableName(string text)
    {
        var lines = text.Split(new[] { '\n', '\r' }, StringSplitOptions.RemoveEmptyEntries);
        foreach (var line in lines)
        {
            var t = line.Trim();
            if (t.StartsWith("let ", StringComparison.OrdinalIgnoreCase) || t.StartsWith("|")) continue;
            var match = System.Text.RegularExpressions.Regex.Match(t, @"^(\w+)");
            if (match.Success)
            {
                var word = match.Groups[1].Value;
                var skip = new[] { "let", "set", "print", "range", "datatable", "union", "find", "search" };
                if (!skip.Contains(word, StringComparer.OrdinalIgnoreCase))
                    return word;
            }
        }
        return null;
    }

    private static bool IsColumnContext(string text)
    {
        var lastPipe = text.LastIndexOf('|');
        if (lastPipe < 0) return false;
        var afterPipe = text.Substring(lastPipe).ToLowerInvariant();
        var ops = new[] { "where", "project", "extend", "summarize", "sort by", "order by",
                          "on", "by", "distinct", "mv-expand", "join" };
        return ops.Any(op => afterPipe.Contains(op));
    }
}
