using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Quest.Server.Protocol;
using Quest.Server.Services;

namespace Quest.Server.Models;

/// <summary>
/// MCP (Model Context Protocol) data source implementation.
/// Acts as a proxy — the VS Code extension handles MCP server lifecycle and tool invocation.
/// The sidecar receives raw JSON results and applies MCPQL post-processing (where, project, take, sort, count, extend).
/// </summary>
public class McpDataSource : IDataSource, ISchemaProvider, IDataSourceHelp
{
    private readonly Action<string> _log;
    private readonly McpqlParser _parser = new();
    private readonly McpqlPostProcessor _postProcessor = new();
    private DataSourceConnectionState _state = DataSourceConnectionState.Connected;

    // Schema cache: populated by extension via mcp/setSchema RPC
    private readonly ConcurrentDictionary<string, McpToolSchemaInfo[]> _serverTools = new();

    public McpDataSource(Action<string> log)
    {
        _log = log;
    }

    // ============ IDataSource Identity ============
    public string Id => "mcp";
    public string DisplayName => "MCP (Model Context Protocol)";
    public string Icon => "\U0001F50C"; // 🔌 plug emoji
    public string QueryLanguage => "MCPQL";

    // ============ UI Configuration ============
    public DataSourceUIConfig UIConfig { get; } = new DataSourceUIConfig
    {
        ServerLabel = "MCP Server",
        ServerPlaceholder = "Auto-detected from mcp.json",
        DatabaseLabel = "Tool",
        DatabasePlaceholder = "MCP tool name",
        ShowDatabaseSelector = false,
        SupportsMaxResults = true,
        DefaultMaxResults = 1000,
        ShowConnectButton = false // VS Code manages MCP server lifecycle
    };

    // ============ Connection ============
    public DataSourceConnectionState State
    {
        get => _state;
        private set
        {
            if (_state != value)
            {
                var oldState = _state;
                _state = value;
                ConnectionStateChanged?.Invoke(this, new ConnectionStateChangedEventArgs(oldState, value));
            }
        }
    }

    public string ConnectionInfo => "MCP (VS Code managed)";

    public event EventHandler<ConnectionStateChangedEventArgs>? ConnectionStateChanged;

    /// <summary>
    /// MCP connections are managed by VS Code, so ConnectAsync is essentially a no-op.
    /// </summary>
    public Task<ConnectionResult> ConnectAsync(DataSourceConnectionParams parameters, CancellationToken ct = default)
    {
        State = DataSourceConnectionState.Connected;
        _log("MCP data source connected (VS Code managed)");
        return Task.FromResult(ConnectionResult.Succeeded("MCP (VS Code managed)"));
    }

    public Task DisconnectAsync()
    {
        State = DataSourceConnectionState.Disconnected;
        return Task.CompletedTask;
    }

    /// <summary>
    /// Execute an MCPQL query. The query is parsed to extract server/tool/params,
    /// but actual tool invocation happens on the extension side. The extension sends
    /// the raw JSON result in the query request, and we apply post-processing here.
    /// 
    /// For direct server-side execution, the RawJsonResult field in the request properties
    /// should contain the MCP tool's response.
    /// </summary>
    public Task<QueryResult> ExecuteQueryAsync(DataSourceQueryRequest request, CancellationToken ct = default)
    {
        try
        {
            // Parse the MCPQL query
            var parsed = _parser.Parse(request.Query);
            _log($"MCPQL: server={parsed.ServerName}, tool={parsed.ToolName}, params={parsed.Parameters.Count}, operators={parsed.Operators.Count}");

            // Check if raw JSON result is provided (sent by extension after calling MCP tool)
            string? rawJson = null;
            if (request.ClusterUrl == "mcp-result")
            {
                // The extension encodes the raw result in the Database field for transport
                rawJson = request.Database;
            }

            if (string.IsNullOrEmpty(rawJson))
            {
                // No raw result — return a "pending" result indicating the extension
                // needs to invoke the MCP tool and re-submit with results
                return Task.FromResult(new QueryResult(
                    Success: false,
                    Columns: Array.Empty<string>(),
                    Rows: Array.Empty<string[]>(),
                    RowCount: 0,
                    ExecutionTimeMs: 0,
                    Error: $"MCP_INVOKE_REQUIRED:{parsed.ServerName}:{parsed.ToolName}:{JsonSerializer.Serialize(parsed.Parameters)}"
                ));
            }

            // Convert JSON to tabular format
            var result = McpqlPostProcessor.JsonToQueryResult(rawJson);
            if (!result.Success)
                return Task.FromResult(result);

            // Apply post-processing operators
            if (parsed.Operators.Count > 0)
            {
                result = _postProcessor.Apply(result, parsed.Operators);
            }

            // Apply max results limit
            if (request.MaxResults > 0 && result.RowCount > request.MaxResults)
            {
                var limitedRows = result.Rows.Take(request.MaxResults).ToArray();
                result = result with { Rows = limitedRows, RowCount = limitedRows.Length };
            }

            return Task.FromResult(result);
        }
        catch (McpqlParseException ex)
        {
            return Task.FromResult(new QueryResult(
                Success: false,
                Columns: Array.Empty<string>(),
                Rows: Array.Empty<string[]>(),
                RowCount: 0,
                ExecutionTimeMs: 0,
                Error: $"MCPQL syntax error: {ex.Message}"
            ));
        }
        catch (Exception ex)
        {
            _log($"MCPQL execution error: {ex.Message}");
            return Task.FromResult(new QueryResult(
                Success: false,
                Columns: Array.Empty<string>(),
                Rows: Array.Empty<string[]>(),
                RowCount: 0,
                ExecutionTimeMs: 0,
                Error: $"MCPQL execution error: {ex.Message}"
            ));
        }
    }

