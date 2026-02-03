using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Quest.Server.Models;

namespace Quest.Server.Services;

/// <summary>
/// Registry for managing data source types and instances.
/// Provides a plugin-like architecture for adding new data sources.
/// </summary>
public class DataSourceRegistry : IDisposable
{
    private readonly Dictionary<string, DataSourceRegistration> _registrations = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, IDataSource> _instances = new(StringComparer.OrdinalIgnoreCase);
    private readonly Action<string> _log;
    private string? _currentId;

    public DataSourceRegistry(Action<string> log)
    {
        _log = log;
    }

    /// <summary>
    /// Currently active data source ID
    /// </summary>
    public string? CurrentId => _currentId;

    /// <summary>
    /// Currently active data source instance
    /// </summary>
    public IDataSource? Current => _currentId != null && _instances.TryGetValue(_currentId, out var ds) ? ds : null;

    /// <summary>
    /// Event raised when the current data source changes
    /// </summary>
    public event EventHandler<DataSourceChangedEventArgs>? CurrentDataSourceChanged;

    /// <summary>
    /// Register a new data source type
    /// </summary>
    public void Register(DataSourceRegistration registration)
    {
        if (string.IsNullOrEmpty(registration.Id))
            throw new ArgumentException("Data source ID is required", nameof(registration));

        if (_registrations.ContainsKey(registration.Id))
        {
            _log($"Data source '{registration.Id}' is already registered, replacing...");
        }

        _registrations[registration.Id] = registration;
        _log($"Registered data source: {registration.Id} ({registration.DisplayName})");
    }

    /// <summary>
    /// Get all registered data sources ordered by sort order
    /// </summary>
    public IEnumerable<DataSourceRegistration> GetAll()
    {
        return _registrations.Values
            .Where(r => r.IsEnabled)
            .OrderBy(r => r.SortOrder)
            .ThenBy(r => r.DisplayName);
    }

    /// <summary>
    /// Get a registration by ID
    /// </summary>
    public DataSourceRegistration? GetRegistration(string id)
    {
        return _registrations.TryGetValue(id, out var reg) ? reg : null;
    }

    /// <summary>
    /// Get or create a data source instance by ID
    /// </summary>
    public IDataSource? GetOrCreate(string id)
    {
        if (_instances.TryGetValue(id, out var existing))
            return existing;

        if (!_registrations.TryGetValue(id, out var reg))
        {
            _log($"Data source '{id}' is not registered");
            return null;
        }

        if (reg.Factory == null)
        {
            _log($"Data source '{id}' has no factory");
            return null;
        }

        try
        {
            var instance = reg.Factory();
            _instances[id] = instance;
            _log($"Created data source instance: {id}");
            return instance;
        }
        catch (Exception ex)
        {
            _log($"Failed to create data source '{id}': {ex.Message}");
            return null;
        }
    }

    /// <summary>
    /// Switch to a different data source by ID
    /// </summary>
    public async Task<bool> SwitchToAsync(string id)
    {
        if (_currentId == id)
            return true;

        // Disconnect current if connected
        if (Current != null && Current.State == DataSourceConnectionState.Connected)
        {
            try
            {
                await Current.DisconnectAsync();
            }
            catch (Exception ex)
            {
                _log($"Error disconnecting from '{_currentId}': {ex.Message}");
            }
        }

        // Get or create the new data source
        var newDataSource = GetOrCreate(id);
        if (newDataSource == null)
            return false;

        var oldId = _currentId;
        _currentId = id;

        _log($"Switched data source from '{oldId}' to '{id}'");
        CurrentDataSourceChanged?.Invoke(this, new DataSourceChangedEventArgs(id, newDataSource));

        return true;
    }

    /// <summary>
    /// Get a data source by ID for query execution (without switching current)
    /// </summary>
    public IDataSource? GetForQuery(string? typeHint, string? query)
    {
        // If type is specified, use it directly
        if (!string.IsNullOrEmpty(typeHint))
        {
            return GetOrCreate(typeHint);
        }

        // Try to detect type from query
        if (!string.IsNullOrEmpty(query))
        {
            foreach (var reg in GetAll())
            {
                var ds = GetOrCreate(reg.Id);
                if (ds != null && ds.CanHandleQuery(query))
                {
                    return ds;
                }
            }
        }

        // Fall back to current or default
        return Current ?? GetOrCreate("kusto");
    }

    /// <summary>
    /// Get data source info for the frontend
    /// </summary>
    public DataSourceInfo[] GetDataSourceInfo()
    {
        return GetAll().Select(r => new DataSourceInfo
        {
            Id = r.Id,
            DisplayName = r.DisplayName,
            Icon = r.Icon,
            QueryLanguage = r.QueryLanguage,
            Description = r.Description
        }).ToArray();
    }

    public void Dispose()
    {
        foreach (var instance in _instances.Values)
        {
            try
            {
                instance.Dispose();
            }
            catch (Exception ex)
            {
                _log($"Error disposing data source: {ex.Message}");
            }
        }

        _instances.Clear();
    }
}

/// <summary>
/// Data source info for the frontend
/// </summary>
public class DataSourceInfo
{
    public string Id { get; set; } = string.Empty;
    public string DisplayName { get; set; } = string.Empty;
    public string Icon { get; set; } = string.Empty;
    public string QueryLanguage { get; set; } = string.Empty;
    public string Description { get; set; } = string.Empty;
}
