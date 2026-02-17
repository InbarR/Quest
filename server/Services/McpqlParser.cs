using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;

namespace Quest.Server.Services;

/// <summary>
/// Parses MCPQL (MCP Query Language) queries.
/// 
/// Grammar:
///   query       := source pipe_chain?
///   source      := server '|' tool '(' params ')'
///                 | server '.' tool '(' params ')'
///   params      := param (',' param)* | empty
///   param       := name '=' value
///   value       := string_literal | number | boolean
///   pipe_chain  := ('|' operator)*
///   operator    := where_op | project_op | take_op | sort_op | count_op | extend_op
///   where_op    := 'where' expression
///   project_op  := 'project' column_list
///   take_op     := 'take' number
///   sort_op     := 'sort' 'by' column ('asc'|'desc')?
///   count_op    := 'count'
///   extend_op   := 'extend' name '=' expression
/// 
/// Examples:
///   github | list_issues(repo='org/repo') | where state == 'open' | project title, author | take 10
///   filesystem.read_file(path='/tmp/data.csv')
///   fetch | get(url='https://api.example.com/data') | where status == 200
/// </summary>
public class McpqlParser
{
    /// <summary>
    /// Parse an MCPQL query string into a structured representation.
    /// </summary>
    public McpqlQuery Parse(string query)
    {
        if (string.IsNullOrWhiteSpace(query))
            throw new McpqlParseException("Query cannot be empty", 0, 0);

        // Strip comments
        var cleanQuery = StripComments(query);
        if (string.IsNullOrWhiteSpace(cleanQuery))
            throw new McpqlParseException("Query contains only comments", 0, 0);

        var tokens = Tokenize(cleanQuery);
        if (tokens.Count == 0)
            throw new McpqlParseException("Query cannot be empty", 0, 0);

        return ParseTokens(tokens);
    }

    /// <summary>
    /// Validate an MCPQL query without fully parsing the post-processing chain.
    /// Returns null if valid, or an error message if invalid.
    /// </summary>
    public McpqlValidationResult Validate(string query)
    {
        try
        {
            Parse(query);
            return McpqlValidationResult.Valid();
        }
        catch (McpqlParseException ex)
        {
            return McpqlValidationResult.Invalid(ex.Message, ex.Line, ex.Column);
        }
    }

    /// <summary>
    /// Format/prettify an MCPQL query.
    /// </summary>
    public string Format(string query)
    {
        try
        {
            var parsed = Parse(query);
            return FormatQuery(parsed);
        }
        catch
        {
            return query; // Return original if parsing fails
        }
    }

    /// <summary>
    /// Detect if a string looks like an MCPQL query.
    /// </summary>
    public static bool LooksLikeMcpql(string query)
    {
        if (string.IsNullOrWhiteSpace(query))
            return false;

        var trimmed = query.Trim();

        // Pattern: identifier | identifier(...)
        // Pattern: identifier.identifier(...)
        if (Regex.IsMatch(trimmed, @"^\w[\w\-]*\s*\|\s*\w[\w\-]*\s*\(", RegexOptions.IgnoreCase))
            return true;

        if (Regex.IsMatch(trimmed, @"^\w[\w\-]*\.\w[\w\-]*\s*\(", RegexOptions.IgnoreCase))
            return true;

        return false;
    }

    #region Tokenizer

