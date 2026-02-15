using System.Reflection;
using System.Runtime.Loader;
using System.Text.Json;
using Quest.Server.Handlers;
using Quest.Server.Models;
using Quest.Server.Protocol;
using Quest.Server.Services;
using MyTools.Core;
using MyUtils.AI;

namespace Quest.Server;

class Program
{
    static AiConfig CreateDefaultAiConfig(Action<string> log)
    {
        // Try to get GitHub token for GitHubModels provider
        string? ghToken = null;
        try
        {
            var tokenPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".gh_token");
            if (File.Exists(tokenPath))
            {
                ghToken = File.ReadAllText(tokenPath).Trim();
                log($"Found GitHub token at {tokenPath}");
            }
        }
        catch { }

        return new AiConfig
        {
            // Use GitHubModels if token available, otherwise CopilotDirect with device code
            Provider = !string.IsNullOrEmpty(ghToken) ? AiProvider.GitHubModels : AiProvider.CopilotDirect,
            Model = AiModel.GPT4oMini,
            GitHubToken = ghToken,
            SystemPrompt = @"You are a helpful assistant for writing database queries. You specialize in:
- KQL (Kusto Query Language) for Azure Data Explorer
- WIQL (Work Item Query Language) for Azure DevOps

When providing queries, always wrap them in code blocks with the appropriate language tag (```kql or ```wiql).
Keep explanations concise and focus on providing working queries.",
            TokenBudget = 8000,
            MaxHistoryMessages = 20,
            DeviceCodeCallback = async (url, code) =>
            {
                log($"[AUTH] To authenticate with GitHub Copilot, visit: {url}");
                log($"[AUTH] Enter code: {code}");
                return null;
            }
        };
    }

    static async Task Main(string[] args)
    {
        // Register assembly resolver for Office interop assemblies
        AssemblyLoadContext.Default.Resolving += (context, assemblyName) =>
        {
            if (assemblyName.Name == "office")
            {
                var assemblyPath = Path.Combine(AppContext.BaseDirectory, "office.dll");
                if (File.Exists(assemblyPath))
                    return context.LoadFromAssemblyPath(assemblyPath);

                // Try GAC location
                var gacPath = @"C:\Windows\assembly\GAC_MSIL\office\15.0.0.0__71e9bce111e9429c\OFFICE.DLL";
                if (File.Exists(gacPath))
                    return context.LoadFromAssemblyPath(gacPath);
            }
            return null;
        };

        // Log to stderr so we don't interfere with JSON-RPC on stdout
        var log = (string message) => Console.Error.WriteLine($"[{DateTime.Now:HH:mm:ss}] {message}");

        // Global exception handlers to prevent silent crashes
        AppDomain.CurrentDomain.UnhandledException += (sender, e) =>
        {
            log($"FATAL: Unhandled exception: {e.ExceptionObject}");
        };

        TaskScheduler.UnobservedTaskException += (sender, e) =>
        {
            log($"FATAL: Unobserved task exception: {e.Exception}");
            e.SetObserved(); // Prevent crash
        };

        log("Quest Server starting...");

        try
        {
            // Initialize paths for Quest
            var appDataPath = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Quest"
            );
            Directory.CreateDirectory(appDataPath);

            log($"App data path: {appDataPath}");

            // Initialize services
            var kustoService = new KustoService();
            var clusterManager = new ClusterManager(Path.Combine(appDataPath, "Clusters.csv"));
            var presetManager = new PresetManager(Path.Combine(appDataPath, "Presets.json"));
            var schemaManager = new KustoSchemaManager(Path.Combine(appDataPath, "KustoSchema.json"));

            // Initialize data source registry
            var dataSourceRegistry = new DataSourceRegistry(log);
            DataSourceInitializer.InitializeDataSources(dataSourceRegistry, kustoService, schemaManager, log);

            // Initialize AI with GitHub Copilot (EMU account support)
            AIHelper? aiHelper = null;
            try
            {
                // Try to load AI config from file, otherwise use Copilot Direct
                var aiConfigPath = Path.Combine(appDataPath, "AiConfig.json");
                AiConfig aiConfig;

                if (File.Exists(aiConfigPath))
                {
                    var json = File.ReadAllText(aiConfigPath);
                    var options = new System.Text.Json.JsonSerializerOptions
                    {
                        PropertyNameCaseInsensitive = true,
                        Converters = { new System.Text.Json.Serialization.JsonStringEnumConverter() }
                    };
                    aiConfig = System.Text.Json.JsonSerializer.Deserialize<AiConfig>(json, options)
                        ?? CreateDefaultAiConfig(log);
                    log($"Loaded AI config from {aiConfigPath}");
                }
                else
                {
                    aiConfig = CreateDefaultAiConfig(log);
                    // Save default config for user reference
                    var json = System.Text.Json.JsonSerializer.Serialize(new
                    {
                        provider = aiConfig.Provider.ToString(),
                        model = aiConfig.Model.ToString(),
                        systemPrompt = aiConfig.SystemPrompt,
                        tokenBudget = aiConfig.TokenBudget,
                        maxHistoryMessages = aiConfig.MaxHistoryMessages
                    }, new System.Text.Json.JsonSerializerOptions { WriteIndented = true });
                    File.WriteAllText(aiConfigPath, json);
                    log($"Created default AI config at {aiConfigPath}");
                }

                aiHelper = new AIHelper(aiConfig, (msg, _) => log($"[AI] {msg}"));
                log($"AI helper initialized with {aiConfig.Provider}");
            }
            catch (Exception ex)
            {
                log($"AI helper not available: {ex.Message}");
            }

            // Create handlers
            var healthHandler = new HealthHandler();
            var queryHandler = new QueryHandler(dataSourceRegistry, log);
            var clusterHandler = new ClusterHandler(clusterManager);
            var presetHandler = new PresetHandler(presetManager, log);
            var schemaHandler = new SchemaHandler(schemaManager, kustoService, log);
            var aiHandler = new AiHandler(aiHelper, log);
            var resultsHistoryHandler = new ResultsHistoryHandler(appDataPath, log);
            var outlookHandler = new OutlookHandler(log);

            log("Setting up JSON-RPC connection...");

            // Simple newline-delimited JSON-RPC over stdin/stdout
            var server = new SimpleJsonRpcServer(
                healthHandler, queryHandler, clusterHandler,
                presetHandler, schemaHandler, aiHandler, resultsHistoryHandler, outlookHandler, log);

            log("JSON-RPC server ready");

            await server.RunAsync(CancellationToken.None);

            log("Server shutting down");
        }
        catch (Exception ex)
        {
            log($"Fatal error: {ex}");
            Environment.Exit(1);
        }
    }
}

