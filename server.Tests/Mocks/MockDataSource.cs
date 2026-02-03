using System;
using System.Threading;
using System.Threading.Tasks;
using Quest.Server.Models;
using Quest.Server.Protocol;

namespace Quest.Server.Tests.Mocks;

/// <summary>
/// Mock data source for testing purposes.
/// Allows configuring behavior and tracking method calls.
/// </summary>
public class MockDataSource : IDataSource, ISchemaProvider, IDataSourceHelp, IExternalViewer
{
    // Configurable behavior
    public bool ConnectShouldSucceed { get; set; } = true;
    public string ConnectErrorMessage { get; set; } = "Mock connection failed";
    public QueryResult? MockQueryResult { get; set; }
    public int ConnectDelayMs { get; set; } = 0;
    public int QueryDelayMs { get; set; } = 0;
    public string[]? MockDatabases { get; set; }
    public SchemaEntity[]? MockEntities { get; set; }
    public SchemaColumn[]? MockColumns { get; set; }
    public SchemaFunction[]? MockFunctions { get; set; }
    public Func<string, bool>? CanHandleQueryFunc { get; set; }

    // Track calls for verification
    public int ConnectCallCount { get; private set; }
    public int DisconnectCallCount { get; private set; }
    public int ExecuteQueryCallCount { get; private set; }
    public DataSourceConnectionParams? LastConnectParams { get; private set; }
    public DataSourceQueryRequest? LastQueryRequest { get; private set; }

    // IDataSource implementation
    public string Id { get; set; } = "mock";
    public string DisplayName { get; set; } = "Mock Data Source";
    public string Icon { get; set; } = "test-icon";
    public string QueryLanguage { get; set; } = "MockQL";

    public DataSourceUIConfig UIConfig { get; set; } = new DataSourceUIConfig
    {
        ServerLabel = "Mock Server",
        DatabaseLabel = "Mock Database",
        ServerPlaceholder = "Enter mock server...",
        DatabasePlaceholder = "Enter mock database...",
        ShowDatabaseSelector = true,
        SupportsMaxResults = true,
        DefaultMaxResults = 1000
    };

    private DataSourceConnectionState _state = DataSourceConnectionState.Disconnected;
    public DataSourceConnectionState State
    {
        get => _state;
        private set
        {
            var oldState = _state;
            _state = value;
            ConnectionStateChanged?.Invoke(this, new ConnectionStateChangedEventArgs(oldState, value));
        }
    }

    public string ConnectionInfo { get; private set; } = string.Empty;

    public event EventHandler<ConnectionStateChangedEventArgs>? ConnectionStateChanged;

    public MockDataSource()
    {
        // Default mock result
        MockQueryResult = new QueryResult(
            Success: true,
            Columns: new[] { "Id", "Name", "Value" },
            Rows: new[]
            {
                new[] { "1", "Item1", "10.5" },
                new[] { "2", "Item2", "20.5" },
                new[] { "3", "Item3", "30.5" }
            },
            RowCount: 3,
            ExecutionTimeMs: 100,
            Error: null
        );
    }

    public async Task<ConnectionResult> ConnectAsync(DataSourceConnectionParams parameters, CancellationToken ct = default)
    {
        ConnectCallCount++;
        LastConnectParams = parameters;
        State = DataSourceConnectionState.Connecting;

        if (ConnectDelayMs > 0)
        {
            await Task.Delay(ConnectDelayMs, ct);
        }

        if (ConnectShouldSucceed)
        {
            State = DataSourceConnectionState.Connected;
            ConnectionInfo = $"{parameters.Server}/{parameters.Database}";
            return ConnectionResult.Succeeded(ConnectionInfo, MockDatabases);
        }
        else
        {
            State = DataSourceConnectionState.Error;
            return ConnectionResult.Failed(ConnectErrorMessage);
        }
    }

    public Task DisconnectAsync()
    {
        DisconnectCallCount++;
        State = DataSourceConnectionState.Disconnected;
        ConnectionInfo = string.Empty;
        return Task.CompletedTask;
    }

    public async Task<QueryResult> ExecuteQueryAsync(DataSourceQueryRequest request, CancellationToken ct = default)
    {
        ExecuteQueryCallCount++;
        LastQueryRequest = request;

        if (State != DataSourceConnectionState.Connected)
        {
            return new QueryResult(
                Success: false,
                Columns: Array.Empty<string>(),
                Rows: Array.Empty<string[]>(),
                RowCount: 0,
                ExecutionTimeMs: 0,
                Error: "Not connected"
            );
        }

        if (QueryDelayMs > 0)
        {
            await Task.Delay(QueryDelayMs, ct);
        }

        ct.ThrowIfCancellationRequested();

        return MockQueryResult!;
    }

    public QueryValidationResult ValidateQuery(string query)
    {
        if (string.IsNullOrWhiteSpace(query))
        {
            return QueryValidationResult.Invalid("Query cannot be empty");
        }
        return QueryValidationResult.Valid();
    }

    public string FormatQuery(string query)
    {
        return query.Trim();
    }

    public bool CanHandleQuery(string query)
    {
        if (CanHandleQueryFunc != null)
        {
            return CanHandleQueryFunc(query);
        }
        // By default, handle queries that contain "mock"
        return query.Contains("mock", StringComparison.OrdinalIgnoreCase);
    }

    // ISchemaProvider
    public Task<SchemaEntity[]> GetEntitiesAsync(CancellationToken ct = default)
    {
        return Task.FromResult(MockEntities ?? new[]
        {
            new SchemaEntity { Name = "MockTable1", EntityType = "Table" },
            new SchemaEntity { Name = "MockTable2", EntityType = "Table" }
        });
    }

    public Task<SchemaColumn[]> GetColumnsAsync(string entityName, CancellationToken ct = default)
    {
        return Task.FromResult(MockColumns ?? new[]
        {
            new SchemaColumn { Name = "Id", DataType = "int" },
            new SchemaColumn { Name = "Name", DataType = "string" },
            new SchemaColumn { Name = "CreatedAt", DataType = "datetime" }
        });
    }

    public Task<SchemaFunction[]> GetFunctionsAsync(CancellationToken ct = default)
    {
        return Task.FromResult(MockFunctions ?? new[]
        {
            new SchemaFunction { Name = "MockFunc1", Signature = "(param1: string)" },
            new SchemaFunction { Name = "MockFunc2", Signature = "(param1: int, param2: string)" }
        });
    }

    // IDataSourceHelp
    public QueryExample[] GetExamples()
    {
        return new[]
        {
            new QueryExample
            {
                Title = "Basic Query",
                Description = "A simple mock query",
                Query = "MockTable1 | take 10"
            },
            new QueryExample
            {
                Title = "Filter Query",
                Description = "Query with filter",
                Query = "MockTable1 | where Name == 'test'"
            }
        };
    }

    public string? GetDocumentationUrl() => "https://example.com/mock-docs";

    public string? GetQuickStartGuide() => "This is a mock data source for testing.";

    // IExternalViewer
    public bool SupportsExternalViewer => true;
    public string ExternalViewerLabel => "Open in Mock Viewer";

    public string? GetExternalViewerUrl(string query, string? server, string? database)
    {
        return $"https://mock.example.com/?q={Uri.EscapeDataString(query)}";
    }

    public void Dispose()
    {
        // Cleanup if needed
    }

    // Helper to reset call tracking
    public void ResetTracking()
    {
        ConnectCallCount = 0;
        DisconnectCallCount = 0;
        ExecuteQueryCallCount = 0;
        LastConnectParams = null;
        LastQueryRequest = null;
    }
}