    private List<McpqlToken> Tokenize(string input)
    {
        var tokens = new List<McpqlToken>();
        int pos = 0;
        int line = 1;
        int col = 1;

        while (pos < input.Length)
        {
            // Skip whitespace
            if (char.IsWhiteSpace(input[pos]))
            {
                if (input[pos] == '\n') { line++; col = 1; }
                else { col++; }
                pos++;
                continue;
            }

            int startCol = col;
            int startLine = line;

            // String literal (single or double quoted)
            if (input[pos] == '\'' || input[pos] == '"')
            {
                var quote = input[pos];
                var sb = new System.Text.StringBuilder();
                pos++; col++;
                while (pos < input.Length && input[pos] != quote)
                {
                    if (input[pos] == '\\' && pos + 1 < input.Length)
                    {
                        sb.Append(input[pos + 1]);
                        pos += 2; col += 2;
                    }
                    else
                    {
                        sb.Append(input[pos]);
                        pos++; col++;
                    }
                }
                if (pos >= input.Length)
                    throw new McpqlParseException($"Unterminated string literal", startLine, startCol);
                pos++; col++; // consume closing quote
                tokens.Add(new McpqlToken(McpqlTokenType.String, sb.ToString(), startLine, startCol));
                continue;
            }

            // Number
            if (char.IsDigit(input[pos]) || (input[pos] == '-' && pos + 1 < input.Length && char.IsDigit(input[pos + 1])))
            {
                var start = pos;
                if (input[pos] == '-') { pos++; col++; }
                while (pos < input.Length && (char.IsDigit(input[pos]) || input[pos] == '.'))
                {
                    pos++; col++;
                }
                tokens.Add(new McpqlToken(McpqlTokenType.Number, input[start..pos], startLine, startCol));
                continue;
            }

            // Operators and punctuation
            switch (input[pos])
            {
                case '|':
                    tokens.Add(new McpqlToken(McpqlTokenType.Pipe, "|", line, col));
                    pos++; col++;
                    continue;
                case '(':
                    tokens.Add(new McpqlToken(McpqlTokenType.OpenParen, "(", line, col));
                    pos++; col++;
                    continue;
                case ')':
                    tokens.Add(new McpqlToken(McpqlTokenType.CloseParen, ")", line, col));
                    pos++; col++;
                    continue;
                case ',':
                    tokens.Add(new McpqlToken(McpqlTokenType.Comma, ",", line, col));
                    pos++; col++;
                    continue;
                case '.':
                    tokens.Add(new McpqlToken(McpqlTokenType.Dot, ".", line, col));
                    pos++; col++;
                    continue;
                case '=':
                    if (pos + 1 < input.Length && input[pos + 1] == '=')
                    {
                        tokens.Add(new McpqlToken(McpqlTokenType.Operator, "==", line, col));
                        pos += 2; col += 2;
                    }
                    else
                    {
                        tokens.Add(new McpqlToken(McpqlTokenType.Equals, "=", line, col));
                        pos++; col++;
                    }
                    continue;
                case '!':
                    if (pos + 1 < input.Length && input[pos + 1] == '=')
                    {
                        tokens.Add(new McpqlToken(McpqlTokenType.Operator, "!=", line, col));
                        pos += 2; col += 2;
                    }
                    else
                    {
                        throw new McpqlParseException($"Unexpected character '!'", line, col);
                    }
                    continue;
                case '>':
                    if (pos + 1 < input.Length && input[pos + 1] == '=')
                    {
                        tokens.Add(new McpqlToken(McpqlTokenType.Operator, ">=", line, col));
                        pos += 2; col += 2;
                    }
                    else
                    {
                        tokens.Add(new McpqlToken(McpqlTokenType.Operator, ">", line, col));
                        pos++; col++;
                    }
                    continue;
                case '<':
                    if (pos + 1 < input.Length && input[pos + 1] == '=')
                    {
                        tokens.Add(new McpqlToken(McpqlTokenType.Operator, "<=", line, col));
                        pos += 2; col += 2;
                    }
                    else
                    {
                        tokens.Add(new McpqlToken(McpqlTokenType.Operator, "<", line, col));
                        pos++; col++;
                    }
                    continue;
            }

            // Identifiers and keywords
            if (char.IsLetter(input[pos]) || input[pos] == '_' || input[pos] == '-')
            {
                var start = pos;
                while (pos < input.Length && (char.IsLetterOrDigit(input[pos]) || input[pos] == '_' || input[pos] == '-'))
                {
                    pos++; col++;
                }
                var word = input[start..pos];
                var type = word.ToLowerInvariant() switch
                {
                    "where" => McpqlTokenType.Where,
                    "project" => McpqlTokenType.Project,
                    "take" => McpqlTokenType.Take,
                    "sort" => McpqlTokenType.Sort,
                    "by" => McpqlTokenType.By,
                    "count" => McpqlTokenType.Count,
                    "extend" => McpqlTokenType.Extend,
                    "asc" => McpqlTokenType.Asc,
                    "desc" => McpqlTokenType.Desc,
                    "and" => McpqlTokenType.And,
                    "or" => McpqlTokenType.Or,
                    "not" => McpqlTokenType.Not,
                    "true" => McpqlTokenType.Boolean,
                    "false" => McpqlTokenType.Boolean,
                    "contains" => McpqlTokenType.Operator,
                    "startswith" => McpqlTokenType.Operator,
                    "endswith" => McpqlTokenType.Operator,
                    "has" => McpqlTokenType.Operator,
                    "matches" => McpqlTokenType.Operator,
                    _ => McpqlTokenType.Identifier
                };
                tokens.Add(new McpqlToken(type, word, startLine, startCol));
                continue;
            }

            throw new McpqlParseException($"Unexpected character '{input[pos]}'", line, col);
        }

        return tokens;
    }