    public QueryValidationResult ValidateQuery(string query)
    {
        var result = _parser.Validate(query);
        if (result.IsValid)
            return Models.QueryValidationResult.Valid();
        return Models.QueryValidationResult.Invalid(
            result.ErrorMessage ?? "Invalid MCPQL query",
            result.ErrorLine,
            result.ErrorColumn);
    }

    public string FormatQuery(string query)
    {
        return _parser.Format(query);
    }

    public bool CanHandleQuery(string query)
    {
        return McpqlParser.LooksLikeMcpql(query);
    }

    // ============ ISchemaProvider ============

    /// <summary>
    /// Set the schema for an MCP server's tools (called by extension via mcp/setSchema RPC).
    /// </summary>
    public void SetToolSchema(string serverName, McpToolSchemaInfo[] tools)
    {
        _serverTools[serverName] = tools;
        _log($"MCP schema updated: server={serverName}, tools={tools.Length}");
    }

    /// <summary>
    /// Clear all cached tool schemas.
    /// </summary>
    public void ClearSchema()
    {
        _serverTools.Clear();
        _log("MCP schema cache cleared");
    }

    /// <summary>
    /// Get all cached tool schemas (for retrieval by extension via mcp/getSchema RPC).
    /// </summary>
    public Dictionary<string, McpToolSchemaInfo[]> GetToolSchema()
    {
        return _serverTools.ToDictionary(kvp => kvp.Key, kvp => kvp.Value);
    }

    /// <summary>
    /// Get available MCP tools as schema entities (tools appear as "tables").
    /// </summary>
    public Task<SchemaEntity[]> GetEntitiesAsync(CancellationToken ct = default)
    {
        var entities = _serverTools.SelectMany(kvp =>
            kvp.Value.Select(tool => new SchemaEntity
            {
                Name = $"{kvp.Key}.{tool.Name}",
                Description = tool.Description,
                EntityType = "Tool"
            })
        ).ToArray();

        return Task.FromResult(entities);
    }

    /// <summary>
    /// Get tool parameters as schema columns (parameters appear as "columns").
    /// </summary>
    public Task<SchemaColumn[]> GetColumnsAsync(string entityName, CancellationToken ct = default)
    {
        // entityName format: "serverName.toolName"
        var parts = entityName.Split('.', 2);
        if (parts.Length != 2)
            return Task.FromResult(Array.Empty<SchemaColumn>());

        var serverName = parts[0];
        var toolName = parts[1];

        if (_serverTools.TryGetValue(serverName, out var tools))
        {
            var tool = tools.FirstOrDefault(t => t.Name == toolName);
            if (tool != null)
            {
                var columns = tool.Parameters.Select(p => new SchemaColumn
                {
                    Name = p.Name,
                    DataType = p.Type,
                    Description = $"{(p.Required ? "[required] " : "")}{p.Description}"
                }).ToArray();
                return Task.FromResult(columns);
            }
        }

        return Task.FromResult(Array.Empty<SchemaColumn>());
    }

