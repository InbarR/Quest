using System;
using System.Threading;
using System.Threading.Tasks;
using Quest.Server.Protocol;

namespace Quest.Server.Models;

/// <summary>
/// Core interface for all data sources in Quest.
/// Implement this interface to add support for a new data source type.
/// </summary>
public interface IDataSource : IDisposable
{
    /// <summary>
    /// Unique identifier for this data source type (e.g., "kusto", "ado", "outlook")
    /// </summary>
    string Id { get; }

    /// <summary>
    /// Display name shown in UI
    /// </summary>
    string DisplayName { get; }

    /// <summary>
    /// Icon for the data source (emoji or icon name)
    /// </summary>
    string Icon { get; }

    /// <summary>
    /// Query language used by this data source (e.g., "KQL", "WIQL", "SQL")
    /// </summary>
    string QueryLanguage { get; }

    /// <summary>
    /// UI configuration for this data source
    /// </summary>
    DataSourceUIConfig UIConfig { get; }

    /// <summary>
    /// Current connection state
    /// </summary>
    DataSourceConnectionState State { get; }

    /// <summary>
    /// Human-readable connection information (e.g., "cluster/database")
    /// </summary>
    string ConnectionInfo { get; }

    /// <summary>
    /// Event raised when connection state changes
    /// </summary>
    event EventHandler<ConnectionStateChangedEventArgs>? ConnectionStateChanged;

    /// <summary>
    /// Connect to the data source
    /// </summary>
    Task<ConnectionResult> ConnectAsync(DataSourceConnectionParams parameters, CancellationToken ct = default);

    /// <summary>
    /// Disconnect from the data source
    /// </summary>
    Task DisconnectAsync();

    /// <summary>
    /// Execute a query against the data source
    /// </summary>
    Task<QueryResult> ExecuteQueryAsync(DataSourceQueryRequest request, CancellationToken ct = default);

    /// <summary>
    /// Validate a query without executing it
    /// </summary>
    QueryValidationResult ValidateQuery(string query);

    /// <summary>
    /// Format/prettify a query
    /// </summary>
    string FormatQuery(string query);

    /// <summary>
    /// Check if this data source can handle the given query based on its content
    /// </summary>
    bool CanHandleQuery(string query);
}

/// <summary>
/// Optional interface for data sources that provide schema information for autocomplete
/// </summary>
public interface ISchemaProvider
{
    /// <summary>
    /// Get available entities (tables, views, folders, etc.)
    /// </summary>
    Task<SchemaEntity[]> GetEntitiesAsync(CancellationToken ct = default);

    /// <summary>
    /// Get columns for a specific entity
    /// </summary>
    Task<SchemaColumn[]> GetColumnsAsync(string entityName, CancellationToken ct = default);

    /// <summary>
    /// Get available functions
    /// </summary>
    Task<SchemaFunction[]> GetFunctionsAsync(CancellationToken ct = default);
}

/// <summary>
/// Optional interface for data sources that provide help and examples
/// </summary>
public interface IDataSourceHelp
{
    /// <summary>
    /// Get example queries for this data source
    /// </summary>
    QueryExample[] GetExamples();

    /// <summary>
    /// Get URL to documentation
    /// </summary>
    string? GetDocumentationUrl();

    /// <summary>
    /// Get a quick start guide
    /// </summary>
    string? GetQuickStartGuide();
}

/// <summary>
/// Optional interface for data sources that can open queries in an external viewer
/// </summary>
public interface IExternalViewer
{
    /// <summary>
    /// Whether this data source supports opening in an external viewer
    /// </summary>
    bool SupportsExternalViewer { get; }

    /// <summary>
    /// Label for the external viewer button (e.g., "Open in ADX")
    /// </summary>
    string ExternalViewerLabel { get; }

    /// <summary>
    /// Get URL to open the query in an external viewer
    /// </summary>
    string? GetExternalViewerUrl(string query, string? server, string? database);
}
