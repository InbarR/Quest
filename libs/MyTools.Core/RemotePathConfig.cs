using System;

namespace MyTools.Core
{
    /// <summary>
    /// Configuration for remote paths to load queries and connections
    /// </summary>
    public class RemotePathConfig
    {
        /// <summary>
        /// Remote path/URL for queries (e.g., ADO Wiki URL)
        /// </summary>
        public string? QueriesPath { get; set; }

        /// <summary>
        /// Remote path/URL for connections/clusters
        /// </summary>
        public string? ConnectionsPath { get; set; }

        /// <summary>
        /// Whether to automatically load from remote paths on startup
        /// </summary>
        public bool AutoLoadOnStartup { get; set; } = true;

        /// <summary>
        /// Cache duration in minutes (0 = no cache, always fetch)
        /// </summary>
        public int CacheDurationMinutes { get; set; } = 30;

        /// <summary>
        /// Last time queries were fetched from remote
        /// </summary>
        public DateTime? LastQueriesFetch { get; set; }

        /// <summary>
        /// Last time connections were fetched from remote
        /// </summary>
        public DateTime? LastConnectionsFetch { get; set; }
    }
}
