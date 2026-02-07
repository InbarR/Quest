using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;

namespace MyUtils.AI
{
    /// <summary>
    /// Exception thrown when device code authentication is required.
    /// </summary>
    public class DeviceCodeAuthRequiredException : Exception
    {
        public string UserCode { get; }
        public string VerificationUri { get; }
        public string DeviceCode { get; }
        public int ExpiresIn { get; }
        public int Interval { get; }

        public DeviceCodeAuthRequiredException(string userCode, string verificationUri, string deviceCode, int expiresIn, int interval)
            : base($"Device code authentication required. Visit {verificationUri} and enter code: {userCode}")
        {
            UserCode = userCode;
            VerificationUri = verificationUri;
            DeviceCode = deviceCode;
            ExpiresIn = expiresIn;
            Interval = interval;
        }
    }

    /// <summary>
    /// Direct GitHub Copilot client that bypasses the need for a proxy server.
    /// Implements authentication and API calls directly to GitHub's Copilot endpoints.
    /// </summary>
    /// <summary>
    /// Callback for showing device code authentication UI to the user.
    /// </summary>
    /// <param name="userCode">The code the user should enter (e.g., "ABCD-1234")</param>
    /// <param name="verificationUri">The URL the user should visit</param>
    /// <returns>Task returning the dialog instance that can be closed when auth completes</returns>
    public delegate Task<object> DeviceCodeCallback(string userCode, string verificationUri);

    public class CopilotClient : IDisposable
    {
        private readonly HttpClient _httpClient;
        private readonly Action<string, bool> _log;
        private readonly DeviceCodeCallback _deviceCodeCallback;
        private string _githubToken;
        private CopilotTokenInfo _copilotToken;
        private readonly string _accountType; // "individual", "business", or "enterprise"
        private readonly string _vsCodeVersion;
        private const string CredentialTarget = "MyKusto_GitHub_Copilot_Token";

        // Track pending device code so retry works regardless of caller session
        private DeviceCodeResponse _pendingDeviceCode;
        private DateTime _pendingDeviceCodeExpiry;

        // GitHub API constants
        private const string GITHUB_BASE_URL = "https://github.com";
        private const string GITHUB_API_BASE_URL = "https://api.github.com";
        private const string GITHUB_CLIENT_ID = "Iv1.b507a08c87ecfe98";
        private const string COPILOT_VERSION = "0.26.7";
        private const string API_VERSION = "2025-04-01";

        public CopilotClient(string accountType = "individual", Action<string, bool> log = null, DeviceCodeCallback deviceCodeCallback = null)
        {
            _accountType = accountType;
            _log = log ?? ((s, b) => { });
            _deviceCodeCallback = deviceCodeCallback;
            _httpClient = new HttpClient();
            _vsCodeVersion = "1.106.3"; // Can be detected from system
        }

        #region Authentication

        /// <summary>
        /// Initiates device code authentication flow.
        /// Returns a code that the user must enter at the verification URL.
        /// </summary>
        public async Task<DeviceCodeResponse> StartAuthenticationAsync(CancellationToken ct = default)
        {
            // GitHub expects application/x-www-form-urlencoded for device code flow
            var formData = new Dictionary<string, string>
            {
                { "client_id", GITHUB_CLIENT_ID },
                { "scope", "read:user user:email" }
            };

            var content = new FormUrlEncodedContent(formData);

            using (var request = new HttpRequestMessage(HttpMethod.Post, $"{GITHUB_BASE_URL}/login/device/code"))
            {
                request.Content = content;
                request.Headers.Add("Accept", "application/json");

                var response = await _httpClient.SendAsync(request, ct);
                response.EnsureSuccessStatusCode();

                var responseText = await response.Content.ReadAsStringAsync();
                var deviceCode = JsonSerializer.Deserialize<DeviceCodeResponse>(responseText);
                
                return deviceCode;
            }
        }

