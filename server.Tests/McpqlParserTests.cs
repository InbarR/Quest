using FluentAssertions;
using Quest.Server.Services;
using Xunit;

namespace Quest.Server.Tests;

public class McpqlParserTests
{
    private readonly McpqlParser _parser = new();

    // ============ Basic Parsing ============

    [Fact]
    public void Parse_PipeSyntax_ServerAndTool()
    {
        var query = "myserver | list_items()";
        var result = _parser.Parse(query);

        result.ServerName.Should().Be("myserver");
        result.ToolName.Should().Be("list_items");
        result.Parameters.Should().BeEmpty();
        result.Operators.Should().BeEmpty();
    }

    [Fact]
    public void Parse_DotSyntax_ServerAndTool()
    {
        var query = "myserver.list_items()";
        var result = _parser.Parse(query);

        result.ServerName.Should().Be("myserver");
        result.ToolName.Should().Be("list_items");
        result.Parameters.Should().BeEmpty();
    }

    [Fact]
    public void Parse_WithStringParameter()
    {
        var query = "github | search_repos(query=\"dotnet\")";
        var result = _parser.Parse(query);

        result.ServerName.Should().Be("github");
        result.ToolName.Should().Be("search_repos");
        result.Parameters.Should().ContainKey("query");
        result.Parameters["query"].Should().Be("dotnet");
    }

    [Fact]
    public void Parse_WithMultipleParameters()
    {
        var query = "github | list_issues(owner=\"microsoft\", repo=\"vscode\", state=\"open\")";
        var result = _parser.Parse(query);

        result.ServerName.Should().Be("github");
        result.ToolName.Should().Be("list_issues");
        result.Parameters.Should().HaveCount(3);
        result.Parameters["owner"].Should().Be("microsoft");
        result.Parameters["repo"].Should().Be("vscode");
        result.Parameters["state"].Should().Be("open");
    }

    [Fact]
    public void Parse_WithNumericParameter()
    {
        var query = "api | get_data(limit=50)";
        var result = _parser.Parse(query);

        result.Parameters["limit"].Should().Be("50");
    }

    [Fact]
    public void Parse_WithBooleanParameter()
    {
        var query = "api | get_data(verbose=true)";
        var result = _parser.Parse(query);

        result.Parameters["verbose"].Should().Be("true");
    }

    // ============ Post-Processing Operators ============

    [Fact]
    public void Parse_WithWhereOperator()
    {
        var query = "github | list_repos(owner=\"microsoft\") | where stars > 100";
        var result = _parser.Parse(query);

        result.Operators.Should().HaveCount(1);
        result.Operators[0].Should().BeOfType<McpqlWhereOperator>();
        var where = (McpqlWhereOperator)result.Operators[0];
        where.Conditions.Should().HaveCount(1);
        where.Conditions[0].Column.Should().Be("stars");
        where.Conditions[0].Operator.Should().Be(">");
        where.Conditions[0].Value.Should().Be("100");
    }

    [Fact]
    public void Parse_WithProjectOperator()
    {
        var query = "github | list_repos(owner=\"microsoft\") | project name, stars, language";
        var result = _parser.Parse(query);

        result.Operators.Should().HaveCount(1);
        result.Operators[0].Should().BeOfType<McpqlProjectOperator>();
        var project = (McpqlProjectOperator)result.Operators[0];
        project.Columns.Should().BeEquivalentTo(new[] { "name", "stars", "language" });
    }

    [Fact]
    public void Parse_WithTakeOperator()
    {
        var query = "github | list_repos(owner=\"microsoft\") | take 10";
        var result = _parser.Parse(query);

        result.Operators.Should().HaveCount(1);
        result.Operators[0].Should().BeOfType<McpqlTakeOperator>();
        ((McpqlTakeOperator)result.Operators[0]).Count.Should().Be(10);
    }

    [Fact]
    public void Parse_WithSortOperator()
    {
        var query = "github | list_repos(owner=\"microsoft\") | sort by stars desc";
        var result = _parser.Parse(query);

        result.Operators.Should().HaveCount(1);
        result.Operators[0].Should().BeOfType<McpqlSortOperator>();
        var sort = (McpqlSortOperator)result.Operators[0];
        sort.Column.Should().Be("stars");
        sort.Descending.Should().BeTrue();
    }

