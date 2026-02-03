using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using MyTools.Core;
using Quest.Server.Protocol;

namespace Quest.Server.Models;

/// <summary>
/// Azure DevOps (WIQL) data source implementation
/// </summary>
public class AdoDataSource : IDataSource, IDataSourceHelp, IExternalViewer
{
    private readonly Action<string> _log;
    private AdoConnection? _connection;
    private string _organizationUrl = string.Empty;
    private string _project = string.Empty;
    private DataSourceConnectionState _state = DataSourceConnectionState.Disconnected;

    public AdoDataSource(Action<string> log)
    {
        _log = log;
    }

    // ============ IDataSource Identity ============
    public string Id => "ado";
    public string DisplayName => "Azure DevOps (WIQL)";
    public string Icon => "\U0001F4CA"; // Bar chart emoji
    public string QueryLanguage => "WIQL";

    // ============ UI Configuration ============
    public DataSourceUIConfig UIConfig { get; } = new DataSourceUIConfig
    {
        ServerLabel = "Organization",
        ServerPlaceholder = "https://dev.azure.com/your-org",
        DatabaseLabel = "Project",
        DatabasePlaceholder = "Project name (optional)",
        ShowDatabaseSelector = true,
        SupportsMaxResults = true,
        DefaultMaxResults = 200,
        ShowConnectButton = true
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

    public string ConnectionInfo => string.IsNullOrEmpty(_organizationUrl) ? string.Empty :
        string.IsNullOrEmpty(_project) ? _organizationUrl : $"{_organizationUrl}/{_project}";

    public event EventHandler<ConnectionStateChangedEventArgs>? ConnectionStateChanged;

    public async Task<ConnectionResult> ConnectAsync(DataSourceConnectionParams parameters, CancellationToken ct = default)
    {
        try
        {
            State = DataSourceConnectionState.Connecting;

            _organizationUrl = parameters.Server;
            _project = parameters.Database ?? string.Empty;

            if (string.IsNullOrEmpty(_organizationUrl))
            {
                State = DataSourceConnectionState.Error;
                return ConnectionResult.Failed("Organization URL is required");
            }

            // Create and connect
            _connection = new AdoConnection(
                (msg, url) => _log($"{msg} {url ?? ""}"),
                _organizationUrl);

            await _connection.Connect();

            State = DataSourceConnectionState.Connected;
            _log($"ADO connected: {ConnectionInfo}");

            return ConnectionResult.Succeeded(ConnectionInfo);
        }
        catch (Exception ex)
        {
            State = DataSourceConnectionState.Error;
            _log($"ADO connection failed: {ex.Message}");
            return ConnectionResult.Failed(ex.Message);
        }
    }

    public Task DisconnectAsync()
    {
        _connection?.Dispose();
        _connection = null;
        _organizationUrl = string.Empty;
        _project = string.Empty;
        State = DataSourceConnectionState.Disconnected;
        return Task.CompletedTask;
    }

    // ============ Query Execution ============
    public async Task<QueryResult> ExecuteQueryAsync(DataSourceQueryRequest request, CancellationToken ct = default)
    {
        var sw = Stopwatch.StartNew();

        try
        {
            var orgUrl = request.ClusterUrl ?? _organizationUrl;
            var project = request.Database ?? _project;

            if (string.IsNullOrEmpty(orgUrl))
            {
                return new QueryResult(
                    Success: false,
                    Columns: Array.Empty<string>(),
                    Rows: Array.Empty<string[]>(),
                    RowCount: 0,
                    ExecutionTimeMs: sw.ElapsedMilliseconds,
                    Error: "Organization URL is required"
                );
            }

            // Strip // comment lines from WIQL queries (ADO doesn't support them)
            var query = StripWiqlComments(request.Query);

            // Check if this is a KQL-like query and translate it
            if (IsKqlLikeAdoQuery(query))
            {
                query = TranslateKqlToWiql(query);
            }

            _log($"Executing ADO query on {orgUrl}");

            // Create a new connection if needed
            using var connection = new AdoConnection(
                (msg, url) => _log($"{msg} {url ?? ""}"),
                orgUrl);

            await connection.Connect();

            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            var result = await connection.RunQueryEx(
                project,
                query,
                request.MaxResults,
                cts);

            // Use fields from result if available, otherwise use defaults
            var columns = result.Fields.Length > 0
                ? result.Fields
                : new[] { "Id", "Title", "State", "WorkItemType", "AssignedTo", "CreatedDate" };

            // Collect parent IDs that need resolution
            var parentIds = new HashSet<int>();
            var parentColumnIndex = Array.FindIndex(columns, c =>
                c.Equals("Parent", StringComparison.OrdinalIgnoreCase) ||
                c.Equals("System.Parent", StringComparison.OrdinalIgnoreCase));

            // First pass: collect all parent IDs
            if (parentColumnIndex >= 0)
            {
                foreach (var wi in result.Items)
                {
                    var parentId = ExtractParentId(wi);
                    if (parentId > 0)
                    {
                        parentIds.Add(parentId);
                    }
                }
            }

            // Resolve parent titles in batch
            var parentTitles = new Dictionary<int, string>();
            if (parentIds.Count > 0)
            {
                _log($"Resolving {parentIds.Count} parent work items in batch...");
                try
                {
                    var parentWorkItems = await connection.GetWorkItemsBatch(
                        parentIds.ToArray(),
                        new[] { "System.Title" },
                        ct);

                    foreach (var wi in parentWorkItems)
                    {
                        if (wi.Id.HasValue && wi.Fields.TryGetValue("System.Title", out var titleObj))
                        {
                            var title = titleObj?.ToString();
                            if (!string.IsNullOrEmpty(title))
                            {
                                parentTitles[wi.Id.Value] = $"{wi.Id.Value} - {title}";
                            }
                        }
                    }
                    _log($"Resolved {parentTitles.Count} parent titles");
                }
                catch (Exception ex)
                {
                    _log($"Failed to batch resolve parents: {ex.Message}");
                }
            }

            var rows = new List<string[]>();
            foreach (var wi in result.Items)
            {
                var row = new List<string>();
                foreach (var col in columns)
                {
                    var fieldName = col.Contains(".") ? col : $"System.{col}";
                    if (fieldName == "System.Id" || col == "Id")
                    {
                        row.Add(wi.Id?.ToString() ?? "");
                    }
                    else if (fieldName == "System.Parent" || col.Equals("Parent", StringComparison.OrdinalIgnoreCase))
                    {
                        var parentId = ExtractParentId(wi);
                        if (parentId > 0 && parentTitles.TryGetValue(parentId, out var parentDisplay))
                        {
                            row.Add(parentDisplay);
                        }
                        else if (parentId > 0)
                        {
                            row.Add(parentId.ToString());
                        }
                        else
                        {
                            row.Add("");
                        }
                    }
                    else if (wi.Fields != null && wi.Fields.TryGetValue(fieldName, out var value))
                    {
                        row.Add(value?.ToString() ?? "");
                    }
                    else if (wi.Fields != null && wi.Fields.TryGetValue(col, out var directValue))
                    {
                        row.Add(directValue?.ToString() ?? "");
                    }
                    else
                    {
                        row.Add("");
                    }
                }
                rows.Add(row.ToArray());
            }

            _log($"ADO query returned {rows.Count} work items");

            return new QueryResult(
                Success: true,
                Columns: columns,
                Rows: rows.ToArray(),
                RowCount: rows.Count,
                ExecutionTimeMs: sw.ElapsedMilliseconds,
                Error: null
            );
        }
        catch (OperationCanceledException)
        {
            return new QueryResult(
                Success: false,
                Columns: Array.Empty<string>(),
                Rows: Array.Empty<string[]>(),
                RowCount: 0,
                ExecutionTimeMs: sw.ElapsedMilliseconds,
                Error: "Query was cancelled"
            );
        }
        catch (Exception ex)
        {
            _log($"ADO query error: {ex.Message}");
            return new QueryResult(
                Success: false,
                Columns: Array.Empty<string>(),
                Rows: Array.Empty<string[]>(),
                RowCount: 0,
                ExecutionTimeMs: sw.ElapsedMilliseconds,
                Error: ex.Message
            );
        }
    }

    public QueryValidationResult ValidateQuery(string query)
    {
        if (string.IsNullOrWhiteSpace(query))
            return QueryValidationResult.Invalid("Query cannot be empty");

        // Check if it's a KQL-like query
        var cleaned = StripWiqlComments(query);
        if (IsKqlLikeAdoQuery(cleaned))
            return QueryValidationResult.Valid(); // KQL-like queries will be translated

        // Basic WIQL validation
        var upper = cleaned.ToUpperInvariant();

        if (!upper.Contains("SELECT"))
            return QueryValidationResult.Invalid("WIQL query must contain SELECT clause");

        if (!upper.Contains("FROM WORKITEMS"))
            return QueryValidationResult.Invalid("WIQL query must contain FROM workitems clause");

        return QueryValidationResult.Valid();
    }

    public string FormatQuery(string query)
    {
        return query.Trim();
    }

    public bool CanHandleQuery(string query)
    {
        if (string.IsNullOrWhiteSpace(query))
            return false;

        var trimmed = StripWiqlComments(query).Trim();
        var upper = trimmed.ToUpperInvariant();

        // Traditional WIQL queries use SELECT...FROM workitems pattern
        if (upper.Contains("SELECT") && upper.Contains("FROM WORKITEMS"))
            return true;

        // KQL-like queries start with WorkItems, Bugs, Tasks, etc. and use pipes
        return IsKqlLikeAdoQuery(trimmed);
    }

    /// <summary>
    /// Checks if a query uses KQL-like syntax for ADO.
    /// KQL-like ADO queries start with a work item type (WorkItems, Bugs, Tasks, etc.) and use pipes.
    /// </summary>
    private bool IsKqlLikeAdoQuery(string query)
    {
        if (string.IsNullOrWhiteSpace(query))
            return false;

        var lines = query.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
        if (lines.Length == 0) return false;

        var firstLine = lines[0].Trim();

        // If first line contains pipe, extract the source before it
        var pipeIndex = firstLine.IndexOf('|');
        var source = pipeIndex >= 0 ? firstLine.Substring(0, pipeIndex).Trim() : firstLine;

        // Check if source is a recognized ADO work item type
        var adoSources = new[] { "workitems", "bugs", "tasks", "features", "epics", "userstories", "issues", "pbi", "testcases" };
        return adoSources.Any(s => source.Equals(s, StringComparison.OrdinalIgnoreCase));
    }

    // ============ IDataSourceHelp ============
    public QueryExample[] GetExamples()
    {
        return new[]
        {
            new QueryExample
            {
                Title = "My Active Tasks",
                Description = "Get all active tasks assigned to me",
                Query = "SELECT [System.Id], [System.Title], [System.State]\nFROM workitems\nWHERE [System.AssignedTo] = @me\n  AND [System.State] <> 'Closed'\n  AND [System.State] <> 'Removed'",
                Category = "My Work"
            },
            new QueryExample
            {
                Title = "Recent Bugs",
                Description = "Find bugs created in the last 7 days",
                Query = "SELECT [System.Id], [System.Title], [System.State], [System.CreatedDate]\nFROM workitems\nWHERE [System.WorkItemType] = 'Bug'\n  AND [System.CreatedDate] >= @today - 7",
                Category = "Bugs"
            },
            new QueryExample
            {
                Title = "Sprint Work Items",
                Description = "Get all work items in current iteration",
                Query = "SELECT [System.Id], [System.Title], [System.State], [System.WorkItemType]\nFROM workitems\nWHERE [System.IterationPath] = @currentIteration",
                Category = "Sprint"
            },
            new QueryExample
            {
                Title = "High Priority Items",
                Description = "Find high priority work items",
                Query = "SELECT [System.Id], [System.Title], [System.State], [Microsoft.VSTS.Common.Priority]\nFROM workitems\nWHERE [Microsoft.VSTS.Common.Priority] = 1\n  AND [System.State] <> 'Closed'",
                Category = "Priority"
            }
        };
    }

    public string? GetDocumentationUrl() => "https://learn.microsoft.com/en-us/azure/devops/boards/queries/wiql-syntax";

    public string? GetQuickStartGuide() => @"WIQL (Work Item Query Language) Quick Start:

1. Basic query: SELECT [System.Id], [System.Title] FROM workitems
2. Filter by state: WHERE [System.State] = 'Active'
3. Filter by assigned: WHERE [System.AssignedTo] = @me
4. Date filter: WHERE [System.CreatedDate] >= @today - 7
5. Type filter: WHERE [System.WorkItemType] = 'Bug'
6. Area path: WHERE [System.AreaPath] UNDER 'Project\Team'

Macros: @me, @today, @currentIteration";

    // ============ IExternalViewer ============
    public bool SupportsExternalViewer => true;
    public string ExternalViewerLabel => "Open in Azure DevOps";

    public string? GetExternalViewerUrl(string query, string? server, string? database)
    {
        var orgUrl = server ?? _organizationUrl;

        if (string.IsNullOrEmpty(orgUrl))
            return null;

        var encodedQuery = Uri.EscapeDataString(query);
        var project = database ?? _project;

        if (!string.IsNullOrEmpty(project))
        {
            return $"{orgUrl}/{project}/_queries?wiql={encodedQuery}";
        }

        return $"{orgUrl}/_queries?wiql={encodedQuery}";
    }

    public void Dispose()
    {
        _connection?.Dispose();
        _connection = null;
    }

    #region KQL to WIQL Translation

    /// <summary>
    /// Field name mappings from KQL-friendly names to WIQL system field names.
    /// </summary>
    private static readonly Dictionary<string, string> FieldMappings = new(StringComparer.OrdinalIgnoreCase)
    {
        // Core fields
        { "Id", "[System.Id]" },
        { "Title", "[System.Title]" },
        { "State", "[System.State]" },
        { "WorkItemType", "[System.WorkItemType]" },
        { "Type", "[System.WorkItemType]" },
        { "AssignedTo", "[System.AssignedTo]" },
        { "CreatedBy", "[System.CreatedBy]" },
        { "CreatedDate", "[System.CreatedDate]" },
        { "ChangedBy", "[System.ChangedBy]" },
        { "ChangedDate", "[System.ChangedDate]" },
        { "AreaPath", "[System.AreaPath]" },
        { "IterationPath", "[System.IterationPath]" },
        { "Tags", "[System.Tags]" },
        { "Description", "[System.Description]" },
        { "Parent", "[System.Parent]" },

        // Common fields
        { "Priority", "[Microsoft.VSTS.Common.Priority]" },
        { "Severity", "[Microsoft.VSTS.Common.Severity]" },
        { "ActivatedBy", "[Microsoft.VSTS.Common.ActivatedBy]" },
        { "ActivatedDate", "[Microsoft.VSTS.Common.ActivatedDate]" },
        { "ClosedBy", "[Microsoft.VSTS.Common.ClosedBy]" },
        { "ClosedDate", "[Microsoft.VSTS.Common.ClosedDate]" },
        { "ResolvedBy", "[Microsoft.VSTS.Common.ResolvedBy]" },
        { "ResolvedDate", "[Microsoft.VSTS.Common.ResolvedDate]" },
        { "StateChangeDate", "[Microsoft.VSTS.Common.StateChangeDate]" },

        // Scheduling
        { "Effort", "[Microsoft.VSTS.Scheduling.Effort]" },
        { "StoryPoints", "[Microsoft.VSTS.Scheduling.StoryPoints]" },
        { "OriginalEstimate", "[Microsoft.VSTS.Scheduling.OriginalEstimate]" },
        { "RemainingWork", "[Microsoft.VSTS.Scheduling.RemainingWork]" },
        { "CompletedWork", "[Microsoft.VSTS.Scheduling.CompletedWork]" },
    };

    /// <summary>
    /// Translates a KQL-like ADO query to WIQL.
    /// </summary>
    private string TranslateKqlToWiql(string kqlQuery)
    {
        var lines = kqlQuery.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)
            .Select(l => l.Trim())
            .Where(l => !string.IsNullOrWhiteSpace(l) && !l.StartsWith("//"))
            .ToList();

        if (lines.Count == 0) return kqlQuery;

        var firstLine = lines[0];
        var conditions = new List<string>();
        var projectFields = new List<string>();
        int? take = null;

        // Parse source from first line
        string source;
        if (firstLine.Contains('|'))
        {
            var pipeIndex = firstLine.IndexOf('|');
            source = firstLine.Substring(0, pipeIndex).Trim();
            lines[0] = firstLine.Substring(pipeIndex); // Keep the pipe part for processing
        }
        else
        {
            source = firstLine;
            lines.RemoveAt(0);
        }

        // Add type filter based on source
        var typeFilter = GetTypeFilterForSource(source);
        if (!string.IsNullOrEmpty(typeFilter))
        {
            conditions.Add(typeFilter);
        }

        // Process pipe commands
        foreach (var line in lines)
        {
            var trimmed = line.TrimStart('|').Trim();

            if (trimmed.StartsWith("where ", StringComparison.OrdinalIgnoreCase))
            {
                var condition = TranslateWhereClause(trimmed.Substring(6).Trim());
                if (!string.IsNullOrEmpty(condition))
                {
                    conditions.Add(condition);
                }
            }
            else if (trimmed.StartsWith("project ", StringComparison.OrdinalIgnoreCase))
            {
                var fields = trimmed.Substring(8).Split(',')
                    .Select(f => MapFieldName(f.Trim()))
                    .Where(f => !string.IsNullOrEmpty(f));
                projectFields.AddRange(fields);
            }
            else if (trimmed.StartsWith("take ", StringComparison.OrdinalIgnoreCase))
            {
                if (int.TryParse(trimmed.Substring(5).Trim(), out var t))
                {
                    take = t;
                }
            }
        }

        // Build WIQL
        var selectFields = projectFields.Count > 0
            ? string.Join(", ", projectFields)
            : "[System.Id], [System.Title], [System.State], [System.WorkItemType], [System.AssignedTo]";

        var wiql = $"SELECT {selectFields} FROM workitems";

        if (conditions.Count > 0)
        {
            wiql += " WHERE " + string.Join(" AND ", conditions);
        }

        _log($"Translated KQL to WIQL: {wiql}");
        return wiql;
    }