        /// <summary>
        /// Polls for the access token after user has authorized the device code.
        /// </summary>
        public async Task<string> PollForAccessTokenAsync(DeviceCodeResponse deviceCode, CancellationToken ct = default)
        {
            var sleepDuration = TimeSpan.FromSeconds(deviceCode.interval + 1);

            while (!ct.IsCancellationRequested)
            {
                // GitHub expects application/x-www-form-urlencoded for token polling
                var formData = new Dictionary<string, string>
                {
                    { "client_id", GITHUB_CLIENT_ID },
                    { "device_code", deviceCode.device_code },
                    { "grant_type", "urn:ietf:params:oauth:grant-type:device_code" }
                };

                var content = new FormUrlEncodedContent(formData);

                try
                {
                    using (var request = new HttpRequestMessage(HttpMethod.Post, $"{GITHUB_BASE_URL}/login/oauth/access_token"))
                    {
                        request.Content = content;
                        request.Headers.Add("Accept", "application/json");

                        var response = await _httpClient.SendAsync(request, ct);

                        if (response.IsSuccessStatusCode)
                        {
                            var responseText = await response.Content.ReadAsStringAsync();
                            using (var doc = JsonDocument.Parse(responseText))
                            {
                                // Check for error response (authorization_pending, slow_down, etc.)
                                if (doc.RootElement.TryGetProperty("error", out var errorProp))
                                {
                                    var error = errorProp.GetString();
                                    if (error == "authorization_pending")
                                    {
                                        // User hasn't authorized yet, continue polling
                                    }
                                    else if (error == "slow_down")
                                    {
                                        sleepDuration = sleepDuration.Add(TimeSpan.FromSeconds(5));
                                    }
                                    else
                                    {
                                        _log($"Authentication error: {error}", true);
                                        throw new InvalidOperationException($"Authentication failed: {error}");
                                    }
                                }
                                else if (doc.RootElement.TryGetProperty("access_token", out var tokenProp))
                                {
                                    _githubToken = tokenProp.GetString();
                                    SaveToken(_githubToken);
                                    return _githubToken;
                                }
                            }
                        }
                    }
                }
                catch (OperationCanceledException)
                {
                    throw;
                }
                catch (InvalidOperationException)
                {
                    throw;
                }
                catch (Exception ex)
                {
                    _log($"Error polling for token: {ex.Message}", false);
                }

                await Task.Delay(sleepDuration, ct);
            }

            throw new OperationCanceledException("Authentication cancelled");
        }

        /// <summary>
        /// Gets or refreshes the Copilot token using the GitHub token.
        /// </summary>
        public async Task<CopilotTokenInfo> GetCopilotTokenAsync(CancellationToken ct = default)
        {
            if (string.IsNullOrEmpty(_githubToken))
                throw new InvalidOperationException("GitHub token not set. Call authentication methods first.");

            // Check if we have a valid cached token
            if (_copilotToken != null && _copilotToken.ExpiresAt > DateTimeOffset.UtcNow.ToUnixTimeSeconds())
            {
                return _copilotToken;
            }

            // Try different endpoint versions
            var endpoints = new[]
            {
                "/copilot_internal/v2/token",
                "/copilot_internal/token",
                "/user/copilot_seat_management"
            };

            Exception lastException = null;

            foreach (var endpoint in endpoints)
            {
                try
                {
                    using (var request = new HttpRequestMessage(HttpMethod.Get, $"{GITHUB_API_BASE_URL}{endpoint}"))
                    {
                        AddGitHubHeaders(request);

                        var response = await _httpClient.SendAsync(request, ct);
                        
                        if (response.IsSuccessStatusCode)
                        {
                            var responseText = await response.Content.ReadAsStringAsync();
                            
                            _copilotToken = JsonSerializer.Deserialize<CopilotTokenInfo>(responseText);
                            
                            if (_copilotToken != null && !string.IsNullOrEmpty(_copilotToken.Token))
                            {
                                _log($"Copilot token obtained successfully", false);
                                return _copilotToken;
                            }
                        }
                    }
                }
                catch (Exception ex)
                {
                    _log($"Failed to get token from {endpoint}: {ex.Message}", false);
                    lastException = ex;
                }
            }

            throw new InvalidOperationException(
                "Failed to retrieve Copilot token from all known endpoints. " +
                "Please ensure you have GitHub Copilot access and a valid GitHub token.",
                lastException);
        }

        /// <summary>
        /// Sets the GitHub token directly (from VS Code authentication).
        /// Also saves to credential store for persistence across server restarts.
        /// </summary>
        public void SetGitHubToken(string token)
        {
            _githubToken = token;
            SaveToken(token);
        }

        /// <summary>
        /// Gets the current GitHub token if available.
        /// </summary>
        public string GetGitHubToken()
        {
            return _githubToken;
        }

