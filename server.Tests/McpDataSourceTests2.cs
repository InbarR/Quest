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
        var result = await _dataSource.ConnectAsync("any-server", "any-database", CancellationToken.None);
        result.Should().BeTrue();
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
    public void SetToolSchema_StoresTools()
    {
        _dataSource.SetToolSchema("test-server", new[]
        {
            new McpToolSchemaInfo("list_items", "List all items", Array.Empty<McpToolParameterInfo>()),
            new McpToolSchemaInfo("get_item", "Get one item", new[] { new McpToolParameterInfo("id", "string", "Item ID", true) })
        });

        var entities = _dataSource.GetSchemaEntities("", "");
        entities.Should().HaveCount(2);
    }

    [Fact]
    public void ClearSchema_RemovesAllTools()
    {
        _dataSource.SetToolSchema("server1", new[]
        {
            new McpToolSchemaInfo("tool1", "desc", Array.Empty<McpToolParameterInfo>())
        });

        _dataSource.ClearSchema();

        var entities = _dataSource.GetSchemaEntities("", "");
        entities.Should().BeEmpty();
    }

    // ============ Query Execution ============

    [Fact]
    public async Task ExecuteQueryAsync_WithMcpResult_AppliesPostProcessing()
    {
        var json = "[{\"name\":\"Alice\",\"age\":\"30\"},{\"name\":\"Bob\",\"age\":\"25\"}]";
        var query = "server | tool() | where name == \"Alice\"";

        var result = await _dataSource.ExecuteQueryAsync(query, "mcp-result", json, CancellationToken.None);

        result.Success.Should().BeTrue();
        result.Rows.Should().HaveCount(1);
    }

    [Fact]
    public async Task ExecuteQueryAsync_WithoutMcpResult_ReturnsMcpInvokeRequired()
    {
        var result = await _dataSource.ExecuteQueryAsync("server | tool()", "server", "", CancellationToken.None);

        result.Success.Should().BeFalse();
        result.Error.Should().StartWith("MCP_INVOKE_REQUIRED:");
    }

    [Fact]
    public async Task ExecuteQueryAsync_WithMcpResult_NoOperators_ReturnsAllData()
    {
        var json = "[{\"id\":\"1\"},{\"id\":\"2\"},{\"id\":\"3\"}]";
        var query = "server | tool()";

        var result = await _dataSource.ExecuteQueryAsync(query, "mcp-result", json, CancellationToken.None);

        result.Success.Should().BeTrue();
        result.Rows.Should().HaveCount(3);
    }

    [Fact]
    public async Task ExecuteQueryAsync_WithMcpResult_TakeOperator()
    {
        var json = "[{\"id\":\"1\"},{\"id\":\"2\"},{\"id\":\"3\"},{\"id\":\"4\"},{\"id\":\"5\"}]";
        var query = "server | tool() | take 2";

        var result = await _dataSource.ExecuteQueryAsync(query, "mcp-result", json, CancellationToken.None);

        result.Success.Should().BeTrue();
        result.Rows.Should().HaveCount(2);
    }

    // ============ Help ============

    [Fact]
    public void GetHelp_ReturnsHelpText()
    {
        var help = _dataSource.GetHelp();
        help.Should().NotBeNull();
        help.Overview.Should().NotBeNullOrWhiteSpace();
    }

    [Fact]
    public void GetExamples_ReturnsExamples()
    {
        var examples = _dataSource.GetExamples();
        examples.Should().NotBeEmpty();
    }
}
