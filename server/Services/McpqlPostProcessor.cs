using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using System.Text.RegularExpressions;
using Quest.Server.Protocol;

namespace Quest.Server.Services;

/// <summary>
/// Applies MCPQL post-processing operators (where, project, take, sort, count, extend)
/// to raw tabular data returned from MCP tool invocations.
/// </summary>
public class McpqlPostProcessor
{
    /// <summary>
    /// Apply a sequence of MCPQL operators to raw query results.
    /// </summary>
    public QueryResult Apply(QueryResult input, List<McpqlOperator> operators)
    {
        if (!input.Success || operators.Count == 0)
            return input;

        var columns = input.Columns.ToList();
        var rows = input.Rows.Select(r => r.ToList()).ToList();

        foreach (var op in operators)
        {
            (columns, rows) = op switch
            {
                McpqlWhereOperator w => ApplyWhere(columns, rows, w),
                McpqlProjectOperator p => ApplyProject(columns, rows, p),
                McpqlTakeOperator t => ApplyTake(columns, rows, t),
                McpqlSortOperator s => ApplySort(columns, rows, s),
                McpqlCountOperator => ApplyCount(columns, rows),
                McpqlExtendOperator e => ApplyExtend(columns, rows, e),
                _ => (columns, rows)
            };
        }

        var resultRows = rows.Select(r => r.ToArray()).ToArray();
        return new QueryResult(
            Success: true,
            Columns: columns.ToArray(),
            Rows: resultRows,
            RowCount: resultRows.Length,
            ExecutionTimeMs: input.ExecutionTimeMs
        );
    }

    /// <summary>
    /// Convert raw JSON (from MCP tool result) into a QueryResult with Columns and Rows.
    /// Handles arrays of objects, single objects, and primitive values.
    /// </summary>
    public static QueryResult JsonToQueryResult(string json, long executionTimeMs = 0)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;