    #endregion

    #region Parser

    private McpqlQuery ParseTokens(List<McpqlToken> tokens)
    {
        int pos = 0;

        // Parse server name
        if (pos >= tokens.Count || tokens[pos].Type != McpqlTokenType.Identifier)
            throw new McpqlParseException("Expected server name", tokens[0].Line, tokens[0].Column);

        var serverName = tokens[pos].Value;
        pos++;

        // Parse separator: '|' or '.'
        if (pos >= tokens.Count)
            throw new McpqlParseException("Expected '|' or '.' after server name", tokens[pos - 1].Line, tokens[pos - 1].Column);

        string toolName;
        if (tokens[pos].Type == McpqlTokenType.Pipe)
        {
            pos++; // consume pipe
            if (pos >= tokens.Count || tokens[pos].Type != McpqlTokenType.Identifier)
                throw new McpqlParseException("Expected tool name after '|'", tokens[pos - 1].Line, tokens[pos - 1].Column);
            toolName = tokens[pos].Value;
            pos++;
        }
        else if (tokens[pos].Type == McpqlTokenType.Dot)
        {
            pos++; // consume dot
            if (pos >= tokens.Count || tokens[pos].Type != McpqlTokenType.Identifier)
                throw new McpqlParseException("Expected tool name after '.'", tokens[pos - 1].Line, tokens[pos - 1].Column);
            toolName = tokens[pos].Value;
            pos++;
        }
        else
        {
            throw new McpqlParseException($"Expected '|' or '.' after server name, got '{tokens[pos].Value}'",
                tokens[pos].Line, tokens[pos].Column);
        }

        // Parse parameters
        var parameters = new Dictionary<string, object>();
        if (pos < tokens.Count && tokens[pos].Type == McpqlTokenType.OpenParen)
        {
            pos++; // consume '('
            parameters = ParseParameters(tokens, ref pos);
            if (pos >= tokens.Count || tokens[pos].Type != McpqlTokenType.CloseParen)
                throw new McpqlParseException("Expected ')' after parameters", 
                    pos < tokens.Count ? tokens[pos].Line : tokens[^1].Line, 
                    pos < tokens.Count ? tokens[pos].Column : tokens[^1].Column);
            pos++; // consume ')'
        }

        // Parse pipe chain (post-processing operators)
        var operators = new List<McpqlOperator>();
        while (pos < tokens.Count)
        {
            if (tokens[pos].Type != McpqlTokenType.Pipe)
                throw new McpqlParseException($"Expected '|' but got '{tokens[pos].Value}'",
                    tokens[pos].Line, tokens[pos].Column);
            pos++; // consume pipe

            if (pos >= tokens.Count)
                throw new McpqlParseException("Expected operator after '|'", tokens[^1].Line, tokens[^1].Column);

            var op = ParseOperator(tokens, ref pos);
            operators.Add(op);
        }

        return new McpqlQuery
        {
            ServerName = serverName,
            ToolName = toolName,
            Parameters = parameters,
            Operators = operators
        };
    }

