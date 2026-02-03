using StreamJsonRpc;
using Quest.Server.Handlers;

namespace Quest.Server.Protocol;

/// <summary>
/// Aggregates all handlers into a single JSON-RPC target
/// </summary>
public class AggregateHandler
{
    private readonly HealthHandler _health;
    private readonly QueryHandler _query;
    private readonly ClusterHandler _cluster;
    private readonly PresetHandler _preset;
    private readonly SchemaHandler _schema;
    private readonly AiHandler _ai;

    public AggregateHandler(
        HealthHandler health,
        QueryHandler query,
        ClusterHandler cluster,
        PresetHandler preset,
        SchemaHandler schema,
        AiHandler ai)
    {
        _health = health;
        _query = query;
        _cluster = cluster;
        _preset = preset;
        _schema = schema;
        _ai = ai;
    }

    // Health
    [JsonRpcMethod("health/check")]
    public HealthCheckResponse HealthCheck() => _health.Check();

    [JsonRpcMethod("shutdown")]
    public void Shutdown() => _health.Shutdown();

    // Clusters
    [JsonRpcMethod("cluster/list")]
    public ClusterInfo[] GetClusters() => _cluster.GetClusters();

    [JsonRpcMethod("cluster/add")]
    public void AddCluster(ClusterInfo cluster) => _cluster.AddCluster(cluster);

    [JsonRpcMethod("cluster/remove")]
    public void RemoveCluster(RemoveRequest request) => _cluster.RemoveCluster(request.Id);

    [JsonRpcMethod("cluster/setFavorite")]
    public void SetFavorite(SetFavoriteRequest request) => _cluster.SetFavorite(request.Id, request.Favorite);

    // Presets
    [JsonRpcMethod("preset/list")]
    public PresetInfo[] GetPresets() => _preset.GetPresets();

    [JsonRpcMethod("preset/save")]
    public void SavePreset(PresetInfo preset) => _preset.SavePreset(preset);

    [JsonRpcMethod("preset/delete")]
    public void DeletePreset(DeletePresetRequest request) => _preset.DeletePreset(request.Id);

    [JsonRpcMethod("history/list")]
    public PresetInfo[] GetHistory(HistoryRequest request) => _preset.GetHistory(request.Limit ?? 100);

    // Query
    [JsonRpcMethod("query/execute")]
    public Task<QueryResult> ExecuteQuery(QueryRequest request, CancellationToken ct) =>
        _query.ExecuteAsync(request, ct);

    [JsonRpcMethod("query/cancel")]
    public void CancelQuery() => _query.Cancel();

    // Schema
    [JsonRpcMethod("schema/get")]
    public SchemaInfo GetSchema(SchemaRequest request) => _schema.GetSchema(request.ClusterUrl, request.Database);

    [JsonRpcMethod("schema/completions")]
    public CompletionItem[] GetCompletions(CompletionRequest request) =>
        _schema.GetCompletions(request.Query, request.Position);

    // AI
    [JsonRpcMethod("ai/chat")]
    public Task<AiChatResponse> AiChat(AiChatRequest request, CancellationToken ct) =>
        _ai.ChatAsync(request, ct);

    [JsonRpcMethod("ai/generateTitle")]
    public Task<GenerateTitleResponse> GenerateTitle(GenerateTitleRequest request, CancellationToken ct) =>
        _ai.GenerateTitleAsync(request.Query, ct);
}