/// <summary>
/// Simple JSON-RPC server using newline-delimited JSON over stdin/stdout
/// </summary>
public class SimpleJsonRpcServer
{
    private readonly HealthHandler _health;
    private readonly QueryHandler _query;
    private readonly ClusterHandler _cluster;
    private readonly PresetHandler _preset;
    private readonly SchemaHandler _schema;
    private readonly AiHandler _ai;
    private readonly ResultsHistoryHandler _resultsHistory;
    private readonly OutlookHandler _outlook;
    private readonly Action<string> _log;
    private readonly JsonSerializerOptions _jsonOptions;

    public SimpleJsonRpcServer(
        HealthHandler health, QueryHandler query, ClusterHandler cluster,
        PresetHandler preset, SchemaHandler schema, AiHandler ai,
        ResultsHistoryHandler resultsHistory, OutlookHandler outlook, Action<string> log)
    {
        _health = health;
        _query = query;
        _cluster = cluster;
        _preset = preset;
        _schema = schema;
        _ai = ai;
        _resultsHistory = resultsHistory;
        _outlook = outlook;
        _log = log;
        _jsonOptions = new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            PropertyNameCaseInsensitive = true
        };
    }

    public async Task RunAsync(CancellationToken ct)
    {
        using var reader = new StreamReader(Console.OpenStandardInput());
        var writeLock = new SemaphoreSlim(1, 1);

        while (!ct.IsCancellationRequested)
        {
            var line = await reader.ReadLineAsync();
            if (line == null) break; // EOF

            if (string.IsNullOrWhiteSpace(line)) continue;

            // Process each request concurrently so long-running queries
            // don't block other operations (health checks, feedback, etc.)
            var requestLine = line;
            _ = Task.Run(async () =>
            {
                try
                {
                    var response = await ProcessRequestAsync(requestLine, ct);
                    await writeLock.WaitAsync(ct);
                    try
                    {
                        Console.WriteLine(response);
                        Console.Out.Flush();
                    }
                    finally
                    {
                        writeLock.Release();
                    }
                }
                catch (Exception ex)
                {
                    _log($"Error processing request: {ex.Message}");
                }
            });
        }
    }

    private async Task<string> ProcessRequestAsync(string json, CancellationToken ct)
    {
        JsonDocument? doc = null;
        int? id = null;

        try
        {
            doc = JsonDocument.Parse(json);
            var root = doc.RootElement;

            id = root.TryGetProperty("id", out var idProp) ? idProp.GetInt32() : null;
            var method = root.GetProperty("method").GetString() ?? "";
            var paramsElement = root.TryGetProperty("params", out var p) ? p : default;

            // Don't log health checks to reduce noise
            if (method != "health/check")
                _log($"Request: {method}");

            object? result = method switch
            {
                "health/check" => _health.Check(),
                "shutdown" => Shutdown(),
                "cluster/list" => _cluster.GetClusters(),
                "cluster/add" => AddCluster(paramsElement),
                "cluster/remove" => RemoveCluster(paramsElement),
                "cluster/setFavorite" => SetFavorite(paramsElement),
                "cluster/rename" => RenameCluster(paramsElement),
                "preset/list" => _preset.GetPresets(),
                "preset/save" => SavePreset(paramsElement),
                "preset/delete" => DeletePreset(paramsElement),
                "history/list" => GetHistory(paramsElement),
                "history/clear" => ClearHistory(),
                "query/execute" => await ExecuteQueryAsync(paramsElement, ct),
                "query/cancel" => CancelQuery(),
                "dataSource/list" => GetDataSources(),
                "schema/get" => GetSchema(paramsElement),
                "schema/fetch" => await FetchSchemaAsync(paramsElement, ct),
                "schema/clearCache" => ClearSchemaCache(paramsElement),
                "schema/cacheStats" => GetSchemaCacheStats(),
                "schema/completions" => GetCompletions(paramsElement),
                "ai/getSystemPrompt" => GetSystemPrompt(paramsElement),
                "ai/chat" => await AiChatAsync(paramsElement, ct),
                "ai/generateTitle" => await GenerateTitleAsync(paramsElement, ct),
                "ai/extractFromImage" => await ExtractFromImageAsync(paramsElement, ct),
                "ai/clearToken" => ClearAiToken(),
                "ai/setToken" => SetAiToken(paramsElement),
                "import/kustoExplorer" => ImportKustoExplorerConnections(paramsElement),
                "resultHistory/list" => GetResultHistory(paramsElement),
                "resultHistory/save" => SaveResultHistory(paramsElement),
                "resultHistory/delete" => DeleteResultHistory(paramsElement),
                "resultHistory/clear" => ClearResultHistory(),
                "outlook/openItem" => OpenOutlookItem(paramsElement),
                "outlook/getPreview" => GetMailPreview(paramsElement),
                "outlook/markRead" => MarkEmailRead(paramsElement),
                "outlook/openRulesEditor" => OpenRulesEditor(),
                "outlook/renameRule" => RenameRule(paramsElement),
                "outlook/setRuleEnabled" => SetRuleEnabled(paramsElement),
                "outlook/deleteRule" => DeleteRule(paramsElement),
                "outlook/sendMail" => SendMail(paramsElement),
                "outlook/getRuleDetails" => GetRuleDetails(paramsElement),
                "outlook/updateRuleProperty" => UpdateRuleProperty(paramsElement),
                _ => throw new Exception($"Unknown method: {method}")
            };

            return CreateResponse(id, result);
        }
        catch (Exception ex)
        {
            _log($"Error: {ex.Message}");
            return CreateErrorResponse(id, ex.Message);
        }
        finally
        {
            doc?.Dispose();
        }
    }

    private string CreateResponse(int? id, object? result)
    {
        var response = new { jsonrpc = "2.0", id, result };
        return JsonSerializer.Serialize(response, _jsonOptions);
    }

    private string CreateErrorResponse(int? id, string message)
    {
        var response = new { jsonrpc = "2.0", id, error = new { code = -1, message } };
        return JsonSerializer.Serialize(response, _jsonOptions);
    }

    private object? Shutdown() { Environment.Exit(0); return null; }

    private object? AddCluster(JsonElement p)
    {
        var cluster = JsonSerializer.Deserialize<ClusterInfo>(p.GetRawText(), _jsonOptions)!;
        _cluster.AddCluster(cluster);
        return null;
    }

    private object? RemoveCluster(JsonElement p)
    {
        var id = p.GetProperty("id").GetString()!;
        _cluster.RemoveCluster(id);
        return null;
    }

    private object? SetFavorite(JsonElement p)
    {
        var id = p.GetProperty("id").GetString()!;
        var favorite = p.GetProperty("favorite").GetBoolean();
        _cluster.SetFavorite(id, favorite);
        return null;
    }

    private object? RenameCluster(JsonElement p)
    {
        var id = p.GetProperty("id").GetString()!;
        var name = p.GetProperty("name").GetString()!;
        _cluster.Rename(id, name);
        return null;
    }

    private object? SavePreset(JsonElement p)
    {
        try
        {
            _log($"SavePreset: parsing params...");
            var preset = JsonSerializer.Deserialize<PresetInfo>(p.GetRawText(), _jsonOptions)!;
            _log($"SavePreset: saving preset '{preset.Name}'...");
            _preset.SavePreset(preset);
            _log($"SavePreset: done");
            return null;
        }
        catch (Exception ex)
        {
            _log($"SavePreset error: {ex.Message}");
            throw;
        }
    }

    private object? DeletePreset(JsonElement p)
    {
        var id = p.GetProperty("id").GetString()!;
        _preset.DeletePreset(id);
        return null;
    }

    private PresetInfo[] GetHistory(JsonElement p)
    {
        var limit = p.TryGetProperty("limit", out var l) ? l.GetInt32() : 100;
        return _preset.GetHistory(limit);
    }

    private object ClearHistory()
    {
        var count = _preset.ClearHistory();
        return new { cleared = count };
    }

    private async Task<QueryResult> ExecuteQueryAsync(JsonElement p, CancellationToken ct)
    {
        var request = JsonSerializer.Deserialize<QueryRequest>(p.GetRawText(), _jsonOptions)!;
        return await _query.ExecuteAsync(request, ct);
    }

    private object? CancelQuery() { _query.Cancel(); return null; }

    private SchemaInfo GetSchema(JsonElement p)
    {
        var clusterUrl = p.GetProperty("clusterUrl").GetString()!;
        var database = p.GetProperty("database").GetString()!;
        return _schema.GetSchema(clusterUrl, database);
    }

    private async Task<FetchSchemaResult> FetchSchemaAsync(JsonElement p, CancellationToken ct)
    {
        var clusterUrl = p.GetProperty("clusterUrl").GetString()!;
        var database = p.GetProperty("database").GetString()!;
        var forceRefresh = p.TryGetProperty("forceRefresh", out var fr) && fr.GetBoolean();
        return await _schema.FetchSchemaAsync(clusterUrl, database, ct, forceRefresh);
    }

    private object? ClearSchemaCache(JsonElement p)
    {
        var clusterUrl = p.TryGetProperty("clusterUrl", out var cu) ? cu.GetString() : null;
        var database = p.TryGetProperty("database", out var db) ? db.GetString() : null;
        _schema.ClearCache(clusterUrl ?? "", database ?? "");
        return new { success = true };
    }

    private object GetSchemaCacheStats()
    {
        var (total, valid, oldest) = _schema.GetCacheStats();
        return new { totalCached = total, validCached = valid, oldestCache = oldest?.ToString("o") };
    }

    private CompletionItem[] GetCompletions(JsonElement p)
    {
        var query = p.GetProperty("query").GetString()!;
        var position = p.GetProperty("position").GetInt32();
        var clusterUrl = p.TryGetProperty("clusterUrl", out var cu) ? cu.GetString() : null;
        var database = p.TryGetProperty("database", out var db) ? db.GetString() : null;
        return _schema.GetCompletions(query, position, clusterUrl, database);
    }

    private GetSystemPromptResponse GetSystemPrompt(JsonElement p)
    {
        var mode = p.TryGetProperty("mode", out var modeEl) ? modeEl.GetString() ?? "kusto" : "kusto";
        var prompt = AiHandler.GetSystemPrompt(mode);
        return new GetSystemPromptResponse(prompt);
    }

    private async Task<AiChatResponse> AiChatAsync(JsonElement p, CancellationToken ct)
    {
        var request = JsonSerializer.Deserialize<AiChatRequest>(p.GetRawText(), _jsonOptions)!;
        return await _ai.ChatAsync(request, ct);
    }

    private async Task<GenerateTitleResponse> GenerateTitleAsync(JsonElement p, CancellationToken ct)
    {
        var query = p.GetProperty("query").GetString()!;
        return await _ai.GenerateTitleAsync(query, ct);
    }

    private ClearTokenResult ClearAiToken()
    {
        return _ai.ClearToken();
    }

    private object SetAiToken(JsonElement p)
    {
        var token = p.GetProperty("token").GetString();
        var success = _ai.SetToken(token ?? "");
        return new { success };
    }

    private async Task<ExtractedDataSourceInfo> ExtractFromImageAsync(JsonElement p, CancellationToken ct)
    {
        var request = JsonSerializer.Deserialize<ExtractDataSourceFromImageRequest>(p.GetRawText(), _jsonOptions)!;
        return await _ai.ExtractDataSourceFromImageAsync(request, ct);
    }

    private ResultHistoryItem[] GetResultHistory(JsonElement p)
    {
        var limit = p.TryGetProperty("limit", out var l) ? l.GetInt32() : 50;
        return _resultsHistory.GetHistory(limit);
    }

    private object? SaveResultHistory(JsonElement p)
    {
        var item = JsonSerializer.Deserialize<ResultHistoryItem>(p.GetRawText(), _jsonOptions)!;
        _resultsHistory.SaveResult(item);
        return null;
    }

    private object? DeleteResultHistory(JsonElement p)
    {
        var id = p.GetProperty("id").GetString()!;
        _resultsHistory.DeleteResult(id);
        return null;
    }

    private object ClearResultHistory()
    {
        var count = _resultsHistory.ClearHistory();
        return new { cleared = count };
    }

    private object? GetDataSources() => _query.GetDataSources();

    private ImportKustoExplorerResponse ImportKustoExplorerConnections(JsonElement p)
    {
        try
        {
            // Check if a file path was provided
            var filePath = p.TryGetProperty("filePath", out var fp) ? fp.GetString() : null;

            string settingsPath;
            if (!string.IsNullOrEmpty(filePath))
            {
                // Use provided file path
                settingsPath = filePath;
                _log($"Using provided Kusto Explorer file: {settingsPath}");
            }
            else
            {
                // Try default location
                var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                settingsPath = Path.Combine(localAppData, "Kusto.Explorer", "UserSettings.xml");
                _log($"Looking for Kusto Explorer settings at: {settingsPath}");
            }

            if (!File.Exists(settingsPath))
            {
                return new ImportKustoExplorerResponse(
                    Success: false,
                    Connections: Array.Empty<KustoExplorerConnection>(),
                    Error: $"File not found: {settingsPath}. You can export connections from Kusto Explorer and select the exported XML file."
                );
            }

            var connections = new List<KustoExplorerConnection>();
            var doc = System.Xml.Linq.XDocument.Load(settingsPath);

            // Kusto Explorer exported XML format:
            // <ServerDescriptionBase><Name>...</Name><ConnectionString>Data Source=...;Initial Catalog=...</ConnectionString></ServerDescriptionBase>
            var serverEntries = doc.Descendants()
                .Where(e => e.Name.LocalName == "ServerDescriptionBase")
                .ToList();

            // If no ServerDescriptionBase found, fall back to scanning for connection strings
            var connectionElements = serverEntries.Count > 0
                ? serverEntries
                : doc.Descendants()
                    .Where(e => e.Name.LocalName == "Connection" ||
                               e.Name.LocalName == "ConnectionString" ||
                               e.Name.LocalName == "Item" ||
                               e.Name.LocalName == "string")
                    .ToList();

            foreach (var elem in connectionElements)
            {
                // Try to get the display name from <Name> child element
                var nameElement = elem.Elements().FirstOrDefault(e => e.Name.LocalName == "Name")?.Value?.Trim();

                // Get connection string from <ConnectionString> child or the element value itself
                var connStr = elem.Elements().FirstOrDefault(e => e.Name.LocalName == "ConnectionString")?.Value?.Trim()
                    ?? elem.Value?.Trim()
                    ?? elem.Attribute("Value")?.Value?.Trim();
                if (string.IsNullOrEmpty(connStr)) continue;

                // Parse connection string
                string? clusterUrl = null;
                string? database = null;
                string? name = nameElement;

                // Handle Data Source format
                var parts = connStr.Split(';', StringSplitOptions.RemoveEmptyEntries);
                foreach (var part in parts)
                {
                    var kv = part.Split('=', 2);
                    if (kv.Length != 2) continue;

                    var key = kv[0].Trim().ToLowerInvariant();
                    var value = kv[1].Trim();

                    if (key == "data source" || key == "server" || key == "addr" || key == "address")
                    {
                        clusterUrl = value;
                    }
                    else if (key == "initial catalog" || key == "database")
                    {
                        database = value;
                    }
                }

                // "NetDefaultDB" is Kusto Explorer's placeholder for "no database selected" — treat as null
                if (string.Equals(database, "NetDefaultDB", StringComparison.OrdinalIgnoreCase))
                {
                    database = null;
                }

                // If no Data Source format, check if it's just a URL
                if (clusterUrl == null && connStr.Contains("kusto") && connStr.StartsWith("http"))
                {
                    clusterUrl = connStr.Split(';')[0];
                }

                // Only add if we have a valid cluster URL (must be a kusto URL)
                if (!string.IsNullOrEmpty(clusterUrl) &&
                    (clusterUrl.Contains("kusto.windows.net") ||
                     clusterUrl.Contains("kusto.azure") ||
                     clusterUrl.Contains("kusto.data")))
                {
                    // Extract name from cluster URL if not provided
                    if (string.IsNullOrEmpty(name))
                    {
                        try
                        {
                            var uri = new Uri(clusterUrl);
                            name = uri.Host.Split('.')[0];
                        }
                        catch
                        {
                            name = clusterUrl;
                        }
                    }

                    // Avoid duplicates
                    if (!connections.Any(c => c.ClusterUrl.Equals(clusterUrl, StringComparison.OrdinalIgnoreCase) &&
                                              c.Database == database))
                    {
                        connections.Add(new KustoExplorerConnection(
                            Name: name ?? "Unknown",
                            ClusterUrl: clusterUrl,
                            Database: database
                        ));
                    }
                }
            }

            _log($"Found {connections.Count} Kusto Explorer connections");

            return new ImportKustoExplorerResponse(
                Success: true,
                Connections: connections.ToArray(),
                Error: null
            );
        }
        catch (Exception ex)
        {
            _log($"Error importing Kusto Explorer connections: {ex.Message}");
            return new ImportKustoExplorerResponse(
                Success: false,
                Connections: Array.Empty<KustoExplorerConnection>(),
                Error: ex.Message
            );
        }
    }

    private object? OpenOutlookItem(JsonElement p)
    {
        var entryId = p.GetProperty("entryId").GetString()!;
        _outlook.OpenItem(entryId);
        return null;
    }

    private object? GetMailPreview(JsonElement p)
    {
        var entryId = p.GetProperty("entryId").GetString()!;
        return _outlook.GetMailPreview(entryId);
    }

    private object? MarkEmailRead(JsonElement p)
    {
        var entryId = p.GetProperty("entryId").GetString()!;
        var markAsRead = p.GetProperty("markAsRead").GetBoolean();
        return _outlook.MarkAsRead(entryId, markAsRead);
    }

    private object? OpenRulesEditor()
    {
        return _outlook.OpenRulesEditor();
    }

    private object? RenameRule(JsonElement p)
    {
        var currentName = p.GetProperty("currentName").GetString()!;
        var newName = p.GetProperty("newName").GetString()!;
        return _outlook.RenameRule(currentName, newName);
    }

    private object? SetRuleEnabled(JsonElement p)
    {
        var ruleName = p.GetProperty("ruleName").GetString()!;
        var enabled = p.GetProperty("enabled").GetBoolean();
        return _outlook.SetRuleEnabled(ruleName, enabled);
    }

    private object? DeleteRule(JsonElement p)
    {
        var ruleName = p.GetProperty("ruleName").GetString()!;
        return _outlook.DeleteRule(ruleName);
    }

    private object? SendMail(JsonElement p)
    {
        var to = p.GetProperty("to").GetString()!;
        var subject = p.GetProperty("subject").GetString()!;
        var body = p.GetProperty("body").GetString()!;
        string[]? attachments = null;
        if (p.TryGetProperty("attachments", out var att) && att.ValueKind == JsonValueKind.Array)
        {
            attachments = att.EnumerateArray().Select(a => a.GetString()!).ToArray();
        }
        return _outlook.SendMail(to, subject, body, attachments);
    }

    private object? GetRuleDetails(JsonElement p)
    {
        var ruleName = p.GetProperty("ruleName").GetString()!;
        return _outlook.GetRuleDetails(ruleName);
    }

    private object? UpdateRuleProperty(JsonElement p)
    {
        var ruleName = p.GetProperty("ruleName").GetString()!;
        var property = p.GetProperty("property").GetString()!;
        var value = p.GetProperty("value").GetString()!;
        return _outlook.UpdateRuleProperty(ruleName, property, value);
    }

}

