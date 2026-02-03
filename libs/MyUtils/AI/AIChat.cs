using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using Azure.AI.OpenAI;
using Azure.Identity;

namespace MyUtils.AI
{
    public enum AiProvider
    {
        AzureOpenAI,
        GitHubModels,
        CopilotProxy,
        CopilotDirect
    }

    public enum AiModel
    {
        GPT4o,
        GPT4oMini,
        O3Mini,
        O1,
        O1Mini,
        GPT4_1,
        GPT4_1Mini,
        GPT4_1Preview,
        GPT4_1MiniPreview,
        GPT4oAudioPreview,
        GPT4oMiniAudioPreview,
        GPT4Turbo,
        GPT4VisionPreview,
        TextEmbedding3Large,
        TextEmbedding3Small,
        TextEmbeddingAda002,
        O3MiniHigh,
        O3MiniMed,
        O3MiniLow
    }

    public class AiConfig
    {
        public AiProvider Provider { get; set; }
        public AiModel Model { get; set; }
        public string AzureEndpoint { get; set; }
        public string GitHubToken { get; set; }
        public string UserAgent { get; set; } = "MyUtils-AIClient";
        public float Temperature { get; set; } = 0.7f;
        public int? MaxTokens { get; set; }
        public string SystemPrompt { get; set; }
        public int TokenBudget { get; set; } = 6000;
        public int MaxHistoryMessages { get; set; } = 24;
        public bool EnableStreaming { get; set; } = true;
        public DeviceCodeCallback DeviceCodeCallback { get; set; }
    }

    public static class AiModelResolver
    {
        public static string Resolve(AiModel model)
        {
            // C# 7.3 compatible if/else chain (no switch expression)
            if (model == AiModel.GPT4o) return "gpt-4o";
            if (model == AiModel.GPT4oMini) return "gpt-4o-mini";
            if (model == AiModel.O3Mini) return "o3-mini";
            if (model == AiModel.O1) return "o1";
            if (model == AiModel.O1Mini) return "o1-mini";
            if (model == AiModel.GPT4_1) return "gpt-4.1";
            if (model == AiModel.GPT4_1Mini) return "gpt-4.1-mini";
            if (model == AiModel.GPT4_1Preview) return "gpt-4.1-preview";
            if (model == AiModel.GPT4_1MiniPreview) return "gpt-4.1-mini-preview";
            if (model == AiModel.GPT4oAudioPreview) return "gpt-4o-audio-preview";
            if (model == AiModel.GPT4oMiniAudioPreview) return "gpt-4o-mini-audio-preview";
            if (model == AiModel.GPT4Turbo) return "gpt-4-turbo";
            if (model == AiModel.GPT4VisionPreview) return "gpt-4-vision-preview";
            if (model == AiModel.TextEmbedding3Large) return "text-embedding-3-large";
            if (model == AiModel.TextEmbedding3Small) return "text-embedding-3-small";
            if (model == AiModel.TextEmbeddingAda002) return "text-embedding-ada-002";
            if (model == AiModel.O3MiniHigh) return "o3-mini-high";
            if (model == AiModel.O3MiniMed) return "o3-mini-medium";
            if (model == AiModel.O3MiniLow) return "o3-mini-low";

            throw new NotSupportedException("Unhandled AiModel " + model);
        }
    }

    public class AiMessage
    {
        public string Role { get; set; }
        public string Content { get; set; }

        public AiMessage() { }
        public AiMessage(string role, string content)
        {
            Role = role;
            Content = content;
        }
    }

    public class AiChatSession
    {
        private readonly List<AiMessage> _messages = new List<AiMessage>();
        public IReadOnlyList<AiMessage> Messages => _messages;
        public int Count => _messages.Count;
        public AiMessage this[int index] => _messages[index];
        public void Add(string role, string content) => _messages.Add(new AiMessage(role, content));
        public void Add(AiMessage m) => _messages.Add(m);
        public void Clear() => _messages.Clear();
        public void RemoveAt(int index)
        {
            if (index >= 0 && index < _messages.Count)
            {
                _messages.RemoveAt(index);
            }
        }

