using MyTools.Core;
using Quest.Server.Protocol;

namespace Quest.Server.Handlers;

public class ClusterHandler
{
    private readonly ClusterManager _clusterManager;
    private List<KustoCluster> _rawClusters = new();
    private List<ClusterInfo> _clusters = new();

    public ClusterHandler(ClusterManager clusterManager)
    {
        _clusterManager = clusterManager;
        RefreshClusters();
    }

    private void RefreshClusters()
    {
        _rawClusters = _clusterManager.LoadClusters().ToList();
        _clusters = _rawClusters.Select(c => new ClusterInfo(
            Id: GenerateStableId(c.Cluster, c.DB),
            Name: !string.IsNullOrEmpty(c.Name) ? c.Name : ExtractName(c.Cluster),
            Url: c.Cluster,
            Database: c.DB,
            Type: c.Cluster.Contains("dev.azure.com") || c.Cluster.Contains("visualstudio.com") ? "ado" : "kusto",
            IsFavorite: c.Favorite,
            Organization: c.Org
        )).ToList();
    }

    // Generate a stable ID that doesn't change between process restarts
    // (GetHashCode() is randomized in .NET Core and not stable)
    private static string GenerateStableId(string cluster, string db)
    {
        var input = $"{cluster}_{db}".ToLowerInvariant();
        using var sha = System.Security.Cryptography.SHA256.Create();
        var hash = sha.ComputeHash(System.Text.Encoding.UTF8.GetBytes(input));
        return Convert.ToHexString(hash)[..16]; // First 16 chars of hex hash
    }

    private static string ExtractName(string url)
    {
        try
        {
            if (url.Contains("dev.azure.com"))
            {
                var match = System.Text.RegularExpressions.Regex.Match(url, @"dev\.azure\.com/([^/]+)");
                return match.Success ? match.Groups[1].Value : url;
            }
            if (url.Contains(".kusto."))
            {
                var match = System.Text.RegularExpressions.Regex.Match(url, @"https?://([^.]+)");
                return match.Success ? match.Groups[1].Value : url;
            }
            return url;
        }
        catch
        {
            return url;
        }
    }

    public ClusterInfo[] GetClusters()
    {
        RefreshClusters();
        return _clusters.ToArray();
    }

    public void AddCluster(ClusterInfo cluster)
    {
        var kustoCluster = new KustoCluster
        {
            Cluster = cluster.Url,
            DB = cluster.Database,
            Org = cluster.Organization ?? "",
            Name = cluster.Name,  // Save the display name
            Favorite = cluster.IsFavorite,
            ShowInUi = true
        };

        _rawClusters.Add(kustoCluster);
        _clusterManager.SaveClusters(_rawClusters);
        RefreshClusters();
    }

    public void RemoveCluster(string id)
    {
        var clusterInfo = _clusters.FirstOrDefault(c => c.Id == id);
        if (clusterInfo != null)
        {
            var rawCluster = _rawClusters.FirstOrDefault(c =>
                c.Cluster == clusterInfo.Url && c.DB == clusterInfo.Database);
            if (rawCluster != null)
            {
                _rawClusters.Remove(rawCluster);
                _clusterManager.SaveClusters(_rawClusters);
                RefreshClusters();
            }
        }
    }

    public void SetFavorite(string id, bool favorite)
    {
        var clusterInfo = _clusters.FirstOrDefault(c => c.Id == id);
        if (clusterInfo != null)
        {
            var rawCluster = _rawClusters.FirstOrDefault(c =>
                c.Cluster == clusterInfo.Url && c.DB == clusterInfo.Database);
            if (rawCluster != null)
            {
                rawCluster.Favorite = favorite;
                _clusterManager.SaveClusters(_rawClusters);
                RefreshClusters();
            }
        }
    }

    public void Rename(string id, string newName)
    {
        var clusterInfo = _clusters.FirstOrDefault(c => c.Id == id);
        if (clusterInfo != null)
        {
            var rawCluster = _rawClusters.FirstOrDefault(c =>
                c.Cluster == clusterInfo.Url && c.DB == clusterInfo.Database);
            if (rawCluster != null)
            {
                rawCluster.Name = newName;
                _clusterManager.SaveClusters(_rawClusters);
                RefreshClusters();
            }
        }
    }
}
