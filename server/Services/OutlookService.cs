using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using Microsoft.Office.Interop.Outlook;
using Exception = System.Exception;

namespace Quest.Server.Services;

/// <summary>
/// Service for querying Outlook data via COM Interop using KQL-like syntax.
///
/// OQL (Outlook Query Language) - KQL-like syntax:
///   Inbox
///   | where Subject contains "meeting"
///   | where From contains "john"
///   | where ReceivedTime > ago(7d)
///   | project Subject, From, ReceivedTime
///   | take 100
///
/// Supported folders: Inbox, SentMail, Drafts, Calendar, Contacts, Tasks, DeletedItems, Notes, Journal, Outbox, Junk
///
/// Mail fields: Subject, From, SenderEmail, To, CC, ReceivedTime, SentTime, HasAttachments, AttachmentCount,
///              Importance, UnRead, Categories, Size, BodyPreview, ConversationTopic, EntryId
///
/// Calendar fields: Subject, Start, End, Location, Organizer, IsRecurring, RecurrenceState, BusyStatus, EntryId
///
/// Contacts fields: FullName, Email1Address, CompanyName, BusinessPhone, MobilePhone, JobTitle, EntryId
///
/// Tasks fields: Subject, DueDate, Status, PercentComplete, Owner, Importance, EntryId
///
/// Supported operators: contains, ==, !=, >, <, >=, <=, startswith, endswith
/// Supported functions: ago(Nd), ago(Nh), ago(Nm), now()
/// </summary>
public class OutlookService : IDisposable
{
    private Application? _outlookApp;
    private NameSpace? _namespace;
    private readonly Action<string>? _log;
    private Search? _currentSearch;
    private TaskCompletionSource<List<object>>? _searchCompletionSource;

    public OutlookService(Action<string>? log = null)
    {
        _log = log;
    }

    public void Connect()
    {
        if (_outlookApp != null) return;

        _log?.Invoke("Connecting to Outlook...");
        _outlookApp = new Application();
        _namespace = _outlookApp.GetNamespace("MAPI");
        _outlookApp.AdvancedSearchComplete += OnAdvancedSearchComplete;
        _log?.Invoke("Connected to Outlook");
    }

    public bool IsConnected => _outlookApp != null;

    /// <summary>
    /// Execute an Outlook query and return results.
    /// Query format: SELECT * FROM FolderName WHERE filter
    /// Or just: FolderName | filter (simplified syntax)
    /// </summary>
    public async Task<OutlookQueryResult> ExecuteQueryAsync(string query, CancellationToken ct, int maxResults = 500)
    {
        Connect();

        try
        {
            var (folderType, filter, take, projectColumns, projectReorderColumns, postFilters) = ParseQuery(query);
            // Use take from query if specified, otherwise use maxResults parameter
            var effectiveMaxResults = take ?? maxResults;
            // Fetch more items if we have post-filters to ensure we get enough after filtering
            var fetchLimit = postFilters.Count > 0 ? effectiveMaxResults * 3 : effectiveMaxResults;
            _log?.Invoke($"Executing Outlook query: Folder={folderType}, Filter={filter}, Take={effectiveMaxResults}, PostFilters={postFilters.Count}");

            // Rules is a virtual folder - handle separately
            if (folderType.Equals("rules", StringComparison.OrdinalIgnoreCase))
            {
                return GetRulesAsResult(effectiveMaxResults, projectColumns, projectReorderColumns, postFilters);
            }

            var folder = GetFolder(folderType);
            if (folder == null)
            {
                return new OutlookQueryResult
                {
                    Success = false,
                    Error = $"Folder not found: {folderType}"
                };
            }

            var items = await SearchFolderAsync(folder, filter, ct, fetchLimit);

            // Process items and release COM objects immediately to prevent memory exhaustion
            var result = ConvertToResultAndRelease(items, folderType, effectiveMaxResults, projectColumns, projectReorderColumns, postFilters);

            Marshal.ReleaseComObject(folder);

            // Force GC after large operations to reclaim COM memory
            if (items.Count > 100)
            {
                GC.Collect();
                GC.WaitForPendingFinalizers();
            }

            return result;
        }
        catch (Exception ex)
        {
            _log?.Invoke($"Query error: {ex.Message}");
            return new OutlookQueryResult
            {
                Success = false,
                Error = ex.Message
            };
        }
    }

    /// <summary>
    /// Get available folders for autocomplete
    /// </summary>
    public List<OutlookFolderInfo> GetFolders()
    {
        Connect();
        var folders = new List<OutlookFolderInfo>();

        try
        {
            // Add default folders
            folders.Add(new OutlookFolderInfo("Inbox", "Mail inbox", OlDefaultFolders.olFolderInbox));
            folders.Add(new OutlookFolderInfo("SentMail", "Sent items", OlDefaultFolders.olFolderSentMail));
            folders.Add(new OutlookFolderInfo("Drafts", "Draft messages", OlDefaultFolders.olFolderDrafts));
            folders.Add(new OutlookFolderInfo("DeletedItems", "Deleted items", OlDefaultFolders.olFolderDeletedItems));
            folders.Add(new OutlookFolderInfo("Calendar", "Calendar events", OlDefaultFolders.olFolderCalendar));
            folders.Add(new OutlookFolderInfo("Contacts", "Contacts", OlDefaultFolders.olFolderContacts));
            folders.Add(new OutlookFolderInfo("Tasks", "Tasks", OlDefaultFolders.olFolderTasks));
            folders.Add(new OutlookFolderInfo("Notes", "Notes", OlDefaultFolders.olFolderNotes));
            folders.Add(new OutlookFolderInfo("Journal", "Journal entries", OlDefaultFolders.olFolderJournal));
            folders.Add(new OutlookFolderInfo("Rules", "Mail rules", OlDefaultFolders.olFolderInbox)); // Virtual folder, FolderType unused
        }
        catch (Exception ex)
        {
            _log?.Invoke($"Error getting folders: {ex.Message}");
        }

        return folders;
    }

    /// <summary>
    /// Parsed OQL query result
    /// </summary>
    private class ParsedOqlQuery
    {
        public string Folder { get; set; } = "Inbox";
        public List<OqlCondition> Conditions { get; set; } = new();
        public List<string>? ProjectColumns { get; set; }
        public List<string>? ProjectReorderColumns { get; set; }
        public int? Take { get; set; }
    }

    private class OqlCondition
    {
        public string Field { get; set; } = "";
        public string Operator { get; set; } = "";
        public string Value { get; set; } = "";
        public bool RequiresPostFilter { get; set; } = false; // Body filters need post-filtering
    }

    private ParsedOqlQuery ParseOqlQuery(string query)
    {
        var result = new ParsedOqlQuery();
        query = query.Trim();

        // Strip comment lines (// and --)
        var lines = query.Split(new[] { "\r\n", "\n" }, StringSplitOptions.None)
            .Where(line => !line.TrimStart().StartsWith("//"))
            .Where(line => !line.TrimStart().StartsWith("--"))
            .ToList();

        if (lines.Count == 0) return result;

        // First non-empty line is the folder name
        var firstLine = lines[0].Trim();

        // Check if first line contains a pipe (inline query like: Inbox | where ...)
        if (firstLine.Contains('|'))
        {
            var pipeIndex = firstLine.IndexOf('|');
            result.Folder = firstLine.Substring(0, pipeIndex).Trim();
            // Treat rest as additional line
            lines[0] = firstLine.Substring(pipeIndex);
        }
        else
        {
            result.Folder = firstLine;
            lines.RemoveAt(0);
        }

        // Process pipe commands
        foreach (var line in lines)
        {
            var trimmed = line.Trim();
            if (!trimmed.StartsWith("|")) continue;

            trimmed = trimmed.Substring(1).Trim(); // Remove leading pipe

            // Parse: where Field operator "value" or where Field operator value
            if (trimmed.StartsWith("where ", StringComparison.OrdinalIgnoreCase))
            {
                var condition = ParseWhereClause(trimmed.Substring(6).Trim());
                if (condition != null)
                {
                    result.Conditions.Add(condition);
                }
            }
            // Parse: project-reorder Field1, Field2, Field3
            else if (trimmed.StartsWith("project-reorder ", StringComparison.OrdinalIgnoreCase))
            {
                var fields = trimmed.Substring(16).Split(',')
                    .Select(f => f.Trim())
                    .Where(f => !string.IsNullOrEmpty(f))
                    .ToList();
                result.ProjectReorderColumns = fields;
            }
            // Parse: project Field1, Field2, Field3
            else if (trimmed.StartsWith("project ", StringComparison.OrdinalIgnoreCase))
            {
                var fields = trimmed.Substring(8).Split(',')
                    .Select(f => f.Trim())
                    .Where(f => !string.IsNullOrEmpty(f))
                    .ToList();
                result.ProjectColumns = fields;
            }
            // Parse: take N
            else if (trimmed.StartsWith("take ", StringComparison.OrdinalIgnoreCase))
            {
                if (int.TryParse(trimmed.Substring(5).Trim(), out var take))
                {
                    result.Take = take;
                }
            }
        }

        return result;
    }

