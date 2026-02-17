using FluentAssertions;
using MyTools.Core;
using Quest.Server.Services;
using Xunit;

namespace Quest.Server.Tests;

public class McpqlPostProcessorTests
{
    private readonly McpqlPostProcessor _processor = new();

    // ============ JSON Array → QueryResult ============

    [Fact]
    public void JsonToQueryResult_ArrayOfObjects_ConvertsCorrectly()
    {
        var json = "[{\"name\":\"Alice\",\"age\":30},{\"name\":\"Bob\",\"age\":25}]";
        var result = McpqlPostProcessor.JsonToQueryResult(json);

        result.Columns.Should().Contain("name");
        result.Columns.Should().Contain("age");
        result.Rows.Should().HaveCount(2);
    }

    [Fact]
    public void JsonToQueryResult_SingleObject_WrapsAsOneRow()
    {
        var json = "{\"name\":\"Alice\",\"age\":30}";
        var result = McpqlPostProcessor.JsonToQueryResult(json);

        result.Columns.Should().Contain("name");
        result.Columns.Should().Contain("age");
        result.Rows.Should().HaveCount(1);
    }

    [Fact]
    public void JsonToQueryResult_PrimitiveValue_WrapsInValueColumn()
    {
        var json = "\"hello world\"";
        var result = McpqlPostProcessor.JsonToQueryResult(json);

        result.Columns.Should().Contain("value");
        result.Rows.Should().HaveCount(1);
        result.Rows[0].Should().Contain("hello world");
    }

    [Fact]
    public void JsonToQueryResult_EmptyArray_ReturnsEmptyResult()
    {
        var json = "[]";
        var result = McpqlPostProcessor.JsonToQueryResult(json);

        result.Rows.Should().BeEmpty();
    }

    // ============ Where Operator ============

    [Fact]
    public void Apply_WhereEquals_FiltersCorrectly()
    {
        var json = "[{\"name\":\"Alice\",\"age\":\"30\"},{\"name\":\"Bob\",\"age\":\"25\"}]";
        var result = McpqlPostProcessor.JsonToQueryResult(json);

        var operators = new List<McpqlOperator>
        {
            new McpqlWhereOperator
            {
                Conditions = new List<McpqlCondition>
                {
                    new() { Column = "name", Operator = "==", Value = "Alice" }
                }
            }
        };

        var filtered = _processor.Apply(result, operators);

        filtered.Rows.Should().HaveCount(1);
        var nameIdx = filtered.Columns.IndexOf("name");
        filtered.Rows[0][nameIdx].Should().Be("Alice");
    }

    [Fact]
    public void Apply_WhereNumericGreaterThan_FiltersCorrectly()
    {
        var json = "[{\"name\":\"Alice\",\"score\":\"90\"},{\"name\":\"Bob\",\"score\":\"50\"},{\"name\":\"Charlie\",\"score\":\"75\"}]";
        var result = McpqlPostProcessor.JsonToQueryResult(json);

        var operators = new List<McpqlOperator>
        {
            new McpqlWhereOperator
            {
                Conditions = new List<McpqlCondition>
                {
                    new() { Column = "score", Operator = ">", Value = "70" }
                }
            }
        };

        var filtered = _processor.Apply(result, operators);

        filtered.Rows.Should().HaveCount(2); // Alice (90) and Charlie (75)
    }

    [Fact]
    public void Apply_WhereContains_FiltersCorrectly()
    {
        var json = "[{\"name\":\"Alice Smith\"},{\"name\":\"Bob Jones\"},{\"name\":\"Alice Cooper\"}]";
        var result = McpqlPostProcessor.JsonToQueryResult(json);

        var operators = new List<McpqlOperator>
        {
            new McpqlWhereOperator
            {
                Conditions = new List<McpqlCondition>
                {
                    new() { Column = "name", Operator = "contains", Value = "Alice" }
                }
            }
        };

        var filtered = _processor.Apply(result, operators);

        filtered.Rows.Should().HaveCount(2);
    }

    // ============ Project Operator ============

    [Fact]
    public void Apply_Project_SelectsColumns()
    {
        var json = "[{\"name\":\"Alice\",\"age\":\"30\",\"city\":\"NYC\"}]";
        var result = McpqlPostProcessor.JsonToQueryResult(json);

        var operators = new List<McpqlOperator>
        {
            new McpqlProjectOperator { Columns = new List<string> { "name", "city" } }
        };

        var projected = _processor.Apply(result, operators);

        projected.Columns.Should().BeEquivalentTo(new[] { "name", "city" });
        projected.Rows[0].Should().HaveCount(2);
    }

    // ============ Take Operator ============

    [Fact]
    public void Apply_Take_LimitsRows()
    {
        var json = "[{\"id\":\"1\"},{\"id\":\"2\"},{\"id\":\"3\"},{\"id\":\"4\"},{\"id\":\"5\"}]";
        var result = McpqlPostProcessor.JsonToQueryResult(json);

        var operators = new List<McpqlOperator>
        {
            new McpqlTakeOperator { Count = 3 }
        };

        var limited = _processor.Apply(result, operators);

        limited.Rows.Should().HaveCount(3);
    }

    // ============ Sort Operator ============

