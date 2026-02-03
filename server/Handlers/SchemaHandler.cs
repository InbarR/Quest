using MyTools.Core;
using Quest.Server.Protocol;

namespace Quest.Server.Handlers;

public class SchemaHandler
{
    private readonly KustoSchemaManager _schemaManager;
    private readonly KustoService _kustoService;
    private readonly Action<string>? _log;

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
                    // Load the cached schema into the active context
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
                clusterUri = $"https://{clusterUrl}.kusto.windows.net";
            }

            var kcsb = new Kusto.Data.KustoConnectionStringBuilder(clusterUri)
                .WithAadUserPromptAuthentication();
            kcsb.InitialCatalog = database;

            // Fetch table names
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

                // Fetch columns for each table (in parallel, limited to 5 concurrent)
                var columnTasks = new List<Task>();
                var semaphore = new SemaphoreSlim(5);

                foreach (var tableName in tableNames.Take(50)) // Limit to first 50 tables for performance
                {
                    columnTasks.Add(Task.Run(async () =>
                    {
                        await semaphore.WaitAsync(ct);
                        try
                        {
                            var columnQuery = $".show table {tableName} schema as json";
                            var columnResult = await _kustoService.RunQueryAsync(kcsb, columnQuery, ct, msg => { });

                            if (columnResult != null && columnResult.Rows.Count > 0)
                            {
                                var schemaJson = columnResult.Rows[0][0]?.ToString();
                                if (!string.IsNullOrWhiteSpace(schemaJson))
                                {
                                    var columns = ExtractColumnsFromSchemaJson(schemaJson);
                                    if (columns.Any())
                                    {
                                        _schemaManager.AddTableWithColumns(tableName, columns);
                                        _log?.Invoke($"  {tableName}: {columns.Count()} columns");
                                    }
                                }
                            }
                        }
                        catch (Exception ex)
                        {
                            _log?.Invoke($"  Failed to get columns for {tableName}: {ex.Message}");
                        }
                        finally
                        {
                            semaphore.Release();
                        }
                    }, ct));
                }

                await Task.WhenAll(columnTasks);
                _log?.Invoke($"Schema fetch complete: {tableNames.Count} tables");

                // Save to cache for future use
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

    private static IEnumerable<string> ExtractColumnsFromSchemaJson(string schemaJson)
    {
        try
        {
            // Parse the Kusto schema JSON which has format like:
            // {"Name":"TableName","OrderedColumns":[{"Name":"Col1","Type":"..."},{"Name":"Col2","Type":"..."}]}
            var doc = System.Text.Json.JsonDocument.Parse(schemaJson);
            var root = doc.RootElement;

            if (root.TryGetProperty("OrderedColumns", out var columns))
            {
                return columns.EnumerateArray()
                    .Where(c => c.TryGetProperty("Name", out _))
                    .Select(c => c.GetProperty("Name").GetString())
                    .Where(n => !string.IsNullOrWhiteSpace(n))
                    .Cast<string>()
                    .ToList();
            }
        }
        catch { }

        return Enumerable.Empty<string>();
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

    public CompletionItem[] GetCompletions(string query, int position)
    {
        var items = new List<CompletionItem>();
        var config = _schemaManager.GetConfig();

        // Get text up to cursor position for context analysis
        var textBeforeCursor = position >= 0 && position <= query.Length
            ? query.Substring(0, position)
            : query;

        // Detect context: find table name and check if we're expecting columns
        var (tableName, isColumnContext) = AnalyzeQueryContext(textBeforeCursor);
        _log?.Invoke($"GetCompletions: tables={config.Tables.Count}, table={tableName ?? "(none)"}, columnContext={isColumnContext}");

        // If we found a table and are in column context, prioritize that table's columns
        if (!string.IsNullOrEmpty(tableName) && isColumnContext)
        {
            var tableSchema = config.Tables.FirstOrDefault(t =>
                string.Equals(t.Name, tableName, StringComparison.OrdinalIgnoreCase));

            if (tableSchema != null)
            {
                // Add columns from the specific table first (with priority)
                foreach (var column in tableSchema.Columns)
                {
                    items.Add(new CompletionItem(
                        Label: column,
                        Kind: "column",
                        Detail: $"Column from {tableSchema.Name}"
                    ));
                }
                _log?.Invoke($"Added {tableSchema.Columns.Count} columns from table {tableName}");
            }
        }

        // Add keywords
        foreach (var keyword in config.Keywords)
        {
            items.Add(new CompletionItem(
                Label: keyword,
                Kind: "keyword",
                Detail: "KQL Keyword"
            ));
        }

        // Add functions
        foreach (var func in config.Functions)
        {
            items.Add(new CompletionItem(
                Label: func,
                Kind: "function",
                Detail: "KQL Function",
                InsertText: $"{func}($1)"
            ));
        }

        // Add aggregation functions
        foreach (var aggFunc in config.AggregationFunctions)
        {
            items.Add(new CompletionItem(
                Label: aggFunc,
                Kind: "function",
                Detail: "Aggregation Function",
                InsertText: $"{aggFunc}($1)"
            ));
        }

        // Add tables from schema
        foreach (var table in config.Tables)
        {
            items.Add(new CompletionItem(
                Label: table.Name,
                Kind: "table",
                Detail: $"Table with {table.Columns.Count} columns"
            ));
        }

        // Add all columns (lower priority) if not already in column context
        if (string.IsNullOrEmpty(tableName) || !isColumnContext)
        {
            foreach (var column in _schemaManager.GetAllColumns())
            {
                items.Add(new CompletionItem(
                    Label: column,
                    Kind: "column",
                    Detail: "Column"
                ));
            }
        }

        _log?.Invoke($"GetCompletions returning {items.Count} items");
        return items.ToArray();
    }

    /// <summary>
    /// Analyzes the query text to find the table name and determine if we're in a column context.
    /// </summary>
    private (string? tableName, bool isColumnContext) AnalyzeQueryContext(string textBeforeCursor)
    {
        if (string.IsNullOrWhiteSpace(textBeforeCursor))
            return (null, false);

        // Normalize whitespace and split by pipe
        var normalized = textBeforeCursor.Trim();

        // Find the table name - it's typically the first identifier in the query
        // Pattern: TableName | where ... or TableName\n| where ...
        string? tableName = null;

        // Try to extract table name from the beginning of the query
        // Skip 'let' statements and find the first table reference
        var lines = normalized.Split(new[] { '\n', '\r' }, StringSplitOptions.RemoveEmptyEntries);
        foreach (var line in lines)
        {
            var trimmedLine = line.Trim();

            // Skip let statements
            if (trimmedLine.StartsWith("let ", StringComparison.OrdinalIgnoreCase))
                continue;

            // Skip lines starting with pipe (continuation)
            if (trimmedLine.StartsWith("|"))
                continue;

            // Extract the first word as potential table name
            var match = System.Text.RegularExpressions.Regex.Match(trimmedLine, @"^(\w+)");
            if (match.Success)
            {
                var potentialTable = match.Groups[1].Value;
                // Skip keywords that aren't table names
                var skipWords = new[] { "let", "set", "print", "range", "datatable", "union", "find", "search" };
                if (!skipWords.Contains(potentialTable, StringComparer.OrdinalIgnoreCase))
                {
                    tableName = potentialTable;
                    break;
                }
            }
        }

        // Determine if we're in a column context
        // Column context is after: where, project, extend, summarize, sort by, order by, on, by
        var columnOperators = new[] { "where", "project", "extend", "summarize", "sort by", "order by", "on", "by", "distinct", "mv-expand" };
        bool isColumnContext = false;

        // Check the last part of the query (after the last pipe or operator)
        var lastPipeIndex = normalized.LastIndexOf('|');
        var relevantPart = lastPipeIndex >= 0 ? normalized.Substring(lastPipeIndex) : normalized;

        foreach (var op in columnOperators)
        {
            // Check if the relevant part contains the operator
            var opIndex = relevantPart.LastIndexOf(op, StringComparison.OrdinalIgnoreCase);
            if (opIndex >= 0)
            {
                // Check if there's content after the operator (meaning we're typing a column)
                var afterOp = relevantPart.Substring(opIndex + op.Length).TrimStart();
                // We're in column context if we're right after the operator or typing
                isColumnContext = true;
                break;
            }
        }

        return (tableName, isColumnContext);
    }
}