        /// <summary>
        /// Updates or adds the system prompt. If a system message exists, it replaces its content.
        /// Otherwise, it inserts a new system message at the beginning.
        /// </summary>
        public void UpdateSystemPrompt(string systemPrompt)
        {
            if (string.IsNullOrEmpty(systemPrompt)) return;

            // Find existing system message
            var existingSystem = _messages.FirstOrDefault(m => m.Role == "system");
            if (existingSystem != null)
            {
                existingSystem.Content = systemPrompt;
            }
            else
            {
                _messages.Insert(0, new AiMessage("system", systemPrompt));
            }
        }
    }

    public static class AiPromptTemplate
    {
        public static string Render(string template, IDictionary<string, string> values)
        {
            if (string.IsNullOrEmpty(template) || values == null)
            {
                return template;
            }

            foreach (var kv in values)
            {
                template = template.Replace("{{" + kv.Key + "}}", kv.Value ?? "");
            }

            return template;
        }
    }

    public class AiChatClient
    {
        private string _gitHubToken;
        private readonly AiConfig _config;
        private readonly Action<string, bool> _log;
        private readonly HttpClient _httpClient;
        private readonly OpenAIClient _azureOpenAIClient;
        private readonly CopilotClient _copilotClient;
        public AiFunctionRegistry Functions => _functions;
        private readonly AiFunctionRegistry _functions = new AiFunctionRegistry();

        private const int GitHubTokenMinLen = 20;
        private const string GitHubBaseUrl = "https://models.inference.ai.azure.com";
        private const string CopilotProxyBaseUrl = "http://localhost:4141";
        private static string CurrentModelString(AiConfig cfg) => AiModelResolver.Resolve(cfg.Model);

        private AiChatClient(AiConfig config, Action<string, bool> log, HttpClient httpClient, OpenAIClient azureOpenAIClient, CopilotClient copilotClient)
        {
            _config = config;
            _log = log ?? ((s, b) => { });
            _httpClient = httpClient;
            _azureOpenAIClient = azureOpenAIClient;
            _copilotClient = copilotClient;
        }