    private OqlCondition? ParseWhereClause(string clause)
    {
        // Patterns to match:
        // Field contains "value"
        // Field == "value" or Field == value
        // Field != "value"
        // Field > ago(7d) or Field > "2024-01-01"
        // Field >= ago(7d)
        // Field startswith "value"
        // Field endswith "value"

        var patterns = new[]
        {
            // contains with quoted value
            (@"^(\w+)\s+contains\s+""([^""]+)""$", "contains"),
            (@"^(\w+)\s+contains\s+'([^']+)'$", "contains"),
            // startswith/endswith
            (@"^(\w+)\s+startswith\s+""([^""]+)""$", "startswith"),
            (@"^(\w+)\s+endswith\s+""([^""]+)""$", "endswith"),
            // comparison with quoted value
            (@"^(\w+)\s*(==|!=|>=|<=|>|<)\s*""([^""]+)""$", "compare"),
            (@"^(\w+)\s*(==|!=|>=|<=|>|<)\s*'([^']+)'$", "compare"),
            // comparison with ago() function
            (@"^(\w+)\s*(>=|<=|>|<)\s*ago\((\d+)([dhm])\)$", "ago"),
            // comparison with now()
            (@"^(\w+)\s*(>=|<=|>|<)\s*now\(\)$", "now"),
            // boolean: Field == true/false
            (@"^(\w+)\s*(==|!=)\s*(true|false)$", "bool"),
            // unquoted value (for backwards compat)
            (@"^(\w+)\s*(==|!=|>=|<=|>|<)\s*(\S+)$", "compare"),
        };

        foreach (var (pattern, type) in patterns)
        {
            var match = Regex.Match(clause, pattern, RegexOptions.IgnoreCase);
            if (match.Success)
            {
                var field = match.Groups[1].Value;

                if (type == "contains")
                {
                    // Body filters don't work reliably in DASL, need post-filtering
                    var requiresPostFilter = field.Equals("body", StringComparison.OrdinalIgnoreCase) ||
                                            field.Equals("bodypreview", StringComparison.OrdinalIgnoreCase);
                    return new OqlCondition { Field = field, Operator = "contains", Value = match.Groups[2].Value, RequiresPostFilter = requiresPostFilter };
                }
                else if (type == "startswith")
                {
                    return new OqlCondition { Field = field, Operator = "startswith", Value = match.Groups[2].Value };
                }
                else if (type == "endswith")
                {
                    return new OqlCondition { Field = field, Operator = "endswith", Value = match.Groups[2].Value };
                }
                else if (type == "compare")
                {
                    var op = match.Groups[2].Value;
                    var value = match.Groups[3].Value;
                    return new OqlCondition { Field = field, Operator = op, Value = value };
                }
                else if (type == "ago")
                {
                    var op = match.Groups[2].Value;
                    var amount = int.Parse(match.Groups[3].Value);
                    var unit = match.Groups[4].Value.ToLower();
                    var date = unit switch
                    {
                        "d" => DateTime.Now.AddDays(-amount),
                        "h" => DateTime.Now.AddHours(-amount),
                        "m" => DateTime.Now.AddMinutes(-amount),
                        _ => DateTime.Now.AddDays(-amount)
                    };
                    return new OqlCondition { Field = field, Operator = op, Value = date.ToString("yyyy-MM-dd HH:mm:ss") };
                }
                else if (type == "now")
                {
                    var op = match.Groups[2].Value;
                    return new OqlCondition { Field = field, Operator = op, Value = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") };
                }
                else if (type == "bool")
                {
                    var op = match.Groups[2].Value;
                    var value = match.Groups[3].Value.ToLower();
                    return new OqlCondition { Field = field, Operator = op, Value = value };
                }
            }
        }

        _log?.Invoke($"Could not parse where clause: {clause}");
        return null;
    }

    // Legacy method for backward compatibility - converts to new format
    private (string folderType, string filter, int? take, List<string>? projectColumns, List<string>? projectReorderColumns, List<OqlCondition> postFilters) ParseQuery(string query)
    {
        var parsed = ParseOqlQuery(query);
        var filter = ConvertConditionsToLegacyFilter(parsed.Conditions);
        var postFilters = parsed.Conditions.Where(c => c.RequiresPostFilter).ToList();
        return (parsed.Folder, filter, parsed.Take, parsed.ProjectColumns, parsed.ProjectReorderColumns, postFilters);
    }

    private string ConvertConditionsToLegacyFilter(List<OqlCondition> conditions)
    {
        if (conditions.Count == 0) return "";

        var parts = new List<string>();
        foreach (var c in conditions)
        {
            if (c.Operator == "contains")
            {
                parts.Add($"{c.Field} LIKE '%{c.Value}%'");
            }
            else if (c.Operator == "startswith")
            {
                parts.Add($"{c.Field} LIKE '{c.Value}%'");
            }
            else if (c.Operator == "endswith")
            {
                parts.Add($"{c.Field} LIKE '%{c.Value}'");
            }
            else
            {
                parts.Add($"{c.Field} {c.Operator} '{c.Value}'");
            }
        }
        return string.Join(" AND ", parts);
    }

    private MAPIFolder? GetFolder(string folderType)
    {
        if (_namespace == null) return null;

        var folderEnum = folderType.ToLowerInvariant() switch
        {
            "inbox" => OlDefaultFolders.olFolderInbox,
            "sentmail" or "sent" or "sentitems" => OlDefaultFolders.olFolderSentMail,
            "drafts" => OlDefaultFolders.olFolderDrafts,
            "deleteditems" or "trash" or "deleted" => OlDefaultFolders.olFolderDeletedItems,
            "calendar" => OlDefaultFolders.olFolderCalendar,
            "contacts" => OlDefaultFolders.olFolderContacts,
            "tasks" => OlDefaultFolders.olFolderTasks,
            "notes" => OlDefaultFolders.olFolderNotes,
            "journal" => OlDefaultFolders.olFolderJournal,
            "outbox" => OlDefaultFolders.olFolderOutbox,
            "junk" or "junkmail" or "spam" => OlDefaultFolders.olFolderJunk,
            _ => OlDefaultFolders.olFolderInbox
        };

        try
        {
            return _namespace.GetDefaultFolder(folderEnum);
        }
        catch
        {
            _log?.Invoke($"Could not get folder: {folderType}");
            return null;
        }
    }

    private async Task<List<object>> SearchFolderAsync(MAPIFolder folder, string filter, CancellationToken ct, int maxResults)
    {
        if (string.IsNullOrWhiteSpace(filter))
        {
            // No filter - get items directly
            return GetItemsDirectly(folder, maxResults, ct);
        }

        // Convert filter to DASL format and use AdvancedSearch
        var daslFilter = ConvertToDASLFilter(filter);
        // _log?.Invoke($"DASL filter: {daslFilter}");

        if (string.IsNullOrWhiteSpace(daslFilter))
        {
            // Couldn't convert filter, get all items
            return GetItemsDirectly(folder, maxResults, ct);
        }

        // Use AdvancedSearch with event-based completion (like Couper)
        _searchCompletionSource = new TaskCompletionSource<List<object>>();
        _maxSearchResults = maxResults;

        var scope = "'" + folder.FolderPath + "'";
        // _log?.Invoke($"AdvancedSearch scope: {scope}");

        try
        {
            // Use true for SearchSubFolders to include subfolders in search
            _currentSearch = _outlookApp!.AdvancedSearch(scope, daslFilter, true, "QuestSearch");

            // Wait for search to complete with timeout
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(TimeSpan.FromSeconds(60));

            var results = await _searchCompletionSource.Task.WaitAsync(cts.Token);
            // Logging handled at result level
            return results;
        }
        catch (OperationCanceledException)
        {
            _currentSearch?.Stop();
            throw;
        }
        catch (Exception ex)
        {
            _log?.Invoke($"AdvancedSearch failed: {ex.Message}, falling back to direct iteration");
            return GetItemsDirectly(folder, maxResults, ct);
        }
    }

    private int _maxSearchResults = 1000;

    private List<object> GetItemsDirectly(MAPIFolder folder, int maxResults, CancellationToken ct)
    {
        var results = new List<object>();
        GetItemsRecursively(folder, results, maxResults, ct);
        return results;
    }

    private void GetItemsRecursively(MAPIFolder folder, List<object> results, int maxResults, CancellationToken ct)
    {
        if (ct.IsCancellationRequested || results.Count >= maxResults) return;

        try
        {
            var items = folder.Items;

            // Sort by received time descending
            try { items.Sort("[ReceivedTime]", true); } catch { }

            var remaining = maxResults - results.Count;
            var count = Math.Min(items.Count, remaining);
            for (int i = 1; i <= count; i++)
            {
                if (ct.IsCancellationRequested || results.Count >= maxResults) break;
                try { results.Add(items[i]); } catch { }
            }
        }
        catch (Exception ex)
        {
            _log?.Invoke($"Error reading items from folder {folder.Name}: {ex.Message}");
        }

        // Recursively search subfolders
        try
        {
            foreach (MAPIFolder subfolder in folder.Folders)
            {
                if (ct.IsCancellationRequested || results.Count >= maxResults) break;
                GetItemsRecursively(subfolder, results, maxResults, ct);
                Marshal.ReleaseComObject(subfolder);
            }
        }
        catch (Exception ex)
        {
            _log?.Invoke($"Error reading subfolders of {folder.Name}: {ex.Message}");
        }
    }

    /// <summary>
    /// Convert SQL-like filter to DASL format for AdvancedSearch (like Couper does)
    /// </summary>
    private string ConvertToDASLFilter(string filter)
    {
        if (string.IsNullOrWhiteSpace(filter)) return "";

        var conditions = new List<string>();

        // Map field names to DASL URN schemas
        var fieldMappings = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            { "subject", "urn:schemas:httpmail:subject" },
            { "from", "urn:schemas:httpmail:sendername" },
            { "sender", "urn:schemas:httpmail:sendername" },
            { "sendername", "urn:schemas:httpmail:sendername" },
            { "senderemail", "urn:schemas:httpmail:fromemail" },
            { "fromemail", "urn:schemas:httpmail:fromemail" },
            { "to", "urn:schemas:httpmail:displayto" },
            { "cc", "urn:schemas:httpmail:displaycc" },
            { "bcc", "urn:schemas:httpmail:displaybcc" },
            { "body", "urn:schemas:httpmail:textdescription" },
            { "bodypreview", "urn:schemas:httpmail:textdescription" },
            { "received", "urn:schemas:httpmail:datereceived" },
            { "receivedtime", "urn:schemas:httpmail:datereceived" },
            { "sent", "urn:schemas:httpmail:date" },
            { "senttime", "urn:schemas:httpmail:date" },
            { "senton", "urn:schemas:httpmail:date" },
            { "read", "urn:schemas:httpmail:read" },
            { "unread", "urn:schemas:httpmail:read" },
            { "importance", "urn:schemas:httpmail:importance" },
            { "categories", "urn:schemas:httpmail:keywords" },
            { "conversationtopic", "urn:schemas:httpmail:thread-topic" },
            { "hasattachments", "urn:schemas:httpmail:hasattachment" },
        };

        // Parse LIKE conditions: field LIKE '%value%'
        var likePattern = @"(\w+)\s+LIKE\s+'%([^%']+)%'";
        foreach (System.Text.RegularExpressions.Match match in System.Text.RegularExpressions.Regex.Matches(filter, likePattern, System.Text.RegularExpressions.RegexOptions.IgnoreCase))
        {
            var field = match.Groups[1].Value.ToLowerInvariant();
            var value = match.Groups[2].Value;

            if (fieldMappings.TryGetValue(field, out var urn))
            {
                conditions.Add($"{urn} LIKE '%{value}%'");
            }
        }

        // Parse comparison conditions: field >= 'value' or field > 'value'
        var comparePattern = @"(\w+)\s*(>=|<=|>|<|=)\s*'([^']*)'";
        foreach (System.Text.RegularExpressions.Match match in System.Text.RegularExpressions.Regex.Matches(filter, comparePattern, System.Text.RegularExpressions.RegexOptions.IgnoreCase))
        {
            var field = match.Groups[1].Value.ToLowerInvariant();
            var op = match.Groups[2].Value;
            var value = match.Groups[3].Value;

            // Skip if already handled by LIKE pattern
            if (filter.ToUpperInvariant().Contains($"{field.ToUpperInvariant()} LIKE")) continue;

            if (fieldMappings.TryGetValue(field, out var urn))
            {
                // Format dates properly for DASL
                if (DateTime.TryParse(value, out var date))
                {
                    value = date.ToString("yyyy-MM-dd HH:mm:ss");
                }
                conditions.Add($"{urn} {op} '{value}'");
            }
        }

        if (conditions.Count == 0) return "";

        return string.Join(" AND ", conditions);
    }