        /// <summary>
        /// Ensures GitHub token is available. The token should be set by the extension
        /// via SetGitHubToken() using VS Code's built-in GitHub authentication.
        /// Falls back to credential store, then throws if no token is available.
        /// </summary>
        public async Task<string> EnsureGitHubTokenAsync(CancellationToken ct = default)
        {
            if (!string.IsNullOrEmpty(_githubToken))
            {
                return _githubToken;
            }

            // Fallback: check credential store (for tokens from previous sessions)
            var storedToken = LoadStoredToken();
            if (!string.IsNullOrEmpty(storedToken))
            {
                _githubToken = storedToken;
                _log("Token loaded from credential store", false);
                return _githubToken;
            }

            // No token available - tell extension to authenticate via VS Code
            _log("No GitHub token available, auth required", false);
            throw new DeviceCodeAuthRequiredException("", "https://github.com/login/device", "", 0, 0);
        }

        /// <summary>
        /// Tries a single poll to check if the user has completed device code authorization.
        /// Returns the token if authorized, null if still pending.
        /// </summary>
        private async Task<string> TryPollOnceAsync(DeviceCodeResponse deviceCode, CancellationToken ct)
        {
            var formData = new Dictionary<string, string>
            {
                { "client_id", GITHUB_CLIENT_ID },
                { "device_code", deviceCode.device_code },
                { "grant_type", "urn:ietf:params:oauth:grant-type:device_code" }
            };

            var content = new FormUrlEncodedContent(formData);

            using (var request = new HttpRequestMessage(HttpMethod.Post, $"{GITHUB_BASE_URL}/login/oauth/access_token"))
            {
                request.Content = content;
                request.Headers.Add("Accept", "application/json");

                var response = await _httpClient.SendAsync(request, ct);

                if (response.IsSuccessStatusCode)
                {
                    var responseText = await response.Content.ReadAsStringAsync();
                    using (var doc = JsonDocument.Parse(responseText))
                    {
                        if (doc.RootElement.TryGetProperty("access_token", out var tokenProp))
                        {
                            return tokenProp.GetString();
                        }
                        // authorization_pending or other status - return null
                    }
                }
            }

            return null;
        }

        private void SaveToken(string token)
        {
            try
            {
                if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
                {
                    CredentialManager.WriteCredential(CredentialTarget, "github", token);
                    _log("Token cached to credential store", false);
                }
            }
            catch (Exception ex)
            {
                _log($"Failed to cache token: {ex.Message}", true);
            }
        }

        private string LoadStoredToken()
        {
            try
            {
                if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
                {
                    var cred = CredentialManager.ReadCredential(CredentialTarget);
                    if (cred != null && !string.IsNullOrEmpty(cred.Password) && cred.Password.Length >= 20)
                        return cred.Password;
                }
            }
            catch (Exception ex)
            {
                _log($"Failed to load token from credential store: {ex.Message}", false);
            }
            return null;
        }

        public void ClearStoredToken()
        {
            _githubToken = null;
            _copilotToken = null;
            try
            {
                if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
                {
                    CredentialManager.DeleteCredential(CredentialTarget);
                }
                _log("Stored token cleared", false);
            }
            catch (Exception ex)
            {
                _log($"Failed to clear stored token: {ex.Message}", true);
            }
        }

        #endregion

        #region Chat Completions