    /// <summary>
    /// Returns true if the token type is a keyword that can also be used as an identifier
    /// (e.g. parameter names in tool invocations like "project='MCAS'").
    /// </summary>
    private static bool IsKeywordToken(McpqlTokenType type) => type switch
    {
        McpqlTokenType.Where   => true,
        McpqlTokenType.Project => true,
        McpqlTokenType.Take    => true,
        McpqlTokenType.Sort    => true,
        McpqlTokenType.By      => true,
        McpqlTokenType.Count   => true,
        McpqlTokenType.Extend  => true,
        McpqlTokenType.Asc     => true,
        McpqlTokenType.Desc    => true,
        McpqlTokenType.And     => true,
        McpqlTokenType.Or      => true,
        McpqlTokenType.Not     => true,
        _ => false
    };

    private Dictionary<string, object> ParseParameters(List<McpqlToken> tokens, ref int pos)
    {
        var parameters = new Dictionary<string, object>();

        // Empty parameters
        if (pos < tokens.Count && tokens[pos].Type == McpqlTokenType.CloseParen)
            return parameters;

        while (pos < tokens.Count)
        {
            // Parameter name — allow keywords (project, where, sort, etc.) as parameter names
            // since MCP tools often have parameters named after MCPQL reserved words
            if (tokens[pos].Type != McpqlTokenType.Identifier && !IsKeywordToken(tokens[pos].Type))
                throw new McpqlParseException($"Expected parameter name, got '{tokens[pos].Value}'",
                    tokens[pos].Line, tokens[pos].Column);
            var paramName = tokens[pos].Value;
            pos++;

            // '='
            if (pos >= tokens.Count || tokens[pos].Type != McpqlTokenType.Equals)
                throw new McpqlParseException($"Expected '=' after parameter name '{paramName}'",
                    pos < tokens.Count ? tokens[pos].Line : tokens[^1].Line,
                    pos < tokens.Count ? tokens[pos].Column : tokens[^1].Column);
            pos++;

            // Value
            if (pos >= tokens.Count)
                throw new McpqlParseException($"Expected value for parameter '{paramName}'", tokens[^1].Line, tokens[^1].Column);

            object value = tokens[pos].Type switch
            {
                McpqlTokenType.String => tokens[pos].Value,
                McpqlTokenType.Number => double.TryParse(tokens[pos].Value, out var d) ? (d == Math.Floor(d) ? (object)(long)d : d) : tokens[pos].Value,
                McpqlTokenType.Boolean => bool.Parse(tokens[pos].Value),
                McpqlTokenType.Identifier => tokens[pos].Value, // unquoted string value
                _ when IsKeywordToken(tokens[pos].Type) => tokens[pos].Value, // keyword used as unquoted value
                _ => throw new McpqlParseException($"Unexpected value type for parameter '{paramName}'",
                    tokens[pos].Line, tokens[pos].Column)
            };
            parameters[paramName] = value;
            pos++;

            // ',' or end
            if (pos < tokens.Count && tokens[pos].Type == McpqlTokenType.Comma)
            {
                pos++; // consume comma
                continue;
            }
            break; // no comma means end of parameters
        }

        return parameters;
    }

    private McpqlOperator ParseOperator(List<McpqlToken> tokens, ref int pos)
    {
        var token = tokens[pos];

        return token.Type switch
        {
            McpqlTokenType.Where => ParseWhereOperator(tokens, ref pos),
            McpqlTokenType.Project => ParseProjectOperator(tokens, ref pos),
            McpqlTokenType.Take => ParseTakeOperator(tokens, ref pos),
            McpqlTokenType.Sort => ParseSortOperator(tokens, ref pos),
            McpqlTokenType.Count => ParseCountOperator(tokens, ref pos),
            McpqlTokenType.Extend => ParseExtendOperator(tokens, ref pos),
            _ => throw new McpqlParseException($"Unknown operator '{token.Value}'. Expected: where, project, take, sort, count, extend",
                token.Line, token.Column)
        };
    }