    private void OnAdvancedSearchComplete(Search search)
    {
        if (search.Tag != "QuestSearch") return;

        var results = new List<object>();
        try
        {
            var count = 0;
            foreach (var item in search.Results)
            {
                if (count >= _maxSearchResults) break;
                results.Add(item);
                count++;
            }
            // Search complete - results collected
        }
        catch (Exception ex)
        {
            _log?.Invoke($"Error processing search results: {ex.Message}");
        }

        _searchCompletionSource?.TrySetResult(results);
    }

    /// <summary>
    /// Expand a recurring appointment into individual occurrences within a date range.
    /// </summary>
    private List<string[]> ExpandRecurringAppointment(AppointmentItem appt, int[] columnMapping, int maxOccurrences)
    {
        var rows = new List<string[]>();

        try
        {
            var recPattern = appt.GetRecurrencePattern();
            var startDate = DateTime.Today;
            var endDate = DateTime.Today.AddDays(60); // Look 60 days ahead

            // Adjust start date based on pattern start
            if (recPattern.PatternStartDate > startDate)
            {
                startDate = recPattern.PatternStartDate;
            }

            // Adjust end date based on pattern end (if not recurring forever)
            if (!recPattern.NoEndDate && recPattern.PatternEndDate < endDate)
            {
                endDate = recPattern.PatternEndDate;
            }

            // Get occurrences by iterating through the date range
            var currentDate = startDate;
            var occurrenceCount = 0;

            while (currentDate <= endDate && occurrenceCount < maxOccurrences && occurrenceCount < 50)
            {
                try
                {
                    var occurrence = recPattern.GetOccurrence(currentDate);
                    if (occurrence != null)
                    {
                        // Create row for this occurrence
                        var fullRow = new[]
                        {
                            occurrence.Subject ?? "",
                            occurrence.Start.ToString("yyyy-MM-dd HH:mm"),
                            occurrence.End.ToString("yyyy-MM-dd HH:mm"),
                            occurrence.Location ?? "",
                            occurrence.Organizer ?? "",
                            "Yes",
                            "Occurrence",
                            occurrence.BusyStatus.ToString(),
                            occurrence.EntryID ?? ""
                        };

                        var row = columnMapping.Select(idx => idx >= 0 && idx < fullRow.Length ? fullRow[idx] : "").ToArray();
                        rows.Add(row);
                        occurrenceCount++;

                        Marshal.ReleaseComObject(occurrence);
                    }
                }
                catch (COMException)
                {
                    // No occurrence on this date, this is expected for non-daily patterns
                }

                currentDate = currentDate.AddDays(1);
            }

            Marshal.ReleaseComObject(recPattern);
        }
        catch (Exception ex)
        {
            _log?.Invoke($"Error expanding recurring appointment '{appt.Subject}': {ex.Message}");

            // Fallback: return the master appointment as-is
            var fullRow = new[]
            {
                appt.Subject ?? "",
                appt.Start.ToString("yyyy-MM-dd HH:mm"),
                appt.End.ToString("yyyy-MM-dd HH:mm"),
                appt.Location ?? "",
                appt.Organizer ?? "",
                "Yes",
                "Master",
                appt.BusyStatus.ToString(),
                appt.EntryID ?? ""
            };
            var row = columnMapping.Select(idx => idx >= 0 && idx < fullRow.Length ? fullRow[idx] : "").ToArray();
            rows.Add(row);
        }

        return rows;
    }

