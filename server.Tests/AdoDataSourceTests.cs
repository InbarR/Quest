using FluentAssertions;
using Quest.Server.Models;
using Xunit;

namespace Quest.Server.Tests;

public class AdoDataSourceTests
{
    private readonly List<string> _logMessages = new();
    private readonly Action<string> _log;
    private readonly AdoDataSource _dataSource;

    public AdoDataSourceTests()
    {
        _log = msg => _logMessages.Add(msg);
        _dataSource = new AdoDataSource(_log);
    }

    [Fact]
    public void Id_ReturnsAdo()
    {
        _dataSource.Id.Should().Be("ado");
    }

    [Fact]
    public void QueryLanguage_ReturnsWIQL()
    {
        _dataSource.QueryLanguage.Should().Be("WIQL");
    }

    [Fact]
    public void UIConfig_HasCorrectLabels()
    {
        _dataSource.UIConfig.ServerLabel.Should().Be("Organization");
        _dataSource.UIConfig.DatabaseLabel.Should().Be("Project");
        _dataSource.UIConfig.ShowDatabaseSelector.Should().BeTrue();
        _dataSource.UIConfig.SupportsMaxResults.Should().BeTrue();
        _dataSource.UIConfig.DefaultMaxResults.Should().Be(200);
    }

    [Fact]
    public void InitialState_IsDisconnected()
    {
        _dataSource.State.Should().Be(DataSourceConnectionState.Disconnected);
    }

    // CanHandleQuery tests
    [Theory]
    [InlineData("SELECT [System.Id] FROM workitems", true)]
    [InlineData("SELECT Id, Title FROM workitems WHERE State = 'Active'", true)]
    [InlineData("select [system.id] from workitems", true)] // Case insensitive
    [InlineData("// Comment\nSELECT Id FROM workitems", true)] // With comment
    [InlineData("TableName | take 10", false)] // Kusto query
    [InlineData("SELECT * FROM Inbox", false)] // Outlook query
    [InlineData(".show tables", false)] // Kusto command
    public void CanHandleQuery_DetectsWiqlQueries(string query, bool expected)
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
    public void ValidateQuery_ReturnsInvalidForMissingSELECT()
    {
        var result = _dataSource.ValidateQuery("FROM workitems WHERE State = 'Active'");
        result.IsValid.Should().BeFalse();
        result.ErrorMessage.Should().Contain("SELECT");
    }

    [Fact]
    public void ValidateQuery_ReturnsInvalidForMissingFROMWorkitems()
    {
        var result = _dataSource.ValidateQuery("SELECT Id FROM sometable");
        result.IsValid.Should().BeFalse();
        result.ErrorMessage.Should().Contain("FROM workitems");
    }

    [Fact]
    public void ValidateQuery_ReturnsValidForProperWiqlQuery()
    {
        var result = _dataSource.ValidateQuery("SELECT [System.Id] FROM workitems WHERE [System.State] = 'Active'");
        result.IsValid.Should().BeTrue();
    }

    [Fact]
    public void ValidateQuery_IgnoresComments()
    {
        var result = _dataSource.ValidateQuery("// This is a comment\nSELECT Id FROM workitems");
        result.IsValid.Should().BeTrue();
    }

    // FormatQuery tests
    [Fact]
    public void FormatQuery_TrimsWhitespace()
    {
        var result = _dataSource.FormatQuery("  SELECT Id FROM workitems  ");
        result.Should().Be("SELECT Id FROM workitems");
    }

    // Connect tests
    [Fact]
    public async Task ConnectAsync_ReturnsErrorForEmptyOrgUrl()
    {
        var result = await _dataSource.ConnectAsync(new DataSourceConnectionParams
        {
            Server = "",
            Database = "project"
        });

        result.Success.Should().BeFalse();
        result.ErrorMessage.Should().Contain("required");
        _dataSource.State.Should().Be(DataSourceConnectionState.Error);
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
            "SELECT Id FROM workitems",
            "https://dev.azure.com/myorg",
            "myproject"
        );

        url.Should().NotBeNullOrEmpty();
        url.Should().Contain("dev.azure.com/myorg");
        url.Should().Contain("myproject");
    }

    [Fact]
    public void GetExternalViewerUrl_ReturnsNullForMissingOrgUrl()
    {
        var url = _dataSource.GetExternalViewerUrl("query", null, "project");
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
            e.Query.Should().Contain("workitems");
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
        guide.Should().Contain("WIQL");
    }

    // Comment stripping tests
    [Theory]
    [InlineData("// comment\nSELECT Id FROM workitems", true)]
    [InlineData("// line1\n// line2\nSELECT Id FROM workitems", true)]
    [InlineData("SELECT Id FROM workitems // inline is NOT stripped", true)]
    public void ValidateQuery_HandlesCommentsCorrectly(string query, bool expectedValid)
    {
        var result = _dataSource.ValidateQuery(query);
        result.IsValid.Should().Be(expectedValid);
    }
}
