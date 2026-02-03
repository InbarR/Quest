# Quest

A powerful VS Code extension for querying multiple data sources with AI assistance.

## Features

### Multi-Source Query Support

- **Azure Data Explorer (Kusto/KQL)** - Query your Kusto clusters with full IntelliSense support
- **Azure DevOps (WIQL)** - Query work items across your Azure DevOps projects
- **Outlook (OQL)** - Query your local Outlook mail, calendar, contacts, and tasks using a KQL-like syntax

### AI-Powered Assistance

- Generate queries from natural language descriptions
- Explain complex queries in plain English
- Get intelligent query suggestions and improvements
- Powered by GitHub Copilot, Azure OpenAI, or GitHub Models

### Rich Query Experience

- Syntax highlighting for KQL, WIQL, and OQL
- IntelliSense with schema-aware autocomplete
- Query history with easy recall
- Save favorite queries for quick access
- Export results to CSV

### Results Viewer

- Tabbed results interface for multiple queries
- Row highlighting and selection
- Multi-select with Ctrl+Click and Shift+Click
- Copy cells, rows, or entire results
- Double-click to open items (ADO work items, Outlook emails)

## Quick Start

1. Install the extension
2. Open the Quest sidebar (click the Quest icon in the activity bar)
3. Add a data source:
   - For Kusto: Add your cluster URL
   - For ADO: Add your organization URL
   - For Outlook: No configuration needed (uses local COM)
4. Create a new query file (.kql, .wiql, or .oql)
5. Press F5 or click Run to execute your query

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `F5` | Run Query |
| `Ctrl+Enter` | Run Query |
| `Shift+F5` | Cancel Query |
| `Ctrl+Shift+S` | Save as Favorite |
| `Ctrl+Shift+A` | Open AI Chat |

## Query Languages

### KQL (Kusto Query Language)

```kql
StormEvents
| where StartTime > ago(7d)
| summarize count() by State
| top 10 by count_
```

### WIQL (Work Item Query Language)

```wiql
SELECT [System.Id], [System.Title], [System.State]
FROM WorkItems
WHERE [System.AssignedTo] = @Me
AND [System.State] <> 'Closed'
ORDER BY [System.ChangedDate] DESC
```

### OQL (Outlook Query Language)

```oql
Inbox
| where Subject contains "meeting"
| where ReceivedTime > ago(7d)
| take 100
```

## Configuration

| Setting | Description | Default |
|---------|-------------|---------|
| `queryStudio.queryTimeout` | Query timeout in seconds | 300 |
| `queryStudio.maxResults` | Maximum rows to return | 10000 |
| `queryStudio.autoSaveHistory` | Auto-save executed queries | true |
| `queryStudio.ai.enabled` | Enable AI features | true |
| `queryStudio.ai.provider` | AI provider (github, azure, copilot) | github |
| `queryStudio.ai.model` | AI model to use | gpt-4o-mini |

## Requirements

- VS Code 1.85.0 or higher
- For Kusto: Azure AD authentication
- For ADO: Azure DevOps PAT or Azure AD
- For Outlook: Windows with Outlook installed (COM interop)

## Known Issues

- Outlook queries are only supported on Windows
- Large result sets may impact performance

## Release Notes

See [CHANGELOG.md](CHANGELOG.md) for release notes.

## License

MIT License - see [LICENSE](LICENSE) for details.