    private OutlookQueryResult ConvertToResultAndRelease(List<object> items, string folderType, int maxResults,
        List<string>? projectColumns = null, List<string>? projectReorderColumns = null, List<OqlCondition>? postFilters = null)
    {
        var isCalendar = folderType.Equals("Calendar", StringComparison.OrdinalIgnoreCase);
        var isContacts = folderType.Equals("Contacts", StringComparison.OrdinalIgnoreCase);
        var isTasks = folderType.Equals("Tasks", StringComparison.OrdinalIgnoreCase);

        // Default columns for each folder type
        string[] defaultColumns;
        if (isCalendar)
        {
            defaultColumns = new[] { "Subject", "Start", "End", "Location", "Organizer", "IsRecurring", "RecurrenceState", "BusyStatus", "EntryId" };
        }
        else if (isContacts)
        {
            defaultColumns = new[] { "FullName", "Email1Address", "CompanyName", "BusinessPhone", "MobilePhone", "JobTitle", "EntryId" };
        }
        else if (isTasks)
        {
            defaultColumns = new[] { "Subject", "DueDate", "Status", "PercentComplete", "Owner", "Importance", "EntryId" };
        }
        else
        {
            // Mail columns - comprehensive set of useful fields
            defaultColumns = new[] { "Subject", "From", "SenderEmail", "To", "CC", "ReceivedTime", "SentTime", "HasAttachments", "AttachmentCount", "Importance", "UnRead", "Categories", "Size", "BodyPreview", "ConversationTopic", "EntryId" };
        }

        // Determine final columns based on project or project-reorder
        // Always ensure EntryId is included (needed for preview/open in Outlook)
        string[] columns;
        if (projectColumns != null && projectColumns.Count > 0)
        {
            // project: only show specified columns (validate they exist)
            var projected = projectColumns
                .Where(c => defaultColumns.Any(dc => dc.Equals(c, StringComparison.OrdinalIgnoreCase)))
                .ToList();
            // Always include EntryId even if user didn't project it
            if (!projected.Any(c => c.Equals("EntryId", StringComparison.OrdinalIgnoreCase)))
                projected.Add("EntryId");
            columns = projected.ToArray();
            if (columns.Length == 0) columns = defaultColumns; // Fallback if no valid columns
        }
        else if (projectReorderColumns != null && projectReorderColumns.Count > 0)
        {
            // project-reorder: put specified columns first, then the rest
            var reordered = new List<string>();
            foreach (var col in projectReorderColumns)
            {
                var match = defaultColumns.FirstOrDefault(dc => dc.Equals(col, StringComparison.OrdinalIgnoreCase));
                if (match != null && !reordered.Contains(match))
                {
                    reordered.Add(match);
                }
            }
            // Add remaining columns
            foreach (var col in defaultColumns)
            {
                if (!reordered.Contains(col))
                {
                    reordered.Add(col);
                }
            }
            columns = reordered.ToArray();
        }
        else
        {
            columns = defaultColumns;
        }

        // Create a mapping from final column order to default column index
        var columnMapping = columns.Select(c => Array.FindIndex(defaultColumns, dc => dc.Equals(c, StringComparison.OrdinalIgnoreCase))).ToArray();

        var rows = new List<string[]>();
        var processedCount = 0;

        foreach (var item in items.Take(maxResults))
        {
            try
            {
                string[] fullRow; // Row with all default columns
                if (item is MailItem mail)
                {
                    // Get full body for post-filtering
                    var fullBody = "";
                    try { fullBody = mail.Body ?? ""; } catch { }

                    // Apply post-filters (e.g., Body contains "x")
                    if (postFilters != null && postFilters.Count > 0)
                    {
                        var passesAllFilters = true;
                        foreach (var filter in postFilters)
                        {
                            if (filter.Field.Equals("body", StringComparison.OrdinalIgnoreCase) ||
                                filter.Field.Equals("bodypreview", StringComparison.OrdinalIgnoreCase))
                            {
                                if (filter.Operator == "contains")
                                {
                                    if (!fullBody.Contains(filter.Value, StringComparison.OrdinalIgnoreCase))
                                    {
                                        passesAllFilters = false;
                                        break;
                                    }
                                }
                            }
                        }
                        if (!passesAllFilters)
                        {
                            // Skip this item - doesn't match post-filters
                            continue;
                        }
                    }

                    // Get Attachments info carefully - it creates a COM object
                    var attachments = mail.Attachments;
                    var attachCount = attachments.Count;
                    var hasAttach = attachCount > 0 ? "Yes" : "No";
                    Marshal.ReleaseComObject(attachments);

                    // Get body preview (first 100 chars, single line)
                    var bodyPreview = "";
                    try
                    {
                        bodyPreview = fullBody.Length > 100 ? fullBody.Substring(0, 100) : fullBody;
                        bodyPreview = bodyPreview.Replace("\r\n", " ").Replace("\n", " ").Replace("\r", " ").Trim();
                    }
                    catch { }

                    // Get categories
                    var categories = "";
                    try { categories = mail.Categories ?? ""; } catch { }

                    // Get size in KB
                    var sizeKb = "";
                    try { sizeKb = (mail.Size / 1024).ToString() + " KB"; } catch { }

                    // Get conversation topic
                    var conversationTopic = "";
                    try { conversationTopic = mail.ConversationTopic ?? ""; } catch { }

                    fullRow = new[]
                    {
                        mail.Subject ?? "",
                        mail.SenderName ?? "",
                        mail.SenderEmailAddress ?? "",
                        mail.To ?? "",
                        mail.CC ?? "",
                        mail.ReceivedTime.ToString("yyyy-MM-dd HH:mm"),
                        mail.SentOn.ToString("yyyy-MM-dd HH:mm"),
                        hasAttach,
                        attachCount.ToString(),
                        mail.Importance.ToString(),
                        mail.UnRead ? "Unread" : "Read",
                        categories,
                        sizeKb,
                        bodyPreview,
                        conversationTopic,
                        mail.EntryID ?? ""
                    };
                }
                else if (item is AppointmentItem appt)
                {
                    // Handle recurring appointments by expanding to individual occurrences
                    if (appt.IsRecurring)
                    {
                        var occurrenceRows = ExpandRecurringAppointment(appt, columnMapping, maxResults - rows.Count);
                        rows.AddRange(occurrenceRows);
                        continue; // Skip adding a master row since we added occurrences
                    }

                    // Non-recurring appointment
                    fullRow = new[]
                    {
                        appt.Subject ?? "",
                        appt.Start.ToString("yyyy-MM-dd HH:mm"),
                        appt.End.ToString("yyyy-MM-dd HH:mm"),
                        appt.Location ?? "",
                        appt.Organizer ?? "",
                        "No",
                        "Single",
                        appt.BusyStatus.ToString(),
                        appt.EntryID ?? ""
                    };
                }
                else if (item is ContactItem contact)
                {
                    fullRow = new[]
                    {
                        contact.FullName ?? "",
                        contact.Email1Address ?? "",
                        contact.CompanyName ?? "",
                        contact.BusinessTelephoneNumber ?? "",
                        contact.MobileTelephoneNumber ?? "",
                        contact.JobTitle ?? "",
                        contact.EntryID ?? ""
                    };
                }
                else if (item is TaskItem task)
                {
                    fullRow = new[]
                    {
                        task.Subject ?? "",
                        task.DueDate.ToString("yyyy-MM-dd"),
                        task.Status.ToString(),
                        task.PercentComplete.ToString() + "%",
                        task.Owner ?? "",
                        task.Importance.ToString(),
                        task.EntryID ?? ""
                    };
                }
                else
                {
                    // Release unknown item and continue
                    if (item != null) Marshal.ReleaseComObject(item);
                    continue;
                }

                // Apply column mapping to reorder/filter columns
                var row = columnMapping.Select(idx => idx >= 0 && idx < fullRow.Length ? fullRow[idx] : "").ToArray();
                rows.Add(row);
            }
            catch (Exception ex)
            {
                _log?.Invoke($"Error processing item: {ex.Message}");
            }
            finally
            {
                // Release COM object immediately after extracting data
                if (item != null)
                {
                    try { Marshal.ReleaseComObject(item); } catch { }
                }

                // Periodic GC for large datasets to prevent memory buildup
                processedCount++;
                if (processedCount % 50 == 0)
                {
                    GC.Collect(0, GCCollectionMode.Optimized);
                }
            }
        }

        return new OutlookQueryResult
        {
            Success = true,
            Columns = columns,
            Rows = rows.ToArray(),
            RowCount = rows.Count
        };
    }

    /// <summary>
    /// Open an Outlook item by its EntryId
    /// </summary>
    public void OpenItem(string entryId)
    {
        if (string.IsNullOrEmpty(entryId))
        {
            _log?.Invoke("Cannot open item: EntryId is empty");
            return;
        }

        Connect();

        try
        {
            var item = _namespace?.GetItemFromID(entryId);
            if (item != null)
            {
                // Display the item using reflection to handle different item types
                dynamic dynItem = item;
                dynItem.Display(false); // false = non-modal, shows normal window with min/max buttons
                Marshal.ReleaseComObject(item);
            }
            else
            {
                _log?.Invoke($"Item not found: {entryId}");
            }
        }
        catch (Exception ex)
        {
            _log?.Invoke($"Error opening item: {ex.Message}");
        }
    }