    public Task<SchemaFunction[]> GetFunctionsAsync(CancellationToken ct = default)
    {
        // MCPQL operators as "functions"
        var functions = new SchemaFunction[]
        {
            new() { Name = "where", Signature = "where column op value", Description = "Filter rows by condition", ReturnType = "table" },
            new() { Name = "project", Signature = "project col1, col2, ...", Description = "Select specific columns", ReturnType = "table" },
            new() { Name = "take", Signature = "take N", Description = "Limit to first N rows", ReturnType = "table" },
            new() { Name = "sort", Signature = "sort by column [asc|desc]", Description = "Sort rows by column", ReturnType = "table" },
            new() { Name = "count", Signature = "count", Description = "Count total rows", ReturnType = "long" },
            new() { Name = "extend", Signature = "extend newCol = expr", Description = "Add a computed column", ReturnType = "table" },
        };
        return Task.FromResult(functions);
    }

    // ============ IDataSourceHelp ============

    public QueryExample[] GetExamples()
    {
        return new QueryExample[]
        {
            new()
            {
                Title = "List MCP tools",
                Description = "Query an MCP server to list available tools",
                Query = "github | list_issues(repo='org/repo')",
                Category = "Basic"
            },
            new()
            {
                Title = "Filter results",
                Description = "Use where to filter MCP tool results",
                Query = "github | list_issues(repo='org/repo') | where state == 'open'",
                Category = "Filtering"
            },
            new()
            {
                Title = "Select columns",
                Description = "Use project to select specific columns",
                Query = "github | list_issues(repo='org/repo') | project title, author, state",
                Category = "Projection"
            },
            new()
            {
                Title = "Limit and sort",
                Description = "Combine take and sort operators",
                Query = "github | list_issues(repo='org/repo') | where state == 'open' | sort by created_at desc | take 10",
                Category = "Advanced"
            },
            new()
            {
                Title = "Dot syntax",
                Description = "Alternative dot syntax for tool invocation",
                Query = "filesystem.read_directory(path='/tmp')",
                Category = "Basic"
            },
            new()
            {
                Title = "Count results",
                Description = "Count the total number of results",
                Query = "github | list_issues(repo='org/repo') | where state == 'open' | count",
                Category = "Aggregation"
            },
        };
    }

    public string? GetDocumentationUrl()
    {
        return "https://modelcontextprotocol.io/docs";
    }

    public string? GetQuickStartGuide()
    {
        return @"# MCPQL Quick Start

## Syntax
```
server | tool(param1='value1', param2='value2') | operator1 | operator2
```

## Alternative dot syntax
```
server.tool(param1='value1')
```

## Post-processing operators
- `| where column == 'value'` — Filter rows
- `| project col1, col2` — Select columns
- `| take N` — Limit rows
- `| sort by column [asc|desc]` — Sort rows
- `| count` — Count rows
- `| extend newCol = expression` — Add column

## Comparison operators
- `==`, `!=`, `>`, `>=`, `<`, `<=`
- `contains`, `startswith`, `endswith`, `has`

## Setup
1. Add `.vscode/mcp.json` to your workspace
2. Switch to MCP mode (Ctrl+Shift+M)
3. Write your query and press F5

## MCP Configuration (.vscode/mcp.json)
```json
{
  ""servers"": {
    ""github"": {
      ""command"": ""npx"",
      ""args"": [""-y"", ""@modelcontextprotocol/server-github""],
      ""env"": { ""GITHUB_TOKEN"": ""..."" }
    }
  }
}
```
";
    }

    public void Dispose()
    {
        _serverTools.Clear();
    }
}

/// <summary>
/// Schema information for an MCP tool, pushed from the extension side.
/// </summary>
public class McpToolSchemaInfo
{
    public string Name { get; set; } = string.Empty;
    public string Description { get; set; } = string.Empty;
    public McpToolParameterInfo[] Parameters { get; set; } = Array.Empty<McpToolParameterInfo>();
}

/// <summary>
/// Parameter information for an MCP tool.
/// </summary>
public class McpToolParameterInfo
{
    public string Name { get; set; } = string.Empty;
    public string Type { get; set; } = "string";
    public string Description { get; set; } = string.Empty;
    public bool Required { get; set; }
}