    /// <summary>
    /// Gets the WIQL type filter for a KQL source name.
    /// </summary>
    private static string? GetTypeFilterForSource(string source)
    {
        return source.ToLowerInvariant() switch
        {
            "bugs" => "[System.WorkItemType] = 'Bug'",
            "tasks" => "[System.WorkItemType] = 'Task'",
            "features" => "[System.WorkItemType] = 'Feature'",
            "epics" => "[System.WorkItemType] = 'Epic'",
            "userstories" or "pbi" => "[System.WorkItemType] IN ('User Story', 'Product Backlog Item')",
            "issues" => "[System.WorkItemType] = 'Issue'",
            "testcases" => "[System.WorkItemType] = 'Test Case'",
            "workitems" => null, // No type filter for generic WorkItems
            _ => null
        };
    }

    /// <summary>
    /// Maps a KQL-friendly field name to WIQL field name.
    /// </summary>
    private static string MapFieldName(string kqlField)
    {
        if (string.IsNullOrWhiteSpace(kqlField)) return "";

        // If already in WIQL format, return as-is
        if (kqlField.StartsWith("[") && kqlField.EndsWith("]"))
            return kqlField;

        // If already has System. or Microsoft. prefix, wrap in brackets
        if (kqlField.StartsWith("System.", StringComparison.OrdinalIgnoreCase) ||
            kqlField.StartsWith("Microsoft.", StringComparison.OrdinalIgnoreCase))
            return $"[{kqlField}]";

        // Try mapping
        if (FieldMappings.TryGetValue(kqlField, out var mapped))
            return mapped;

        // Default: assume it's a System field
        return $"[System.{kqlField}]";
    }