    /// <summary>
    /// Mark an email as read or unread
    /// </summary>
    public MarkReadResult MarkAsRead(string entryId, bool markAsRead)
    {
        if (string.IsNullOrEmpty(entryId))
        {
            return new MarkReadResult { Success = false, Error = "EntryId is empty" };
        }

        Connect();

        try
        {
            var item = _namespace?.GetItemFromID(entryId);
            if (item == null)
            {
                return new MarkReadResult { Success = false, Error = "Item not found" };
            }

            try
            {
                if (item is MailItem mail)
                {
                    mail.UnRead = !markAsRead;
                    mail.Save();
                    return new MarkReadResult { Success = true, IsRead = markAsRead };
                }
                else
                {
                    return new MarkReadResult { Success = false, Error = "Item is not an email" };
                }
            }
            finally
            {
                Marshal.ReleaseComObject(item);
            }
        }
        catch (Exception ex)
        {
            _log?.Invoke($"Error marking email: {ex.Message}");
            return new MarkReadResult { Success = false, Error = ex.Message };
        }
    }

    /// <summary>
    /// Open Outlook's Rules and Alerts dialog
    /// </summary>
    public RuleOperationResult OpenRulesEditor()
    {
        Connect();

        try
        {
            dynamic app = _namespace!.Application;
            var explorer = app.ActiveExplorer();
            if (explorer != null)
            {
                explorer.CommandBars.ExecuteMso("RulesAndAlerts");
                Marshal.ReleaseComObject(explorer);
                return new RuleOperationResult { Success = true };
            }
            else
            {
                return new RuleOperationResult { Success = false, Error = "No active Outlook window found" };
            }
        }
        catch (Exception ex)
        {
            _log?.Invoke($"Error opening rules editor: {ex.Message}");
            return new RuleOperationResult { Success = false, Error = ex.Message };
        }
    }

    /// <summary>
    /// Rename an Outlook rule
    /// </summary>
    public RuleOperationResult RenameRule(string currentName, string newName)
    {
        if (string.IsNullOrEmpty(currentName))
            return new RuleOperationResult { Success = false, Error = "Current rule name is empty" };
        if (string.IsNullOrEmpty(newName))
            return new RuleOperationResult { Success = false, Error = "New rule name is empty" };

        Connect();

        Rules? rules = null;
        try
        {
            rules = _namespace!.DefaultStore.GetRules();
            for (int i = 1; i <= rules.Count; i++)
            {
                var rule = rules[i];
                try
                {
                    if (string.Equals(rule.Name, currentName, StringComparison.OrdinalIgnoreCase))
                    {
                        rule.Name = newName;
                        rules.Save();
                        return new RuleOperationResult { Success = true };
                    }
                }
                finally
                {
                    Marshal.ReleaseComObject(rule);
                }
            }
            return new RuleOperationResult { Success = false, Error = $"Rule '{currentName}' not found" };
        }
        catch (Exception ex)
        {
            _log?.Invoke($"Error renaming rule: {ex.Message}");
            return new RuleOperationResult { Success = false, Error = ex.Message };
        }
        finally
        {
            if (rules != null) Marshal.ReleaseComObject(rules);
        }
    }

    /// <summary>
    /// Enable or disable an Outlook rule
    /// </summary>
    public RuleOperationResult SetRuleEnabled(string ruleName, bool enabled)
    {
        if (string.IsNullOrEmpty(ruleName))
            return new RuleOperationResult { Success = false, Error = "Rule name is empty" };

        Connect();

        Rules? rules = null;
        try
        {
            rules = _namespace!.DefaultStore.GetRules();
            for (int i = 1; i <= rules.Count; i++)
            {
                var rule = rules[i];
                try
                {
                    if (string.Equals(rule.Name, ruleName, StringComparison.OrdinalIgnoreCase))
                    {
                        rule.Enabled = enabled;
                        rules.Save();
                        return new RuleOperationResult { Success = true };
                    }
                }
                finally
                {
                    Marshal.ReleaseComObject(rule);
                }
            }
            return new RuleOperationResult { Success = false, Error = $"Rule '{ruleName}' not found" };
        }
        catch (Exception ex)
        {
            _log?.Invoke($"Error setting rule enabled: {ex.Message}");
            return new RuleOperationResult { Success = false, Error = ex.Message };
        }
        finally
        {
            if (rules != null) Marshal.ReleaseComObject(rules);
        }
    }

    /// <summary>
    /// Delete an Outlook rule
    /// </summary>
    public RuleOperationResult DeleteRule(string ruleName)
    {
        if (string.IsNullOrEmpty(ruleName))
            return new RuleOperationResult { Success = false, Error = "Rule name is empty" };

        Connect();

        Rules? rules = null;
        try
        {
            rules = _namespace!.DefaultStore.GetRules();
            for (int i = 1; i <= rules.Count; i++)
            {
                var rule = rules[i];
                try
                {
                    if (string.Equals(rule.Name, ruleName, StringComparison.OrdinalIgnoreCase))
                    {
                        Marshal.ReleaseComObject(rule);
                        rules.Remove(i);
                        rules.Save();
                        return new RuleOperationResult { Success = true };
                    }
                }
                finally
                {
                    // rule already released above if matched; safe to call again if not matched
                    try { Marshal.ReleaseComObject(rule); } catch { }
                }
            }
            return new RuleOperationResult { Success = false, Error = $"Rule '{ruleName}' not found" };
        }
        catch (Exception ex)
        {
            _log?.Invoke($"Error deleting rule: {ex.Message}");
            return new RuleOperationResult { Success = false, Error = ex.Message };
        }
        finally
        {
            if (rules != null) Marshal.ReleaseComObject(rules);
        }
    }

    /// <summary>
    /// Get a preview of an email by its EntryId
    /// </summary>
    public MailPreviewResult GetMailPreview(string entryId)
    {
        if (string.IsNullOrEmpty(entryId))
        {
            return new MailPreviewResult { Error = "EntryId is empty" };
        }

        Connect();

        try
        {
            var item = _namespace?.GetItemFromID(entryId);
            if (item == null)
            {
                return new MailPreviewResult { Error = "Item not found" };
            }

            try
            {
                if (item is MailItem mail)
                {
                    var result = new MailPreviewResult
                    {
                        Subject = mail.Subject ?? "",
                        From = mail.SenderName ?? "",
                        FromEmail = mail.SenderEmailAddress ?? "",
                        To = mail.To ?? "",
                        CC = mail.CC ?? "",
                        ReceivedTime = mail.ReceivedTime.ToString("yyyy-MM-dd HH:mm:ss"),
                        Body = mail.Body ?? "",
                        HtmlBody = mail.HTMLBody ?? "",
                        HasAttachments = mail.Attachments?.Count > 0,
                        AttachmentCount = mail.Attachments?.Count ?? 0,
                        Importance = mail.Importance.ToString(),
                        IsRead = !mail.UnRead
                    };
                    return result;
                }
                else
                {
                    // Handle other item types dynamically
                    dynamic dynItem = item;
                    return new MailPreviewResult
                    {
                        Subject = dynItem.Subject ?? "No subject",
                        Body = dynItem.Body ?? "",
                        ReceivedTime = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss")
                    };
                }
            }
            finally
            {
                Marshal.ReleaseComObject(item);
            }
        }
        catch (Exception ex)
        {
            _log?.Invoke($"Error getting mail preview: {ex.Message}");
            return new MailPreviewResult { Error = ex.Message };
        }
    }

