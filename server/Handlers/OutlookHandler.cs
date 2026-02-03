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

    public void Dispose()
    {
        _outlookService.Dispose();
    }
}
