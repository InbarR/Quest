# Quest - Multi-Data-Source Query Studio for VS Code

A powerful VS Code extension for querying multiple data sources with AI assistance. Query Azure Data Explorer (KQL), Azure DevOps work items (WIQL), and local Outlook (OQL) from a unified interface.

![VS Code](https://img.shields.io/badge/VS%20Code-1.85+-blue.svg)
![.NET](https://img.shields.io/badge/.NET-8.0-purple.svg)
![License](https://img.shields.io/badge/License-MIT-green.svg)

## Features

### Multi-Source Query Support

| Source | Language | Description |
|--------|----------|-------------|
| **Azure Data Explorer** | KQL | Query Kusto clusters with full IntelliSense and schema explorer |
| **Azure DevOps** | WIQL | Query work items with preview panel showing description/repro steps |
| **Outlook** | OQL | Query local Outlook mail, calendar, contacts using KQL-like syntax |

### AI-Powered Query Assistance

- Generate queries from natural language descriptions
- Explain complex queries in plain English
- Get intelligent query suggestions and improvements
- Supports GitHub Copilot, Azure OpenAI, and GitHub Models

### Rich Results Viewer

- Tabbed interface for multiple concurrent queries
- Real-time filtering and highlighting
- Column visibility toggle and reordering
- Row selection (Ctrl+Click, Shift+Click for multi-select)
- Export to CSV/JSON
- Color-coded rows based on custom rules
- Preview panel for ADO work items (renders HTML description/repro steps)
- Preview panel for Kusto row details
- Double-click to open items in browser/Outlook

### Developer Experience

- Syntax highlighting for KQL, WIQL, and OQL
- IntelliSense with schema-aware autocomplete
- Hover documentation for functions and operators
- Query history with search
- Favorites management
- Keyboard shortcuts for common actions

## Architecture

Quest uses a two-component architecture:

```
┌─────────────────────────────────────────────────────────────┐
│                    VS Code Extension                         │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │  Languages  │  │  Providers  │  │      Commands       │  │
│  │ KQL/WIQL/OQL│  │Results/Chat │  │ Query/Cluster/AI    │  │
│  └─────────────┘  └─────────────┘  └─────────────────────┘  │
│                           │                                  │
│                    JSON-RPC (stdin/stdout)                   │
│                           │                                  │
└───────────────────────────┼─────────────────────────────────┘
                            │
┌───────────────────────────┼─────────────────────────────────┐
│                    .NET 8 Sidecar Server                     │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │  Handlers   │  │  Services   │  │    Data Sources     │  │
│  │Query/Schema │  │Outlook/ADO  │  │ Kusto/ADO/Outlook   │  │
│  └─────────────┘  └─────────────┘  └─────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### Extension (`/extension`)

TypeScript-based VS Code extension providing:
- Language support (syntax highlighting, completion, hover)
- WebView providers (results viewer, AI chat, favorites, history)
- Command handlers (run query, add cluster, AI interactions)
- Sidecar process management

### Server (`/server`)

.NET 8 console application providing:
- JSON-RPC request handlers via StreamJsonRpc
- Kusto query execution with Azure.Identity authentication
- ADO work item queries via Azure DevOps REST API
- Outlook COM interop for local mail/calendar queries
- Schema caching and management

## Getting Started

### Prerequisites

- [VS Code](https://code.visualstudio.com/) 1.85+
- [.NET 8 SDK](https://dotnet.microsoft.com/download/dotnet/8.0)
- [Node.js](https://nodejs.org/) LTS (18+)
- Windows (required for Outlook queries)

### Building from Source

1. **Clone the repository**
   ```bash
   git clone https://github.com/InbarR/Quest.git
   cd Quest
   ```

2. **Build the server**
   ```bash
   cd server
   dotnet build
   dotnet publish -c Release -r win-x64 --self-contained true -o ../extension/server
   ```

3. **Build the extension**
   ```bash
   cd extension
   npm install
   npm run compile
   ```

4. **Package the extension**
   ```bash
   npm run package
   # Creates quest-x.x.x.vsix
   ```

5. **Install in VS Code**
   ```bash
   code --install-extension quest-*.vsix
   ```

### Development

1. Open the project in VS Code
2. Press `F5` to launch Extension Development Host
3. Make changes and reload (`Ctrl+R` in dev host)

## Usage

### Adding Data Sources

**Kusto Cluster:**
1. Click the `+` button in the Data Sources panel
2. Enter cluster URL (e.g., `https://help.kusto.windows.net`)
3. Select a database
4. Authenticate via Azure AD

**Azure DevOps:**
1. Switch to ADO mode using the mode selector
2. Add organization URL (e.g., `https://dev.azure.com/myorg`)
3. Provide project name
4. Authenticate via Azure AD or PAT

**Outlook:**
1. Switch to Outlook mode
2. No configuration needed - uses local Outlook installation

### Writing Queries

Create a new file with the appropriate extension:

**KQL (.kql)**
```kql
StormEvents
| where StartTime > ago(7d)
| summarize Count=count() by State
| top 10 by Count
```

**WIQL (.wiql)**
```sql
SELECT [System.Id], [System.Title], [System.State]
FROM WorkItems
WHERE [System.AssignedTo] = @Me
  AND [System.State] <> 'Closed'
ORDER BY [System.ChangedDate] DESC
```

**OQL (.oql)**
```
Inbox
| where Subject contains "meeting"
| where ReceivedTime > ago(7d)
| project Subject, From, ReceivedTime
| take 50
```

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `F5` | Run Query |
| `Ctrl+Enter` | Run Query |
| `Shift+F5` | Cancel Query |
| `Ctrl+Shift+S` | Save as Favorite |
| `Ctrl+Shift+A` | Open AI Chat |
| `F1` | Show Keyboard Shortcuts |

## Project Structure

```
Quest/
├── extension/              # VS Code extension (TypeScript)
│   ├── src/
│   │   ├── commands/       # Command handlers
│   │   ├── languages/      # KQL, WIQL, OQL language support
│   │   ├── providers/      # WebView providers
│   │   └── sidecar/        # Sidecar client & manager
│   ├── syntaxes/           # TextMate grammars
│   └── resources/          # Icons, walkthrough
├── server/                 # .NET sidecar server
│   ├── Handlers/           # JSON-RPC request handlers
│   ├── Models/             # Data source abstractions
│   ├── Services/           # Business logic
│   └── Protocol/           # Message types
└── server.Tests/           # Server unit tests
```

## Configuration

| Setting | Description | Default |
|---------|-------------|---------|
| `queryStudio.queryTimeout` | Query timeout in seconds | 300 |
| `queryStudio.maxResults` | Maximum rows to return | 10000 |
| `queryStudio.autoSaveHistory` | Auto-save executed queries | true |
| `queryStudio.ai.enabled` | Enable AI features | true |
| `queryStudio.ai.provider` | AI provider (github, azure, copilot) | github |

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## Known Limitations

- Outlook queries require Windows with Outlook installed (COM interop)
- Large result sets (>10,000 rows) may impact performance
- AI features require configured provider credentials

## License

This project is licensed under the MIT License - see the [LICENSE](extension/LICENSE) file for details.

## Acknowledgments

- Built with [VS Code Extension API](https://code.visualstudio.com/api)
- Server communication via [StreamJsonRpc](https://github.com/microsoft/vs-streamjsonrpc)
- Kusto queries powered by [Azure.Data.Explorer](https://docs.microsoft.com/en-us/azure/data-explorer/)