    /// <summary>
    /// Translates a KQL where clause to WIQL format.
    /// </summary>
    private string TranslateWhereClause(string clause)
    {
        if (string.IsNullOrWhiteSpace(clause)) return "";

        // Patterns to match
        var patterns = new (string pattern, Func<Match, string> translator)[]
        {
            // field contains "value"
            (@"^(\w+)\s+contains\s+""([^""]+)""$", m =>
                $"{MapFieldName(m.Groups[1].Value)} CONTAINS '{m.Groups[2].Value}'"),
            (@"^(\w+)\s+contains\s+'([^']+)'$", m =>
                $"{MapFieldName(m.Groups[1].Value)} CONTAINS '{m.Groups[2].Value}'"),

            // field == "value" or field == value
            (@"^(\w+)\s*==\s*""([^""]+)""$", m =>
                $"{MapFieldName(m.Groups[1].Value)} = '{m.Groups[2].Value}'"),
            (@"^(\w+)\s*==\s*'([^']+)'$", m =>
                $"{MapFieldName(m.Groups[1].Value)} = '{m.Groups[2].Value}'"),
            (@"^(\w+)\s*==\s*@(\w+)$", m =>
                $"{MapFieldName(m.Groups[1].Value)} = @{m.Groups[2].Value}"),

            // field != "value"
            (@"^(\w+)\s*!=\s*""([^""]+)""$", m =>
                $"{MapFieldName(m.Groups[1].Value)} <> '{m.Groups[2].Value}'"),
            (@"^(\w+)\s*!=\s*'([^']+)'$", m =>
                $"{MapFieldName(m.Groups[1].Value)} <> '{m.Groups[2].Value}'"),

            // field > ago(Nd) - date comparison
            (@"^(\w+)\s*(>=|<=|>|<)\s*ago\((\d+)d\)$", m =>
            {
                var field = MapFieldName(m.Groups[1].Value);
                var op = m.Groups[2].Value;
                var days = int.Parse(m.Groups[3].Value);
                return $"{field} {op} @today - {days}";
            }),

            // field comparison with @me, @today, @currentIteration
            (@"^(\w+)\s*(>=|<=|>|<|==|!=)\s*@(\w+)$", m =>
            {
                var field = MapFieldName(m.Groups[1].Value);
                var op = m.Groups[2].Value == "==" ? "=" : m.Groups[2].Value == "!=" ? "<>" : m.Groups[2].Value;
                return $"{field} {op} @{m.Groups[3].Value}";
            }),

            // field in ("val1", "val2") - not equality
            (@"^(\w+)\s+in\s+\((.+)\)$", m =>
            {
                var field = MapFieldName(m.Groups[1].Value);
                var valuesRaw = m.Groups[2].Value;
                var values = Regex.Matches(valuesRaw, @"""([^""]+)""|'([^']+)'")
                    .Cast<Match>()
                    .Select(v => "'" + (v.Groups[1].Success ? v.Groups[1].Value : v.Groups[2].Value) + "'")
                    .ToList();
                return $"{field} IN ({string.Join(", ", values)})";
            }),

            // field !in ("val1", "val2") - not in
            (@"^(\w+)\s+!in\s+\((.+)\)$", m =>
            {
                var field = MapFieldName(m.Groups[1].Value);
                var valuesRaw = m.Groups[2].Value;
                var values = Regex.Matches(valuesRaw, @"""([^""]+)""|'([^']+)'")
                    .Cast<Match>()
                    .Select(v => "'" + (v.Groups[1].Success ? v.Groups[1].Value : v.Groups[2].Value) + "'")
                    .ToList();
                return $"{field} NOT IN ({string.Join(", ", values)})";
            }),

            // Simple unquoted comparison: field == value (for backwards compat)
            (@"^(\w+)\s*(==|!=|>=|<=|>|<)\s*(\S+)$", m =>
            {
                var field = MapFieldName(m.Groups[1].Value);
                var op = m.Groups[2].Value == "==" ? "=" : m.Groups[2].Value == "!=" ? "<>" : m.Groups[2].Value;
                var value = m.Groups[3].Value;
                // If value doesn't start with @ (macro), quote it
                if (!value.StartsWith("@") && !int.TryParse(value, out _))
                    value = $"'{value}'";
                return $"{field} {op} {value}";
            }),
        };

