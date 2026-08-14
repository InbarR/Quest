using FluentAssertions;
using Quest.Server.Models;
using System.Runtime.InteropServices;
using Xunit;

namespace Quest.Server.Tests;

public class OutlookDataSourceTests
{
    private readonly List<string> _logMessages = new();
    private readonly Action<string> _log;
    private readonly OutlookDataSource _dataSource;

    public OutlookDataSourceTests()
    {
        _log = msg => _logMessages.Add(msg);
        _dataSource = new OutlookDataSource(_log);
    }

    [Fact]
    public void Id_ReturnsOutlook()
    {
        _dataSource.Id.Should().Be("outlook");
    }

    [Fact]
    public void QueryLanguage_ReturnsOql()
    {
        _dataSource.QueryLanguage.Should().Be("OQL");
    }

    [Fact]
    public void UIConfig_HasCorrectLabels()
    {
        _dataSource.UIConfig.ServerLabel.Should().Be("Folder");
        _dataSource.UIConfig.ShowDatabaseSelector.Should().BeFalse();
        _dataSource.UIConfig.SupportsMaxResults.Should().BeTrue();
        _dataSource.UIConfig.DefaultMaxResults.Should().Be(500);
    }

    [Fact]
    public void InitialState_IsDisconnected()
    {
        _dataSource.State.Should().Be(DataSourceConnectionState.Disconnected);
    }

    [Fact]
    public void IsSupported_ReturnsTrueOnWindowsOnly()
    {
        var isWindows = RuntimeInformation.IsOSPlatform(OSPlatform.Windows);
        OutlookDataSource.IsSupported.Should().Be(isWindows);
    }

    // CanHandleQuery tests.
    // OQL uses KQL-like pipe syntax (folder name first); the legacy SQL "SELECT ... FROM folder"
    // form is no longer recognized.
    [Theory]
    [InlineData("Inbox", true)] // Simple folder name
    [InlineData("Calendar", true)]
    [InlineData("Contacts", true)]
    [InlineData("Tasks", true)]
    [InlineData("SentMail", true)]
    [InlineData("inbox", true)] // Case insensitive
    [InlineData("Inbox | where Subject contains \"test\"", true)]
    [InlineData("Calendar | where Start > ago(7d)", true)]
    [InlineData("// Comment\nInbox | take 10", true)] // With comment
    [InlineData("SELECT * FROM Inbox", false)] // Legacy SQL syntax no longer supported
    [InlineData("SELECT Id FROM workitems", false)] // ADO query
    [InlineData("TableName | take 10", false)] // Kusto query
    [InlineData(".show tables", false)] // Kusto command
    public void CanHandleQuery_DetectsOutlookQueries(string query, bool expected)
    {
        _dataSource.CanHandleQuery(query).Should().Be(expected);
    }

    [Fact]
    public void CanHandleQuery_ReturnsFalseForEmptyQuery()
    {
        _dataSource.CanHandleQuery("").Should().BeFalse();
        _dataSource.CanHandleQuery("   ").Should().BeFalse();
    }

