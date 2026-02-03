using System;
using System.Collections.Generic;
using System.Linq;

namespace MyTools.Core
{
    public class KustoPreset : IEquatable<KustoPreset>
    {
        public string PresetName { get; set; }
        public KustoCluster[] Clusters { get; set; }
        public string Query { get; set; }
        public bool AutoSaved { get; set; }
        public DateTime Time { get; set; }
        public PresetMode Mode { get; set; } = PresetMode.Kusto;

        /// <summary>
        /// Display title for history items (tab name or AI-generated title)
        /// </summary>
        public string Title { get; set; }

        public bool Equals(KustoPreset other)
        {
            if (other is null)
            {
                return false;
            }
            return PresetName == other.PresetName;
        }

        public override bool Equals(object obj)
        {
            return Equals(obj as KustoPreset);
        }

        public override int GetHashCode()
        {
            return PresetName?.GetHashCode() ?? 0;
        }

        public bool PresetEquals(KustoPreset other)
        {
            if (other == null) return false;
            return other.Query == Query &&
                   (other.Clusters ?? new KustoCluster[0]).Select(c => c.ToString()).OrderBy(c => c)
                   .SequenceEqual((Clusters ?? new KustoCluster[0]).Select(c => c.ToString()).OrderBy(c => c));
        }

        public override string ToString()
        {
            return PresetName;
        }
    }
}