        public static AiChatClient Create(AiConfig config, Action<string, bool> log = null)
        {
            if (config == null)
            {
                throw new ArgumentNullException(nameof(config));
            }

            HttpClient httpClient = null;
            OpenAIClient azureOpenAIClient = null;
            CopilotClient copilotClient = null;

            if (config.Provider == AiProvider.CopilotDirect)
            {
                // Device code callback should be provided by the UI layer
                // For now, use null which will cause CopilotClient to use its default behavior
                copilotClient = new CopilotClient("individual", log, config.DeviceCodeCallback);
            }
            else if (config.Provider == AiProvider.GitHubModels)
            {
                httpClient = new HttpClient { BaseAddress = new Uri(GitHubBaseUrl) };
            }
            else if (config.Provider == AiProvider.CopilotProxy)
            {
                httpClient = new HttpClient { BaseAddress = new Uri(CopilotProxyBaseUrl) };
            }
            else if (config.Provider == AiProvider.AzureOpenAI)
            {
                if (string.IsNullOrWhiteSpace(config.AzureEndpoint))
                {
                    throw new ArgumentException("AzureEndpoint is required for AzureOpenAI provider.");
                }

                try
                {
                    azureOpenAIClient = new OpenAIClient(new Uri(config.AzureEndpoint), new DefaultAzureCredential(true));
                }
                catch (TypeInitializationException tie) when (
                    tie.InnerException is FileLoadException &&
                    tie.InnerException.Message.IndexOf("Microsoft.Extensions.Logging.Abstractions, Version=8.0.0.0", StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    log?.Invoke("AzureOpenAI disabled: logging abstractions v8 not loadable under .NET Framework.", true);
                    throw;
                }
                catch (FileLoadException fle) when (
                    fle.Message.IndexOf("Microsoft.Extensions.Logging.Abstractions, Version=8.0.0.0", StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    log?.Invoke("AzureOpenAI disabled: logging abstractions v8 mismatch.", true);
                    throw;
                }
                catch (Exception ex)
                {
                    log?.Invoke("AzureOpenAI init failure: " + ex.Message, true);
                    throw;
                }
            }

            return new AiChatClient(config, log, httpClient, azureOpenAIClient, copilotClient);
        }

        public void Init()
        {
            if (_config.Provider == AiProvider.GitHubModels)
            {
                _gitHubToken = _config.GitHubToken ?? ResolveGitHubToken();
                _log?.Invoke("GitHub token resolved.", false);
            }
            else if (_config.Provider == AiProvider.CopilotProxy)
            {
                // CopilotProxy doesn't need a real token, just use "dummy"
                _gitHubToken = _config.GitHubToken ?? "dummy";
                _log?.Invoke("CopilotProxy token set.", false);
            }
            else if (_config.Provider == AiProvider.CopilotDirect)
            {
                if (!string.IsNullOrEmpty(_config.GitHubToken))
                {
                    _copilotClient.SetGitHubToken(_config.GitHubToken);
                }
            }
        }

        public async Task<string> CompleteAsync(IEnumerable<AiMessage> messages, float? temperature = null, CancellationToken ct = default)
        {
            if (messages == null) throw new ArgumentNullException(nameof(messages));
            if (!temperature.HasValue) temperature = _config.Temperature;
            try
            {
                if (_config.Provider == AiProvider.AzureOpenAI)
                {
                    return await ExecuteAzureAsync(messages.ToList(), temperature.Value, ct);
                }
                else if (_config.Provider == AiProvider.CopilotDirect)
                {
                    return await ExecuteCopilotDirectAsync(messages.ToList(), temperature.Value, ct);
                }
                else if (_config.Provider == AiProvider.GitHubModels || _config.Provider == AiProvider.CopilotProxy)
                {
                    return await ExecuteGitHubAsync(messages.ToList(), temperature.Value, ct);
                }
                else
                {
                    throw new NotSupportedException($"Provider {_config.Provider} not supported.");
                }
            }
            catch (Exception ex)
            {
                _log?.Invoke("Provider failed: " + ex.Message, true);
                throw;
            }
        }

        public async Task<string> RunWithHistoryAsync(AiChatSession session, string userPrompt, float? temperature = null, CancellationToken ct = default)
        {
            if (session == null)
            {
                throw new ArgumentNullException(nameof(session));
            }

            if (userPrompt == null)
            {
                userPrompt = "";
            }

            if (!string.IsNullOrEmpty(_config.SystemPrompt) && !session.Messages.Any(m => m.Role == "system"))
            {
                session.Add("system", _config.SystemPrompt);
            }

            session.Add("user", userPrompt);

            TrimHistory(session);

            var reply = await CompleteAsync(session.Messages, temperature, ct);

            session.Add("assistant", reply);

            if (_functions.Count > 0 && reply.StartsWith("CALL:", StringComparison.OrdinalIgnoreCase))
            {
                try
                {
                    var fnResult = await AiFunctionDispatcher.TryExecuteAsync(_functions, reply, ct);
                    if (fnResult.Executed)
                    {
                        session.Add("assistant", fnResult.Result ?? "");
                        return fnResult.Result ?? "";
                    }
                }
                catch (Exception ex)
                {
                    _log?.Invoke("Function execution error: " + ex.Message, true);
                }
            }

            return reply;
        }

        public async Task<List<string>> GetModelsAsync(CancellationToken ct = default)
        {
            if (_config.Provider == AiProvider.CopilotDirect)
            {
                if (_copilotClient == null)
                {
                    throw new InvalidOperationException("CopilotClient not initialized.");
                }
                
                // Ensure GitHub token is available (load from storage or authenticate)
                await _copilotClient.EnsureGitHubTokenAsync(ct);
                return await _copilotClient.GetModelsAsync(ct);
            }
            else if (_config.Provider == AiProvider.GitHubModels || _config.Provider == AiProvider.CopilotProxy)
            {
                // For GitHub Models and CopilotProxy, return a default list
                return new List<string>
                {
                    "gpt-4o",
                    "gpt-4o-mini",
                    "o1",
                    "o1-mini",
                    "gpt-4-turbo"
                };
            }
            else if (_config.Provider == AiProvider.AzureOpenAI)
            {
                // For Azure OpenAI, return the available models
                return new List<string>
                {
                    "gpt-4o",
                    "gpt-4o-mini",
                    "gpt-4-turbo",
                    "gpt-35-turbo"
                };
            }
            else
            {
                throw new NotSupportedException($"Provider {_config.Provider} not supported for GetModelsAsync.");
            }
        }

        public async Task RunStreamingSimpleAsync(string systemPrompt, string userPrompt, Action<string, bool> onChunk, float? temperature = null, CancellationToken ct = default)
        {
            if (onChunk == null) throw new ArgumentNullException(nameof(onChunk));
            if (!_config.EnableStreaming)
            {
                var singleMessages = new List<AiMessage>
                {
                    new AiMessage("system", systemPrompt),
                    new AiMessage("user", userPrompt)
                };
                var full = await CompleteAsync(singleMessages, temperature, ct);
                onChunk(full, true);
                return;
            }

            var messages = new List<AiMessage>
            {
                new AiMessage("system", systemPrompt),
                new AiMessage("user", userPrompt)
            };

            if (_config.Provider == AiProvider.AzureOpenAI)
            {
                var result = await ExecuteAzureAsync(messages, temperature ?? _config.Temperature, ct);
                var lines = result.Split(new[] { Environment.NewLine }, StringSplitOptions.RemoveEmptyEntries);
                for (int i = 0; i < lines.Length; i++)
                    onChunk(lines[i] + (i < lines.Length - 1 ? Environment.NewLine : ""), i == lines.Length - 1);
            }
            else if (_config.Provider == AiProvider.CopilotDirect)
            {
                var full = await ExecuteCopilotDirectAsync(messages, temperature ?? _config.Temperature, ct);
                var segments = full.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
                var sb = new StringBuilder();
                for (int i = 0; i < segments.Length; i++)
                {
                    sb.Append(segments[i]).Append(' ');
                    if (i % 20 == 0 && i != 0 && i < segments.Length - 1)
                        onChunk(sb.ToString(), false);
                }
                onChunk(sb.ToString(), true);
            }
            else if (_config.Provider == AiProvider.GitHubModels || _config.Provider == AiProvider.CopilotProxy)
            {
                var full = await ExecuteGitHubAsync(messages, temperature ?? _config.Temperature, ct);
                var segments = full.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
                var sb = new StringBuilder();
                for (int i = 0; i < segments.Length; i++)
                {
                    sb.Append(segments[i]).Append(' ');
                    if (i % 20 == 0 && i != 0 && i < segments.Length - 1)
                        onChunk(sb.ToString(), false);
                }
                onChunk(sb.ToString(), true);
            }
        }

        private void TrimHistory(AiChatSession session)
        {
            while (session.Count > _config.MaxHistoryMessages)
            {
                int idx = -1;
                for (int i = 0; i < session.Count; i++)
                {
                    if (session[i].Role != "system")
                    {
                        idx = i;
                        break;
                    }
                }
                if (idx < 0) break;
                session.RemoveAt(idx);
            }

            int TotalTokens()
            {
                int t = 0;
                for (int i = 0; i < session.Count; i++)
                    t += EstimateTokens(session[i].Content);
                return t;
            }

            int total = TotalTokens();
            if (total <= _config.TokenBudget) return;

            for (int i = 0; i < session.Count && total > _config.TokenBudget; i++)
            {
                var msg = session[i];
                if (msg.Role == "system") continue;
                if (msg.Content.Length > 400)
                {
                    msg.Content = msg.Content.Substring(0, 300) + "...(trimmed)";
                    total = TotalTokens();
                }
                else
                {
                    session.RemoveAt(i);
                    total = TotalTokens();
                    i--;
                }
            }
        }

        private async Task<string> ExecuteAzureAsync(List<AiMessage> messages, float temperature, CancellationToken ct)
        {
            if (_azureOpenAIClient == null)
            {
                throw new InvalidOperationException("Azure OpenAIClient not initialized.");
            }

            var chatCompletionsOptions = new ChatCompletionsOptions()
            {
                DeploymentName = CurrentModelString(_config),
                Temperature = temperature,
                MaxTokens = _config.MaxTokens
            };

            foreach (var m in messages)
            {
                if (m.Role == "system")
                {
                    chatCompletionsOptions.Messages.Add(new ChatRequestSystemMessage(m.Content));
                }
                else if (m.Role == "user")
                {
                    chatCompletionsOptions.Messages.Add(new ChatRequestUserMessage(m.Content));
                }
                else if (m.Role == "assistant")
                {
                    chatCompletionsOptions.Messages.Add(new ChatRequestAssistantMessage(m.Content));
                }
            }

            var response = await _azureOpenAIClient.GetChatCompletionsAsync(chatCompletionsOptions, ct);
            
            return response.Value.Choices.First().Message.Content;
        }

        private async Task<string> ExecuteGitHubAsync(List<AiMessage> messages, float temperature, CancellationToken ct, string modelOverride = null)
        {
            if (_httpClient == null) throw new InvalidOperationException("GitHub HttpClient not initialized.");
            if (string.IsNullOrWhiteSpace(_gitHubToken))
                throw new InvalidOperationException("GitHub token not resolved. Call Init() first.");

            var payload = new GitHubChatRequest
            {
                model = modelOverride ?? CurrentModelString(_config),
                messages = messages.Select(m => new GitHubChatMessage { role = m.Role, content = m.Content }).ToList(),
                temperature = temperature,
                max_tokens = _config.MaxTokens
            };

            var json = JsonSerializer.Serialize(payload, new JsonSerializerOptions
            {
                DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
            });

            using (var req = new HttpRequestMessage(HttpMethod.Post, "/chat/completions"))
            {
                req.Headers.Add("Authorization", $"Bearer {_gitHubToken}");
                req.Headers.Add("Accept", "application/json");
                req.Headers.Add("User-Agent", _config.UserAgent);
                req.Headers.Add("X-GitHub-Api-Version", "2023-11-08");
                req.Content = new StringContent(json, Encoding.UTF8, "application/json");

                using (var resp = await _httpClient.SendAsync(req, ct))
                {
                    var respContent = await resp.Content.ReadAsStringAsync();
                    if (!resp.IsSuccessStatusCode)
                    {
                        throw new Exception($"GitHub Models status {(int)resp.StatusCode} {resp.StatusCode}: {respContent}");
                    }

                    using (var doc = JsonDocument.Parse(respContent))
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
                        if (doc.RootElement.TryGetProperty("output_text", out var outTxt))
                        {
                            return outTxt.GetString() ?? string.Empty;
                        }
                    }
                    return respContent;
                }
            }
        }

        private string ResolveGitHubToken()
        {
            try
            {
                var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
                var paths = new[]
                {
                    Path.Combine(home, ".gh_token"),
                    ".gh_token"
                };

                foreach (var p in paths)
                {
                    if (File.Exists(p))
                    {
                        var fileTok = File.ReadAllText(p).Trim();
                        if (IsValidToken(fileTok))
                        {
                            _log?.Invoke("GitHub token loaded from file.", false);
                            return fileTok;
                        }
                    }
                }
            }
            catch { }

            try
            {
                var psi = new ProcessStartInfo
                {
                    FileName = "gh",
                    Arguments = "auth token",
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    CreateNoWindow = true
                };
                using (var p = Process.Start(psi))
                {
                    if (p == null) throw new Exception("Failed to start gh process.");
                    var output = p.StandardOutput.ReadToEnd().Trim();
                    p.WaitForExit(3000);
                    if (!IsValidToken(output))
                        throw new Exception("gh CLI returned invalid token.");
                    return output;
                }
            }
            catch (Exception ex)
            {
                throw new Exception("Failed to resolve GitHub token (env/file/gh). " + ex.Message);
            }
        }

        private bool IsValidToken(string tok) => !string.IsNullOrWhiteSpace(tok) && tok.Length >= GitHubTokenMinLen;

        private async Task<string> ExecuteCopilotDirectAsync(List<AiMessage> messages, float temperature, CancellationToken ct)
        {
            if (_copilotClient == null)
            {
                throw new InvalidOperationException("CopilotClient not initialized.");
            }

            // Ensure GitHub token is available (load from storage or authenticate)
            await _copilotClient.EnsureGitHubTokenAsync(ct);

            var copilotMessages = messages.Select(m => new CopilotMessage(m.Role, m.Content)).ToList();
            return await _copilotClient.CreateChatCompletionAsync(
                copilotMessages,
                CurrentModelString(_config),
                temperature,
                _config.MaxTokens,
                ct);
        }

        /// <summary>
        /// Executes a vision completion using the CopilotDirect provider.
        /// </summary>
        public async Task<string> VisionCompleteAsync(
            string imageBase64,
            string imageMimeType,
            string systemPrompt,
            string userPrompt,
            float temperature = 0.3f,
            CancellationToken ct = default)
        {
            if (_config.Provider != AiProvider.CopilotDirect)
            {
                throw new InvalidOperationException("Vision features require CopilotDirect provider.");
            }

            if (_copilotClient == null)
            {
                throw new InvalidOperationException("CopilotClient not initialized.");
            }

            await _copilotClient.EnsureGitHubTokenAsync(ct);

            return await _copilotClient.CreateVisionCompletionAsync(
                imageBase64,
                imageMimeType,
                systemPrompt,
                userPrompt,
                "gpt-4o",  // Vision requires gpt-4o model
                temperature,
                ct);
        }

        public static int EstimateTokens(string text)
        {
            if (string.IsNullOrEmpty(text)) return 0;
            return Math.Max(1, text.Length / 4);
        }
    }

