using FluentAssertions;
using Quest.Server.Models;
using Xunit;

namespace Quest.Server.Tests;

public class McpDataSourceTests
{
    private readonly List<string> _logMessages = new();
    private readonly Action<string> _log;
    private readonly McpDataSource _dataSource;

    public McpDataSourceTests()
    {
        _log = msg => _logMessages.Add(msg);
        _dataSource = new McpDataSource(_log);
    }

    [Fact]
    public void Id_ReturnsMcp()
    {
        _dataSource.Id.Should().Be("mcp");
    }

    [Fact]
    public void QueryLanguage_ReturnsMCPQL()
    {
        _dataSource.QueryLanguage.Should().Be("MCPQL");
    }

    [Fact]
    public void DisplayName_IsCorrect()
    {
        _dataSource.DisplayName.Should().Contain("MCP");
    }

    [Fact]
    public void UIConfig_HasCorrectLabels()
    {
        _dataSource.UIConfig.ServerLabel.Should().Be("MCP Server");
        _dataSource.UIConfig.DatabaseLabel.Should().Be("Tool");
        _dataSource.UIConfig.ShowDatabaseSelector.Should().BeFalse();
    }

    [Fact]
    public void State_IsAlwaysConnected()
    {
        _dataSource.State.Should().Be(DataSourceConnectionState.Connected);
    }

    [Fact]
    public async Task ConnectAsync_AlwaysSucceeds()
    {
        var result = await _dataSource.ConnectAsync(
            new DataSourceConnectionParams { Server = "any-server", Database = "any-database" },
            CancellationToken.None);

        result.Success.Should().BeTrue();
    }

    [Fact]
    public void CanHandleQuery_ReturnsTrueForMcpql()
    {
        _dataSource.CanHandleQuery("myserver | tool()").Should().BeTrue();
    }

    [Fact]
    public void CanHandleQuery_ReturnsTrueForDotSyntax()
    {
        _dataSource.CanHandleQuery("myserver.tool()").Should().BeTrue();
    }

    [Fact]
    public void CanHandleQuery_ReturnsFalseForKql()
    {
        _dataSource.CanHandleQuery("StormEvents | take 10").Should().BeFalse();
    }

    [Fact]
    public void CanHandleQuery_ReturnsFalseForEmpty()
    {
        _dataSource.CanHandleQuery("").Should().BeFalse();
    }

    // ============ Schema Management ============

    [Fact]
    public async Task SetToolSchema_StoresTools()
    {
        _dataSource.SetToolSchema("test-server", new[]
        {
            new McpToolSchemaInfo { Name = "list_items", Description = "List all items" },
            new McpToolSchemaInfo
            {
                Name = "get_item",
                Description = "Get one item",
                Parameters = new[]
                {
                    new McpToolParameterInfo { Name = "id", Type = "string", Description = "Item ID", Required = true }
                }
            }
        });

        var entities = await _dataSource.GetEntitiesAsync();
        entities.Should().HaveCount(2);
    }

    [Fact]
    public async Task ClearSchema_RemovesAllTools()
    {
        _dataSource.SetToolSchema("server1", new[]
        {
            new McpToolSchemaInfo { Name = "tool1", Description = "desc" }
        });

        _dataSource.ClearSchema();

        var entities = await _dataSource.GetEntitiesAsync();
        entities.Should().BeEmpty();
    }

    // ============ Query Execution ============

    [Fact]
    public async Task ExecuteQueryAsync_WithMcpResult_AppliesPostProcessing()
    {
        var json = "[{\"name\":\"Alice\",\"age\":\"30\"},{\"name\":\"Bob\",\"age\":\"25\"}]";
        var query = "server | tool() | where name == \"Alice\"";

        var result = await _dataSource.ExecuteQueryAsync(McpResultRequest(query, json), CancellationToken.None);

        result.Success.Should().BeTrue();
        result.Rows.Should().HaveCount(1);
    }

    [Fact]
    public async Task ExecuteQueryAsync_WithoutMcpResult_ReturnsMcpInvokeRequired()
    {
        var result = await _dataSource.ExecuteQueryAsync(
            new DataSourceQueryRequest { Query = "server | tool()", ClusterUrl = "server", Database = "" },
            CancellationToken.None);

        result.Success.Should().BeFalse();
        result.Error.Should().StartWith("MCP_INVOKE_REQUIRED:");
    }

    [Fact]
    public async Task ExecuteQueryAsync_WithMcpResult_NoOperators_ReturnsAllData()
    {
        var json = "[{\"id\":\"1\"},{\"id\":\"2\"},{\"id\":\"3\"}]";
        var query = "server | tool()";

        var result = await _dataSource.ExecuteQueryAsync(McpResultRequest(query, json), CancellationToken.None);

        result.Success.Should().BeTrue();
        result.Rows.Should().HaveCount(3);
    }

    [Fact]
    public async Task ExecuteQueryAsync_WithMcpResult_TakeOperator()
    {
        var json = "[{\"id\":\"1\"},{\"id\":\"2\"},{\"id\":\"3\"},{\"id\":\"4\"},{\"id\":\"5\"}]";
        var query = "server | tool() | take 2";

        var result = await _dataSource.ExecuteQueryAsync(McpResultRequest(query, json), CancellationToken.None);

        result.Success.Should().BeTrue();
        result.Rows.Should().HaveCount(2);
    }

    /// <summary>
    /// The extension transports the raw MCP tool response in the Database field,
    /// flagged by the sentinel ClusterUrl "mcp-result".
    /// </summary>
    private static DataSourceQueryRequest McpResultRequest(string query, string rawJson) => new()
    {
        Query = query,
        ClusterUrl = "mcp-result",
        Database = rawJson
    };

    // ============ Help ============

    [Fact]
    public void GetQuickStartGuide_ReturnsGuideText()
    {
        var guide = _dataSource.GetQuickStartGuide();
        guide.Should().NotBeNullOrWhiteSpace();
    }

    [Fact]
    public void GetDocumentationUrl_ReturnsUrl()
    {
        _dataSource.GetDocumentationUrl().Should().NotBeNullOrWhiteSpace();
    }

    [Fact]
    public void GetExamples_ReturnsExamples()
    {
        var examples = _dataSource.GetExamples();
        examples.Should().NotBeEmpty();
    }
}
