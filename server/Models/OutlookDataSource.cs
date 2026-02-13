using System;
using System.Diagnostics;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using Quest.Server.Protocol;
using Quest.Server.Services;

namespace Quest.Server.Models;

/// <summary>
/// Outlook data source implementation using COM Interop.
/// Only supported on Windows.
/// </summary>
public class OutlookDataSource : IDataSource, ISchemaProvider, IDataSourceHelp
{
    private readonly OutlookService _outlookService;
    private readonly Action<string> _log;
    private string _selectedFolder = "Inbox";
    private DataSourceConnectionState _state = DataSourceConnectionState.Disconnected;

    /// <summary>
    /// Check if Outlook data source is supported on this platform
    /// </summary>
    public static bool IsSupported => RuntimeInformation.IsOSPlatform(OSPlatform.Windows);

    public OutlookDataSource(Action<string> log)
    {
        _log = log;
        _outlookService = new OutlookService(log);
    }

    // ============ IDataSource Identity ============
    public string Id => "outlook";
    public string DisplayName => "Outlook (Email/Calendar)";
    public string Icon => "\U0001F4E7"; // Envelope emoji
    public string QueryLanguage => "OQL"; // Outlook Query Language (KQL-like syntax)

    // ============ UI Configuration ============
    public DataSourceUIConfig UIConfig { get; } = new DataSourceUIConfig
    {
        ServerLabel = "Folder",
        ServerPlaceholder = "Select folder (Inbox, Calendar, etc.)",
        DatabaseLabel = "",
        DatabasePlaceholder = "",
        ShowDatabaseSelector = false,
        SupportsMaxResults = true,
        DefaultMaxResults = 500,
        ShowConnectButton = false
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

    public string ConnectionInfo => _outlookService.IsConnected ? $"Outlook/{_selectedFolder}" : string.Empty;

    public event EventHandler<ConnectionStateChangedEventArgs>? ConnectionStateChanged;

    public Task<ConnectionResult> ConnectAsync(DataSourceConnectionParams parameters, CancellationToken ct = default)
    {
        try
        {
            if (!IsSupported)
            {
                State = DataSourceConnectionState.Error;
                return Task.FromResult(ConnectionResult.Failed("Outlook data source is only supported on Windows"));
            }

            State = DataSourceConnectionState.Connecting;

            _selectedFolder = parameters.Server;
            if (string.IsNullOrEmpty(_selectedFolder))
            {
                _selectedFolder = "Inbox";
            }

            _outlookService.Connect();

            State = DataSourceConnectionState.Connected;
            _log($"Outlook connected: {ConnectionInfo}");

            // Return available folders as "databases"
            var folders = _outlookService.GetFolders()
                .Select(f => f.Name)
                .ToArray();

            return Task.FromResult(ConnectionResult.Succeeded(ConnectionInfo, folders));
        }
        catch (Exception ex)
        {
            State = DataSourceConnectionState.Error;
            _log($"Outlook connection failed: {ex.Message}");
            return Task.FromResult(ConnectionResult.Failed(ex.Message));
        }
    }

    public Task DisconnectAsync()
    {
        _outlookService.Dispose();
        _selectedFolder = "Inbox";
        State = DataSourceConnectionState.Disconnected;
        return Task.CompletedTask;
    }

    // ============ Query Execution ============
    public async Task<QueryResult> ExecuteQueryAsync(DataSourceQueryRequest request, CancellationToken ct = default)
    {
        var sw = Stopwatch.StartNew();

        try
        {
            if (!IsSupported)
            {
                return new QueryResult(
                    Success: false,
                    Columns: Array.Empty<string>(),
                    Rows: Array.Empty<string[]>(),
                    RowCount: 0,
                    ExecutionTimeMs: sw.ElapsedMilliseconds,
                    Error: "Outlook data source is only supported on Windows"
                );
            }

            _log($"Executing Outlook query: {request.Query.Substring(0, Math.Min(100, request.Query.Length))}...");

            var result = await _outlookService.ExecuteQueryAsync(request.Query, ct, request.MaxResults);

            if (!result.Success)
            {
                return new QueryResult(
                    Success: false,
                    Columns: Array.Empty<string>(),
                    Rows: Array.Empty<string[]>(),
                    RowCount: 0,
                    ExecutionTimeMs: sw.ElapsedMilliseconds,
                    Error: result.Error
                );
            }

            _log($"Outlook query returned {result.RowCount} rows");

            return new QueryResult(
                Success: true,
                Columns: result.Columns,
                Rows: result.Rows,
                RowCount: result.RowCount,
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
            _log($"Outlook query error: {ex.Message}");
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

        // Strip comment lines
        var lines = query.Split(new[] { "\r\n", "\n" }, StringSplitOptions.None);
        var cleanedQuery = string.Join("\n", lines
            .Where(line => !line.TrimStart().StartsWith("//"))
            .Where(line => !line.TrimStart().StartsWith("--")));

        if (string.IsNullOrWhiteSpace(cleanedQuery))
            return false;

        var trimmed = cleanedQuery.Trim();

        var outlookFolders = new[] {
            "inbox", "sentmail", "sent", "drafts", "deleteditems", "trash",
            "calendar", "contacts", "tasks", "notes", "journal", "outbox", "junk",
            "rules"
        };

        // Check for KQL-like syntax: starts with folder name, may have pipe operators
        // Example: Inbox | where Subject contains "meeting" | take 100
        var firstWord = trimmed.Split(new[] { ' ', '\t', '\n', '\r', '|' }, StringSplitOptions.RemoveEmptyEntries).FirstOrDefault() ?? "";
        if (outlookFolders.Contains(firstWord.ToLowerInvariant()))
            return true;

        return false;
    }

    // ============ ISchemaProvider ============
    public Task<SchemaEntity[]> GetEntitiesAsync(CancellationToken ct = default)
    {
        try
        {
            var folders = _outlookService.GetFolders()
                .Select(f => new SchemaEntity
                {
                    Name = f.Name,
                    Description = f.Description,
                    EntityType = "Folder"
                })
                .ToArray();

            return Task.FromResult(folders);
        }
        catch
        {
            return Task.FromResult(Array.Empty<SchemaEntity>());
        }
    }

    public Task<SchemaColumn[]> GetColumnsAsync(string entityName, CancellationToken ct = default)
    {
        // Return columns based on folder type
        var folderLower = entityName.ToLowerInvariant();

        SchemaColumn[] columns = folderLower switch
        {
            "rules" => new[]
            {
                new SchemaColumn { Name = "Name", DataType = "string" },
                new SchemaColumn { Name = "ExecutionOrder", DataType = "int" },
                new SchemaColumn { Name = "RuleType", DataType = "string" },
                new SchemaColumn { Name = "Conditions", DataType = "string" },
                new SchemaColumn { Name = "Actions", DataType = "string" },
                new SchemaColumn { Name = "Exceptions", DataType = "string" },
                new SchemaColumn { Name = "Enabled", DataType = "bool" }
            },
            "calendar" => new[]
            {
                new SchemaColumn { Name = "Subject", DataType = "string" },
                new SchemaColumn { Name = "Start", DataType = "datetime" },
                new SchemaColumn { Name = "End", DataType = "datetime" },
                new SchemaColumn { Name = "Location", DataType = "string" },
                new SchemaColumn { Name = "Organizer", DataType = "string" },
                new SchemaColumn { Name = "IsRecurring", DataType = "bool" },
                new SchemaColumn { Name = "BusyStatus", DataType = "string" }
            },
            "contacts" => new[]
            {
                new SchemaColumn { Name = "FullName", DataType = "string" },
                new SchemaColumn { Name = "Email1Address", DataType = "string" },
                new SchemaColumn { Name = "CompanyName", DataType = "string" },
                new SchemaColumn { Name = "BusinessPhone", DataType = "string" },
                new SchemaColumn { Name = "MobilePhone", DataType = "string" },
                new SchemaColumn { Name = "JobTitle", DataType = "string" }
            },
            "tasks" => new[]
            {
                new SchemaColumn { Name = "Subject", DataType = "string" },
                new SchemaColumn { Name = "DueDate", DataType = "datetime" },
                new SchemaColumn { Name = "Status", DataType = "string" },
                new SchemaColumn { Name = "PercentComplete", DataType = "int" },
                new SchemaColumn { Name = "Owner", DataType = "string" },
                new SchemaColumn { Name = "Importance", DataType = "string" }
            },
            _ => new[] // Mail folders
            {
                new SchemaColumn { Name = "Subject", DataType = "string" },
                new SchemaColumn { Name = "From", DataType = "string" },
                new SchemaColumn { Name = "To", DataType = "string" },
                new SchemaColumn { Name = "ReceivedTime", DataType = "datetime" },
                new SchemaColumn { Name = "HasAttachments", DataType = "bool" },
                new SchemaColumn { Name = "Importance", DataType = "string" },
                new SchemaColumn { Name = "UnRead", DataType = "bool" }
            }
        };

        return Task.FromResult(columns);
    }

    public Task<SchemaFunction[]> GetFunctionsAsync(CancellationToken ct = default)
    {
        // Outlook queries don't really have functions
        return Task.FromResult(Array.Empty<SchemaFunction>());
    }

    // ============ IDataSourceHelp ============
    public QueryExample[] GetExamples()
    {
        return new[]
        {
            new QueryExample
            {
                Title = "Recent Inbox",
                Description = "Get recent inbox messages",
                Query = "Inbox\n| take 100",
                Category = "Mail"
            },
            new QueryExample
            {
                Title = "Search Subject",
                Description = "Search emails by subject",
                Query = "Inbox\n| where Subject contains \"meeting\"\n| take 100",
                Category = "Mail"
            },
            new QueryExample
            {
                Title = "Emails from Last Week",
                Description = "Get emails from the past 7 days",
                Query = "Inbox\n| where ReceivedTime > ago(7d)\n| take 100",
                Category = "Mail"
            },
            new QueryExample
            {
                Title = "Unread Messages",
                Description = "Get unread messages from inbox",
                Query = "Inbox\n| where UnRead == true\n| take 50",
                Category = "Mail"
            },
            new QueryExample
            {
                Title = "From Sender",
                Description = "Find emails from a specific sender",
                Query = "Inbox\n| where From contains \"john\"\n| take 100",
                Category = "Mail"
            },
            new QueryExample
            {
                Title = "Combined Filters",
                Description = "Recent emails with keyword in subject",
                Query = "Inbox\n| where Subject contains \"report\"\n| where ReceivedTime > ago(30d)\n| take 50",
                Category = "Mail"
            },
            new QueryExample
            {
                Title = "Calendar Events",
                Description = "Get calendar events",
                Query = "Calendar\n| take 50",
                Category = "Calendar"
            },
            new QueryExample
            {
                Title = "Sent Items",
                Description = "Get sent emails",
                Query = "SentMail\n| take 100",
                Category = "Mail"
            },
            new QueryExample
            {
                Title = "Contacts",
                Description = "Get all contacts",
                Query = "Contacts\n| take 100",
                Category = "Contacts"
            },
            new QueryExample
            {
                Title = "Tasks",
                Description = "Get all tasks",
                Query = "Tasks\n| take 50",
                Category = "Tasks"
            },
            new QueryExample
            {
                Title = "Mail Rules",
                Description = "Get all mail rules",
                Query = "Rules\n| take 100",
                Category = "Rules"
            }
        };
    }

    public string? GetDocumentationUrl() => null; // No official docs for this custom syntax

    public string? GetQuickStartGuide() => @"OQL (Outlook Query Language) - KQL-like syntax

Basic syntax:
  FolderName
  | where Field operator ""value""
  | take N

Examples:
  Inbox
  | where Subject contains ""meeting""
  | where ReceivedTime > ago(7d)
  | take 100

Folders: Inbox, SentMail, Drafts, Calendar, Contacts, Tasks, Rules

Operators: contains, ==, !=, >, <, >=, <=, startswith, endswith

Time functions: ago(7d), ago(24h), ago(30m), now()

Mail fields: Subject, From, To, ReceivedTime, UnRead, HasAttachments
Calendar fields: Subject, Start, End, Location, Organizer
Contact fields: FullName, Email1Address, CompanyName
Task fields: Subject, DueDate, Status, PercentComplete
Rule fields: Name, ExecutionOrder, RuleType, Conditions, Actions, Exceptions, Enabled";

    public void Dispose()
    {
        _outlookService.Dispose();
    }
}