    internal class GitHubChatRequest
    {
        public string model { get; set; }
        public List<GitHubChatMessage> messages { get; set; }
        public float? temperature { get; set; }
        public int? max_tokens { get; set; }
    }

    internal class GitHubChatMessage
    {
        public string role { get; set; }
        public string content { get; set; }
    }

    #region Function Calling

    public class AiFunctionDescriptor
    {
        public string Name { get; }
        public string Description { get; }
        public Func<JsonElement, CancellationToken, Task<string>> Handler { get; }
        public AiFunctionDescriptor(string name, string description, Func<JsonElement, CancellationToken, Task<string>> handler)
        {
            Name = name ?? throw new ArgumentNullException(nameof(name));
            Description = description ?? "";
            Handler = handler ?? throw new ArgumentNullException(nameof(handler));
        }
    }

    public class AiFunctionRegistry
    {
        private readonly Dictionary<string, AiFunctionDescriptor> _map = new Dictionary<string, AiFunctionDescriptor>(StringComparer.OrdinalIgnoreCase);
        public int Count => _map.Count;
        public void Register(AiFunctionDescriptor descriptor)
        {
            if (descriptor == null) throw new ArgumentNullException(nameof(descriptor));
            _map[descriptor.Name] = descriptor;
        }
        public bool TryGet(string name, out AiFunctionDescriptor descriptor) => _map.TryGetValue(name, out descriptor);
        public IEnumerable<AiFunctionDescriptor> All => _map.Values;
    }

