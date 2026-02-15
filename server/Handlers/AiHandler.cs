using MyUtils.AI;
using Quest.Server.Protocol;

namespace Quest.Server.Handlers;

public class AiHandler
{
    private readonly AIHelper? _aiHelper;
    private readonly Dictionary<string, AiChatSession> _sessions = new();
    private readonly Action<string>? _log;

    public AiHandler(AIHelper? aiHelper, Action<string>? log = null)
    {
        _aiHelper = aiHelper;
        _log = log;
        _log?.Invoke($"AiHandler created, AIHelper is {(aiHelper == null ? "NULL" : "available")}");
    }

    public async Task<AiChatResponse> ChatAsync(AiChatRequest request, CancellationToken ct)
    {
        if (_aiHelper == null)
        {
            return new AiChatResponse(
                Message: "AI features are not configured. Please check the Output panel for details.\n\nTo enable AI:\n1. Create a file at ~/.gh_token with your GitHub token, OR\n2. The extension will use GitHub Copilot device code authentication",
                SessionId: Guid.NewGuid().ToString(),
                SuggestedQuery: null
            );
        }

        // Get or create session
        var sessionId = request.SessionId ?? Guid.NewGuid().ToString();
        if (!_sessions.TryGetValue(sessionId, out var session))
        {
            session = new AiChatSession();
            _sessions[sessionId] = session;
        }

        var mode = request.Mode ?? "kusto";
        var systemPrompt = !string.IsNullOrWhiteSpace(request.Context?.SystemPromptOverride)
            ? request.Context.SystemPromptOverride
            : GetSystemPrompt(mode);

        if (!string.IsNullOrWhiteSpace(request.Context?.PersonaInstructions))
            systemPrompt += "\n\n## PERSONA INSTRUCTIONS\n" + request.Context.PersonaInstructions;

        session.UpdateSystemPrompt(systemPrompt);

        var userMessageWithContext = BuildUserMessageWithContext(request.Message, request.Context, mode);

        try
        {
            var response = await _aiHelper.RunWithHistoryAsync(session, userMessageWithContext, 0.7f, ct);

            // Try to extract a query from the response
            string? suggestedQuery = ExtractQuery(response);

            return new AiChatResponse(
                Message: response ?? "No response received",
                SessionId: sessionId,
                SuggestedQuery: suggestedQuery
            );
        }
        catch (Exception ex) when (ex is MyUtils.AI.DeviceCodeAuthRequiredException
            || ex.InnerException is MyUtils.AI.DeviceCodeAuthRequiredException
            || ex.Message.Contains("Device code authentication required", StringComparison.OrdinalIgnoreCase)
            || ex.InnerException?.Message?.Contains("Device code authentication required", StringComparison.OrdinalIgnoreCase) == true)
        {
            // Token not available - tell extension to authenticate via VS Code
            return new AiChatResponse(
                Message: "GitHub authentication required. Please sign in to GitHub in VS Code.",
                SessionId: sessionId,
                SuggestedQuery: null,
                AuthRequired: true
            );
        }
        catch (Exception ex)
        {
            return new AiChatResponse(
                Message: $"AI request failed: {ex.Message}",
                SessionId: sessionId,
                SuggestedQuery: null
            );
        }
    }

    public async Task<GenerateTitleResponse> GenerateTitleAsync(string query, CancellationToken ct)
    {
        if (_aiHelper == null)
        {
            // Fallback: extract first line or table name
            var title = ExtractFallbackTitle(query);
            return new GenerateTitleResponse(Title: title);
        }

        try
        {
            var title = await _aiHelper.GenerateTitle(query);
            return new GenerateTitleResponse(Title: title);
        }
        catch
        {
            var title = ExtractFallbackTitle(query);
            return new GenerateTitleResponse(Title: title);
        }
    }

