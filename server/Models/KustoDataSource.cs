using System;
using System.Diagnostics;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Kusto.Data;
using MyTools.Core;
using Quest.Server.Protocol;

namespace Quest.Server.Models;

/// <summary>
/// Azure Data Explorer (Kusto) data source implementation
/// </summary>
public class KustoDataSource : IDataSource, ISchemaProvider, IDataSourceHelp, IExternalViewer
{
    private readonly KustoService _kustoService;
    private readonly KustoSchemaManager? _schemaManager;
    private readonly Action<string> _log;
    private string _clusterUrl = string.Empty;
    private string _databaseName = string.Empty;
    private DataSourceConnectionState _state = DataSourceConnectionState.Disconnected;

    public KustoDataSource(KustoService kustoService, KustoSchemaManager? schemaManager, Action<string> log)
    {
        _kustoService = kustoService;
        _schemaManager = schemaManager;
        _log = log;
    }

    // ============ IDataSource Identity ============
    public string Id => "kusto";
    public string DisplayName => "Kusto (Azure Data Explorer)";
    public string Icon => "\U0001F5C4"; // File cabinet emoji
    public string QueryLanguage => "KQL";

    // ============ UI Configuration ============
    public DataSourceUIConfig UIConfig { get; } = new DataSourceUIConfig
    {
        ServerLabel = "Cluster",
        ServerPlaceholder = "Select or enter cluster URL...",
        DatabaseLabel = "Database",
        DatabasePlaceholder = "Select database...",
        ShowDatabaseSelector = true,
        SupportsMaxResults = true,
        DefaultMaxResults = 10000,
        ShowConnectButton = false
    };

    // ============ Connection ============
    public DataSourceConnectionState State
    {
        get => _state;
        private set
        {
            if (_state != value)
            {
                var oldState = _state;
                _state = value;
                ConnectionStateChanged?.Invoke(this, new ConnectionStateChangedEventArgs(oldState, value));
            }
        }
    }

    public string ConnectionInfo => string.IsNullOrEmpty(_clusterUrl) ? string.Empty : $"{_clusterUrl}/{_databaseName}";

    public event EventHandler<ConnectionStateChangedEventArgs>? ConnectionStateChanged;

    public Task<ConnectionResult> ConnectAsync(DataSourceConnectionParams parameters, CancellationToken ct = default)
    {
        try
        {
            State = DataSourceConnectionState.Connecting;

            _clusterUrl = NormalizeClusterUrl(parameters.Server);
            _databaseName = parameters.Database ?? string.Empty;

            if (string.IsNullOrEmpty(_clusterUrl))
            {
                State = DataSourceConnectionState.Error;
                return Task.FromResult(ConnectionResult.Failed("Cluster URL is required"));
            }

            // Kusto uses on-demand connection, so we just validate and store params
            State = DataSourceConnectionState.Connected;
            _log($"Kusto connection configured: {ConnectionInfo}");

            return Task.FromResult(ConnectionResult.Succeeded(ConnectionInfo));
        }
        catch (Exception ex)
        {
            State = DataSourceConnectionState.Error;
            return Task.FromResult(ConnectionResult.Failed(ex.Message));
        }
    }

    public Task DisconnectAsync()
    {
        _clusterUrl = string.Empty;
        _databaseName = string.Empty;
        State = DataSourceConnectionState.Disconnected;
        return Task.CompletedTask;
    }