    public static class AiFunctionDispatcher
    {
        // Pattern: CALL:FunctionName{ ...json... }
        public static async Task<(bool Executed, string Result)> TryExecuteAsync(AiFunctionRegistry registry, string assistantMessage, CancellationToken ct)
        {
            if (string.IsNullOrWhiteSpace(assistantMessage) || registry == null) return (false, null);
            const string prefix = "CALL:";
            if (!assistantMessage.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) return (false, null);

            int braceIdx = assistantMessage.IndexOf('{');
            if (braceIdx < 0) return (false, null);
            string header = assistantMessage.Substring(prefix.Length, braceIdx - prefix.Length).Trim();
            string jsonPart = assistantMessage.Substring(braceIdx).Trim();

            if (!registry.TryGet(header, out var fn))
                return (false, null);

            JsonElement args;
            try
            {
                using (var doc = JsonDocument.Parse(jsonPart))
                {
                    args = doc.RootElement.Clone();
                }
            }
            catch
            {
                using (var doc = JsonDocument.Parse("{\"raw\":\"parse_error\"}"))
                {
                    args = doc.RootElement.Clone();
                }
            }

            var result = await fn.Handler(args, ct);
            return (true, result);
        }
    }

    #endregion

    #region Session Persistence

    public static class AiChatSessionExtensions
    {
        public static string Serialize(this AiChatSession session)
        {
            var arr = session.Messages.Select(m => new { m.Role, m.Content }).ToArray();
            return JsonSerializer.Serialize(arr);
        }