    [Fact]
    public void Apply_SortAscending_SortsCorrectly()
    {
        var json = "[{\"name\":\"Charlie\"},{\"name\":\"Alice\"},{\"name\":\"Bob\"}]";
        var result = McpqlPostProcessor.JsonToQueryResult(json);

        var operators = new List<McpqlOperator>
        {
            new McpqlSortOperator { Column = "name", Descending = false }
        };

        var sorted = _processor.Apply(result, operators);

        var nameIdx = sorted.Columns.IndexOf("name");
        sorted.Rows[0][nameIdx].Should().Be("Alice");
        sorted.Rows[1][nameIdx].Should().Be("Bob");
        sorted.Rows[2][nameIdx].Should().Be("Charlie");
    }

    [Fact]
    public void Apply_SortDescending_SortsCorrectly()
    {
        var json = "[{\"value\":\"10\"},{\"value\":\"30\"},{\"value\":\"20\"}]";
        var result = McpqlPostProcessor.JsonToQueryResult(json);

        var operators = new List<McpqlOperator>
        {
            new McpqlSortOperator { Column = "value", Descending = true }
        };

        var sorted = _processor.Apply(result, operators);

        var valIdx = sorted.Columns.IndexOf("value");
        sorted.Rows[0][valIdx].Should().Be("30");
        sorted.Rows[1][valIdx].Should().Be("20");
        sorted.Rows[2][valIdx].Should().Be("10");
    }

    // ============ Count Operator ============

    [Fact]
    public void Apply_Count_ReturnsRowCount()
    {
        var json = "[{\"id\":\"1\"},{\"id\":\"2\"},{\"id\":\"3\"}]";
        var result = McpqlPostProcessor.JsonToQueryResult(json);

        var operators = new List<McpqlOperator>
        {
            new McpqlCountOperator()
        };

        var counted = _processor.Apply(result, operators);

        counted.Columns.Should().Contain("count");
        counted.Rows.Should().HaveCount(1);
        counted.Rows[0][0].Should().Be("3");
    }

    // ============ Extend Operator ============

    [Fact]
    public void Apply_Extend_AddsColumn()
    {
        var json = "[{\"name\":\"Alice\",\"score\":\"90\"},{\"name\":\"Bob\",\"score\":\"80\"}]";
        var result = McpqlPostProcessor.JsonToQueryResult(json);

        var operators = new List<McpqlOperator>
        {
            new McpqlExtendOperator { NewColumn = "score_copy", Expression = "score" }
        };

        var extended = _processor.Apply(result, operators);

        extended.Columns.Should().Contain("score_copy");
        var copyIdx = extended.Columns.IndexOf("score_copy");
        extended.Rows[0][copyIdx].Should().Be("90");
    }

    // ============ Chained Operators ============

    [Fact]
    public void Apply_ChainedOperators_AppliesInOrder()
    {
        var json = "[{\"name\":\"Alice\",\"score\":\"90\"},{\"name\":\"Bob\",\"score\":\"50\"},{\"name\":\"Charlie\",\"score\":\"75\"}]";
        var result = McpqlPostProcessor.JsonToQueryResult(json);

        var operators = new List<McpqlOperator>
        {
            new McpqlWhereOperator
            {
                Conditions = new List<McpqlCondition>
                {
                    new() { Column = "score", Operator = ">", Value = "60" }
                }
            },
            new McpqlSortOperator { Column = "score", Descending = true },
            new McpqlProjectOperator { Columns = new List<string> { "name" } },
            new McpqlTakeOperator { Count = 1 }
        };

        var final = _processor.Apply(result, operators);

        final.Columns.Should().BeEquivalentTo(new[] { "name" });
        final.Rows.Should().HaveCount(1);
        final.Rows[0][0].Should().Be("Alice"); // Highest score after filtering
    }

    // ============ No Operators ============

    [Fact]
    public void Apply_NoOperators_ReturnsOriginal()
    {
        var json = "[{\"name\":\"Alice\"},{\"name\":\"Bob\"}]";
        var result = McpqlPostProcessor.JsonToQueryResult(json);

        var final = _processor.Apply(result, new List<McpqlOperator>());

        final.Rows.Should().HaveCount(2);
    }

    // ============ Edge Cases ============

    [Fact]
    public void JsonToQueryResult_ObjectWithArrayProperty_FlattensMainArray()
    {
        var json = "{\"data\":[{\"id\":\"1\"},{\"id\":\"2\"}]}";
        var result = McpqlPostProcessor.JsonToQueryResult(json);

        result.Rows.Should().HaveCount(2);
        result.Columns.Should().Contain("id");
    }

    [Fact]
    public void Apply_WhereOnMissingColumn_ReturnsNoRows()
    {
        var json = "[{\"name\":\"Alice\"}]";
        var result = McpqlPostProcessor.JsonToQueryResult(json);

        var operators = new List<McpqlOperator>
        {
            new McpqlWhereOperator
            {
                Conditions = new List<McpqlCondition>
                {
                    new() { Column = "nonexistent", Operator = "==", Value = "foo" }
                }
            }
        };

        var filtered = _processor.Apply(result, operators);

        filtered.Rows.Should().BeEmpty();
    }
}