        /// <summary>
        /// Creates a chat completion using GitHub Copilot API.
        /// </summary>
        public async Task<string> CreateChatCompletionAsync(
            List<CopilotMessage> messages,
            string model = "gpt-4o",
            float temperature = 0.7f,
            int? maxTokens = null,
            CancellationToken ct = default)
        {
            await EnsureCopilotTokenAsync(ct);

            var payload = new
            {
                messages = messages.Select(m => new { role = m.Role, content = m.Content }).ToList(),
                model,
                temperature,
                max_tokens = maxTokens,
                stream = false
            };

            var copilotBaseUrl = GetCopilotBaseUrl();
            using (var request = new HttpRequestMessage(HttpMethod.Post, $"{copilotBaseUrl}/chat/completions"))
            {
                AddCopilotHeaders(request, false);
                
                // Determine if this is an agent call
                var isAgentCall = messages.Any(m => m.Role == "assistant" || m.Role == "tool");
                request.Headers.Add("X-Initiator", isAgentCall ? "agent" : "user");

                var json = JsonSerializer.Serialize(payload, new JsonSerializerOptions
                {
                    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
                });
                request.Content = new StringContent(json, Encoding.UTF8, "application/json");

                var response = await _httpClient.SendAsync(request, ct);
                response.EnsureSuccessStatusCode();

                var responseText = await response.Content.ReadAsStringAsync();
                using (var doc = JsonDocument.Parse(responseText))
                {
                    if (doc.RootElement.TryGetProperty("choices", out var choices) &&
                        choices.ValueKind == JsonValueKind.Array &&
                        choices.GetArrayLength() > 0)
                    {
                        var first = choices[0];
                        if (first.TryGetProperty("message", out var msg) &&
                            msg.TryGetProperty("content", out var contentProp))
                        {
                            return contentProp.GetString() ?? string.Empty;
                        }
                    }
                }

                return responseText;
            }
        }

        /// <summary>
        /// Creates a vision chat completion using GitHub Copilot API with image support.
        /// </summary>
        public async Task<string> CreateVisionCompletionAsync(
            string imageBase64,
            string imageMimeType,
            string systemPrompt,
            string userPrompt = "Extract the information from this image.",
            string model = "gpt-4o",
            float temperature = 0.3f,
            CancellationToken ct = default)
        {
            await EnsureCopilotTokenAsync(ct);

            // Build message with image content
            var imageDataUrl = $"data:{imageMimeType};base64,{imageBase64}";

            // Build messages as a list of dictionaries for proper JSON serialization
            var messages = new List<object>
            {
                new Dictionary<string, object>
                {
                    { "role", "system" },
                    { "content", systemPrompt }
                },
                new Dictionary<string, object>
                {
                    { "role", "user" },
                    { "content", new object[]
                        {
                            new Dictionary<string, object>
                            {
                                { "type", "image_url" },
                                { "image_url", new Dictionary<string, object>
                                    {
                                        { "url", imageDataUrl },
                                        { "detail", "high" }
                                    }
                                }
                            },
                            new Dictionary<string, object>
                            {
                                { "type", "text" },
                                { "text", userPrompt }
                            }
                        }
                    }
                }
            };

            var payload = new Dictionary<string, object>
            {
                { "messages", messages },
                { "model", model },
                { "temperature", temperature },
                { "max_tokens", 500 },
                { "stream", false }
            };

            var copilotBaseUrl = GetCopilotBaseUrl();
            using (var request = new HttpRequestMessage(HttpMethod.Post, $"{copilotBaseUrl}/chat/completions"))
            {
                AddCopilotHeaders(request, vision: true);

                var json = JsonSerializer.Serialize(payload, new JsonSerializerOptions
                {
                    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
                });
                request.Content = new StringContent(json, Encoding.UTF8, "application/json");

                var response = await _httpClient.SendAsync(request, ct);
                response.EnsureSuccessStatusCode();

                var responseText = await response.Content.ReadAsStringAsync();
                using (var doc = JsonDocument.Parse(responseText))
                {
                    if (doc.RootElement.TryGetProperty("choices", out var choices) &&
                        choices.ValueKind == JsonValueKind.Array &&
                        choices.GetArrayLength() > 0)
                    {
                        var first = choices[0];
                        if (first.TryGetProperty("message", out var msg) &&
                            msg.TryGetProperty("content", out var contentProp))
                        {
                            return contentProp.GetString() ?? string.Empty;
                        }
                    }
                }

                return responseText;
            }
        }