    // ============ Query Execution ============
    public async Task<QueryResult> ExecuteQueryAsync(DataSourceQueryRequest request, CancellationToken ct = default)
    {
        var sw = Stopwatch.StartNew();

        try
        {
            var clusterUrl = NormalizeClusterUrl(request.ClusterUrl ?? _clusterUrl);
            var database = request.Database ?? _databaseName;

            if (string.IsNullOrEmpty(clusterUrl))
            {
                return new QueryResult(
                    Success: false,
                    Columns: Array.Empty<string>(),
                    Rows: Array.Empty<string[]>(),
                    RowCount: 0,
                    ExecutionTimeMs: sw.ElapsedMilliseconds,
                    Error: "Cluster URL is required"
                );
            }

            if (string.IsNullOrEmpty(database))
            {
                return new QueryResult(
                    Success: false,
                    Columns: Array.Empty<string>(),
                    Rows: Array.Empty<string[]>(),
                    RowCount: 0,
                    ExecutionTimeMs: sw.ElapsedMilliseconds,
                    Error: "Database is required"
                );
            }

            _log($"Executing Kusto query on {clusterUrl}/{database}");

            var kcsb = KustoAuthProvider.CreateKcsb(clusterUrl, database);

            var result = await _kustoService.RunQueryAsync(kcsb, request.Query, ct, _log);

            var columns = result.Columns ?? Array.Empty<string>();
            var rows = result.Rows?
                .Select(r => r.ToArray())
                .Take(request.MaxResults)
                .ToArray() ?? Array.Empty<string[]>();

            _log($"Kusto query returned {rows.Length} rows");

            return new QueryResult(
                Success: true,
                Columns: columns,
                Rows: rows,
                RowCount: rows.Length,
                ExecutionTimeMs: sw.ElapsedMilliseconds,
                Error: null
            );
        }
        catch (OperationCanceledException)
        {
            return new QueryResult(
                Success: false,
                Columns: Array.Empty<string>(),
                Rows: Array.Empty<string[]>(),
                RowCount: 0,
                ExecutionTimeMs: sw.ElapsedMilliseconds,
                Error: "Query was cancelled"
            );
        }
        catch (Exception ex)
        {
            _log($"Kusto query error: {ex.Message}");
            return new QueryResult(
                Success: false,
                Columns: Array.Empty<string>(),
                Rows: Array.Empty<string[]>(),
                RowCount: 0,
                ExecutionTimeMs: sw.ElapsedMilliseconds,
                Error: ex.Message
            );
        }
    }

    public QueryValidationResult ValidateQuery(string query)
    {
        if (string.IsNullOrWhiteSpace(query))
            return QueryValidationResult.Invalid("Query cannot be empty");

        return QueryValidationResult.Valid();
    }

    public string FormatQuery(string query)
    {
        return query.Trim();
    }

    public bool CanHandleQuery(string query)
    {
        // Kusto queries typically start with a table name or command
        // They don't have SELECT...FROM pattern like SQL/Outlook
        if (string.IsNullOrWhiteSpace(query))
            return false;

        var trimmed = query.Trim();

        // Kusto commands start with .
        if (trimmed.StartsWith("."))
            return true;

        // If it has | operator typical of KQL
        if (trimmed.Contains("|"))
            return true;

        // Not a SELECT statement (Outlook/SQL pattern)
        var upperQuery = trimmed.ToUpperInvariant();
        if (upperQuery.StartsWith("SELECT "))
            return false;

        // Default to true for Kusto as fallback
        return true;
    }

    // ============ ISchemaProvider ============
    public Task<SchemaEntity[]> GetEntitiesAsync(CancellationToken ct = default)
    {
        if (_schemaManager == null)
            return Task.FromResult(Array.Empty<SchemaEntity>());

        try
        {
            var config = _schemaManager.GetConfig();
            var entities = config.Tables
                .Select(t => new SchemaEntity { Name = t.Name, EntityType = "Table" })
                .ToArray();

            return Task.FromResult(entities);
        }
        catch
        {
            return Task.FromResult(Array.Empty<SchemaEntity>());
        }
    }

    public Task<SchemaColumn[]> GetColumnsAsync(string entityName, CancellationToken ct = default)
    {
        if (_schemaManager == null)
            return Task.FromResult(Array.Empty<SchemaColumn>());

        try
        {
            var columns = _schemaManager.GetColumnsForTable(entityName)
                .Select(c => new SchemaColumn { Name = c, DataType = "unknown" })
                .ToArray();

            return Task.FromResult(columns);
        }
        catch
        {
            return Task.FromResult(Array.Empty<SchemaColumn>());
        }
    }

