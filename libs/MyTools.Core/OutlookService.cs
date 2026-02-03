using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using Microsoft.Office.Interop.Outlook;
using Exception = System.Exception;

namespace MyTools.Core;

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
/// Supported folders: Inbox, SentMail, Drafts, Calendar, Contacts, Tasks
/// Supported operators: contains, ==, !=, >, <, >=, <=, startswith, endswith
/// Supported functions: ago(Nd), ago(Nh), now()
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
            var (folderType, filter, take) = ParseQuery(query);
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
            var result = ConvertToResultAndRelease(items, folderType, effectiveMaxResults);

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
    private (string folderType, string filter, int? take) ParseQuery(string query)
    {
        var parsed = ParseOqlQuery(query);
        var filter = ConvertConditionsToLegacyFilter(parsed.Conditions);
        return (parsed.Folder, filter, parsed.Take);
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
            _currentSearch = _outlookApp!.AdvancedSearch(scope, daslFilter, true, "QueryStudioSearch");

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
            { "body", "urn:schemas:httpmail:textdescription" },
            { "received", "urn:schemas:httpmail:datereceived" },
            { "receivedtime", "urn:schemas:httpmail:datereceived" },
            { "sent", "urn:schemas:httpmail:date" },
            { "senttime", "urn:schemas:httpmail:date" },
            { "read", "urn:schemas:httpmail:read" },
            { "unread", "urn:schemas:httpmail:read" },
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
        if (search.Tag != "QueryStudioSearch") return;

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

    private OutlookQueryResult ConvertToResultAndRelease(List<object> items, string folderType, int maxResults)
    {
        var isCalendar = folderType.Equals("Calendar", StringComparison.OrdinalIgnoreCase);
        var isContacts = folderType.Equals("Contacts", StringComparison.OrdinalIgnoreCase);
        var isTasks = folderType.Equals("Tasks", StringComparison.OrdinalIgnoreCase);

        string[] columns;
        if (isCalendar)
        {
            columns = new[] { "Subject", "Start", "End", "Location", "Organizer", "IsRecurring", "BusyStatus", "EntryId" };
        }
        else if (isContacts)
        {
            columns = new[] { "FullName", "Email1Address", "CompanyName", "BusinessPhone", "MobilePhone", "JobTitle", "EntryId" };
        }
        else if (isTasks)
        {
            columns = new[] { "Subject", "DueDate", "Status", "PercentComplete", "Owner", "Importance", "EntryId" };
        }
        else
        {
            columns = new[] { "Subject", "From", "To", "ReceivedTime", "HasAttachments", "Importance", "UnRead", "EntryId" };
        }

        var rows = new List<string[]>();
        var processedCount = 0;

        foreach (var item in items.Take(maxResults))
        {
            try
            {
                string[] row;
                if (item is MailItem mail)
                {
                    // Get Attachments count carefully - it creates a COM object
                    var attachments = mail.Attachments;
                    var hasAttach = attachments.Count > 0 ? "Yes" : "No";
                    Marshal.ReleaseComObject(attachments);

                    row = new[]
                    {
                        mail.Subject ?? "",
                        mail.SenderName ?? "",
                        mail.To ?? "",
                        mail.ReceivedTime.ToString("yyyy-MM-dd HH:mm"),
                        hasAttach,
                        mail.Importance.ToString(),
                        mail.UnRead ? "Unread" : "Read",
                        mail.EntryID ?? ""
                    };
                }
                else if (item is AppointmentItem appt)
                {
                    row = new[]
                    {
                        appt.Subject ?? "",
                        appt.Start.ToString("yyyy-MM-dd HH:mm"),
                        appt.End.ToString("yyyy-MM-dd HH:mm"),
                        appt.Location ?? "",
                        appt.Organizer ?? "",
                        appt.IsRecurring ? "Yes" : "No",
                        appt.BusyStatus.ToString(),
                        appt.EntryID ?? ""
                    };
                }
                else if (item is ContactItem contact)
                {
                    row = new[]
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
                    row = new[]
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
                dynItem.Display(true); // true = modal
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
