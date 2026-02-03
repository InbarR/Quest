using System.Threading.Tasks;

namespace MyUtils.AI
{
    public enum QueryLanguage
    {
        KQL,
        WIQL
    }

    public class QueryTitleGenerator
    {
        private readonly AIHelper _aiHelper;

        public QueryTitleGenerator(AIHelper aiHelper)
        {
            _aiHelper = aiHelper;
        }

        public async Task<string> GenerateTitle(string query, QueryLanguage language)
        {
            if (_aiHelper == null)
            {
                return null;
            }

            var systemPrompt = GetSystemPrompt(language);
            var userPrompt = $"{language} Query:\n{query}";

            var response = await _aiHelper.RunPrompt(systemPrompt, userPrompt);

            if (response.IsEmpty())
            {
                return null;
            }

            return response?.Trim()?.Replace("\"", "")?.Replace("'", "") ?? null;
        }

        private string GetSystemPrompt(QueryLanguage language)
        {
            switch (language)
            {
                case QueryLanguage.KQL:
                    return @"
You are an expert in Kusto Query Language (KQL).
Given a KQL query, generate a very short, descriptive title (3-6 words max) that summarizes what the query is looking for.

Rules:
- Keep it under 6 words
- Focus on the main purpose/filter
- Use business-friendly language
- Examples: 'Failed Sign-ins Last 24h', 'Device CPU Usage', 'Top Talkers by Sent Bytes'
- Don't include technical KQL syntax like 'project', 'where', 'summarize'
- Make it human-readable and meaningful
- Use only alphanumeric characters, spaces, and hyphens

Only return the title, nothing else.";
                case QueryLanguage.WIQL:
                    return @"
You are an expert in Work Item Query Language (WIQL).
Given a WIQL query, generate a very short, descriptive title (3-6 words max) that summarizes what the query is looking for.

Rules:
- Keep it under 6 words
- Focus on the main purpose/filter
- Use business-friendly language
- Examples: 'My Active Bugs', 'High Priority Features', 'Recently Closed Tasks'
- Don't include technical WIQL syntax like 'SELECT', 'WHERE', 'ORDER BY'
- Make it human-readable and meaningful
- Use only alphanumeric characters, spaces, and hyphens

Only return the title, nothing else.";
                default:
                    return "Generate a short, descriptive title (3-6 words) for the following query.";
            }
        }
    }
}