        public static AiChatSession DeserializeSession(string json)
        {
            var s = new AiChatSession();
            if (string.IsNullOrWhiteSpace(json)) return s;
            try
            {
                var arr = JsonSerializer.Deserialize<List<AiMessage>>(json);
                if (arr != null)
                    foreach (var m in arr) s.Add(m);
            }
            catch { }
            return s;
        }
    }

    #endregion

    #region Embeddings

    public class AiEmbeddingsClient
    {
        private readonly AiConfig _config;

        private readonly OpenAIClient _azureClient;
        private readonly HttpClient _httpClient;
        private readonly string _gitHubToken;

        public AiEmbeddingsClient(AiConfig config)
        {
            _config = config ?? throw new ArgumentNullException(nameof(config));
            if (config.Provider == AiProvider.AzureOpenAI)
            {
                if (string.IsNullOrWhiteSpace(config.AzureEndpoint))
                    throw new ArgumentException("AzureEndpoint required for embeddings.");
                _azureClient = new OpenAIClient(new Uri(config.AzureEndpoint), new DefaultAzureCredential(true));
            }
            else
            {
                _httpClient = new HttpClient { BaseAddress = new Uri("https://models.inference.ai.azure.com") };
                _gitHubToken = config.GitHubToken ?? Environment.GetEnvironmentVariable("GITHUB_TOKEN");
                if (string.IsNullOrWhiteSpace(_gitHubToken))
                    throw new InvalidOperationException("GitHub token required for embeddings.");
            }
        }