    private McpqlOperator ParseWhereOperator(List<McpqlToken> tokens, ref int pos)
    {
        pos++; // consume 'where'
        var conditions = new List<McpqlCondition>();

        while (pos < tokens.Count && tokens[pos].Type != McpqlTokenType.Pipe)
        {
            // Skip logical operators between conditions
            if (conditions.Count > 0)
            {
                if (tokens[pos].Type == McpqlTokenType.And || tokens[pos].Type == McpqlTokenType.Or)
                {
                    pos++; // consume 'and'/'or'
                    if (pos >= tokens.Count || tokens[pos].Type == McpqlTokenType.Pipe)
                        break;
                }
            }

            // Column name
            if (tokens[pos].Type != McpqlTokenType.Identifier)
                throw new McpqlParseException($"Expected column name in where clause, got '{tokens[pos].Value}'",
                    tokens[pos].Line, tokens[pos].Column);
            var column = tokens[pos].Value;
            pos++;

            // Operator
            if (pos >= tokens.Count)
                throw new McpqlParseException("Expected comparison operator", tokens[^1].Line, tokens[^1].Column);

            string op;
            if (tokens[pos].Type == McpqlTokenType.Operator)
            {
                op = tokens[pos].Value;
                pos++;
            }
            else
            {
                throw new McpqlParseException($"Expected comparison operator, got '{tokens[pos].Value}'",
                    tokens[pos].Line, tokens[pos].Column);
            }

            // Value
            if (pos >= tokens.Count)
                throw new McpqlParseException("Expected value in where clause", tokens[^1].Line, tokens[^1].Column);

            string value;
            if (tokens[pos].Type == McpqlTokenType.String || tokens[pos].Type == McpqlTokenType.Number ||
                tokens[pos].Type == McpqlTokenType.Boolean || tokens[pos].Type == McpqlTokenType.Identifier)
            {
                value = tokens[pos].Value;
                pos++;
            }
            else
            {
                throw new McpqlParseException($"Expected value in where clause, got '{tokens[pos].Value}'",
                    tokens[pos].Line, tokens[pos].Column);
            }

            conditions.Add(new McpqlCondition { Column = column, Operator = op, Value = value });
        }

        return new McpqlWhereOperator { Conditions = conditions };
    }

    private McpqlOperator ParseProjectOperator(List<McpqlToken> tokens, ref int pos)
    {
        pos++; // consume 'project'
        var columns = new List<string>();

        while (pos < tokens.Count && tokens[pos].Type != McpqlTokenType.Pipe)
        {
            if (tokens[pos].Type == McpqlTokenType.Identifier || tokens[pos].Type == McpqlTokenType.String)
            {
                columns.Add(tokens[pos].Value);
                pos++;
            }
            else if (tokens[pos].Type == McpqlTokenType.Comma)
            {
                pos++; // skip comma
            }
            else
            {
                break;
            }
        }

        if (columns.Count == 0)
            throw new McpqlParseException("project requires at least one column name",
                tokens[pos > 0 ? pos - 1 : 0].Line, tokens[pos > 0 ? pos - 1 : 0].Column);

        return new McpqlProjectOperator { Columns = columns };
    }

    private McpqlOperator ParseTakeOperator(List<McpqlToken> tokens, ref int pos)
    {
        pos++; // consume 'take'
        if (pos >= tokens.Count || tokens[pos].Type != McpqlTokenType.Number)
            throw new McpqlParseException("take requires a number",
                pos < tokens.Count ? tokens[pos].Line : tokens[^1].Line,
                pos < tokens.Count ? tokens[pos].Column : tokens[^1].Column);

        var count = int.Parse(tokens[pos].Value);
        pos++;
        return new McpqlTakeOperator { Count = count };
    }