    public Task<SchemaFunction[]> GetFunctionsAsync(CancellationToken ct = default)
    {
        if (_schemaManager == null)
            return Task.FromResult(Array.Empty<SchemaFunction>());

        try
        {
            var config = _schemaManager.GetConfig();
            var functions = config.Functions
                .Select(f => new SchemaFunction { Name = f, Signature = "()" })
                .Concat(config.AggregationFunctions
                    .Select(f => new SchemaFunction { Name = f, Signature = "()", Description = "Aggregation function" }))
                .ToArray();

            return Task.FromResult(functions);
        }
        catch
        {
            return Task.FromResult(Array.Empty<SchemaFunction>());
        }
    }

    // ============ IDataSourceHelp ============
    public QueryExample[] GetExamples()
    {
        return new[]
        {
            new QueryExample
            {
                Title = "Basic Query",
                Description = "Get 10 rows from a table",
                Query = "TableName\n| take 10",
                Category = "Basic"
            },
            new QueryExample
            {
                Title = "Filter Query",
                Description = "Filter rows by a condition",
                Query = "TableName\n| where Column == 'value'",
                Category = "Basic"
            },
            new QueryExample
            {
                Title = "Time Filter",
                Description = "Filter by time range",
                Query = "TableName\n| where Timestamp > ago(1h)",
                Category = "Time"
            },
            new QueryExample
            {
                Title = "Aggregation",
                Description = "Count rows by group",
                Query = "TableName\n| summarize count() by GroupColumn",
                Category = "Aggregation"
            },
            new QueryExample
            {
                Title = "Top N",
                Description = "Get top N rows ordered by column",
                Query = "TableName\n| top 10 by SortColumn desc",
                Category = "Sorting"
            },
            new QueryExample
            {
                Title = "Time Series",
                Description = "Create time series chart",
                Query = "TableName\n| where Timestamp > ago(7d)\n| summarize count() by bin(Timestamp, 1h)\n| render timechart",
                Category = "Visualization"
            }
        };
    }

    public string? GetDocumentationUrl() => "https://learn.microsoft.com/en-us/azure/data-explorer/kusto/query/";

    public string? GetQuickStartGuide() => @"KQL (Kusto Query Language) Quick Start:

1. Basic query: TableName | take 10
2. Filter: | where Column == 'value'
3. Time filter: | where Timestamp > ago(1h)
4. Aggregate: | summarize count() by GroupColumn
5. Sort: | order by Column desc
6. Project columns: | project Col1, Col2, Col3

Press Ctrl+Space for autocomplete.";

    // ============ IExternalViewer ============
    public bool SupportsExternalViewer => true;
    public string ExternalViewerLabel => "Open in ADX";

    public string? GetExternalViewerUrl(string query, string? server, string? database)
    {
        var clusterUrl = server ?? _clusterUrl;
        var db = database ?? _databaseName;

        if (string.IsNullOrEmpty(clusterUrl) || string.IsNullOrEmpty(db))
            return null;

        var clusterUri = NormalizeClusterUrl(clusterUrl);
        var encodedQuery = Uri.EscapeDataString(query);

        return $"https://dataexplorer.azure.com/clusters/{Uri.EscapeDataString(clusterUri)}/databases/{Uri.EscapeDataString(db)}?query={encodedQuery}";
    }

    public void Dispose()
    {
        // No resources to dispose
    }

    /// <summary>
    /// Normalizes a Kusto cluster URL to ensure it has the proper format.
    /// </summary>
    private static string NormalizeClusterUrl(string clusterUrl)
    {
        if (string.IsNullOrWhiteSpace(clusterUrl))
            return clusterUrl;

        var url = clusterUrl.Trim();

        // If it's already a full URL with scheme, return as-is
        if (url.StartsWith("https://", StringComparison.OrdinalIgnoreCase) ||
            url.StartsWith("http://", StringComparison.OrdinalIgnoreCase))
        {
            return url;
        }

        // If it doesn't have the kusto.windows.net suffix, add it
        if (!url.Contains(".kusto.windows.net", StringComparison.OrdinalIgnoreCase) &&
            !url.Contains(".kusto.azure.com", StringComparison.OrdinalIgnoreCase))
        {
            // Remove any trailing port if present
            if (url.Contains(":"))
            {
                url = url.Substring(0, url.LastIndexOf(':'));
            }

            url = $"{url}.kusto.windows.net";
        }

        // Add https:// prefix
        return $"https://{url}";
    }
}
