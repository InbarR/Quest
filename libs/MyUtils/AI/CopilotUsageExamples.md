# GitHub Copilot Direct Integration - Usage Examples

This document shows how to use the new `CopilotDirect` provider to access GitHub Copilot API directly from C# without needing a separate proxy server.

## Features

- ✅ **No proxy server needed** - Direct integration with GitHub Copilot API
- ✅ **Device code authentication** - Simple OAuth flow
- ✅ **Token caching** - Automatic token refresh
- ✅ **Full model support** - Access to GPT-4, Claude, and other models
- ✅ **Integrated with existing AIChat.cs** - Same API, new provider

## Quick Start

### Option 1: Interactive Authentication

```csharp
using MyUtils.AI;

// Create client with CopilotDirect provider
var config = new AiConfig
{
    Provider = AiProvider.CopilotDirect,
    Model = AiModel.GPT4_1,
    Temperature = 0.7f
};

var client = AiChatClient.Create(config, (msg, isError) => Console.WriteLine(msg));

// Initialize (will prompt for interactive auth if no token is set)
client.Init();

// If using the direct CopilotClient, perform authentication
var copilotClient = new CopilotClient("individual", (msg, isError) => Console.WriteLine(msg));

// Start device code flow
var deviceCode = await copilotClient.StartAuthenticationAsync();
Console.WriteLine($"Please visit {deviceCode.verification_uri} and enter: {deviceCode.user_code}");

// Poll for access token (waits for user to authorize)
var githubToken = await copilotClient.PollForAccessTokenAsync(deviceCode);
Console.WriteLine("Authenticated successfully!");

// Get Copilot token
var copilotToken = await copilotClient.GetCopilotTokenAsync();

// Now use with AIChat
var session = new AiChatSession();
var response = await client.RunWithHistoryAsync(session, "Hello! How are you?");
Console.WriteLine(response);
```

### Option 2: Pre-configured Token

If you already have a GitHub token (from `gh auth token`):

```csharp
using MyUtils.AI;

var config = new AiConfig
{
    Provider = AiProvider.CopilotDirect,
    Model = AiModel.GPT4o,
    GitHubToken = "your-github-token-here",  // Or load from file
    Temperature = 0.7f
};

var client = AiChatClient.Create(config);
client.Init();

// Use it
var session = new AiChatSession();
var response = await client.RunWithHistoryAsync(session, "Write a hello world in Python");
Console.WriteLine(response);
```

## Using CopilotClient Directly

For more control, use the `CopilotClient` class directly:

```csharp
using MyUtils.AI;

var copilot = new CopilotClient("individual");

// Set token if you have one
copilot.SetGitHubToken("your-github-token");

// Or do interactive auth
var deviceCode = await copilot.StartAuthenticationAsync();
// User visits URL and enters code...
var token = await copilot.PollForAccessTokenAsync(deviceCode);

// Get available models
var models = await copilot.GetModelsAsync();
Console.WriteLine("Available models: " + string.Join(", ", models));

// Create chat completion
var messages = new List<CopilotMessage>
{
    new CopilotMessage("system", "You are a helpful assistant."),
    new CopilotMessage("user", "What is the capital of France?")
};

var response = await copilot.CreateChatCompletionAsync(
    messages,
    model: "gpt-4o",
    temperature: 0.7f
);

Console.WriteLine(response);
```

## Integration with MyKusto

Here's how to integrate this into MyKusto without external dependencies:

```csharp
public class MyKustoAIHelper
{
    private readonly AiChatClient _client;
    private readonly AiChatSession _session;

    public MyKustoAIHelper()
    {
        // Load GitHub token from environment or secure storage
        var githubToken = Environment.GetEnvironmentVariable("GITHUB_TOKEN") 
            ?? LoadTokenFromSecureStorage();

        var config = new AiConfig
        {
            Provider = AiProvider.CopilotDirect,
            Model = AiModel.GPT4_1,
            GitHubToken = githubToken,
            SystemPrompt = "You are an expert in Kusto Query Language (KQL). Help users write and optimize KQL queries.",
            Temperature = 0.3f
        };

        _client = AiChatClient.Create(config);
        _client.Init();
        _session = new AiChatSession();
    }

    public async Task<string> GenerateKQLQueryAsync(string userRequest)
    {
        var response = await _client.RunWithHistoryAsync(
            _session,
            $"Generate a KQL query for: {userRequest}"
        );

        return response;
    }

    public async Task<string> ExplainKQLAsync(string query)
    {
        var response = await _client.RunWithHistoryAsync(
            _session,
            $"Explain this KQL query:\n{query}"
        );

        return response;
    }

    private string LoadTokenFromSecureStorage()
    {
        // Implement secure token storage
        // For example, read from encrypted config or Windows Credential Manager
        var tokenPath = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            ".github-token"
        );

        if (File.Exists(tokenPath))
        {
            return File.ReadAllText(tokenPath).Trim();
        }

        throw new InvalidOperationException("GitHub token not found. Please authenticate first.");
    }
}
```

## Provider Comparison

| Feature | CopilotProxy | CopilotDirect |
|---------|--------------|---------------|
| External Server | Required (localhost:4141) | None |
| Authentication | Handled by proxy | Built-in C# |
| Dependencies | Node.js, Bun | None (pure C#) |
| Token Management | Proxy handles | Automatic caching |
| Deployment | Extra process | Single process |
| Best For | Development/Testing | Production/Deployment |

## Advanced: Token Persistence

Save tokens to avoid re-authentication:

```csharp
public class TokenManager
{
    private const string TOKEN_FILE = ".copilot-token";

    public static void SaveToken(string githubToken)
    {
        var tokenPath = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            TOKEN_FILE
        );
        File.WriteAllText(tokenPath, githubToken);
        Console.WriteLine($"Token saved to {tokenPath}");
    }

    public static string LoadToken()
    {
        var tokenPath = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            TOKEN_FILE
        );

        if (File.Exists(tokenPath))
        {
            return File.ReadAllText(tokenPath).Trim();
        }

        return null;
    }
}

// Usage
var token = TokenManager.LoadToken();
if (token == null)
{
    // Do interactive auth
    var copilot = new CopilotClient();
    var deviceCode = await copilot.StartAuthenticationAsync();
    token = await copilot.PollForAccessTokenAsync(deviceCode);
    TokenManager.SaveToken(token);
}

// Use the token
var config = new AiConfig
{
    Provider = AiProvider.CopilotDirect,
    GitHubToken = token,
    Model = AiModel.GPT4_1
};
```

## Account Types

The `CopilotClient` supports different account types:

```csharp
// Individual account (default)
var copilot = new CopilotClient("individual");

// Business account
var copilot = new CopilotClient("business");

// Enterprise account
var copilot = new CopilotClient("enterprise");
```

## Error Handling

```csharp
try
{
    var client = AiChatClient.Create(config);
    client.Init();
    
    var response = await client.RunWithHistoryAsync(session, prompt);
}
catch (InvalidOperationException ex)
{
    // Token not set or authentication failed
    Console.WriteLine($"Auth error: {ex.Message}");
}
catch (HttpRequestException ex)
{
    // Network or API error
    Console.WriteLine($"API error: {ex.Message}");
}
catch (Exception ex)
{
    // Other errors
    Console.WriteLine($"Unexpected error: {ex.Message}");
}
```

## Summary

The `CopilotDirect` provider gives you:
- **Zero external dependencies** - No proxy server needed
- **Simple integration** - Same API as other providers
- **Full control** - Token management, caching, error handling
- **Production ready** - Self-contained C# implementation

Perfect for integrating GitHub Copilot into internal tools like MyKusto!
