using FluentAssertions;
using MyTools.Core;
using NSubstitute;
using Quest.Server.Models;
using Xunit;

namespace Quest.Server.Tests;

public class KustoDataSourceTests
{
    private readonly List<string> _logMessages = new();
    private readonly Action<string> _log;
    private readonly KustoService _kustoService;
    private readonly KustoDataSource _dataSource;

    public KustoDataSourceTests()
    {
        _log = msg => _logMessages.Add(msg);
        _kustoService = new KustoService();
        _dataSource = new KustoDataSource(_kustoService, null, _log);
    }

    [Fact]
    public void Id_ReturnsKusto()
    {
        _dataSource.Id.Should().Be("kusto");
    }

    [Fact]
    public void QueryLanguage_ReturnsKQL()
    {
        _dataSource.QueryLanguage.Should().Be("KQL");
    }

    [Fact]
    public void UIConfig_HasCorrectLabels()
    {
        _dataSource.UIConfig.ServerLabel.Should().Be("Cluster");
        _dataSource.UIConfig.DatabaseLabel.Should().Be("Database");
        _dataSource.UIConfig.ShowDatabaseSelector.Should().BeTrue();
    }

    [Fact]
    public void InitialState_IsDisconnected()
    {
        _dataSource.State.Should().Be(DataSourceConnectionState.Disconnected);
    }

    // CanHandleQuery tests
    [Theory]
    [InlineData("TableName | take 10", true)]
    [InlineData("TableName | where Column == 'value'", true)]
    [InlineData(".show tables", true)]
    [InlineData(".show databases", true)]
    [InlineData("MyTable\n| summarize count()", true)]
    [InlineData("SELECT * FROM Inbox", false)] // Outlook query
    [InlineData("SELECT Id FROM workitems", false)] // ADO query pattern detected as SQL
    public void CanHandleQuery_DetectsKustoQueries(string query, bool expected)
    {
        _dataSource.CanHandleQuery(query).Should().Be(expected);
    }

    [Fact]
    public void CanHandleQuery_ReturnsFalseForEmptyQuery()
    {
        _dataSource.CanHandleQuery("").Should().BeFalse();
        _dataSource.CanHandleQuery("   ").Should().BeFalse();
    }

    // ValidateQuery tests
    [Fact]
    public void ValidateQuery_ReturnsInvalidForEmptyQuery()
    {
        var result = _dataSource.ValidateQuery("");
        result.IsValid.Should().BeFalse();
        result.ErrorMessage.Should().Contain("empty");
    }

    [Fact]
    public void ValidateQuery_ReturnsInvalidForWhitespaceQuery()
    {
        var result = _dataSource.ValidateQuery("   ");
        result.IsValid.Should().BeFalse();
    }

    [Fact]
    public void ValidateQuery_ReturnsValidForNonEmptyQuery()
    {
        var result = _dataSource.ValidateQuery("TableName | take 10");
        result.IsValid.Should().BeTrue();
    }

    // FormatQuery tests
    [Fact]
    public void FormatQuery_TrimsWhitespace()
    {
        var result = _dataSource.FormatQuery("  TableName | take 10  ");
        result.Should().Be("TableName | take 10");
    }

    // Connect tests
    [Fact]
    public async Task ConnectAsync_ReturnsErrorForEmptyClusterUrl()
    {
        var result = await _dataSource.ConnectAsync(new DataSourceConnectionParams
        {
            Server = "",
            Database = "testdb"
        });

        result.Success.Should().BeFalse();
        result.ErrorMessage.Should().Contain("required");
        _dataSource.State.Should().Be(DataSourceConnectionState.Error);
    }

    [Fact]
    public async Task ConnectAsync_SucceedsWithValidParams()
    {
        var result = await _dataSource.ConnectAsync(new DataSourceConnectionParams
        {
            Server = "testcluster",
            Database = "testdb"
        });

        result.Success.Should().BeTrue();
        _dataSource.State.Should().Be(DataSourceConnectionState.Connected);
        _dataSource.ConnectionInfo.Should().Contain("testcluster");
    }

    [Fact]
    public async Task ConnectAsync_RaisesStateChangedEvent()
    {
        var stateChanges = new List<DataSourceConnectionState>();
        _dataSource.ConnectionStateChanged += (s, e) => stateChanges.Add(e.NewState);

        await _dataSource.ConnectAsync(new DataSourceConnectionParams
        {
            Server = "testcluster",
            Database = "testdb"
        });

        stateChanges.Should().Contain(DataSourceConnectionState.Connecting);
        stateChanges.Should().Contain(DataSourceConnectionState.Connected);
    }

    // Disconnect tests
    [Fact]
    public async Task DisconnectAsync_SetsStateToDisconnected()
    {
        await _dataSource.ConnectAsync(new DataSourceConnectionParams
        {
            Server = "testcluster",
            Database = "testdb"
        });

        await _dataSource.DisconnectAsync();

        _dataSource.State.Should().Be(DataSourceConnectionState.Disconnected);
        _dataSource.ConnectionInfo.Should().BeEmpty();
    }

    // External viewer tests
    [Fact]
    public void SupportsExternalViewer_ReturnsTrue()
    {
        _dataSource.SupportsExternalViewer.Should().BeTrue();
    }

    [Fact]
    public void GetExternalViewerUrl_ReturnsValidUrl()
    {
        var url = _dataSource.GetExternalViewerUrl(
            "TableName | take 10",
            "https://mycluster.kusto.windows.net",
            "mydb"
        );

        url.Should().NotBeNullOrEmpty();
        url.Should().Contain("dataexplorer.azure.com");
        url.Should().Contain("mydb");
    }

    [Fact]
    public void GetExternalViewerUrl_ReturnsNullForMissingParams()
    {
        var url = _dataSource.GetExternalViewerUrl("query", null, null);
        url.Should().BeNull();
    }

    // Examples tests
    [Fact]
    public void GetExamples_ReturnsNonEmptyArray()
    {
        var examples = _dataSource.GetExamples();
        examples.Should().NotBeEmpty();
        examples.Should().AllSatisfy(e =>
        {
            e.Title.Should().NotBeNullOrEmpty();
            e.Query.Should().NotBeNullOrEmpty();
        });
    }

    [Fact]
    public void GetDocumentationUrl_ReturnsValidUrl()
    {
        var url = _dataSource.GetDocumentationUrl();
        url.Should().NotBeNullOrEmpty();
        url.Should().StartWith("https://");
    }

    [Fact]
    public void GetQuickStartGuide_ReturnsNonEmptyString()
    {
        var guide = _dataSource.GetQuickStartGuide();
        guide.Should().NotBeNullOrEmpty();
    }
}