    /// <summary>
    /// Get mail rules as a query result (virtual "Rules" folder).
    /// </summary>
    private OutlookQueryResult GetRulesAsResult(int maxResults,
        List<string>? projectColumns = null, List<string>? projectReorderColumns = null, List<OqlCondition>? postFilters = null)
    {
        Connect();

        string[] defaultColumns = { "Name", "ExecutionOrder", "RuleType", "Conditions", "Actions", "Exceptions", "Enabled" };

        // Determine final columns based on project or project-reorder
        string[] columns;
        if (projectColumns != null && projectColumns.Count > 0)
        {
            columns = projectColumns
                .Where(c => defaultColumns.Any(dc => dc.Equals(c, StringComparison.OrdinalIgnoreCase)))
                .ToArray();
            if (columns.Length == 0) columns = defaultColumns;
        }
        else if (projectReorderColumns != null && projectReorderColumns.Count > 0)
        {
            var reordered = new List<string>();
            foreach (var col in projectReorderColumns)
            {
                var match = defaultColumns.FirstOrDefault(dc => dc.Equals(col, StringComparison.OrdinalIgnoreCase));
                if (match != null && !reordered.Contains(match))
                    reordered.Add(match);
            }
            foreach (var col in defaultColumns)
            {
                if (!reordered.Contains(col))
                    reordered.Add(col);
            }
            columns = reordered.ToArray();
        }
        else
        {
            columns = defaultColumns;
        }

        var columnMapping = columns.Select(c => Array.FindIndex(defaultColumns, dc => dc.Equals(c, StringComparison.OrdinalIgnoreCase))).ToArray();

        var rows = new List<string[]>();
        Rules? rulesCollection = null;

        try
        {
            rulesCollection = _namespace!.DefaultStore.GetRules();
            _log?.Invoke($"Found {rulesCollection.Count} rules");

            for (int i = 1; i <= rulesCollection.Count && rows.Count < maxResults; i++)
            {
                Rule? rule = null;
                try
                {
                    rule = rulesCollection[i];

                    var fullRow = new[]
                    {
                        rule.Name ?? "",
                        rule.ExecutionOrder.ToString(),
                        rule.RuleType.ToString(),
                        GetEnabledConditions(rule.Conditions),
                        GetEnabledActions(rule.Actions),
                        GetEnabledConditions(rule.Exceptions),
                        rule.Enabled ? "Yes" : "No"
                    };

                    // Apply post-filters
                    if (postFilters != null && postFilters.Count > 0)
                    {
                        var passesAll = true;
                        foreach (var filter in postFilters)
                        {
                            var fieldIdx = Array.FindIndex(defaultColumns, dc => dc.Equals(filter.Field, StringComparison.OrdinalIgnoreCase));
                            if (fieldIdx >= 0 && fieldIdx < fullRow.Length)
                            {
                                var fieldValue = fullRow[fieldIdx];
                                if (filter.Operator == "contains" && !fieldValue.Contains(filter.Value, StringComparison.OrdinalIgnoreCase))
                                {
                                    passesAll = false;
                                    break;
                                }
                            }
                        }
                        if (!passesAll) continue;
                    }

                    var row = columnMapping.Select(idx => idx >= 0 && idx < fullRow.Length ? fullRow[idx] : "").ToArray();
                    rows.Add(row);
                }
                catch (Exception ex)
                {
                    _log?.Invoke($"Error processing rule {i}: {ex.Message}");
                }
                finally
                {
                    if (rule != null) Marshal.ReleaseComObject(rule);
                }
            }
        }
        catch (Exception ex)
        {
            _log?.Invoke($"Error getting rules: {ex.Message}");
            return new OutlookQueryResult
            {
                Success = false,
                Error = $"Failed to get mail rules: {ex.Message}"
            };
        }
        finally
        {
            if (rulesCollection != null) Marshal.ReleaseComObject(rulesCollection);
        }

        return new OutlookQueryResult
        {
            Success = true,
            Columns = columns,
            Rows = rows.ToArray(),
            RowCount = rows.Count
        };
    }

    /// <summary>
    /// Get human-readable descriptions of enabled rule conditions.
    /// </summary>
    private string GetEnabledConditions(RuleConditions conditions)
    {
        var explanations = new List<string>();

        try
        {
            foreach (RuleCondition condition in conditions)
            {
                if (!condition.Enabled) continue;

                switch (condition.ConditionType)
                {
                    case OlRuleConditionType.olConditionOnlyToMe:
                        explanations.Add("Sent only to me");
                        break;

                    case OlRuleConditionType.olConditionSubject:
                        var textCondition = condition as TextRuleCondition;
                        if (textCondition?.Text is string[] subjectTexts && subjectTexts.Length > 0)
                            explanations.Add($"Subject contains \"{string.Join(", ", subjectTexts)}\"");
                        break;

                    case OlRuleConditionType.olConditionBody:
                        var bodyCondition = condition as TextRuleCondition;
                        if (bodyCondition?.Text is string[] bodyTexts && bodyTexts.Length > 0)
                            explanations.Add($"Body contains \"{string.Join(", ", bodyTexts)}\"");
                        break;

                    case OlRuleConditionType.olConditionFrom:
                        try
                        {
                            dynamic fromCondition = condition;
                            Recipients recipients = fromCondition.Recipients;
                            explanations.Add($"From \"{GetRecipientNames(recipients)}\"");
                            Marshal.ReleaseComObject(recipients);
                        }
                        catch { explanations.Add("From [Unreadable]"); }
                        break;

                    case OlRuleConditionType.olConditionSentTo:
                        try
                        {
                            dynamic sentToCondition = condition;
                            Recipients recipients = sentToCondition.Recipients;
                            explanations.Add($"Sent to \"{GetRecipientNames(recipients)}\"");
                            Marshal.ReleaseComObject(recipients);
                        }
                        catch { explanations.Add("Sent to [Unreadable]"); }
                        break;

                    case OlRuleConditionType.olConditionMessageHeader:
                        var headerCondition = condition as TextRuleCondition;
                        if (headerCondition?.Text is string[] headerTexts && headerTexts.Length > 0)
                            explanations.Add($"Header contains \"{string.Join(", ", headerTexts)}\"");
                        break;

                    case OlRuleConditionType.olConditionImportance:
                        try
                        {
                            dynamic impCondition = condition;
                            explanations.Add($"Importance is {impCondition.Importance}");
                        }
                        catch { explanations.Add("Importance filter"); }
                        break;

                    case OlRuleConditionType.olConditionHasAttachment:
                        explanations.Add("Has attachment");
                        break;

                    case OlRuleConditionType.olConditionCc:
                        explanations.Add("I'm on CC");
                        break;

                    case OlRuleConditionType.olConditionToOrCc:
                        explanations.Add("I'm on To or CC");
                        break;

                    default:
                        explanations.Add(condition.ConditionType.ToString().Replace("olCondition", ""));
                        break;
                }
            }
        }
        catch (Exception ex)
        {
            _log?.Invoke($"Error reading conditions: {ex.Message}");
        }

        return explanations.Count > 0 ? string.Join("; ", explanations) : "";
    }

    /// <summary>
    /// Get human-readable descriptions of enabled rule actions.
    /// </summary>
    private string GetEnabledActions(RuleActions actions)
    {
        var list = new List<string>();

        try
        {
            if (actions.AssignToCategory?.Enabled == true)
            {
                try
                {
                    var cats = actions.AssignToCategory.Categories as string[];
                    list.Add(cats?.Length > 0 ? $"Categorize as \"{string.Join(", ", cats)}\"" : "Assign to category");
                }
                catch { list.Add("Assign to category"); }
            }

            if (actions.CopyToFolder?.Enabled == true)
            {
                try
                {
                    var folder = actions.CopyToFolder.Folder;
                    list.Add(folder != null ? $"Copy to \"{folder.Name}\"" : "Copy to folder");
                    if (folder != null) Marshal.ReleaseComObject(folder);
                }
                catch { list.Add("Copy to folder"); }
            }

            if (actions.Delete?.Enabled == true)
                list.Add("Delete");

            if (actions.DeletePermanently?.Enabled == true)
                list.Add("Delete permanently");

            if (actions.Forward?.Enabled == true)
            {
                try
                {
                    var recipients = actions.Forward.Recipients;
                    list.Add($"Forward to \"{GetRecipientNames(recipients)}\"");
                    Marshal.ReleaseComObject(recipients);
                }
                catch { list.Add("Forward"); }
            }

            if (actions.ForwardAsAttachment?.Enabled == true)
                list.Add("Forward as attachment");

            if (actions.MarkAsTask?.Enabled == true)
                list.Add("Mark as task");

            if (actions.MoveToFolder?.Enabled == true)
            {
                try
                {
                    var folder = actions.MoveToFolder.Folder;
                    list.Add(folder != null ? $"Move to \"{folder.Name}\"" : "Move to folder");
                    if (folder != null) Marshal.ReleaseComObject(folder);
                }
                catch { list.Add("Move to folder"); }
            }

            if (actions.NewItemAlert?.Enabled == true)
                list.Add("New item alert");

            if (actions.NotifyDelivery?.Enabled == true)
                list.Add("Notify delivery");

            if (actions.NotifyRead?.Enabled == true)
                list.Add("Notify read");

            if (actions.PlaySound?.Enabled == true)
                list.Add("Play sound");

            if (actions.Redirect?.Enabled == true)
                list.Add("Redirect");

            if (actions.Stop?.Enabled == true)
                list.Add("Stop processing more rules");
        }
        catch (Exception ex)
        {
            _log?.Invoke($"Error reading actions: {ex.Message}");
        }

        return string.Join("; ", list);
    }

    /// <summary>
    /// Extract names from a Recipients COM collection.
    /// </summary>
    private static string GetRecipientNames(Recipients recipients)
    {
        var names = new List<string>();
        foreach (Recipient recipient in recipients)
        {
            names.Add(recipient.Name);
            Marshal.ReleaseComObject(recipient);
        }
        return string.Join(", ", names);
    }

