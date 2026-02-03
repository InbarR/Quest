using System;
using System.Collections.Generic;

namespace Quest.Server.Models;

/// <summary>
/// Connection state for data sources
/// </summary>
public enum DataSourceConnectionState
{
    Disconnected,
    Connecting,
    Connected,
    Error
}

/// <summary>
/// Parameters for connecting to a data source
/// </summary>
public class DataSourceConnectionParams
{
    /// <summary>
    /// Primary server/cluster/organization URL
    /// </summary>
    public string Server { get; set; } = string.Empty;

    /// <summary>
    /// Database/project name (optional for some data sources)
    /// </summary>
    public string? Database { get; set; }

    /// <summary>
    /// Maximum results to return (for data sources that support it)
    /// </summary>
    public int? MaxResults { get; set; }

    /// <summary>
    /// Additional properties specific to the data source
    /// </summary>
    public Dictionary<string, object> Properties { get; set; } = new();
}

/// <summary>
/// Query request for a data source
/// </summary>
public class DataSourceQueryRequest
{
    /// <summary>
    /// The query text to execute
    /// </summary>
    public string Query { get; set; } = string.Empty;

    /// <summary>
    /// Server/cluster URL (if not using current connection)
    /// </summary>
    public string? ClusterUrl { get; set; }

    /// <summary>
    /// Database name (if not using current connection)
    /// </summary>
    public string? Database { get; set; }

    /// <summary>
    /// Maximum results to return
    /// </summary>
    public int MaxResults { get; set; } = 10000;

    /// <summary>
    /// Query timeout in milliseconds
    /// </summary>
    public int? TimeoutMs { get; set; }
}

/// <summary>
/// Result of a connection attempt
/// </summary>
public class ConnectionResult
{
    public bool Success { get; set; }
    public string? ErrorMessage { get; set; }
    public string? ConnectionInfo { get; set; }

    /// <summary>
    /// Available databases/projects after connection (if applicable)
    /// </summary>
    public string[]? AvailableDatabases { get; set; }

    public static ConnectionResult Succeeded(string? connectionInfo = null, string[]? databases = null) => new()
    {
        Success = true,
        ConnectionInfo = connectionInfo,
        AvailableDatabases = databases
    };

    public static ConnectionResult Failed(string errorMessage) => new()
    {
        Success = false,
        ErrorMessage = errorMessage
    };
}

/// <summary>
/// Event args for connection state changes
/// </summary>
public class ConnectionStateChangedEventArgs : EventArgs
{
    public DataSourceConnectionState OldState { get; }
    public DataSourceConnectionState NewState { get; }
    public string? Message { get; }

    public ConnectionStateChangedEventArgs(DataSourceConnectionState oldState, DataSourceConnectionState newState, string? message = null)
    {
        OldState = oldState;
        NewState = newState;
        Message = message;
    }
}

/// <summary>
/// UI configuration for a data source
/// </summary>
public class DataSourceUIConfig
{
    /// <summary>
    /// Label for the primary server/cluster field (e.g., "Cluster", "Organization")
    /// </summary>
    public string ServerLabel { get; set; } = "Server";

    /// <summary>
    /// Placeholder text for the server field
    /// </summary>
    public string ServerPlaceholder { get; set; } = "Enter server...";

    /// <summary>
    /// Label for the database/project field (e.g., "Database", "Project")
    /// </summary>
    public string DatabaseLabel { get; set; } = "Database";

    /// <summary>
    /// Placeholder text for the database field
    /// </summary>
    public string DatabasePlaceholder { get; set; } = "Enter database...";

    /// <summary>
    /// Whether to show the database selector
    /// </summary>
    public bool ShowDatabaseSelector { get; set; } = true;

    /// <summary>
    /// Whether this data source supports max results setting
    /// </summary>
    public bool SupportsMaxResults { get; set; } = false;

    /// <summary>
    /// Default max results value (if supported)
    /// </summary>
    public int DefaultMaxResults { get; set; } = 1000;

    /// <summary>
    /// Whether to show a connect button (vs auto-connect)
    /// </summary>
    public bool ShowConnectButton { get; set; } = false;
}

/// <summary>
/// Result of query validation
/// </summary>
public class QueryValidationResult
{
    public bool IsValid { get; set; }
    public string? ErrorMessage { get; set; }
    public int? ErrorLine { get; set; }
    public int? ErrorColumn { get; set; }

    public static QueryValidationResult Valid() => new() { IsValid = true };
    public static QueryValidationResult Invalid(string message, int? line = null, int? column = null) => new()
    {
        IsValid = false,
        ErrorMessage = message,
        ErrorLine = line,
        ErrorColumn = column
    };
}

/// <summary>
/// Schema entity (table, folder, etc.)
/// </summary>
public class SchemaEntity
{
    public string Name { get; set; } = string.Empty;
    public string? Description { get; set; }
    public string EntityType { get; set; } = "Table"; // Table, View, Folder, etc.
}

/// <summary>
/// Schema column
/// </summary>
public class SchemaColumn
{
    public string Name { get; set; } = string.Empty;
    public string DataType { get; set; } = "string";
    public string? Description { get; set; }
}

/// <summary>
/// Schema function
/// </summary>
public class SchemaFunction
{
    public string Name { get; set; } = string.Empty;
    public string? Signature { get; set; }
    public string? Description { get; set; }
    public string? ReturnType { get; set; }
}

/// <summary>
/// Example query for help/documentation
/// </summary>
public class QueryExample
{
    public string Title { get; set; } = string.Empty;
    public string Description { get; set; } = string.Empty;
    public string Query { get; set; } = string.Empty;
    public string? Category { get; set; }
}

/// <summary>
/// Registration information for a data source in the registry
/// </summary>
public class DataSourceRegistration
{
    /// <summary>
    /// Unique identifier for the data source (e.g., "kusto", "ado", "outlook")
    /// </summary>
    public string Id { get; set; } = string.Empty;

    /// <summary>
    /// Display name shown in UI
    /// </summary>
    public string DisplayName { get; set; } = string.Empty;

    /// <summary>
    /// Icon (emoji or icon name)
    /// </summary>
    public string Icon { get; set; } = string.Empty;

    /// <summary>
    /// Sort order in the dropdown (lower = earlier)
    /// </summary>
    public int SortOrder { get; set; } = 0;

    /// <summary>
    /// Whether this data source is enabled
    /// </summary>
    public bool IsEnabled { get; set; } = true;

    /// <summary>
    /// Factory function to create a new instance
    /// </summary>
    public Func<IDataSource>? Factory { get; set; }

    /// <summary>
    /// Description of this data source
    /// </summary>
    public string Description { get; set; } = string.Empty;

    /// <summary>
    /// Query language used
    /// </summary>
    public string QueryLanguage { get; set; } = string.Empty;
}

/// <summary>
/// Event args for data source changes
/// </summary>
public class DataSourceChangedEventArgs : EventArgs
{
    public string? DataSourceId { get; }
    public IDataSource? DataSource { get; }

    public DataSourceChangedEventArgs(string? dataSourceId, IDataSource? dataSource)
    {
        DataSourceId = dataSourceId;
        DataSource = dataSource;
    }
}
