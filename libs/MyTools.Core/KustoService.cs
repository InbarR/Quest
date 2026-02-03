using System;
using System.Collections.Generic;
using System.Data;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Kusto.Data;
using Kusto.Data.Common;
using Kusto.Data.Net.Client;

namespace MyTools.Core
{
    public class KustoService
    {
        private const string KustoUrlSuffix = ".kusto.windows.net";
        private static readonly HttpClient _httpClient;

        static KustoService()
        {
            // Configure HttpClient with proper timeout and proxy settings
            var handler = new HttpClientHandler
            {
                // Use system proxy settings
                UseProxy = true,
                Proxy = WebRequest.GetSystemWebProxy(),
                UseDefaultCredentials = true,
                
                // Allow auto-redirect
                AllowAutoRedirect = true,
                MaxAutomaticRedirections = 10,
                
                // Timeout settings
                ServerCertificateCustomValidationCallback = HttpClientHandler.DangerousAcceptAnyServerCertificateValidator
            };

            _httpClient = new HttpClient(handler)
            {
                Timeout = TimeSpan.FromMinutes(15) // Increase timeout for long-running queries and slow networks
            };

            // Configure ServicePointManager for better connection handling
            ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12 | SecurityProtocolType.Tls13;
            ServicePointManager.DefaultConnectionLimit = 100;
            ServicePointManager.Expect100Continue = false;
            ServicePointManager.UseNagleAlgorithm = false;
            
            // Increase socket connection timeout
            ServicePointManager.MaxServicePointIdleTime = 300000; // 5 minutes
            ServicePointManager.DnsRefreshTimeout = 120000; // 2 minutes
        }

        public async Task<KustoResult> RunQueryAsync(
            KustoConnectionStringBuilder kcsb,
            string query,
            CancellationToken cancellationToken,
            Action<string> logAction = null)
        {
            if (string.IsNullOrWhiteSpace(query))
            {
                throw new ArgumentException("Query is empty", nameof(query));
            }

            var clusterName = kcsb.DataSource;
            var database = kcsb.InitialCatalog;
            var writeCluster = !query.Contains("cluster(");

            // Set application name for better diagnostics
            kcsb.ApplicationNameForTracing = "MyKusto-Avalonia";

            if (writeCluster)
            {
                logAction?.Invoke($"Running query on {clusterName}:{database}");
            }

            // Run the entire query execution on a background thread to avoid UI freezing
            return await Task.Run(async () =>
            {
                var result = new KustoResult();
                var rows = new List<string[]>();
                ICslQueryProvider queryProvider = null;
                IDataReader reader = null;

                try
                {
                    queryProvider = KustoClientFactory.CreateCslQueryProvider(kcsb);
                    
                    var clientRequestProperties = new ClientRequestProperties 
                    { 
                        ClientRequestId = "MyKusto " + Guid.NewGuid(),
                        Application = "MyKusto-Avalonia"
                    };

                    // Set query timeout - increase for better reliability
                    clientRequestProperties.SetOption(ClientRequestProperties.OptionServerTimeout, TimeSpan.FromMinutes(10));

                    // Register cancellation callback to dispose resources when cancellation is requested
                    using (cancellationToken.Register(() =>
                    {
                        try
                        {
                            reader?.Dispose();
                            queryProvider?.Dispose();
                            logAction?.Invoke("Query cancellation requested - cleaning up resources");
                        }
                        catch
                        {
                            // Ignore disposal errors during cancellation
                        }
                    }))
                    {
                        reader = await queryProvider.ExecuteQueryAsync(database, query, clientRequestProperties);
                        
                        cancellationToken.ThrowIfCancellationRequested();
                        
                        int count = reader.FieldCount;

                        var columns = new List<string>();

                        for (int i = 0; i < count; i++)
                        {
                            string col = reader.GetName(i);
                            columns.Add(col);
                        }
                        
                        result.Columns = columns.ToArray();

                        while (reader.Read())
                        {
                            cancellationToken.ThrowIfCancellationRequested();

                            var row = new List<string>();

                            for (int i = 0; i < count; i++)
                            {
                                var val = GetValAsString(reader, i);
                                row.Add(val);
                            }

                            rows.Add(row.ToArray());
                        }

                        result.Rows = rows;
                        logAction?.Invoke($"{rows.Count} results.");
                    }
                }
                finally
                {
                    // Ensure resources are disposed even if an exception occurs
                    try { reader?.Dispose(); } catch { }
                    try { queryProvider?.Dispose(); } catch { }
                }

                return result;
            }, cancellationToken);
        }

        private string GetValAsString(IDataReader reader, int i)
        {
            var type = reader.GetFieldType(i);
            string str = reader.GetValue(i).ToString().Replace("\n", "").Replace("\r", "");

            if (!string.IsNullOrEmpty(str))
            {
                if (type == typeof(DateTime))
                {
                    // Default format, can be parameterized
                    str = reader.GetDateTime(i).ToString("yyyy-MM-dd HH:mm:ss"); 
                }
                else if (type == typeof(bool))
                {
                    str = reader.GetBoolean(i).ToString();
                }
                else if (type == typeof(sbyte))
                {
                    str = str == "0" ? "False" : "True";
                }
            }

            return str;
        }
    }
}