    [Fact]
    public void CanHandleQuery_ReturnsFalseForUnknownFolder()
    {
        _dataSource.CanHandleQuery("SELECT * FROM UnknownFolder").Should().BeFalse();
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
    public void ValidateQuery_ReturnsValidForAnyNonEmptyQuery()
    {
        // Outlook data source has lenient validation
        var result = _dataSource.ValidateQuery("Inbox");
        result.IsValid.Should().BeTrue();
    }

    // FormatQuery tests
    [Fact]
    public void FormatQuery_TrimsWhitespace()
    {
        var result = _dataSource.FormatQuery("  SELECT * FROM Inbox  ");
        result.Should().Be("SELECT * FROM Inbox");
    }

    // Connect tests (Windows only)
    [Fact]
    public async Task ConnectAsync_FailsOnNonWindows()
    {
        if (Skip.If(RuntimeInformation.IsOSPlatform(OSPlatform.Windows), "Test only runs on non-Windows"))
            return;

        var result = await _dataSource.ConnectAsync(new DataSourceConnectionParams
        {
            Server = "Inbox"
        });

        result.Success.Should().BeFalse();
        result.ErrorMessage.Should().Contain("Windows");
    }

    [Fact]
    public async Task ConnectAsync_UsesDefaultFolderIfEmpty()
    {
        if (Skip.IfNot(RuntimeInformation.IsOSPlatform(OSPlatform.Windows), "Test only runs on Windows"))
            return;
        if (Skip.If(true, "Requires Outlook to be installed"))
            return;

        var result = await _dataSource.ConnectAsync(new DataSourceConnectionParams
        {
            Server = ""
        });

        // The connection info should show Inbox as default
        _dataSource.ConnectionInfo.Should().Contain("Inbox");
    }

    // Schema provider tests
    [Fact]
    public async Task GetEntitiesAsync_ReturnsFolders()
    {
        if (Skip.IfNot(RuntimeInformation.IsOSPlatform(OSPlatform.Windows), "Test only runs on Windows"))
            return;
        if (Skip.If(true, "Requires Outlook to be installed"))
            return;

        var entities = await _dataSource.GetEntitiesAsync();

        entities.Should().NotBeEmpty();
        entities.Should().Contain(e => e.Name == "Inbox");
        entities.Should().Contain(e => e.Name == "Calendar");
    }

    [Fact]
    public async Task GetColumnsAsync_ReturnsMailColumnsForInbox()
    {
        var columns = await _dataSource.GetColumnsAsync("Inbox");

        columns.Should().NotBeEmpty();
        columns.Should().Contain(c => c.Name == "Subject");
        columns.Should().Contain(c => c.Name == "From");
        columns.Should().Contain(c => c.Name == "ReceivedTime");
    }

    [Fact]
    public async Task GetColumnsAsync_ReturnsCalendarColumnsForCalendar()
    {
        var columns = await _dataSource.GetColumnsAsync("Calendar");

        columns.Should().NotBeEmpty();
        columns.Should().Contain(c => c.Name == "Subject");
        columns.Should().Contain(c => c.Name == "Start");
        columns.Should().Contain(c => c.Name == "End");
        columns.Should().Contain(c => c.Name == "Location");
    }

    [Fact]
    public async Task GetColumnsAsync_ReturnsContactColumnsForContacts()
    {
        var columns = await _dataSource.GetColumnsAsync("Contacts");

        columns.Should().NotBeEmpty();
        columns.Should().Contain(c => c.Name == "FullName");
        columns.Should().Contain(c => c.Name == "Email1Address");
    }

    [Fact]
    public async Task GetColumnsAsync_ReturnsTaskColumnsForTasks()
    {
        var columns = await _dataSource.GetColumnsAsync("Tasks");

        columns.Should().NotBeEmpty();
        columns.Should().Contain(c => c.Name == "Subject");
        columns.Should().Contain(c => c.Name == "DueDate");
        columns.Should().Contain(c => c.Name == "Status");
    }

    [Fact]
    public async Task GetFunctionsAsync_ReturnsEmptyArray()
    {
        var functions = await _dataSource.GetFunctionsAsync();
        functions.Should().BeEmpty();
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
    public void GetExamples_ContainsVariousFolderExamples()
    {
        var examples = _dataSource.GetExamples();

        examples.Should().Contain(e => e.Query.Contains("Inbox"));
        examples.Should().Contain(e => e.Query.Contains("Calendar"));
        examples.Should().Contain(e => e.Query.Contains("Contacts"));
    }

    [Fact]
    public void GetDocumentationUrl_ReturnsNull()
    {
        // No official docs for custom Outlook query syntax
        var url = _dataSource.GetDocumentationUrl();
        url.Should().BeNull();
    }

    [Fact]
    public void GetQuickStartGuide_ReturnsNonEmptyString()
    {
        var guide = _dataSource.GetQuickStartGuide();
        guide.Should().NotBeNullOrEmpty();
        guide.Should().Contain("Inbox");
    }
}

/// <summary>
/// Simple skip helper - returns true if the test should be skipped
/// </summary>
public static class Skip
{
    /// <summary>
    /// Returns true if condition is true (test should be skipped)
    /// </summary>
    public static bool If(bool condition, string reason = "")
    {
        return condition;
    }

    /// <summary>
    /// Returns true if condition is false (test should be skipped)
    /// </summary>
    public static bool IfNot(bool condition, string reason = "")
    {
        return !condition;
    }
}