        /// <summary>
        /// Gets available models from GitHub Copilot using the v1/models endpoint.
        /// First retrieves a valid Copilot token, then queries the models endpoint.
        /// Falls back to known models list if token retrieval fails.
        /// </summary>
        public async Task<List<string>> GetModelsAsync(CancellationToken ct = default)
        {
            try
            {
                var tokenInfo = await GetCopilotTokenAsync(ct);

                var copilotBaseUrl = GetCopilotBaseUrl();
                using (var request = new HttpRequestMessage(HttpMethod.Get, $"{copilotBaseUrl}/models"))
                {
                    AddCopilotHeaders(request, false);

                    var response = await _httpClient.SendAsync(request, ct);
                    response.EnsureSuccessStatusCode();

                    var responseText = await response.Content.ReadAsStringAsync();

                    // Parse the response to extract model IDs
                    var models = new List<string>();
                    using (var doc = JsonDocument.Parse(responseText))
                    {
                        if (doc.RootElement.TryGetProperty("data", out var dataArray) &&
                            dataArray.ValueKind == JsonValueKind.Array)
                        {
                            foreach (var model in dataArray.EnumerateArray())
                            {
                                if (model.TryGetProperty("id", out var idProp))
                                {
                                    var modelId = idProp.GetString();
                                    if (!string.IsNullOrEmpty(modelId))
                                    {
                                        models.Add(modelId);
                                    }
                                }
                            }
                        }
                    }

                    return models;
                }
            }
            catch (Exception ex)
            {
                _log($"Failed to retrieve models from API: {ex.Message}. Falling back to known models list.", true);
                
                // Fallback to known Copilot models
                return new List<string>
                {
                    "gpt-4o",
                    "gpt-4o-mini",
                    "gpt-4",
                    "gpt-3.5-turbo",
                    "o1-preview",
                    "o1-mini"
                };
            }
        }

        #endregion

        #region Helper Methods

        private async Task EnsureCopilotTokenAsync(CancellationToken ct)
        {
            if (_copilotToken == null || _copilotToken.ExpiresAt <= DateTimeOffset.UtcNow.ToUnixTimeSeconds())
            {
                await GetCopilotTokenAsync(ct);
            }
        }

        private string GetCopilotBaseUrl()
        {
            if (_accountType == "individual")
                return "https://api.githubcopilot.com";
            return $"https://api.{_accountType}.githubcopilot.com";
        }

        private void AddGitHubHeaders(HttpRequestMessage request)
        {
            request.Headers.Add("Authorization", $"token {_githubToken}");
            request.Headers.Add("Accept", "application/json");
            request.Headers.Add("editor-version", $"vscode/{_vsCodeVersion}");
            request.Headers.Add("editor-plugin-version", $"copilot-chat/{COPILOT_VERSION}");
            request.Headers.Add("user-agent", $"GitHubCopilotChat/{COPILOT_VERSION}");
            request.Headers.Add("x-github-api-version", API_VERSION);
            request.Headers.Add("x-vscode-user-agent-library-version", "electron-fetch");
        }

        private void AddCopilotHeaders(HttpRequestMessage request, bool vision = false)
        {
            // Use TryAddWithoutValidation because Copilot tokens contain semicolons which HttpClient rejects
            request.Headers.TryAddWithoutValidation("Authorization", $"Bearer {_copilotToken.Token}");
            request.Headers.Add("copilot-integration-id", "vscode-chat");
            request.Headers.Add("editor-version", $"vscode/{_vsCodeVersion}");
            request.Headers.Add("editor-plugin-version", $"copilot-chat/{COPILOT_VERSION}");
            request.Headers.Add("user-agent", $"GitHubCopilotChat/{COPILOT_VERSION}");
            request.Headers.Add("openai-intent", "conversation-panel");
            request.Headers.Add("x-github-api-version", API_VERSION);
            request.Headers.Add("x-request-id", Guid.NewGuid().ToString());
            request.Headers.Add("x-vscode-user-agent-library-version", "electron-fetch");

            if (vision)
                request.Headers.Add("copilot-vision-request", "true");
        }

        #endregion

        public void Dispose()
        {
            _httpClient?.Dispose();
        }
    }

    #region Supporting Classes

    public class CopilotMessage
    {
        public string Role { get; set; }
        public string Content { get; set; }

        public CopilotMessage(string role, string content)
        {
            Role = role;
            Content = content;
        }
    }

    public class CopilotTokenInfo
    {
        [JsonPropertyName("token")]
        public string Token { get; set; }

        [JsonPropertyName("expires_at")]
        public long ExpiresAt { get; set; }

        [JsonPropertyName("refresh_in")]
        public long RefreshIn { get; set; }
    }

    public class DeviceCodeResponse
    {
        [JsonPropertyName("device_code")]
        public string device_code { get; set; }

        [JsonPropertyName("user_code")]
        public string user_code { get; set; }

        [JsonPropertyName("verification_uri")]
        public string verification_uri { get; set; }

        [JsonPropertyName("expires_in")]
        public int expires_in { get; set; }

