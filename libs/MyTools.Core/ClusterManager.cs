using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace MyTools.Core
{
    public class ClusterManager
    {
        private const string FavPrefix = "*";
        private const string IgnorePrefix = "#";
        private readonly string _clustersFile;
        private readonly RemoteContentLoader? _remoteLoader;

        public ClusterManager(string clustersFile, RemoteContentLoader? remoteLoader = null)
        {
            _clustersFile = clustersFile;
            _remoteLoader = remoteLoader;
        }

        public KustoCluster[] LoadClusters()
        {
            var localClusters = LoadLocalClusters();
            return localClusters;
        }

        public async System.Threading.Tasks.Task<KustoCluster[]> LoadClustersWithRemoteAsync(string? remotePath, int cacheMinutes = 30)
        {
            var localClusters = LoadLocalClusters();

            if (_remoteLoader != null && !string.IsNullOrEmpty(remotePath))
            {
                try
                {
                    var remoteClusters = await _remoteLoader.LoadClustersFromRemoteAsync(remotePath, cacheMinutes);
                    
                    // Merge local and remote clusters, preferring local if duplicates
                    var merged = localClusters
                        .Concat(remoteClusters.Where(rc => !localClusters.Any(lc => 
                            lc.Cluster.Equals(rc.Cluster, StringComparison.OrdinalIgnoreCase) && 
                            lc.DB.Equals(rc.DB, StringComparison.OrdinalIgnoreCase))))
                        .ToArray();
                    
                    return merged;
                }
                catch (Exception)
                {
                    // If remote fails, return local clusters
                    return localClusters;
                }
            }

            return localClusters;
        }

        private KustoCluster[] LoadLocalClusters()
        {
            if (!File.Exists(_clustersFile))
            {
                return new KustoCluster[0];
            }

            try
            {
                // Use FileShare.ReadWrite to allow reading even if file is open in editor
                using (var stream = new FileStream(_clustersFile, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                using (var reader = new StreamReader(stream))
                {
                    var lines = new List<string>();
                    string? line;
                    while ((line = reader.ReadLine()) != null)
                    {
                        lines.Add(line);
                    }

                    return lines
                        .Select(l => l.Split(','))
                        .Where(s => s.Length >= 2)
                        .Select(s => new KustoCluster
                        {
                            Cluster = (s[0].StartsWith(IgnorePrefix) || s[0].StartsWith(FavPrefix) ? s[0].Substring(1) : s[0]).Trim(),
                            DB = s[1].Trim(),
                            Org = s.Length >= 3 ? s[2].Trim() : "",
                            Name = s.Length >= 4 ? s[3].Trim() : null,  // Custom name (optional, 4th field)
                            ShowInUi = !s[0].StartsWith(IgnorePrefix),
                            Favorite = s[0].StartsWith(FavPrefix)
                        })
                        .Distinct()
                        .ToArray();
                }
            }
            catch (IOException ex)
            {
                // If file is locked, return empty array and let caller handle it
                System.Diagnostics.Debug.WriteLine($"Error loading clusters: {ex.Message}");
                return new KustoCluster[0];
            }
        }

        public void SaveClusters(IEnumerable<KustoCluster> clusters)
        {
            // CSV format: ClusterURL,DB,Org,Name (4th field is optional custom name)
            var lines = clusters.Select(c =>
                string.IsNullOrEmpty(c.Name)
                    ? $"{ClusterName(c)},{c.DB},{c.Org}"
                    : $"{ClusterName(c)},{c.DB},{c.Org},{c.Name}"
            ).ToArray();
            
            try
            {
                // Use FileShare.Read to allow other processes to read while we write
                using (var stream = new FileStream(_clustersFile, FileMode.Create, FileAccess.Write, FileShare.Read))
                using (var writer = new StreamWriter(stream))
                {
                    foreach (var line in lines)
                    {
                        writer.WriteLine(line);
                    }
                }
            }
            catch (IOException ex)
            {
                // If we can't save, throw to let caller handle it
                throw new InvalidOperationException($"Cannot save clusters. The file may be open in another application. Please close it and try again.", ex);
            }
        }

        private string ClusterName(KustoCluster cluster)
        {
            if (!cluster.ShowInUi)
            {
                return IgnorePrefix + cluster.Cluster;
            }

            if (cluster.Favorite)
            {
                return FavPrefix + cluster.Cluster;
            }

            return cluster.Cluster;
        }

    }
}