    [Fact]
    public void Parse_WithCountOperator()
    {
        var query = "github | list_repos(owner=\"microsoft\") | count";
        var result = _parser.Parse(query);

        result.Operators.Should().HaveCount(1);
        result.Operators[0].Should().BeOfType<McpqlCountOperator>();
    }

    [Fact]
    public void Parse_WithExtendOperator()
    {
        var query = "github | list_repos(owner=\"microsoft\") | extend doubled = stars";
        var result = _parser.Parse(query);

        result.Operators.Should().HaveCount(1);
        result.Operators[0].Should().BeOfType<McpqlExtendOperator>();
        var extend = (McpqlExtendOperator)result.Operators[0];
        extend.NewColumn.Should().Be("doubled");
        extend.Expression.Should().Be("stars");
    }

    [Fact]
    public void Parse_WithMultipleOperators()
    {
        var query = "github | list_repos(owner=\"microsoft\") | where stars > 100 | project name, stars | sort by stars desc | take 5";
        var result = _parser.Parse(query);

        result.Operators.Should().HaveCount(4);
        result.Operators[0].Should().BeOfType<McpqlWhereOperator>();
        result.Operators[1].Should().BeOfType<McpqlProjectOperator>();
        result.Operators[2].Should().BeOfType<McpqlSortOperator>();
        result.Operators[3].Should().BeOfType<McpqlTakeOperator>();
    }

    // ============ Detection ============

    [Theory]
    [InlineData("server | tool()", true)]
    [InlineData("server.tool()", true)]
    [InlineData("server | tool(param=\"value\")", true)]
    [InlineData("SELECT * FROM table", false)]
    [InlineData("StormEvents | take 10", false)]
    [InlineData("", false)]
    public void LooksLikeMcpql_DetectsCorrectly(string query, bool expected)
    {
        McpqlParser.LooksLikeMcpql(query).Should().Be(expected);
    }

    // ============ Formatting ============

    [Fact]
    public void Format_ProducesReadableOutput()
    {
        var query = "github | list_repos(owner=\"microsoft\") | where stars > 100 | take 5";
        var parsed = _parser.Parse(query);
        var formatted = McpqlParser.Format(parsed);

        formatted.Should().Contain("github");
        formatted.Should().Contain("list_repos");
        formatted.Should().Contain("where");
        formatted.Should().Contain("take");
    }

    // ============ Validation ============

    [Fact]
    public void Validate_ValidQuery_ReturnsNoErrors()
    {
        var query = "server | tool(param=\"value\")";
        var parsed = _parser.Parse(query);
        var errors = McpqlParser.Validate(parsed);

        errors.Should().BeEmpty();
    }

    [Fact]
    public void Validate_MissingServerName_ReturnsError()
    {
        var query = new McpqlQuery { ServerName = "", ToolName = "tool" };
        var errors = McpqlParser.Validate(query);

        errors.Should().ContainMatch("*server*");
    }

    [Fact]
    public void Validate_MissingToolName_ReturnsError()
    {
        var query = new McpqlQuery { ServerName = "server", ToolName = "" };
        var errors = McpqlParser.Validate(query);

        errors.Should().ContainMatch("*tool*");
    }

    // ============ Error Handling ============

    [Fact]
    public void Parse_EmptyQuery_ThrowsMcpqlParseException()
    {
        var action = () => _parser.Parse("");
        action.Should().Throw<McpqlParseException>();
    }

    [Fact]
    public void Parse_InvalidSyntax_ThrowsMcpqlParseException()
    {
        var action = () => _parser.Parse("just some random text without pipe or dot");
        action.Should().Throw<McpqlParseException>();
    }

    // ============ Comments ============

    [Fact]
    public void Parse_IgnoresLineComments()
    {
        var query = "// this is a comment\nserver | tool()";
        var result = _parser.Parse(query);

        result.ServerName.Should().Be("server");
        result.ToolName.Should().Be("tool");
    }

    // ============ Hyphens in names ============

    [Fact]
    public void Parse_HandlesHyphenatedServerNames()
    {
        var query = "my-server | my-tool()";
        var result = _parser.Parse(query);

        result.ServerName.Should().Be("my-server");
        result.ToolName.Should().Be("my-tool");
    }
}
