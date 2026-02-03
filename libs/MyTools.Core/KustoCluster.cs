using System;
using System.Collections.Generic;

namespace MyTools.Core
{
    public class KustoCluster : IEquatable<KustoCluster>
    {
        public string Cluster { get; set; }
        public string DB { get; set; }
        public string Org { get; set; }
        public string Name { get; set; }  // Custom display name (optional)
        public bool ShowInUi { get; set; } = true;
        public bool Favorite { get; set; }

        public bool Equals(KustoCluster other)
        {
            if (other is null)
            {
                return false;
            }

            return string.Equals(Cluster, other.Cluster, StringComparison.OrdinalIgnoreCase) &&
                   string.Equals(DB, other.DB, StringComparison.OrdinalIgnoreCase);
        }

        public override bool Equals(object obj)
        {
            return Equals(obj as KustoCluster);
        }

        public override int GetHashCode()
        {
            return (Cluster?.ToLowerInvariant(), DB?.ToLowerInvariant()).GetHashCode();
        }

        public override string ToString()
        {
            return Cluster;
        }
    }
}