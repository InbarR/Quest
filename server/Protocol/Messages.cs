using System.Text.Json.Serialization;

namespace Quest.Server.Protocol;

// Health
public record HealthCheckResponse(string Status, string Version, string Timestamp);

// Clusters
public record ClusterInfo(
    string Id,
    string Name,
    string Url,
    string Database,
    string Type,
    bool IsFavorite,
    string? Organization = null
);

public record SetFavoriteRequest(string Id, bool Favorite);
public record RemoveRequest(string Id);

// Presets
public record PresetInfo(
    string Id,
    string Name,
    string Query,
    string? ClusterUrl,
    string? Database,
    string Type,
    string CreatedAt,
    bool IsAutoSaved
);

public record DeletePresetRequest(string Id);
public record HistoryRequest(int? Limit);

// Query
public record QueryRequest(
    [property: JsonPropertyName("query")] string Query,
    [property: JsonPropertyName("clusterUrl")] string ClusterUrl,
    [property: JsonPropertyName("database")] string Database,
    [property: JsonPropertyName("type")] string Type,
    [property: JsonPropertyName("timeout")] int? Timeout,
    [property: JsonPropertyName("maxResults")] int? MaxResults
);

public record QueryResult(
    bool Success,
    string[] Columns,
    string[][] Rows,
    int RowCount,
    long ExecutionTimeMs,
    string? Error = null
);

// Schema
public record SchemaRequest(string ClusterUrl, string Database);
public record FetchSchemaResult(bool Success, int TableCount, string? Error);
public record SchemaInfo(TableInfo[] Tables);
public record TableInfo(string Name, ColumnInfo[] Columns);
public record ColumnInfo(string Name, string Type);

public record CompletionRequest(string Query, int Position, string? ClusterUrl = null, string? Database = null);
public record CompletionItem(string Label, string Kind, string? Detail = null, string? InsertText = null);

// AI
public record AiChatRequest(string Message, string? Mode = null, AiContext? Context = null, string? SessionId = null);
public record AiContext(
    string? CurrentQuery = null,
    string? ClusterUrl = null,
    string? Database = null,
    string[]? Favorites = null,
    string[]? RecentQueries = null
);
public record AiChatResponse(
    string Message,
    string SessionId,
    string? SuggestedQuery = null,
    bool AuthRequired = false,
    string? AuthUrl = null,
    string? AuthCode = null
);
public record GenerateTitleRequest(string Query);
public record GenerateTitleResponse(string Title);

// Results History
public record ResultHistoryItem(
    string Id,
    string Query,
    string Title,
    string? ClusterUrl,
    string? Database,
    int RowCount,
    long ExecutionTimeMs,
    bool Success,
    string? Error,
    string CreatedAt,
    string Type,
    string[]? Columns = null,
    string[][]? SampleRows = null,
    string? FilePath = null
);

public record ResultHistoryRequest(int? Limit);
public record DeleteResultHistoryRequest(string Id);

// Image-based data source extraction
public record ExtractDataSourceFromImageRequest(
    string ImageBase64,
    string ImageMimeType,
    string Mode  // "kusto" or "ado"
);

public record ExtractedDataSourceInfo(
    bool Success,
    string? ClusterUrl,
    string? Database,
    string? DisplayName,
    string? Organization,
    string Type,
    string? Error,
    float Confidence
);

// Kusto Explorer import
public record ImportKustoExplorerRequest(
    string? FilePath  // Optional: if null, uses default location; otherwise uses provided file
);

public record KustoExplorerConnection(
    string Name,
    string ClusterUrl,
    string? Database
);

public record ImportKustoExplorerResponse(
    bool Success,
    KustoExplorerConnection[] Connections,
    string? Error
);
