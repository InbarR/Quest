using System;
using System.Threading.Tasks;
using Azure.Core;
using Azure.Identity;
using Kusto.Data;

namespace MyTools.Core;

/// <summary>
/// Provides persistent Azure AD authentication for Kusto connections.
/// Uses ChainedTokenCredential to try silent auth first (Azure CLI, VS Code, etc.)
/// before falling back to interactive browser login.
/// </summary>
public static class KustoAuthProvider
{
    private static ChainedTokenCredential? _credential;
    private static readonly object _lock = new();

    private static ChainedTokenCredential GetCredential()
    {
        if (_credential != null) return _credential;
        lock (_lock)
        {
            if (_credential != null) return _credential;

            // Try these in order (silent methods first, interactive last)
            _credential = new ChainedTokenCredential(
                // 1. Try Azure CLI credentials (if user is logged in via 'az login')
                new AzureCliCredential(),
                // 2. Try VS Code credentials (if signed in to Azure extension)
                new VisualStudioCodeCredential(),
                // 3. Try Visual Studio credentials
                new VisualStudioCredential(),
                // 4. Fall back to interactive browser (with persistent cache)
                new InteractiveBrowserCredential(new InteractiveBrowserCredentialOptions
                {
                    TokenCachePersistenceOptions = new TokenCachePersistenceOptions
                    {
                        Name = "QueryStudio"
                    }
                })
            );
            return _credential;
        }
    }

    /// <summary>
    /// Gets an Azure AD token for the specified Kusto cluster.
    /// Tries silent auth methods first (Azure CLI, VS Code, etc.)
    /// Falls back to browser login only if needed.
    /// </summary>
    public static async Task<string> GetTokenAsync(string clusterUrl)
    {
        var credential = GetCredential();
        var scope = clusterUrl.TrimEnd('/') + "/.default";
        var token = await credential.GetTokenAsync(new TokenRequestContext(new[] { scope }));
        return token.Token;
    }

    /// <summary>
    /// Creates a KustoConnectionStringBuilder with smart credential chain.
    /// </summary>
    public static KustoConnectionStringBuilder CreateKcsb(string clusterUrl, string database)
    {
        var url = clusterUrl;
        return new KustoConnectionStringBuilder(clusterUrl, database)
            .WithAadTokenProviderAuthentication(async () => await GetTokenAsync(url));
    }
}