        foreach (var (pattern, translator) in patterns)
        {
            var match = Regex.Match(clause, pattern, RegexOptions.IgnoreCase);
            if (match.Success)
            {
                return translator(match);
            }
        }

        _log($"Could not translate where clause: {clause}");
        return "";
    }

    #endregion

    /// <summary>
    /// Strips // comment lines from WIQL queries since ADO doesn't support them.
    /// </summary>
    private static string StripWiqlComments(string query)
    {
        if (string.IsNullOrWhiteSpace(query))
            return query;

        var lines = query.Split(new[] { "\r\n", "\n" }, StringSplitOptions.None);
        var nonCommentLines = lines
            .Where(line => !line.TrimStart().StartsWith("//"))
            .ToList();

        return string.Join("\n", nonCommentLines);
    }

    /// <summary>
    /// Extracts the parent work item ID from the work item fields or relations.
    /// </summary>
    private static int ExtractParentId(Microsoft.TeamFoundation.WorkItemTracking.WebApi.Models.WorkItem workItem)
    {
        // Try System.Parent field first
        if (workItem.Fields != null && workItem.Fields.TryGetValue("System.Parent", out var parentValue) && parentValue != null)
        {
            var parentStr = parentValue.ToString() ?? "";

            // If it's already a number
            if (int.TryParse(parentStr, out var directId))
                return directId;

            // If it's a URL like "vstfs:///WorkItemTracking/WorkItem/12345"
            var match = Regex.Match(parentStr, @"/(\d+)$");
            if (match.Success && int.TryParse(match.Groups[1].Value, out var urlId))
                return urlId;
        }

        // Try Relations (parent is "System.LinkTypes.Hierarchy-Reverse")
        if (workItem.Relations != null)
        {
            var parentRelation = workItem.Relations.FirstOrDefault(r =>
                r.Rel == "System.LinkTypes.Hierarchy-Reverse");

            if (parentRelation != null)
            {
                var url = parentRelation.Url;
                var match = Regex.Match(url, @"/workItems/(\d+)$", RegexOptions.IgnoreCase);
                if (match.Success && int.TryParse(match.Groups[1].Value, out var relationId))
                    return relationId;
            }
        }

        return 0;
    }
}