        public async Task<IReadOnlyList<float[]>> GetEmbeddingsAsync(IReadOnlyList<string> inputs, CancellationToken ct = default)
        {
            if (inputs == null || inputs.Count == 0) return Array.Empty<float[]>();

            if (_config.Provider == AiProvider.AzureOpenAI)
            {
                throw new NotSupportedException("Azure embeddings not supported with current Azure.AI.OpenAI SDK version (2.1.0).");
            }
            else
            {
                var payload = new
                {
                    model = AiModelResolver.Resolve(_config.Model),
                    input = inputs
                };
                var json = JsonSerializer.Serialize(payload);
                var req = new HttpRequestMessage(HttpMethod.Post, "/embeddings");
                req.Headers.Add("Authorization", $"Bearer {_gitHubToken}");
                req.Headers.Add("Accept", "application/json");
                req.Headers.Add("User-Agent", _config.UserAgent);
                req.Content = new StringContent(json, Encoding.UTF8, "application/json");
                var resp = await _httpClient.SendAsync(req, ct);
                var respContent = await resp.Content.ReadAsStringAsync();
                resp.EnsureSuccessStatusCode();
                List<float[]> list;
                using (var doc = JsonDocument.Parse(respContent))
                {
                    list = new List<float[]>();
                    if (doc.RootElement.TryGetProperty("data", out var dataEl) && dataEl.ValueKind == JsonValueKind.Array)
                    {
                        foreach (var item in dataEl.EnumerateArray())
                        {
                            if (item.TryGetProperty("embedding", out var emb) && emb.ValueKind == JsonValueKind.Array)
                            {
                                list.Add(emb.EnumerateArray().Select(f => f.GetSingle()).ToArray());
                            }
                        }
                    }
                }
                return list;
            }
        }
    }

    #endregion

    #region VectorStoreAndUtilities

    public class AiVectorStore
    {
        private readonly List<VectorItem> _items = new List<VectorItem>();
        private int _dimension = -1;
        public int Count => _items.Count;

        public class VectorItem
        {
            public string Id { get; set; }
            public float[] Embedding { get; set; }
            public string Text { get; set; }
            public object Meta { get; set; }
        }

        public void Add(string id, float[] embedding, string text, object meta = null)
        {
            if (embedding == null) throw new ArgumentNullException(nameof(embedding));
            if (string.IsNullOrWhiteSpace(id)) throw new ArgumentNullException(nameof(id));
            if (_dimension < 0) _dimension = embedding.Length;
            if (embedding.Length != _dimension) throw new ArgumentException("Embedding dimension mismatch.");
            _items.Add(new VectorItem { Id = id, Embedding = embedding, Text = text ?? "", Meta = meta });
        }

        public void Clear()
        {
            _items.Clear();
            _dimension = -1;
        }

        public IReadOnlyList<VectorItem> All() => _items;

        public IReadOnlyList<VectorItem> Query(float[] queryEmbedding, int topK = 5)
        {
            if (queryEmbedding == null) throw new ArgumentNullException(nameof(queryEmbedding));
            if (_dimension < 0 || _items.Count == 0) return Array.Empty<VectorItem>();
            if (queryEmbedding.Length != _dimension) throw new ArgumentException("Query embedding dimension mismatch.");
            if (topK <= 0) topK = 1;

            var scored = new List<Tuple<VectorItem, double>>(_items.Count);
            foreach (var itm in _items)
            {
                double score = Cosine(queryEmbedding, itm.Embedding);
                scored.Add(Tuple.Create(itm, score));
            }
            return scored.OrderByDescending(t => t.Item2).Take(topK).Select(t => t.Item1).ToList();
        }

