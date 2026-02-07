using System;
using System.Threading.Tasks;
using Azure.Core;
using Azure.Identity;
using Kusto.Data;

namespace MyTools.Core;

/// <summary>
/// Provides persistent Azure AD authentication for Kusto connections.
/// Tokens are cached to disk (encrypted via DPAPI on Windows) and reused across server restarts.
/// </summary>
public static class KustoAuthProvider
{
    private static InteractiveBrowserCredential? _credential;
    private static readonly object _lock = new();

    private static InteractiveBrowserCredential GetCredential()
    {
        if (_credential != null) return _credential;
        lock (_lock)
        {
            _credential ??= new InteractiveBrowserCredential(new InteractiveBrowserCredentialOptions
            {
                TokenCachePersistenceOptions = new TokenCachePersistenceOptions
                {
                    Name = "QueryStudio"
                }
            });
            return _credential;
        }
    }

    /// <summary>
    /// Gets an Azure AD token for the specified Kusto cluster.
    /// On first call, opens a browser for interactive login.
    /// Subsequent calls use the persisted token cache (including refresh tokens).
    /// </summary>
    public static async Task<string> GetTokenAsync(string clusterUrl)
    {
        var credential = GetCredential();
        var scope = clusterUrl.TrimEnd('/') + "/.default";
        var token = await credential.GetTokenAsync(new TokenRequestContext(new[] { scope }));
        return token.Token;
    }

    /// <summary>
    /// Creates a KustoConnectionStringBuilder with persistent token caching.
    /// </summary>
    public static KustoConnectionStringBuilder CreateKcsb(string clusterUrl, string database)
    {
        var url = clusterUrl;
        return new KustoConnectionStringBuilder(clusterUrl, database)
            .WithAadTokenProviderAuthentication(async () => await GetTokenAsync(url));
    }
}
