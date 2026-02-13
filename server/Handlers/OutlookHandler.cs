using Quest.Server.Protocol;
using Quest.Server.Services;

namespace Quest.Server.Handlers;

public class OutlookHandler : IDisposable
{
    private readonly OutlookService _outlookService;
    private readonly Action<string> _log;

    public OutlookHandler(Action<string> log)
    {
        _log = log;
        _outlookService = new OutlookService(log);
    }

    public async Task<QueryResult> ExecuteAsync(QueryRequest request, CancellationToken ct)
    {
        _log($"Executing Outlook query: {request.Query.Substring(0, Math.Min(100, request.Query.Length))}...");

        try
        {
            var result = await _outlookService.ExecuteQueryAsync(request.Query, ct, request.MaxResults ?? 500);

            if (!result.Success)
            {
                return new QueryResult(
                    Success: false,
                    Columns: Array.Empty<string>(),
                    Rows: Array.Empty<string[]>(),
                    RowCount: 0,
                    ExecutionTimeMs: 0,
                    Error: result.Error
                );
            }

            _log($"Outlook query returned {result.RowCount} rows");

            return new QueryResult(
                Success: true,
                Columns: result.Columns,
                Rows: result.Rows,
                RowCount: result.RowCount,
                ExecutionTimeMs: 0, // Will be set by caller
                Error: null
            );
        }
        catch (OperationCanceledException)
        {
            _log("Outlook query cancelled");
            return new QueryResult(
                Success: false,
                Columns: Array.Empty<string>(),
                Rows: Array.Empty<string[]>(),
                RowCount: 0,
                ExecutionTimeMs: 0,
                Error: "Query was cancelled"
            );
        }
        catch (Exception ex)
        {
            _log($"Outlook query error: {ex.Message}");
            return new QueryResult(
                Success: false,
                Columns: Array.Empty<string>(),
                Rows: Array.Empty<string[]>(),
                RowCount: 0,
                ExecutionTimeMs: 0,
                Error: ex.Message
            );
        }
    }

    public OutlookFolderInfo[] GetFolders()
    {
        return _outlookService.GetFolders().ToArray();
    }

    public void OpenItem(string entryId)
    {
        _log($"Opening Outlook item: {entryId.Substring(0, Math.Min(20, entryId.Length))}...");
        _outlookService.OpenItem(entryId);
    }

    public MailPreviewResult GetMailPreview(string entryId)
    {
        _log($"Getting mail preview: {entryId.Substring(0, Math.Min(20, entryId.Length))}...");
        return _outlookService.GetMailPreview(entryId);
    }

    public MarkReadResult MarkAsRead(string entryId, bool markAsRead)
    {
        _log($"Marking email {(markAsRead ? "read" : "unread")}: {entryId.Substring(0, Math.Min(20, entryId.Length))}...");
        return _outlookService.MarkAsRead(entryId, markAsRead);
    }

    public RuleOperationResult OpenRulesEditor()
    {
        _log("Opening Rules and Alerts dialog");
        return _outlookService.OpenRulesEditor();
    }

    public RuleOperationResult RenameRule(string currentName, string newName)
    {
        _log($"Renaming rule: \"{currentName}\" → \"{newName}\"");
        return _outlookService.RenameRule(currentName, newName);
    }

    public RuleOperationResult SetRuleEnabled(string ruleName, bool enabled)
    {
        _log($"{(enabled ? "Enabling" : "Disabling")} rule: \"{ruleName}\"");
        return _outlookService.SetRuleEnabled(ruleName, enabled);
    }

    public RuleOperationResult DeleteRule(string ruleName)
    {
        _log($"Deleting rule: \"{ruleName}\"");
        return _outlookService.DeleteRule(ruleName);
    }

    public SendMailResult SendMail(string to, string subject, string body, string[]? attachmentPaths = null)
    {
        _log($"Sending mail to: {to}, subject: {subject.Substring(0, Math.Min(50, subject.Length))}...");
        return _outlookService.SendMail(to, subject, body, attachmentPaths);
    }

    public RuleDetailsResult GetRuleDetails(string ruleName)
    {
        _log($"Getting rule details: \"{ruleName}\"");
        return _outlookService.GetRuleDetails(ruleName);
    }

    public RuleOperationResult UpdateRuleProperty(string ruleName, string property, string value)
    {
        _log($"Updating rule \"{ruleName}\": {property} = {value}");
        return _outlookService.UpdateRuleProperty(ruleName, property, value);
    }

    public void Dispose()
    {
        _outlookService.Dispose();
    }
}
