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
            var (folderType, filter, take, projectColumns, projectReorderColumns) = ParseQuery(query);
            // Use take from query if specified, otherwise use maxResults parameter
            var effectiveMaxResults = take ?? maxResults;
            _log?.Invoke($"Executing Outlook query: Folder={folderType}, Filter={filter}, Take={effectiveMaxResults}");

            var folder = GetFolder(folderType);
            if (folder == null)
            {
                return new OutlookQueryResult
                {
                    Success = false,
                    Error = $"Folder not found: {folderType}"
                };
            }

            var items = await SearchFolderAsync(folder, filter, ct, effectiveMaxResults);

            // Process items and release COM objects immediately to prevent memory exhaustion
            var result = ConvertToResultAndRelease(items, folderType, effectiveMaxResults, projectColumns, projectReorderColumns);

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
                    return new OqlCondition { Field = field, Operator = "contains", Value = match.Groups[2].Value };
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
    private (string folderType, string filter, int? take, List<string>? projectColumns, List<string>? projectReorderColumns) ParseQuery(string query)
    {
        var parsed = ParseOqlQuery(query);
        var filter = ConvertConditionsToLegacyFilter(parsed.Conditions);
        return (parsed.Folder, filter, parsed.Take, parsed.ProjectColumns, parsed.ProjectReorderColumns);
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
        List<string>? projectColumns = null, List<string>? projectReorderColumns = null)
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
        string[] columns;
        if (projectColumns != null && projectColumns.Count > 0)
        {
            // project: only show specified columns (validate they exist)
            columns = projectColumns
                .Where(c => defaultColumns.Any(dc => dc.Equals(c, StringComparison.OrdinalIgnoreCase)))
                .ToArray();
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
                    // Get Attachments info carefully - it creates a COM object
                    var attachments = mail.Attachments;
                    var attachCount = attachments.Count;
                    var hasAttach = attachCount > 0 ? "Yes" : "No";
                    Marshal.ReleaseComObject(attachments);

                    // Get body preview (first 100 chars, single line)
                    var bodyPreview = "";
                    try
                    {
                        var body = mail.Body ?? "";
                        bodyPreview = body.Length > 100 ? body.Substring(0, 100) : body;
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