/// <summary>
/// Initializes all available data sources in the registry.
/// To add a new data source:
/// 1. Create a class implementing IDataSource
/// 2. Add a registration here
/// </summary>
static partial class DataSourceInitializer
{
    public static void InitializeDataSources(
        DataSourceRegistry registry,
        KustoService kustoService,
        KustoSchemaManager schemaManager,
        Action<string> log)
    {
        // Register Kusto data source
        registry.Register(new DataSourceRegistration
        {
            Id = "kusto",
            DisplayName = "Kusto (Azure Data Explorer)",
            Icon = "\U0001F5C4",
            QueryLanguage = "KQL",
            SortOrder = 1,
            IsEnabled = true,
            Description = "Query Azure Data Explorer clusters using KQL",
            Factory = () => new KustoDataSource(kustoService, schemaManager, log)
        });

        // Register ADO data source
        registry.Register(new DataSourceRegistration
        {
            Id = "ado",
            DisplayName = "Azure DevOps (WIQL)",
            Icon = "\U0001F4CA",
            QueryLanguage = "WIQL",
            SortOrder = 2,
            IsEnabled = true,
            Description = "Query Azure DevOps work items using WIQL",
            Factory = () => new AdoDataSource(log)
        });

        // Register Outlook data source (Windows only)
        if (OutlookDataSource.IsSupported)
        {
            registry.Register(new DataSourceRegistration
            {
                Id = "outlook",
                DisplayName = "Outlook (Email/Calendar)",
                Icon = "\U0001F4E7",
                QueryLanguage = "Outlook SQL",
                SortOrder = 3,
                IsEnabled = true,
                Description = "Query Outlook emails, calendar, and contacts",
                Factory = () => new OutlookDataSource(log)
            });
        }

        log($"Registered {registry.GetAll().Count()} data sources");
    }
}