    /// <summary>
    /// Extracts data source information (cluster URL, database) from a screenshot using AI vision.
    /// </summary>
    public async Task<ExtractedDataSourceInfo> ExtractDataSourceFromImageAsync(
        ExtractDataSourceFromImageRequest request,
        CancellationToken ct)
    {
        _log?.Invoke($"[AI] ExtractDataSourceFromImage - Mode: {request.Mode}");

        if (_aiHelper == null)
        {
            return new ExtractedDataSourceInfo(
                Success: false,
                ClusterUrl: null,
                Database: null,
                DisplayName: null,
                Organization: null,
                Type: request.Mode,
                Error: "AI not configured",
                Confidence: 0);
        }

        var systemPrompt = GetExtractionPrompt(request.Mode);

        try
        {
            var result = await _aiHelper.ExtractFromImageAsync(
                request.ImageBase64,
                request.ImageMimeType,
                systemPrompt,
                "Extract the cluster/database information from this screenshot.",
                0.3f,
                ct);

            _log?.Invoke($"[AI] Vision result received ({result?.Length ?? 0} chars)");
            return ParseExtractionResult(result, request.Mode);
        }
        catch (Exception ex) when (ex is MyUtils.AI.DeviceCodeAuthRequiredException
            || ex.InnerException is MyUtils.AI.DeviceCodeAuthRequiredException
            || ex.Message.Contains("Device code authentication required", StringComparison.OrdinalIgnoreCase)
            || ex.InnerException?.Message?.Contains("Device code authentication required", StringComparison.OrdinalIgnoreCase) == true)
        {
            _log?.Invoke("[AI] Vision extraction needs auth");
            return new ExtractedDataSourceInfo(
                Success: false,
                ClusterUrl: null,
                Database: null,
                DisplayName: null,
                Organization: null,
                Type: request.Mode,
                Error: "AUTH_REQUIRED",
                Confidence: 0);
        }
        catch (Exception ex)
        {
            _log?.Invoke($"[AI] Vision extraction error: {ex.Message}");
            return new ExtractedDataSourceInfo(
                Success: false,
                ClusterUrl: null,
                Database: null,
                DisplayName: null,
                Organization: null,
                Type: request.Mode,
                Error: ex.Message,
                Confidence: 0);
        }
    }

