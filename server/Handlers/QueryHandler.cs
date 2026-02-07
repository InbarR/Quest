using System.Diagnostics;
using Quest.Server.Models;
using Quest.Server.Protocol;
using Quest.Server.Services;

namespace Quest.Server.Handlers;

/// <summary>
/// Handles query execution requests using the data source registry.
/// </summary>
public class QueryHandler : IDisposable
{
    private readonly DataSourceRegistry _registry;
    private readonly Action<string> _log;
    private CancellationTokenSource? _currentQueryCts;

    public QueryHandler(DataSourceRegistry registry, Action<string> log)
    {
        _registry = registry;
        _log = log;
    }

    public void Dispose()
    {
        _currentQueryCts?.Cancel();
        _currentQueryCts?.Dispose();
    }

    public async Task<QueryResult> ExecuteAsync(QueryRequest request, CancellationToken externalCt)
    {
        var sw = Stopwatch.StartNew();

        var requestType = request.Type ?? "";
        _log($"ExecuteAsync - Type: '{requestType}', ClusterUrl: '{request.ClusterUrl ?? "(null)"}', Database: '{request.Database ?? "(null)"}'");

        // Validate required fields
        if (string.IsNullOrWhiteSpace(request.Query))
        {
            return new QueryResult(
                Success: false,
                Columns: Array.Empty<string>(),
                Rows: Array.Empty<string[]>(),
                RowCount: 0,
                ExecutionTimeMs: 0,
                Error: "Query cannot be empty"
            );
        }

        // Create linked cancellation token
        _currentQueryCts?.Cancel();
        _currentQueryCts = CancellationTokenSource.CreateLinkedTokenSource(externalCt);
        var ct = _currentQueryCts.Token;

        try
        {
            // Get the appropriate data source
            var dataSource = _registry.GetForQuery(requestType, request.Query);

            if (dataSource == null)
            {
                return new QueryResult(
                    Success: false,
                    Columns: Array.Empty<string>(),
                    Rows: Array.Empty<string[]>(),
                    RowCount: 0,
                    ExecutionTimeMs: sw.ElapsedMilliseconds,
                    Error: $"No data source available for type '{requestType}'"
                );
            }

            _log($"Using data source: {dataSource.Id} ({dataSource.DisplayName})");

            // Validate connection parameters for non-Outlook data sources
            var isOutlook = dataSource.Id.Equals("outlook", StringComparison.OrdinalIgnoreCase);
            if (!isOutlook)
            {
                if (string.IsNullOrWhiteSpace(request.ClusterUrl))
                {
                    return new QueryResult(
                        Success: false,
                        Columns: Array.Empty<string>(),
                        Rows: Array.Empty<string[]>(),
                        RowCount: 0,
                        ExecutionTimeMs: sw.ElapsedMilliseconds,
                        Error: $"{dataSource.UIConfig.ServerLabel} is required. Please select a data source."
                    );
                }

                // Database requirement depends on the data source
                if (dataSource.UIConfig.ShowDatabaseSelector && string.IsNullOrWhiteSpace(request.Database))
                {
                    // ADO allows empty project, Kusto requires database
                    if (dataSource.Id.Equals("kusto", StringComparison.OrdinalIgnoreCase))
                    {
                        return new QueryResult(
                            Success: false,
                            Columns: Array.Empty<string>(),
                            Rows: Array.Empty<string[]>(),
                            RowCount: 0,
                            ExecutionTimeMs: sw.ElapsedMilliseconds,
                            Error: $"{dataSource.UIConfig.DatabaseLabel} is required. Please select a data source."
                        );
                    }
                }
            }

            // Create query request for the data source
            var dsRequest = new DataSourceQueryRequest
            {
                Query = request.Query,
                ClusterUrl = request.ClusterUrl,
                Database = request.Database,
                MaxResults = request.MaxResults ?? dataSource.UIConfig.DefaultMaxResults,
                TimeoutMs = request.Timeout
            };

            // Execute the query
            var result = await dataSource.ExecuteQueryAsync(dsRequest, ct);

            sw.Stop();
            // Return result with actual execution time
            return result with { ExecutionTimeMs = sw.ElapsedMilliseconds };
        }
        catch (OperationCanceledException)
        {
            _log("Query cancelled");
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
            _log($"Query error: {ex.Message}");
            return new QueryResult(
                Success: false,
                Columns: Array.Empty<string>(),
                Rows: Array.Empty<string[]>(),
                RowCount: 0,
                ExecutionTimeMs: sw.ElapsedMilliseconds,
                Error: ex.Message
            );
        }
        finally
        {
            sw.Stop();
        }
    }

    public void Cancel()
    {
        var hasActiveCts = _currentQueryCts != null;
        _log($"Cancel requested (active query: {hasActiveCts})");
        _currentQueryCts?.Cancel();
        if (hasActiveCts)
        {
            _log("Cancellation token triggered");
        }
    }

    /// <summary>
    /// Get available data sources
    /// </summary>
    public DataSourceInfo[] GetDataSources()
    {
        return _registry.GetDataSourceInfo();
    }
}