    /// <summary>
    /// Send an email via Outlook COM
    /// </summary>
    public SendMailResult SendMail(string to, string subject, string body, string[]? attachmentPaths = null)
    {
        Connect();

        MailItem? mail = null;
        try
        {
            mail = (MailItem)_outlookApp!.CreateItem(OlItemType.olMailItem);
            mail.To = to;
            mail.Subject = subject;
            mail.Body = body;

            if (attachmentPaths != null)
            {
                foreach (var filePath in attachmentPaths)
                {
                    if (File.Exists(filePath))
                    {
                        mail.Attachments.Add(filePath, OlAttachmentType.olByValue);
                        _log?.Invoke($"Attached: {Path.GetFileName(filePath)}");
                    }
                    else
                    {
                        _log?.Invoke($"Attachment not found: {filePath}");
                    }
                }
            }

            mail.Send();
            _log?.Invoke($"Feedback email sent to {to}");
            return new SendMailResult { Success = true };
        }
        catch (Exception ex)
        {
            _log?.Invoke($"Error sending mail: {ex.Message}");
            return new SendMailResult { Success = false, Error = ex.Message };
        }
        finally
        {
            if (mail != null) Marshal.ReleaseComObject(mail);
        }
    }

    /// <summary>
    /// Get detailed rule information for editing
    /// </summary>
    public RuleDetailsResult GetRuleDetails(string ruleName)
    {
        if (string.IsNullOrEmpty(ruleName))
            return new RuleDetailsResult { Success = false, Error = "Rule name is empty" };

        Connect();

        Rules? rules = null;
        try
        {
            rules = _namespace!.DefaultStore.GetRules();
            for (int i = 1; i <= rules.Count; i++)
            {
                var rule = rules[i];
                try
                {
                    if (!string.Equals(rule.Name, ruleName, StringComparison.OrdinalIgnoreCase))
                    {
                        Marshal.ReleaseComObject(rule);
                        continue;
                    }

                    var properties = new List<RulePropertyInfo>();

                    // Extract conditions
                    ExtractConditionProperties(rule.Conditions, "condition", properties);

                    // Extract actions
                    ExtractActionProperties(rule.Actions, properties);

                    // Extract exceptions
                    ExtractConditionProperties(rule.Exceptions, "exception", properties);

                    var result = new RuleDetailsResult
                    {
                        Success = true,
                        Name = rule.Name,
                        Enabled = rule.Enabled,
                        ExecutionOrder = rule.ExecutionOrder,
                        RuleType = rule.RuleType.ToString(),
                        Properties = properties.ToArray()
                    };

                    Marshal.ReleaseComObject(rule);
                    return result;
                }
                catch
                {
                    Marshal.ReleaseComObject(rule);
                    throw;
                }
            }

            return new RuleDetailsResult { Success = false, Error = $"Rule '{ruleName}' not found" };
        }
        catch (Exception ex)
        {
            _log?.Invoke($"Error getting rule details: {ex.Message}");
            return new RuleDetailsResult { Success = false, Error = ex.Message };
        }
        finally
        {
            if (rules != null) Marshal.ReleaseComObject(rules);
        }
    }

    private void ExtractConditionProperties(RuleConditions conditions, string category, List<RulePropertyInfo> properties)
    {
        try
        {
            // Subject text
            try
            {
                var subj = conditions.Subject;
                if (subj != null)
                {
                    var texts = subj.Text as string[] ?? Array.Empty<string>();
                    properties.Add(new RulePropertyInfo
                    {
                        Category = category,
                        Name = "Subject contains",
                        Key = $"{category}.subject",
                        Type = "text",
                        Value = string.Join(", ", texts),
                        Enabled = subj.Enabled,
                        Editable = true
                    });
                }
            }
            catch { }

            // Body text
            try
            {
                var body = conditions.Body;
                if (body != null)
                {
                    var texts = body.Text as string[] ?? Array.Empty<string>();
                    properties.Add(new RulePropertyInfo
                    {
                        Category = category,
                        Name = "Body contains",
                        Key = $"{category}.body",
                        Type = "text",
                        Value = string.Join(", ", texts),
                        Enabled = body.Enabled,
                        Editable = true
                    });
                }
            }
            catch { }

            // Message header text
            try
            {
                var header = conditions.MessageHeader;
                if (header != null)
                {
                    var texts = header.Text as string[] ?? Array.Empty<string>();
                    properties.Add(new RulePropertyInfo
                    {
                        Category = category,
                        Name = "Header contains",
                        Key = $"{category}.header",
                        Type = "text",
                        Value = string.Join(", ", texts),
                        Enabled = header.Enabled,
                        Editable = true
                    });
                }
            }
            catch { }

            // From recipients (read-only)
            try
            {
                dynamic fromCond = conditions.From;
                if (fromCond != null && fromCond.Enabled)
                {
                    Recipients recipients = fromCond.Recipients;
                    properties.Add(new RulePropertyInfo
                    {
                        Category = category,
                        Name = "From",
                        Key = $"{category}.from",
                        Type = "recipients",
                        Value = GetRecipientNames(recipients),
                        Enabled = true,
                        Editable = false
                    });
                    Marshal.ReleaseComObject(recipients);
                }
            }
            catch { }

            // Sent to recipients (read-only)
            try
            {
                dynamic sentTo = conditions.SentTo;
                if (sentTo != null && sentTo.Enabled)
                {
                    Recipients recipients = sentTo.Recipients;
                    properties.Add(new RulePropertyInfo
                    {
                        Category = category,
                        Name = "Sent to",
                        Key = $"{category}.sentTo",
                        Type = "recipients",
                        Value = GetRecipientNames(recipients),
                        Enabled = true,
                        Editable = false
                    });
                    Marshal.ReleaseComObject(recipients);
                }
            }
            catch { }

            // Toggle conditions
            try
            {
                if (conditions.OnlyToMe?.Enabled == true)
                    properties.Add(new RulePropertyInfo { Category = category, Name = "Sent only to me", Key = $"{category}.onlyToMe", Type = "toggle", Value = "true", Enabled = true, Editable = true });
            }
            catch { }

            try
            {
                if (conditions.CC?.Enabled == true)
                    properties.Add(new RulePropertyInfo { Category = category, Name = "I'm on CC", Key = $"{category}.cc", Type = "toggle", Value = "true", Enabled = true, Editable = true });
            }
            catch { }

            try
            {
                if (conditions.ToOrCc?.Enabled == true)
                    properties.Add(new RulePropertyInfo { Category = category, Name = "I'm on To or CC", Key = $"{category}.toOrCc", Type = "toggle", Value = "true", Enabled = true, Editable = true });
            }
            catch { }

            try
            {
                if (conditions.HasAttachment?.Enabled == true)
                    properties.Add(new RulePropertyInfo { Category = category, Name = "Has attachment", Key = $"{category}.hasAttachment", Type = "toggle", Value = "true", Enabled = true, Editable = true });
            }
            catch { }

            // Importance
            try
            {
                dynamic impCond = conditions.Importance;
                if (impCond != null && impCond.Enabled)
                {
                    properties.Add(new RulePropertyInfo
                    {
                        Category = category,
                        Name = "Importance",
                        Key = $"{category}.importance",
                        Type = "text",
                        Value = impCond.Importance.ToString(),
                        Enabled = true,
                        Editable = false
                    });
                }
            }
            catch { }
        }
        catch (Exception ex)
        {
            _log?.Invoke($"Error extracting {category} properties: {ex.Message}");
        }
    }