            return root.ValueKind switch
            {
                JsonValueKind.Array => ArrayToQueryResult(root, executionTimeMs),
                JsonValueKind.Object => ObjectToQueryResult(root, executionTimeMs),
                _ => PrimitiveToQueryResult(root, executionTimeMs)
            };
        }
        catch (JsonException ex)
        {
            return new QueryResult(
                Success: false,
                Columns: Array.Empty<string>(),
                Rows: Array.Empty<string[]>(),
                RowCount: 0,
                ExecutionTimeMs: executionTimeMs,
                Error: $"Failed to parse MCP tool result as JSON: {ex.Message}"
            );
        }
    }

    #region JSON Conversion

    private static QueryResult ArrayToQueryResult(JsonElement array, long executionTimeMs)
    {
        var items = array.EnumerateArray().ToList();
        if (items.Count == 0)
        {
            return new QueryResult(
                Success: true,
                Columns: Array.Empty<string>(),
                Rows: Array.Empty<string[]>(),
                RowCount: 0,
                ExecutionTimeMs: executionTimeMs
            );
        }

        // If array of objects, extract columns from all objects (union of keys)
        if (items[0].ValueKind == JsonValueKind.Object)
        {
            var columnSet = new LinkedHashSet<string>();
            foreach (var item in items)
            {
                if (item.ValueKind == JsonValueKind.Object)
                {
                    foreach (var prop in item.EnumerateObject())
                        columnSet.Add(prop.Name);
                }
            }

            var columns = columnSet.ToList();
            var rows = items.Select(item =>
            {
                if (item.ValueKind != JsonValueKind.Object)
                    return columns.Select(_ => "").ToArray();

                return columns.Select(col =>
                {
                    if (item.TryGetProperty(col, out var val))
                        return JsonElementToString(val);
                    return "";
                }).ToArray();
            }).ToArray();

            return new QueryResult(
                Success: true,
                Columns: columns.ToArray(),
                Rows: rows,
                RowCount: rows.Length,
                ExecutionTimeMs: executionTimeMs
            );
        }

        // Array of primitives
        var primColumns = new[] { "value" };
        var primRows = items.Select(item => new[] { JsonElementToString(item) }).ToArray();
        return new QueryResult(
            Success: true,
            Columns: primColumns,
            Rows: primRows,
            RowCount: primRows.Length,
            ExecutionTimeMs: executionTimeMs
        );
    }

    private static QueryResult ObjectToQueryResult(JsonElement obj, long executionTimeMs)
    {
        // Check if the object has array properties that look like the main data
        // (common pattern: { "items": [...], "total": 10 })
        foreach (var prop in obj.EnumerateObject())
        {
            if (prop.Value.ValueKind == JsonValueKind.Array && prop.Value.GetArrayLength() > 0)
            {
                var firstItem = prop.Value.EnumerateArray().First();
                if (firstItem.ValueKind == JsonValueKind.Object)
                {
                    return ArrayToQueryResult(prop.Value, executionTimeMs);
                }
            }
        }

        // Single object → one row with property names as columns
        var columns = obj.EnumerateObject().Select(p => p.Name).ToArray();
        var row = obj.EnumerateObject().Select(p => JsonElementToString(p.Value)).ToArray();
        return new QueryResult(
            Success: true,
            Columns: columns,
            Rows: new[] { row },
            RowCount: 1,
            ExecutionTimeMs: executionTimeMs
        );
    }

    private static QueryResult PrimitiveToQueryResult(JsonElement element, long executionTimeMs)
    {
        return new QueryResult(
            Success: true,
            Columns: new[] { "value" },
            Rows: new[] { new[] { JsonElementToString(element) } },
            RowCount: 1,
            ExecutionTimeMs: executionTimeMs
        );
    }

    private static string JsonElementToString(JsonElement element)
    {
        return element.ValueKind switch
        {
            JsonValueKind.String => element.GetString() ?? "",
            JsonValueKind.Number => element.GetRawText(),
            JsonValueKind.True => "true",
            JsonValueKind.False => "false",
            JsonValueKind.Null => "",
            JsonValueKind.Undefined => "",
            JsonValueKind.Object => element.GetRawText(),
            JsonValueKind.Array => element.GetRawText(),
            _ => element.GetRawText()
        };
    }

    #endregion

    #region Operators

    private (List<string>, List<List<string>>) ApplyWhere(
        List<string> columns, List<List<string>> rows, McpqlWhereOperator where)
    {
        var filtered = rows.Where(row =>
        {
            return where.Conditions.All(condition =>
            {
                var colIndex = columns.IndexOf(condition.Column);
                // Try case-insensitive match
                if (colIndex < 0)
                    colIndex = columns.FindIndex(c => c.Equals(condition.Column, System.StringComparison.OrdinalIgnoreCase));
                if (colIndex < 0 || colIndex >= row.Count)
                    return false;

                var cellValue = row[colIndex];
                return EvaluateCondition(cellValue, condition.Operator, condition.Value);
            });
        }).ToList();

        return (columns, filtered);
    }

    private (List<string>, List<List<string>>) ApplyProject(
        List<string> columns, List<List<string>> rows, McpqlProjectOperator project)
    {
        var indices = project.Columns.Select(col =>
        {
            var idx = columns.IndexOf(col);
            if (idx < 0)
                idx = columns.FindIndex(c => c.Equals(col, System.StringComparison.OrdinalIgnoreCase));
            return (Name: col, Index: idx);
        }).Where(x => x.Index >= 0).ToList();

        var newColumns = indices.Select(x => columns[x.Index]).ToList();
        var newRows = rows.Select(row =>
            indices.Select(x => x.Index < row.Count ? row[x.Index] : "").ToList()
        ).ToList();

        return (newColumns, newRows);
    }

    private (List<string>, List<List<string>>) ApplyTake(
        List<string> columns, List<List<string>> rows, McpqlTakeOperator take)
    {
        return (columns, rows.Take(take.Count).ToList());
    }

    private (List<string>, List<List<string>>) ApplySort(
        List<string> columns, List<List<string>> rows, McpqlSortOperator sort)
    {
        var colIndex = columns.IndexOf(sort.Column);
        if (colIndex < 0)
            colIndex = columns.FindIndex(c => c.Equals(sort.Column, System.StringComparison.OrdinalIgnoreCase));
        if (colIndex < 0)
            return (columns, rows);

        var sorted = sort.Ascending
            ? rows.OrderBy(r => GetSortKey(r, colIndex)).ToList()
            : rows.OrderByDescending(r => GetSortKey(r, colIndex)).ToList();

        return (columns, sorted);
    }

    private (List<string>, List<List<string>>) ApplyCount(
        List<string> columns, List<List<string>> rows)
    {
        return (
            new List<string> { "Count" },
            new List<List<string>> { new List<string> { rows.Count.ToString() } }
        );
    }

    private (List<string>, List<List<string>>) ApplyExtend(
        List<string> columns, List<List<string>> rows, McpqlExtendOperator extend)
    {
        var newColumns = new List<string>(columns) { extend.ColumnName };
        var newRows = rows.Select(row =>
        {
            var newRow = new List<string>(row);
            // Simple expression evaluation: if expression is a column reference, copy it
            var exprColIndex = columns.FindIndex(c => c.Equals(extend.Expression, System.StringComparison.OrdinalIgnoreCase));
            if (exprColIndex >= 0 && exprColIndex < row.Count)
            {
                newRow.Add(row[exprColIndex]);
            }
            else
            {
                // Use expression as literal value
                newRow.Add(extend.Expression);
            }
            return newRow;
        }).ToList();

        return (newColumns, newRows);
    }

    #endregion

    #region Helpers

    private bool EvaluateCondition(string cellValue, string op, string compareValue)
    {
        // Try numeric comparison
        if (double.TryParse(cellValue, NumberStyles.Any, CultureInfo.InvariantCulture, out var cellNum) &&
            double.TryParse(compareValue, NumberStyles.Any, CultureInfo.InvariantCulture, out var compareNum))
        {
            return op switch
            {
                "==" => cellNum == compareNum,
                "!=" => cellNum != compareNum,
                ">" => cellNum > compareNum,
                ">=" => cellNum >= compareNum,
                "<" => cellNum < compareNum,
                "<=" => cellNum <= compareNum,
                _ => StringComparison(cellValue, op, compareValue)
            };
        }

        return StringComparison(cellValue, op, compareValue);
    }

    private bool StringComparison(string cellValue, string op, string compareValue)
    {
        return op.ToLowerInvariant() switch
        {
            "==" => cellValue.Equals(compareValue, System.StringComparison.OrdinalIgnoreCase),
            "!=" => !cellValue.Equals(compareValue, System.StringComparison.OrdinalIgnoreCase),
            "contains" => cellValue.Contains(compareValue, System.StringComparison.OrdinalIgnoreCase),
            "startswith" => cellValue.StartsWith(compareValue, System.StringComparison.OrdinalIgnoreCase),
            "endswith" => cellValue.EndsWith(compareValue, System.StringComparison.OrdinalIgnoreCase),
            "has" => cellValue.Contains(compareValue, System.StringComparison.OrdinalIgnoreCase),
            "matches" => Regex.IsMatch(cellValue, compareValue, RegexOptions.IgnoreCase),
            ">" => string.Compare(cellValue, compareValue, System.StringComparison.OrdinalIgnoreCase) > 0,
            ">=" => string.Compare(cellValue, compareValue, System.StringComparison.OrdinalIgnoreCase) >= 0,
            "<" => string.Compare(cellValue, compareValue, System.StringComparison.OrdinalIgnoreCase) < 0,
            "<=" => string.Compare(cellValue, compareValue, System.StringComparison.OrdinalIgnoreCase) <= 0,
            _ => false
        };
    }

    private object GetSortKey(List<string> row, int colIndex)
    {
        if (colIndex >= row.Count)
            return "";
        var val = row[colIndex];
        if (double.TryParse(val, NumberStyles.Any, CultureInfo.InvariantCulture, out var num))
            return num;
        return val;
    }

    #endregion
}

/// <summary>
/// A LinkedHashSet that preserves insertion order (used for column discovery).
/// </summary>
internal class LinkedHashSet<T> where T : notnull
{
    private readonly HashSet<T> _set = new();
    private readonly List<T> _list = new();

    public bool Add(T item)
    {
        if (_set.Add(item))
        {
            _list.Add(item);
            return true;
        }
        return false;
    }

    public List<T> ToList() => new(_list);
}