    private static string GetExtractionPrompt(string mode)
    {
        return mode == "kusto" ? @"You are extracting Azure Data Explorer (Kusto) connection information from a screenshot.

IMPORTANT: In tree views, the structure is:
- Top-level item = Cluster (e.g., '1es', 'icmcluster', 'help')
- Nested items under cluster = Databases (e.g., '1ESPTInsights', 'Samples')

Look for ALL visible clusters and ALL their databases. Return every cluster+database pair you can see.

1. Cluster URL - PREFER the FULL URL if visible (e.g., https://xyz.kusto.windows.net or https://xyz.kusto.azure.com)
   - If only a short name is visible (like '1es'), return it as-is
   - Look in address bars, connection dialogs, tooltips, or status bars for full URLs
   - Common domains: .kusto.windows.net, .kusto.azure.com, .kusto.data.microsoft.com
2. Databases - ALL items shown UNDER each cluster in tree view
3. Display name - use the cluster short name

Common cluster naming patterns:
- Short names: 1es, icmcluster, help, azsc
- Full URLs: https://1es.kusto.windows.net, https://help.kusto.azure.com

Respond ONLY in this exact JSON format, nothing else:
{""clusters"": [{""clusterUrl"": ""FULL URL if visible, otherwise short name"", ""databases"": [""db1"", ""db2""], ""displayName"": ""suggested name""}], ""confidence"": 0.9}

If you cannot find a value, set it to null. Set confidence between 0.0-1.0 based on how certain you are." :

@"You are extracting Azure DevOps connection information from a screenshot.
Look for:
1. Organization URL (e.g., https://dev.azure.com/myorg or myorg.visualstudio.com)
2. Project name
3. Organization name

Respond ONLY in this exact JSON format, nothing else:
{""organizationUrl"": ""the org URL"", ""project"": ""project name or null"", ""organization"": ""org name"", ""displayName"": ""suggested name"", ""confidence"": 0.9}

If you cannot find a value, set it to null. Set confidence between 0.0-1.0 based on how certain you are.";
    }

    private ExtractedDataSourceInfo ParseExtractionResult(string result, string mode)
    {
        try
        {
            // Clean up the response - sometimes AI adds markdown code blocks
            var json = result.Trim();
            if (json.StartsWith("```"))
            {
                var lines = json.Split('\n');
                json = string.Join("\n", lines.Skip(1).TakeWhile(l => !l.StartsWith("```")));
            }

            using var doc = System.Text.Json.JsonDocument.Parse(json);
            var root = doc.RootElement;

            if (mode == "kusto")
            {
                var confidence = root.TryGetProperty("confidence", out var confProp) ? confProp.GetSingle() : 0.5f;

                // Parse multi-cluster array format
                ExtractedClusterItem[]? clusters = null;
                string? firstClusterUrl = null;
                string? firstDatabase = null;
                string? firstDisplayName = null;

                if (root.TryGetProperty("clusters", out var clustersArr) && clustersArr.ValueKind == System.Text.Json.JsonValueKind.Array)
                {
                    var list = new List<ExtractedClusterItem>();
                    foreach (var item in clustersArr.EnumerateArray())
                    {
                        var url = item.TryGetProperty("clusterUrl", out var u) ? u.GetString() : null;
                        if (string.IsNullOrEmpty(url)) continue;

                        var dbs = new List<string>();
                        if (item.TryGetProperty("databases", out var dbArr) && dbArr.ValueKind == System.Text.Json.JsonValueKind.Array)
                        {
                            foreach (var db in dbArr.EnumerateArray())
                            {
                                var dbName = db.GetString();
                                if (!string.IsNullOrEmpty(dbName))
                                    dbs.Add(dbName);
                            }
                        }

                        var name = item.TryGetProperty("displayName", out var n) ? n.GetString() : null;
                        list.Add(new ExtractedClusterItem(url!, dbs.ToArray(), name));
                    }
                    if (list.Count > 0)
                    {
                        clusters = list.ToArray();
                        firstClusterUrl = clusters[0].ClusterUrl;
                        firstDatabase = clusters[0].Databases.Length > 0 ? clusters[0].Databases[0] : null;
                        firstDisplayName = clusters[0].DisplayName;
                    }
                }

                // Fallback: single-cluster format (backward compat)
                if (clusters == null || clusters.Length == 0)
                {
                    firstClusterUrl = root.TryGetProperty("clusterUrl", out var urlProp) ? urlProp.GetString() : null;
                    firstDatabase = root.TryGetProperty("database", out var dbProp) ? dbProp.GetString() : null;
                    firstDisplayName = root.TryGetProperty("displayName", out var nameProp) ? nameProp.GetString() : null;
                }

                return new ExtractedDataSourceInfo(
                    Success: !string.IsNullOrEmpty(firstClusterUrl),
                    ClusterUrl: firstClusterUrl,
                    Database: firstDatabase,
                    DisplayName: firstDisplayName,
                    Organization: null,
                    Type: "kusto",
                    Error: null,
                    Confidence: confidence,
                    Clusters: clusters);
            }
            else // ado
            {
                var orgUrl = root.TryGetProperty("organizationUrl", out var urlProp) ? urlProp.GetString() : null;
                var project = root.TryGetProperty("project", out var projProp) ? projProp.GetString() : null;
                var org = root.TryGetProperty("organization", out var orgProp) ? orgProp.GetString() : null;
                var displayName = root.TryGetProperty("displayName", out var nameProp) ? nameProp.GetString() : null;
                var confidence = root.TryGetProperty("confidence", out var confProp) ? confProp.GetSingle() : 0.5f;

                return new ExtractedDataSourceInfo(
                    Success: !string.IsNullOrEmpty(orgUrl),
                    ClusterUrl: orgUrl,
                    Database: project,
                    DisplayName: displayName,
                    Organization: org,
                    Type: "ado",
                    Error: null,
                    Confidence: confidence);
            }
        }
        catch (Exception ex)
        {
            _log?.Invoke($"[AI] Failed to parse extraction result: {ex.Message}");
            return new ExtractedDataSourceInfo(
                Success: false,
                ClusterUrl: null,
                Database: null,
                DisplayName: null,
                Organization: null,
                Type: mode,
                Error: $"Failed to parse AI response: {ex.Message}",
                Confidence: 0);
        }
    }

    /// <summary>
    /// System prompt contains only instructions - no context data.
    /// Mode-specific prompts for KQL, WIQL, and OQL.
    /// </summary>
    public static string GetSystemPrompt(string mode)
    {
        return mode switch
        {
            "outlook" => @"You are an OQL (Outlook Query Language) assistant. OQL uses KQL-like syntax.

## YOUR ROLE
You help build OQL queries to search Outlook emails, calendar, contacts, and tasks.

## OQL SYNTAX (KQL-like)
FolderName
| where Field operator ""value""
| where Field > ago(Nd)
| take N

## FOLDERS
Inbox, SentMail, Drafts, DeletedItems, Calendar, Contacts, Tasks, Rules

## MAIL FIELDS
Subject, From, To, ReceivedTime, UnRead, HasAttachments, Importance, Body

## CALENDAR FIELDS
Subject, Start, End, Location, Organizer, IsRecurring

## CONTACT FIELDS
FullName, Email1Address, CompanyName, BusinessPhone, JobTitle

## TASK FIELDS
Subject, DueDate, Status, PercentComplete, Owner

## RULES FIELDS (virtual folder for mail rules)
Name, ExecutionOrder, RuleType, Conditions, Actions, Exceptions, Enabled

## OPERATORS
- contains: partial text match (Subject contains ""meeting"")
- ==, !=: exact match (UnRead == true)
- >, <, >=, <=: comparison (ReceivedTime > ago(7d))
- startswith, endswith: prefix/suffix match

## TIME FUNCTIONS
- ago(7d): 7 days ago
- ago(24h): 24 hours ago
- ago(30m): 30 minutes ago
- now(): current time

## EXAMPLES
```oql
// Get recent unread emails
Inbox
| where UnRead == true
| where ReceivedTime > ago(7d)
| take 50
```

```oql
// Search emails from specific sender
Inbox
| where From contains ""john""
| take 100
```

```oql
// Emails with keyword in subject from last month
Inbox
| where Subject contains ""report""
| where ReceivedTime > ago(30d)
| take 100
```

```oql
// Calendar events
Calendar
| where Start > now()
| take 20
```

```oql
// Mail rules
Rules
| take 100
```

## INSTRUCTIONS
1. ALWAYS use KQL-like pipe syntax, NOT SQL syntax
2. Use ""contains"" for partial text search (not LIKE)
3. Use ago(Nd) for relative dates (d=days, h=hours, m=minutes)
4. Each | where is a separate filter (AND logic)
5. Use | take N to limit results
6. Wrap queries in ```oql code blocks

## OUTPUT
For query requests: output in ```oql blocks. For other questions: plain text.",

            "ado" => @"You are a WIQL (Work Item Query Language) assistant.

## YOUR ROLE
You help with Azure DevOps Work Item Query Language (WIQL) queries.

## INSTRUCTIONS
1. If the user provides a '## USER WIQL' block, modify it based on their request.
2. Generate complete, runnable WIQL queries.
3. Wrap queries in triple backticks (```wiql).
4. If '## ADO DEFAULTS (MANDATORY)' section is provided, you MUST include the Area Path filter in EVERY query. This is non-negotiable.

## WIQL BEST PRACTICES
1. Use proper field references: [System.Id], [System.Title], [System.State], etc.
2. Use @Me for current user, @Today for today's date
3. Common fields: WorkItemType, State, AssignedTo, CreatedDate, ChangedDate
4. Filter by Area Path using: [System.AreaPath] UNDER 'Project\Team'
5. Filter by Iteration using: [System.IterationPath] = @CurrentIteration

## AREA PATH RULE
When the '## ADO DEFAULTS (MANDATORY)' section specifies a Default Area Path, you MUST ALWAYS add it as a WHERE clause filter.
- For WIQL: `AND [System.AreaPath] UNDER '<area path>'`
- For KQL-style: `| where AreaPath under ""<area path>""`
NEVER omit the area path filter when defaults are provided. This applies to every single query without exception.

## EXAMPLE
```wiql
SELECT [System.Id], [System.Title], [System.State], [System.AssignedTo]
FROM WorkItems
WHERE [System.WorkItemType] = 'Bug'
AND [System.AreaPath] UNDER 'MyProject\MyTeam'
AND [System.State] <> 'Closed'
ORDER BY [System.ChangedDate] DESC
```

## OUTPUT RULE
- For query requests: output the query in ```wiql blocks with brief explanation.
- For non-query requests: plain text, no code fences.",

            _ => @"You are a KQL (Kusto Query Language) assistant.

## YOUR ROLE
You help with Azure Data Explorer Kusto Query Language (KQL) generation and modification.

## CRITICAL: TABLE SELECTION (READ THIS FIRST!)
When generating queries:
1. ALWAYS scan the '## AVAILABLE TABLES' section for the best matching table name
2. Match keywords from user's request to table names (e.g., user says 'tenants' -> use a table with 'Tenant' in name)
3. IGNORE favorites when choosing tables - favorites are just examples, not suggestions for which table to use
4. Only use a table from favorites if no better match exists in AVAILABLE TABLES

## INSTRUCTIONS
1. If the user provides a '## USER KQL' block, treat it as the CURRENT QUERY and modify it.
2. Generate precise, efficient KQL queries.
3. Wrap queries in triple backticks (```kql).

## KQL BEST PRACTICES
1. Include time filters (e.g., where Timestamp > ago(7d))
2. Use 'project' to limit columns for better performance
3. Use 'summarize' for aggregations with appropriate bin() for time series

## OUTPUT RULE
- For query requests: output the query in ```kql blocks with brief explanation.
- For non-query requests: plain text, no code fences."
        };
    }

    /// <summary>
    /// Builds the user message with context prepended.
    /// Following the pattern from KustoAIContextBuilder.BuildNaturalLanguageContext.
    /// </summary>
    private static string BuildUserMessageWithContext(string userMessage, AiContext? context, string mode)
    {
        var sb = new System.Text.StringBuilder();

        // IMPORTANT: Add current date so AI knows what "today", "this week", etc. mean
        sb.AppendLine($"## CURRENT DATE: {DateTime.Now:yyyy-MM-dd} ({DateTime.Now:dddd})");
        sb.AppendLine();

        // Get mode-specific labels
        var (queryLabel, codeFence) = mode switch
        {
            "outlook" => ("OQL", "oql"),
            "ado" => ("WIQL", "wiql"),
            _ => ("KQL", "kql")
        };

        // Add available tables FIRST - this is critical for table selection
        if (context?.AvailableTables != null && context.AvailableTables.Length > 0)
        {
            sb.AppendLine("## AVAILABLE TABLES (USE THESE!)");
            sb.AppendLine("IMPORTANT: Pick the table whose name best matches the user's request. DO NOT default to tables from favorites.");
            sb.AppendLine("For example: if user asks about 'tenants', look for tables with 'Tenant' in the name.");
            sb.AppendLine();
            // Show up to 100 tables
            var tablesToShow = context.AvailableTables.Take(100);
            sb.AppendLine(string.Join(", ", tablesToShow));
            if (context.AvailableTables.Length > 100)
                sb.AppendLine($"... and {context.AvailableTables.Length - 100} more");
            sb.AppendLine();
        }

        // Add current query context if available - this is the key context
        if (context?.CurrentQuery != null && !string.IsNullOrWhiteSpace(context.CurrentQuery))
        {
            sb.AppendLine($"## USER {queryLabel}");
            sb.AppendLine("The following query is currently in the editor. Modify THIS query based on my request:");
            sb.AppendLine($"```{codeFence}");
            sb.AppendLine(context.CurrentQuery);
            sb.AppendLine("```");
            sb.AppendLine();
        }

        // Add favorites context (limited to prevent token overflow)
        if (context?.Favorites != null && context.Favorites.Length > 0)
        {
            sb.AppendLine("## FAVORITES (for reference)");
            foreach (var fav in context.Favorites.Take(5))
            {
                var truncated = fav.Length > 100 ? fav.Substring(0, 100) + "..." : fav;
                sb.AppendLine($"- {truncated}");
            }
            sb.AppendLine();
        }

        // Add recent history context (limited)
        if (context?.RecentQueries != null && context.RecentQueries.Length > 0)
        {
            sb.AppendLine("## RECENT QUERIES");
            foreach (var query in context.RecentQueries.Take(3))
            {
                var truncated = query.Length > 80 ? query.Substring(0, 80) + "..." : query;
                sb.AppendLine($"- {truncated}");
            }
            sb.AppendLine();
        }

        // Add ADO-specific context
        if (mode == "ado" && context?.AdoContext != null)
        {
            var adoCtx = context.AdoContext;
            if (!string.IsNullOrWhiteSpace(adoCtx.DefaultAreaPath) || !string.IsNullOrWhiteSpace(adoCtx.DefaultProject))
            {
                sb.AppendLine("## ADO DEFAULTS (MANDATORY)");
                if (!string.IsNullOrWhiteSpace(adoCtx.DefaultProject))
                    sb.AppendLine($"Default Project: {adoCtx.DefaultProject}");
                if (!string.IsNullOrWhiteSpace(adoCtx.DefaultAreaPath))
                {
                    sb.AppendLine($"Default Area Path: {adoCtx.DefaultAreaPath}");
                    sb.AppendLine($"CRITICAL: You MUST add `[System.AreaPath] UNDER '{adoCtx.DefaultAreaPath}'` to the WHERE clause of EVERY WIQL query you generate, unless the user explicitly asks for a different area path.");
                    sb.AppendLine($"For KQL-style queries, add: `| where AreaPath under \"{adoCtx.DefaultAreaPath}\"`");
                }
                sb.AppendLine();
            }
        }

        // Add the user's actual request
        sb.AppendLine("## REQUEST");
        sb.AppendLine(userMessage ?? "");

        return sb.ToString();
    }

    private static string? ExtractQuery(string response)
    {
        // Try to extract query from code blocks (KQL, WIQL, OQL)
        var patterns = new[]
        {
            @"```(?:kql|kusto)\n([\s\S]*?)```",
            @"```(?:wiql|sql)\n([\s\S]*?)```",
            @"```(?:oql|outlook)\n([\s\S]*?)```",
            @"```\n([\s\S]*?)```"
        };

        foreach (var pattern in patterns)
        {
            var match = System.Text.RegularExpressions.Regex.Match(response, pattern);
            if (match.Success)
            {
                return match.Groups[1].Value.Trim();
            }
        }

        return null;
    }


    private static string ExtractFallbackTitle(string query)
    {
        // Try to extract table name from the start of the query (KQL style: TableName | ...)
        var tableMatch = System.Text.RegularExpressions.Regex.Match(
            query,
            @"^\s*(\w+)\s*\|",
            System.Text.RegularExpressions.RegexOptions.Multiline
        );

        if (tableMatch.Success)
        {
            var tableName = tableMatch.Groups[1].Value;

            // Try to add context from the first operator (e.g., "where", "summarize")
            var operatorMatch = System.Text.RegularExpressions.Regex.Match(
                query,
                @"\|\s*(where|summarize|project|extend|join|distinct|count|take|top)\b",
                System.Text.RegularExpressions.RegexOptions.IgnoreCase
            );

            if (operatorMatch.Success)
            {
                var op = operatorMatch.Groups[1].Value.ToLower();
                if (op == "where") return tableName + "Filtered";
                if (op == "summarize" || op == "count") return tableName + "Summary";
                if (op == "distinct") return tableName + "Distinct";
                if (op == "take" || op == "top") return tableName + "Sample";
            }

            return tableName;
        }

        // Try to extract from comment
        var commentMatch = System.Text.RegularExpressions.Regex.Match(query, @"^//\s*(.+)$", System.Text.RegularExpressions.RegexOptions.Multiline);
        if (commentMatch.Success)
        {
            return commentMatch.Groups[1].Value.Substring(0, Math.Min(30, commentMatch.Groups[1].Value.Length));
        }

        // Try FROM clause (SQL/WIQL style)
        var fromMatch = System.Text.RegularExpressions.Regex.Match(
            query,
            @"\bFROM\s+(\w+)",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase
        );
        if (fromMatch.Success)
        {
            return fromMatch.Groups[1].Value;
        }

        return "QueryResult";
    }

    /// <summary>
    /// Sets the GitHub token directly (e.g., restored from extension storage on startup).
    /// </summary>
    public bool SetToken(string token)
    {
        if (_aiHelper == null || string.IsNullOrEmpty(token))
        {
            return false;
        }

        _aiHelper.SetGitHubToken(token);
        return true;
    }

    /// <summary>
    /// Clears the stored AI authentication token, forcing re-authentication on next request.
    /// </summary>
    public ClearTokenResult ClearToken()
    {
        if (_aiHelper == null)
        {
            return new ClearTokenResult(Success: false, Error: "AI not configured");
        }

        try
        {
            _aiHelper.ClearStoredToken();
            // Also clear chat sessions so user gets a fresh start
            _sessions.Clear();
            _log?.Invoke("[AI] Token and sessions cleared");
            return new ClearTokenResult(Success: true, Error: null);
        }
        catch (Exception ex)
        {
            _log?.Invoke($"[AI] Failed to clear token: {ex.Message}");
            return new ClearTokenResult(Success: false, Error: ex.Message);
        }
    }
}