    private McpqlOperator ParseSortOperator(List<McpqlToken> tokens, ref int pos)
    {
        pos++; // consume 'sort'
        if (pos < tokens.Count && tokens[pos].Type == McpqlTokenType.By)
            pos++; // consume optional 'by'

        if (pos >= tokens.Count || tokens[pos].Type != McpqlTokenType.Identifier)
            throw new McpqlParseException("sort requires a column name",
                pos < tokens.Count ? tokens[pos].Line : tokens[^1].Line,
                pos < tokens.Count ? tokens[pos].Column : tokens[^1].Column);

        var column = tokens[pos].Value;
        pos++;

        bool ascending = true;
        if (pos < tokens.Count)
        {
            if (tokens[pos].Type == McpqlTokenType.Asc) { ascending = true; pos++; }
            else if (tokens[pos].Type == McpqlTokenType.Desc) { ascending = false; pos++; }
        }

        return new McpqlSortOperator { Column = column, Ascending = ascending };
    }

    private McpqlOperator ParseCountOperator(List<McpqlToken> tokens, ref int pos)
    {
        pos++; // consume 'count'
        return new McpqlCountOperator();
    }

    private McpqlOperator ParseExtendOperator(List<McpqlToken> tokens, ref int pos)
    {
        pos++; // consume 'extend'
        if (pos >= tokens.Count || tokens[pos].Type != McpqlTokenType.Identifier)
            throw new McpqlParseException("extend requires a column name",
                pos < tokens.Count ? tokens[pos].Line : tokens[^1].Line,
                pos < tokens.Count ? tokens[pos].Column : tokens[^1].Column);

        var columnName = tokens[pos].Value;
        pos++;

        if (pos >= tokens.Count || tokens[pos].Type != McpqlTokenType.Equals)
            throw new McpqlParseException($"Expected '=' after extend column name '{columnName}'",
                pos < tokens.Count ? tokens[pos].Line : tokens[^1].Line,
                pos < tokens.Count ? tokens[pos].Column : tokens[^1].Column);
        pos++;

        // Collect the expression tokens until pipe or end
        var exprTokens = new List<string>();
        while (pos < tokens.Count && tokens[pos].Type != McpqlTokenType.Pipe)
        {
            exprTokens.Add(tokens[pos].Value);
            pos++;
        }

        if (exprTokens.Count == 0)
            throw new McpqlParseException($"Expected expression after '=' in extend",
                tokens[pos > 0 ? pos - 1 : 0].Line, tokens[pos > 0 ? pos - 1 : 0].Column);

        return new McpqlExtendOperator
        {
            ColumnName = columnName,
            Expression = string.Join(" ", exprTokens)
        };
    }

    #endregion

    #region Helpers

    private string StripComments(string input)
    {
        // Remove // line comments
        var lines = input.Split('\n');
        var cleaned = lines.Select(line =>
        {
            var inString = false;
            char stringChar = '\0';
            for (int i = 0; i < line.Length - 1; i++)
            {
                if (inString)
                {
                    if (line[i] == stringChar && (i == 0 || line[i - 1] != '\\'))
                        inString = false;
                }
                else
                {
                    if (line[i] == '\'' || line[i] == '"')
                    {
                        inString = true;
                        stringChar = line[i];
                    }
                    else if (line[i] == '/' && line[i + 1] == '/')
                    {
                        return line[..i];
                    }
                }
            }
            return line;
        });
        return string.Join('\n', cleaned);
    }

    private string FormatQuery(McpqlQuery query)
    {
        var parts = new List<string>();

        // Server | tool(params)
        var paramStr = string.Join(", ", query.Parameters.Select(p =>
        {
            var valueStr = p.Value switch
            {
                string s => $"'{s}'",
                bool b => b.ToString().ToLowerInvariant(),
                _ => p.Value.ToString() ?? ""
            };
            return $"{p.Key}={valueStr}";
        }));

        parts.Add($"{query.ServerName} | {query.ToolName}({paramStr})");

        // Operators
        foreach (var op in query.Operators)
        {
            parts.Add(op switch
            {
                McpqlWhereOperator w => "| where " + string.Join(" and ", w.Conditions.Select(c =>
                    $"{c.Column} {c.Operator} '{c.Value}'")),
                McpqlProjectOperator p2 => "| project " + string.Join(", ", p2.Columns),
                McpqlTakeOperator t => $"| take {t.Count}",
                McpqlSortOperator s => $"| sort by {s.Column} {(s.Ascending ? "asc" : "desc")}",
                McpqlCountOperator => "| count",
                McpqlExtendOperator e => $"| extend {e.ColumnName} = {e.Expression}",
                _ => op.ToString() ?? ""
            });
        }

        return string.Join("\n", parts);
    }