        private static double Cosine(float[] a, float[] b)
        {
            double dot = 0, magA = 0, magB = 0;
            for (int i = 0; i < a.Length; i++)
            {
                dot += a[i] * b[i];
                magA += a[i] * a[i];
                magB += b[i] * b[i];
            }
            if (magA == 0 || magB == 0) return 0;
            return dot / (Math.Sqrt(magA) * Math.Sqrt(magB));
        }
    }

    public static class AiUtilities
    {
        public static void RegisterBuiltinFunctions(AiChatClient client, AiVectorStore vectorStore = null)
        {
            if (client == null) throw new ArgumentNullException(nameof(client));

            client.Functions.Register(new AiFunctionDescriptor(
                "Echo",
                "Echo back a 'text' field.",
                async (json, ct) =>
                {
                    string txt = json.TryGetProperty("text", out var p) ? p.GetString() : "";
                    await Task.Yield();
                    return "EchoResult: " + txt;
                }));

            client.Functions.Register(new AiFunctionDescriptor(
                "Now",
                "Return current UTC timestamp.",
                async (json, ct) =>
                {
                    await Task.Yield();
                    return DateTime.UtcNow.ToString("o");
                }));

            client.Functions.Register(new AiFunctionDescriptor(
                "Sum",
                "Sum an array of numbers in field 'values'.",
                async (json, ct) =>
                {
                    double sum = 0;
                    if (json.TryGetProperty("values", out var arr) && arr.ValueKind == JsonValueKind.Array)
                    {
                        foreach (var v in arr.EnumerateArray())
                            if (v.ValueKind == JsonValueKind.Number) sum += v.GetDouble();
                    }
                    await Task.Yield();
                    return "SumResult: " + sum;
                }));

            if (vectorStore != null)
            {
                client.Functions.Register(new AiFunctionDescriptor(
                    "VectorQuery",
                    "Query vector store. Args: {\"embedding\":[...],\"topK\":5}",
                    async (json, ct) =>
                    {
                        if (!json.TryGetProperty("embedding", out var embEl) || embEl.ValueKind != JsonValueKind.Array)
                            return "VectorQuery error: missing 'embedding' array.";
                        var embedding = embEl.EnumerateArray().Select(e => e.ValueKind == JsonValueKind.Number ? e.GetSingle() : 0f).ToArray();
                        int topK = json.TryGetProperty("topK", out var kEl) && kEl.ValueKind == JsonValueKind.Number ? kEl.GetInt32() : 5;
                        var matches = vectorStore.Query(embedding, topK);
                        var arr = matches.Select(m => new { m.Id, m.Text }).ToArray();
                        await Task.Yield();
                        return "VectorQueryResult: " + JsonSerializer.Serialize(arr);
                    }));
            }
        }

        public static string BuildFunctionCatalogPrompt(AiFunctionRegistry registry)
        {
            if (registry == null) return "";
            var sb = new StringBuilder();
            sb.AppendLine("You can call functions by emitting: CALL:FunctionName{jsonArgs}");
            sb.AppendLine("Available Functions:");
            foreach (var f in registry.All)
                sb.Append("- ").Append(f.Name).Append(": ").Append(f.Description).AppendLine();
            sb.AppendLine("Return ONLY a normal assistant reply unless you truly need tool invocation.");
            return sb.ToString();
        }

        public static void EnsureSystemFunctionCatalog(AiChatSession session, AiFunctionRegistry registry)
        {
            if (session == null || registry == null) return;
            if (!session.Messages.Any(m => m.Role == "system" &&
                                           m.Content.IndexOf("Available Functions:", StringComparison.OrdinalIgnoreCase) >= 0))
            {
                session.Add("system", BuildFunctionCatalogPrompt(registry));
            }
        }

        public static async Task IndexTextsAsync(AiEmbeddingsClient embClient, AiVectorStore store, IReadOnlyList<string> texts, CancellationToken ct = default)
        {
            if (embClient == null) throw new ArgumentNullException(nameof(embClient));
            if (store == null) throw new ArgumentNullException(nameof(store));
            if (texts == null || texts.Count == 0) return;

            var embeddings = await embClient.GetEmbeddingsAsync(texts, ct);
            if (embeddings.Count != texts.Count) throw new Exception("Embeddings count mismatch.");
            for (int i = 0; i < texts.Count; i++)
                store.Add("doc_" + i, embeddings[i], texts[i]);
        }
    }
    #endregion
}