        [JsonPropertyName("interval")]
        public int interval { get; set; }
    }

    #endregion

    #region Windows Credential Manager

    /// <summary>
    /// Helper class for interacting with Windows Credential Manager.
    /// </summary>
    internal static class CredentialManager
    {
        [DllImport("Advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool CredRead(string target, CRED_TYPE type, int reservedFlag, out IntPtr credentialPtr);

        [DllImport("Advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool CredWrite([In] ref CREDENTIAL userCredential, [In] uint flags);

        [DllImport("Advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool CredDelete(string target, CRED_TYPE type, int reservedFlag);

        [DllImport("Advapi32.dll", EntryPoint = "CredFree", SetLastError = true)]
        private static extern void CredFree([In] IntPtr cred);

        private enum CRED_TYPE : uint
        {
            GENERIC = 1,
            DOMAIN_PASSWORD = 2,
            DOMAIN_CERTIFICATE = 3,
            DOMAIN_VISIBLE_PASSWORD = 4,
            GENERIC_CERTIFICATE = 5,
            DOMAIN_EXTENDED = 6,
            MAXIMUM = 7,
            MAXIMUM_EX = 1007
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct CREDENTIAL
        {
            public uint Flags;
            public uint Type;
            [MarshalAs(UnmanagedType.LPWStr)]
            public string TargetName;
            [MarshalAs(UnmanagedType.LPWStr)]
            public string Comment;
            public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
            public uint CredentialBlobSize;
            public IntPtr CredentialBlob;
            public uint Persist;
            public uint AttributeCount;
            public IntPtr Attributes;
            [MarshalAs(UnmanagedType.LPWStr)]
            public string TargetAlias;
            [MarshalAs(UnmanagedType.LPWStr)]
            public string UserName;
        }

        public class CredentialData
        {
            public string UserName { get; set; }
            public string Password { get; set; }
        }

        /// <summary>
        /// Reads a credential from Windows Credential Manager.
        /// </summary>
        public static CredentialData ReadCredential(string target)
        {
            IntPtr credPtr = IntPtr.Zero;
            try
            {
                if (CredRead(target, CRED_TYPE.GENERIC, 0, out credPtr))
                {
                    var credential = Marshal.PtrToStructure<CREDENTIAL>(credPtr);
                    var password = credential.CredentialBlobSize > 0
                        ? Marshal.PtrToStringUni(credential.CredentialBlob, (int)credential.CredentialBlobSize / 2)
                        : string.Empty;

                    return new CredentialData
                    {
                        UserName = credential.UserName,
                        Password = password
                    };
                }
                return null;
            }
            finally
            {
                if (credPtr != IntPtr.Zero)
                {
                    CredFree(credPtr);
                }
            }
        }

        /// <summary>
        /// Writes a credential to Windows Credential Manager.
        /// </summary>
        public static void WriteCredential(string target, string userName, string password)
        {
            var passwordBytes = Encoding.Unicode.GetBytes(password);
            var passwordPtr = Marshal.AllocHGlobal(passwordBytes.Length);
            try
            {
                Marshal.Copy(passwordBytes, 0, passwordPtr, passwordBytes.Length);

                var credential = new CREDENTIAL
                {
                    Type = (uint)CRED_TYPE.GENERIC,
                    TargetName = target,
                    UserName = userName,
                    CredentialBlob = passwordPtr,
                    CredentialBlobSize = (uint)passwordBytes.Length,
                    Persist = 2, // CRED_PERSIST_LOCAL_MACHINE
                    Comment = "GitHub Copilot Token for MyKusto"
                };

                if (!CredWrite(ref credential, 0))
                {
                    throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                }
            }
            finally
            {
                if (passwordPtr != IntPtr.Zero)
                {
                    Marshal.FreeHGlobal(passwordPtr);
                }
            }
        }

        /// <summary>
        /// Deletes a credential from Windows Credential Manager.
        /// </summary>
        public static void DeleteCredential(string target)
        {
            if (!CredDelete(target, CRED_TYPE.GENERIC, 0))
            {
                int error = Marshal.GetLastWin32Error();
                // ERROR_NOT_FOUND = 1168, ignore if credential doesn't exist
                if (error != 1168)
                {
                    throw new System.ComponentModel.Win32Exception(error);
                }
            }
        }
    }

    #endregion
}