    private void ExtractActionProperties(RuleActions actions, List<RulePropertyInfo> properties)
    {
        try
        {
            // Move to folder (read-only, folder selection is complex)
            try
            {
                if (actions.MoveToFolder?.Enabled == true)
                {
                    var folder = actions.MoveToFolder.Folder;
                    var folderName = folder?.Name ?? "Unknown";
                    if (folder != null) Marshal.ReleaseComObject(folder);
                    properties.Add(new RulePropertyInfo { Category = "action", Name = "Move to folder", Key = "action.moveToFolder", Type = "folder", Value = folderName, Enabled = true, Editable = false });
                }
            }
            catch { }

            // Copy to folder (read-only)
            try
            {
                if (actions.CopyToFolder?.Enabled == true)
                {
                    var folder = actions.CopyToFolder.Folder;
                    var folderName = folder?.Name ?? "Unknown";
                    if (folder != null) Marshal.ReleaseComObject(folder);
                    properties.Add(new RulePropertyInfo { Category = "action", Name = "Copy to folder", Key = "action.copyToFolder", Type = "folder", Value = folderName, Enabled = true, Editable = false });
                }
            }
            catch { }

            // Forward to (read-only)
            try
            {
                if (actions.Forward?.Enabled == true)
                {
                    var recipients = actions.Forward.Recipients;
                    properties.Add(new RulePropertyInfo { Category = "action", Name = "Forward to", Key = "action.forward", Type = "recipients", Value = GetRecipientNames(recipients), Enabled = true, Editable = false });
                    Marshal.ReleaseComObject(recipients);
                }
            }
            catch { }

            // Assign to category (editable)
            try
            {
                if (actions.AssignToCategory?.Enabled == true)
                {
                    var cats = actions.AssignToCategory.Categories as string[] ?? Array.Empty<string>();
                    properties.Add(new RulePropertyInfo { Category = "action", Name = "Assign category", Key = "action.category", Type = "text", Value = string.Join(", ", cats), Enabled = true, Editable = true });
                }
            }
            catch { }

            // Toggle actions
            try
            {
                if (actions.Delete?.Enabled == true)
                    properties.Add(new RulePropertyInfo { Category = "action", Name = "Delete", Key = "action.delete", Type = "toggle", Value = "true", Enabled = true, Editable = true });
            }
            catch { }

            try
            {
                if (actions.DeletePermanently?.Enabled == true)
                    properties.Add(new RulePropertyInfo { Category = "action", Name = "Delete permanently", Key = "action.deletePermanently", Type = "toggle", Value = "true", Enabled = true, Editable = true });
            }
            catch { }

            try
            {
                if (actions.Stop?.Enabled == true)
                    properties.Add(new RulePropertyInfo { Category = "action", Name = "Stop processing more rules", Key = "action.stop", Type = "toggle", Value = "true", Enabled = true, Editable = true });
            }
            catch { }

            try
            {
                if (actions.MarkAsTask?.Enabled == true)
                    properties.Add(new RulePropertyInfo { Category = "action", Name = "Mark as task", Key = "action.markAsTask", Type = "toggle", Value = "true", Enabled = true, Editable = true });
            }
            catch { }

            try
            {
                if (actions.PlaySound?.Enabled == true)
                    properties.Add(new RulePropertyInfo { Category = "action", Name = "Play sound", Key = "action.playSound", Type = "toggle", Value = "true", Enabled = true, Editable = true });
            }
            catch { }
        }
        catch (Exception ex)
        {
            _log?.Invoke($"Error extracting action properties: {ex.Message}");
        }
    }

    /// <summary>
    /// Update a specific property of a rule
    /// </summary>
    public RuleOperationResult UpdateRuleProperty(string ruleName, string property, string value)
    {
        if (string.IsNullOrEmpty(ruleName))
            return new RuleOperationResult { Success = false, Error = "Rule name is empty" };
        if (string.IsNullOrEmpty(property))
            return new RuleOperationResult { Success = false, Error = "Property is empty" };

        Connect();

        Rules? rules = null;
        try
        {
            rules = _namespace!.DefaultStore.GetRules();
            for (int i = 1; i <= rules.Count; i++)
            {
                var rule = rules[i];
                try
                {
                    if (!string.Equals(rule.Name, ruleName, StringComparison.OrdinalIgnoreCase))
                    {
                        Marshal.ReleaseComObject(rule);
                        continue;
                    }

                    ApplyRulePropertyUpdate(rule, property, value);
                    rules.Save();
                    _log?.Invoke($"Updated rule '{ruleName}' property '{property}' = '{value}'");
                    Marshal.ReleaseComObject(rule);
                    return new RuleOperationResult { Success = true };
                }
                catch
                {
                    Marshal.ReleaseComObject(rule);
                    throw;
                }
            }

            return new RuleOperationResult { Success = false, Error = $"Rule '{ruleName}' not found" };
        }
        catch (Exception ex)
        {
            _log?.Invoke($"Error updating rule property: {ex.Message}");
            return new RuleOperationResult { Success = false, Error = ex.Message };
        }
        finally
        {
            if (rules != null) Marshal.ReleaseComObject(rules);
        }
    }

    private void ApplyRulePropertyUpdate(Rule rule, string property, string value)
    {
        var parts = property.Split('.');
        if (parts.Length < 2)
            throw new ArgumentException($"Invalid property format: {property}");

        var category = parts[0]; // condition, action, exception
        var propName = parts[1]; // subject, body, header, stop, delete, etc.

        // Parse text values as comma-separated array
        string[] textValues = value.Split(',').Select(v => v.Trim()).Where(v => !string.IsNullOrEmpty(v)).ToArray();
        bool boolValue = value.Equals("true", StringComparison.OrdinalIgnoreCase);

        if (category == "condition" || category == "exception")
        {
            var conditions = category == "condition" ? rule.Conditions : rule.Exceptions;
            switch (propName)
            {
                case "subject":
                    conditions.Subject.Text = textValues;
                    conditions.Subject.Enabled = textValues.Length > 0;
                    break;
                case "body":
                    conditions.Body.Text = textValues;
                    conditions.Body.Enabled = textValues.Length > 0;
                    break;
                case "header":
                    conditions.MessageHeader.Text = textValues;
                    conditions.MessageHeader.Enabled = textValues.Length > 0;
                    break;
                case "onlyToMe":
                    conditions.OnlyToMe.Enabled = boolValue;
                    break;
                case "cc":
                    conditions.CC.Enabled = boolValue;
                    break;
                case "toOrCc":
                    conditions.ToOrCc.Enabled = boolValue;
                    break;
                case "hasAttachment":
                    conditions.HasAttachment.Enabled = boolValue;
                    break;
                default:
                    throw new ArgumentException($"Unknown condition property: {propName}");
            }
        }
        else if (category == "action")
        {
            switch (propName)
            {
                case "category":
                    rule.Actions.AssignToCategory.Categories = textValues;
                    rule.Actions.AssignToCategory.Enabled = textValues.Length > 0;
                    break;
                case "delete":
                    rule.Actions.Delete.Enabled = boolValue;
                    break;
                case "deletePermanently":
                    rule.Actions.DeletePermanently.Enabled = boolValue;
                    break;
                case "stop":
                    rule.Actions.Stop.Enabled = boolValue;
                    break;
                case "markAsTask":
                    rule.Actions.MarkAsTask.Enabled = boolValue;
                    break;
                case "playSound":
                    rule.Actions.PlaySound.Enabled = boolValue;
                    break;
                default:
                    throw new ArgumentException($"Unknown action property: {propName}");
            }
        }
        else
        {
            throw new ArgumentException($"Unknown category: {category}");
        }
    }

    public void Dispose()
    {
        if (_currentSearch != null)
        {
            try { _currentSearch.Stop(); } catch { }
            Marshal.ReleaseComObject(_currentSearch);
            _currentSearch = null;
        }

        if (_namespace != null)
        {
            Marshal.ReleaseComObject(_namespace);
            _namespace = null;
        }

        if (_outlookApp != null)
        {
            _outlookApp.AdvancedSearchComplete -= OnAdvancedSearchComplete;
            Marshal.ReleaseComObject(_outlookApp);
            _outlookApp = null;
        }

        GC.Collect();
        GC.WaitForPendingFinalizers();
    }
}

public class OutlookQueryResult
{
    public bool Success { get; set; }
    public string[] Columns { get; set; } = Array.Empty<string>();
    public string[][] Rows { get; set; } = Array.Empty<string[]>();
    public int RowCount { get; set; }
    public string? Error { get; set; }
}

public class OutlookFolderInfo
{
    public string Name { get; set; }
    public string Description { get; set; }
    public OlDefaultFolders FolderType { get; set; }

    public OutlookFolderInfo(string name, string description, OlDefaultFolders folderType)
    {
        Name = name;
        Description = description;
        FolderType = folderType;
    }
}

public class MailPreviewResult
{
    public string? Subject { get; set; }
    public string? From { get; set; }
    public string? FromEmail { get; set; }
    public string? To { get; set; }
    public string? CC { get; set; }
    public string? ReceivedTime { get; set; }
    public string? Body { get; set; }
    public string? HtmlBody { get; set; }
    public bool HasAttachments { get; set; }
    public int AttachmentCount { get; set; }
    public string? Importance { get; set; }
    public bool IsRead { get; set; }
    public string? Error { get; set; }
}

public class MarkReadResult
{
    public bool Success { get; set; }
    public bool IsRead { get; set; }
    public string? Error { get; set; }
}

public class RuleOperationResult
{
    public bool Success { get; set; }
    public string? Error { get; set; }
}

public class SendMailResult
{
    public bool Success { get; set; }
    public string? Error { get; set; }
}

public class RuleDetailsResult
{
    public bool Success { get; set; }
    public string? Error { get; set; }
    public string Name { get; set; } = "";
    public bool Enabled { get; set; }
    public int ExecutionOrder { get; set; }
    public string RuleType { get; set; } = "";
    public RulePropertyInfo[] Properties { get; set; } = Array.Empty<RulePropertyInfo>();
}

public class RulePropertyInfo
{
    public string Category { get; set; } = "";  // "condition", "action", "exception"
    public string Name { get; set; } = "";      // display name
    public string Key { get; set; } = "";       // property key for updates
    public string Type { get; set; } = "";      // "text", "toggle", "recipients", "folder"
    public string Value { get; set; } = "";     // current value
    public bool Enabled { get; set; }           // whether currently enabled
    public bool Editable { get; set; }          // whether editable through API
}
