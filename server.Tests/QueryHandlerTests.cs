using FluentAssertions;
using Quest.Server.Handlers;
using Quest.Server.Models;
using Quest.Server.Protocol;
using Quest.Server.Services;
using Quest.Server.Tests.Mocks;
using Xunit;

namespace Quest.Server.Tests;

public class QueryHandlerTests : IDisposable
{
    private readonly List<string> _logMessages = new();
    private readonly Action<string> _log;
    private readonly DataSourceRegistry _registry;
    private readonly QueryHandler _handler;
    private readonly MockDataSource _mockDataSource;

    public QueryHandlerTests()
    {
        _log = msg => _logMessages.Add(msg);
        _registry = new DataSourceRegistry(_log);

        _mockDataSource = new MockDataSource { Id = "mock" };
        _registry.Register(new DataSourceRegistration
        {
            Id = "mock",
            DisplayName = "Mock",
            Icon = "test",
            QueryLanguage = "MockQL",
            SortOrder = 1,
            IsEnabled = true,
            Factory = () => _mockDataSource
        });

        _handler = new QueryHandler(_registry, _log);
    }

    public void Dispose()
    {
        _handler.Dispose();
        _registry.Dispose();
    }

    [Fact]
    public async Task ExecuteAsync_ReturnsErrorForEmptyQuery()
    {
        // Arrange
        var request = new QueryRequest(
            Query: "",
            ClusterUrl: "test-server",
            Database: "test-db",
            Type: "mock",
            Timeout: null,
            MaxResults: null
        );

        // Act
        var result = await _handler.ExecuteAsync(request, CancellationToken.None);

        // Assert
        result.Success.Should().BeFalse();
        result.Error.Should().Contain("empty");
    }

    [Fact]
    public async Task ExecuteAsync_ReturnsErrorForWhitespaceQuery()
    {
        // Arrange
        var request = new QueryRequest(
            Query: "   ",
            ClusterUrl: "test-server",
            Database: "test-db",
            Type: "mock",
            Timeout: null,
            MaxResults: null
        );

        // Act
        var result = await _handler.ExecuteAsync(request, CancellationToken.None);

        // Assert
        result.Success.Should().BeFalse();
        result.Error.Should().Contain("empty");
    }

    [Fact]
    public async Task ExecuteAsync_ReturnsErrorForUnknownDataSourceType()
    {
        // Arrange
        var request = new QueryRequest(
            Query: "some query",
            ClusterUrl: "test-server",
            Database: "test-db",
            Type: "unknown-type",
            Timeout: null,
            MaxResults: null
        );

        // Act
        var result = await _handler.ExecuteAsync(request, CancellationToken.None);

        // Assert
        result.Success.Should().BeFalse();
        result.Error.Should().Contain("No data source available");
    }

    [Fact]
    public async Task ExecuteAsync_ReturnsErrorForMissingClusterUrl()
    {
        // Arrange
        var request = new QueryRequest(
            Query: "some query",
            ClusterUrl: "",
            Database: "test-db",
            Type: "mock",
            Timeout: null,
            MaxResults: null
        );

        // Act
        var result = await _handler.ExecuteAsync(request, CancellationToken.None);

        // Assert
        result.Success.Should().BeFalse();
        result.Error.Should().Contain("required");
    }

    [Fact]
    public async Task ExecuteAsync_ExecutesQueryOnDataSource()
    {
        // Arrange
        // First connect the mock data source
        await _mockDataSource.ConnectAsync(new DataSourceConnectionParams
        {
            Server = "test-server",
            Database = "test-db"
        });

        var request = new QueryRequest(
            Query: "test query",
            ClusterUrl: "test-server",
            Database: "test-db",
            Type: "mock",
            Timeout: null,
            MaxResults: 100
        );

        // Act
        var result = await _handler.ExecuteAsync(request, CancellationToken.None);

        // Assert
        result.Success.Should().BeTrue();
        result.Columns.Should().BeEquivalentTo(new[] { "Id", "Name", "Value" });
        result.RowCount.Should().Be(3);
        _mockDataSource.ExecuteQueryCallCount.Should().Be(1);
        _mockDataSource.LastQueryRequest!.Query.Should().Be("test query");
        _mockDataSource.LastQueryRequest!.MaxResults.Should().Be(100);
    }

    [Fact]
    public async Task ExecuteAsync_UsesDefaultMaxResultsFromUIConfig()
    {
        // Arrange
        await _mockDataSource.ConnectAsync(new DataSourceConnectionParams
        {
            Server = "test-server",
            Database = "test-db"
        });

        var request = new QueryRequest(
            Query: "test query",
            ClusterUrl: "test-server",
            Database: "test-db",
            Type: "mock",
            Timeout: null,
            MaxResults: null // Not specified
        );

        // Act
        await _handler.ExecuteAsync(request, CancellationToken.None);

        // Assert
        _mockDataSource.LastQueryRequest!.MaxResults.Should().Be(1000); // Default from MockDataSource.UIConfig
    }