    #endregion
}

#region Types

/// <summary>
/// A parsed MCPQL query.
/// </summary>
public class McpqlQuery
{
    /// <summary>MCP server name</summary>
    public string ServerName { get; set; } = string.Empty;

    /// <summary>MCP tool name to invoke</summary>
    public string ToolName { get; set; } = string.Empty;

    /// <summary>Input parameters for the tool call</summary>
    public Dictionary<string, object> Parameters { get; set; } = new();

    /// <summary>Post-processing operators (where, project, take, sort, count, extend)</summary>
    public List<McpqlOperator> Operators { get; set; } = new();
}

/// <summary>
/// Validation result for MCPQL queries.
/// </summary>
public class McpqlValidationResult
{
    public bool IsValid { get; set; }
    public string? ErrorMessage { get; set; }
    public int? ErrorLine { get; set; }
    public int? ErrorColumn { get; set; }

    public static McpqlValidationResult Valid() => new() { IsValid = true };
    public static McpqlValidationResult Invalid(string message, int? line = null, int? column = null) => new()
    {
        IsValid = false,
        ErrorMessage = message,
        ErrorLine = line,
        ErrorColumn = column
    };
}

/// <summary>
/// Base class for MCPQL post-processing operators.
/// </summary>
public abstract class McpqlOperator { }

/// <summary>
/// where column op value [and column op value]*
/// </summary>
public class McpqlWhereOperator : McpqlOperator
{
    public List<McpqlCondition> Conditions { get; set; } = new();
}

/// <summary>
/// project col1, col2, col3
/// </summary>
public class McpqlProjectOperator : McpqlOperator
{
    public List<string> Columns { get; set; } = new();
}

/// <summary>
/// take N
/// </summary>
public class McpqlTakeOperator : McpqlOperator
{
    public int Count { get; set; }
}

/// <summary>
/// sort by column [asc|desc]
/// </summary>
public class McpqlSortOperator : McpqlOperator
{
    public string Column { get; set; } = string.Empty;
    public bool Ascending { get; set; } = true;
}

/// <summary>
/// count
/// </summary>
public class McpqlCountOperator : McpqlOperator { }

/// <summary>
/// extend newCol = expression
/// </summary>
public class McpqlExtendOperator : McpqlOperator
{
    public string ColumnName { get; set; } = string.Empty;
    public string Expression { get; set; } = string.Empty;
}

/// <summary>
/// A single condition in a where clause.
/// </summary>
public class McpqlCondition
{
    public string Column { get; set; } = string.Empty;
    public string Operator { get; set; } = "==";
    public string Value { get; set; } = string.Empty;
}

#endregion

#region Token Types

public enum McpqlTokenType
{
    Identifier,
    String,
    Number,
    Boolean,
    Pipe,
    Dot,
    OpenParen,
    CloseParen,
    Comma,
    Equals,
    Operator,
    Where,
    Project,
    Take,
    Sort,
    By,
    Count,
    Extend,
    Asc,
    Desc,
    And,
    Or,
    Not
}

public record McpqlToken(McpqlTokenType Type, string Value, int Line, int Column);

public class McpqlParseException : Exception
{
    public int Line { get; }
    public int Column { get; }

    public McpqlParseException(string message, int line, int column)
        : base($"{message} (line {line}, column {column})")
    {
        Line = line;
        Column = column;
    }
}

#endregion
