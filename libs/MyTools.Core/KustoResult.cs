using System;
using System.Collections.Generic;
using System.IO;

namespace MyTools.Core
{
    public class KustoResult : IEqualityComparer<KustoResult>
    {
        public string Name { get; set; }
        public string Path { get; set; }
        public uint Num { get; set; }
        public string Content => File.ReadAllText(Path);
        public DateTime Time { get; set; }
        public string[] Columns { get; set; }
        public List<string[]> Rows { get; set; }

        public bool Equals(KustoResult x, KustoResult y)
        {
            if (x is null || y is null)
            {
                return false;
            }
            return x.Name == y.Name;
        }

        public int GetHashCode(KustoResult obj)
        {
            return obj.Name.GetHashCode();
        }

        public override string ToString()
        {
            return Name;
        }
    }
}