    [Fact]
    public async Task ExecuteAsync_PassesConnectionParamsToDataSource()
    {
        // Arrange
        await _mockDataSource.ConnectAsync(new DataSourceConnectionParams
        {
            Server = "test-server",
            Database = "test-db"
        });

        var request = new QueryRequest(
            Query: "test query",
            ClusterUrl: "my-cluster",
            Database: "my-database",
            Type: "mock",
            Timeout: null,
            MaxResults: null
        );

        // Act
        await _handler.ExecuteAsync(request, CancellationToken.None);

        // Assert
        _mockDataSource.LastQueryRequest!.ClusterUrl.Should().Be("my-cluster");
        _mockDataSource.LastQueryRequest!.Database.Should().Be("my-database");
    }

    [Fact]
    public async Task ExecuteAsync_HandlesQueryError()
    {
        // Arrange
        _mockDataSource.MockQueryResult = new QueryResult(
            Success: false,
            Columns: Array.Empty<string>(),
            Rows: Array.Empty<string[]>(),
            RowCount: 0,
            ExecutionTimeMs: 0,
            Error: "Query execution failed"
        );

        await _mockDataSource.ConnectAsync(new DataSourceConnectionParams
        {
            Server = "test-server",
            Database = "test-db"
        });

        var request = new QueryRequest(
            Query: "bad query",
            ClusterUrl: "test-server",
            Database: "test-db",
            Type: "mock",
            Timeout: null,
            MaxResults: null
        );

        // Act
        var result = await _handler.ExecuteAsync(request, CancellationToken.None);

        // Assert
        result.Success.Should().BeFalse();
        result.Error.Should().Be("Query execution failed");
    }

    [Fact]
    public async Task ExecuteAsync_HandlesCancellation()
    {
        // Arrange
        _mockDataSource.QueryDelayMs = 5000; // Long delay
        await _mockDataSource.ConnectAsync(new DataSourceConnectionParams
        {
            Server = "test-server",
            Database = "test-db"
        });

        var request = new QueryRequest(
            Query: "test query",
            ClusterUrl: "test-server",
            Database: "test-db",
            Type: "mock",
            Timeout: null,
            MaxResults: null
        );

        using var cts = new CancellationTokenSource();
        cts.CancelAfter(100); // Cancel quickly

        // Act
        var result = await _handler.ExecuteAsync(request, cts.Token);

        // Assert
        result.Success.Should().BeFalse();
        result.Error.Should().Contain("cancelled");
    }

    [Fact]
    public async Task ExecuteAsync_SetsExecutionTime()
    {
        // Arrange
        _mockDataSource.QueryDelayMs = 50;
        await _mockDataSource.ConnectAsync(new DataSourceConnectionParams
        {
            Server = "test-server",
            Database = "test-db"
        });

        var request = new QueryRequest(
            Query: "test query",
            ClusterUrl: "test-server",
            Database: "test-db",
            Type: "mock",
            Timeout: null,
            MaxResults: null
        );

        // Act
        var result = await _handler.ExecuteAsync(request, CancellationToken.None);

        // Assert
        result.ExecutionTimeMs.Should().BeGreaterThanOrEqualTo(50);
    }

    [Fact]
    public void Cancel_CancelsCurrentQuery()
    {
        // Arrange
        _mockDataSource.QueryDelayMs = 10000;

        // Act & Assert - should not throw
        _handler.Cancel();
    }

    [Fact]
    public void GetDataSources_ReturnsRegisteredDataSources()
    {
        // Act
        var dataSources = _handler.GetDataSources();

        // Assert
        dataSources.Should().HaveCount(1);
        dataSources[0].Id.Should().Be("mock");
        dataSources[0].DisplayName.Should().Be("Mock");
    }

    [Fact]
    public async Task ExecuteAsync_DetectsDataSourceFromQuery()
    {
        // Arrange
        var specialMock = new MockDataSource
        {
            Id = "special",
            CanHandleQueryFunc = q => q.Contains("SPECIAL_KEYWORD")
        };

        _registry.Register(new DataSourceRegistration
        {
            Id = "special",
            DisplayName = "Special",
            SortOrder = 0, // Higher priority
            IsEnabled = true,
            Factory = () => specialMock
        });

        await specialMock.ConnectAsync(new DataSourceConnectionParams
        {
            Server = "test",
            Database = "db"
        });

        var request = new QueryRequest(
            Query: "query with SPECIAL_KEYWORD",
            ClusterUrl: "test",
            Database: "db",
            Type: "", // No type hint
            Timeout: null,
            MaxResults: null
        );

        // Act
        var result = await _handler.ExecuteAsync(request, CancellationToken.None);

        // Assert
        specialMock.ExecuteQueryCallCount.Should().Be(1);
    }
}
