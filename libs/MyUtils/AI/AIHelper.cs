using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;

namespace MyUtils.AI
{
    public class AIHelper
    {
        public AiConfig Config { get; }
        private readonly AiChatClient _chatClient;
        private readonly Action<string, bool> _log;

        public AIHelper(AiConfig config, Action<string, bool> log = null)
        {
            Config = config ?? throw new ArgumentNullException(nameof(config));
            _log = log ?? ((s, e) => { });

            _chatClient = AiChatClient.Create(Config, _log);

            if (Config.Provider == AiProvider.GitHubModels || Config.Provider == AiProvider.CopilotProxy || Config.Provider == AiProvider.CopilotDirect)
            {
                _chatClient.Init();
            }
        }

        public Task<string> RunPrompt(string systemPrompt, string userPrompt, float? temperature = null, CancellationToken ct = default)
        {
            systemPrompt = systemPrompt ?? string.Empty;
            userPrompt = userPrompt ?? string.Empty;

            var msgs = new[]
            {
                new AiMessage("system", systemPrompt),
                new AiMessage("user", userPrompt)
            };

            return _chatClient.CompleteAsync(msgs, temperature, ct);
        }
        public Task<string> RunWithHistoryAsync(AiChatSession session, string userPrompt, float? temperature = null, CancellationToken ct = default)
        {
            return _chatClient.RunWithHistoryAsync(session, userPrompt, temperature, ct);
        }

        public async Task<List<string>> GetAvailableModelsAsync(CancellationToken ct = default)
        {
            try
            {
                return await _chatClient.GetModelsAsync(ct);
            }
            catch (Exception ex)
            {
                _log($"Failed to get models: {ex.Message}", true);
                throw;
            }
        }
        public async Task<string> GenerateTitle(string query)
        {
            var systemPrompt = @"Generate a short title (2-4 words) for a database query. Rules:
1. Start with the main table/entity name if identifiable
2. Add the action or filter if meaningful (e.g., 'Errors', 'Recent', 'ByUser')
3. Use PascalCase without spaces
4. Examples: 'CreateProcessEvents', 'RecentLogins', 'ErrorsByRegion', 'UserActivity'
5. Do not use generic words like 'Query', 'Results', 'Fetch', 'Get', 'Single', 'Record'
6. Do not include quotes or markdown
Output only the title, nothing else.";
            var userPrompt = $"Query:\n{query}";

            var title = await RunPrompt(systemPrompt, userPrompt, 0.3f);
            return title?.Trim() ?? "Result";
        }

        /// <summary>
        /// Extracts information from an image using AI vision capabilities.
        /// Requires CopilotDirect provider for vision support.
        /// </summary>
        public async Task<string> ExtractFromImageAsync(
            string imageBase64,
            string imageMimeType,
            string systemPrompt,
            string userPrompt = "Extract the information from this image.",
            float temperature = 0.3f,
            CancellationToken ct = default)
        {
            // Vision requires CopilotDirect provider
            if (Config.Provider != AiProvider.CopilotDirect)
            {
                throw new InvalidOperationException("Vision features require CopilotDirect provider");
            }

            return await _chatClient.VisionCompleteAsync(imageBase64, imageMimeType, systemPrompt, userPrompt, temperature, ct);
        }
    }
}
