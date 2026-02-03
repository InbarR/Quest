# Change Log

All notable changes to the "Quest" extension will be documented in this file.

## [0.5.0] - 2025-02-03

### Added

- **ADO Data Source from URL** - Paste any Azure DevOps URL to automatically extract org and project
- **Concurrent Query Execution** - Run multiple queries simultaneously, each in its own tab
- **Improved Loading State** - Card-based design with query preview and timer
- **Improved Error State** - Clean card-based error display with retry option
- **Enhanced Walkthrough** - Detailed documentation for mode switching and editor buttons

### Changed

- Publisher changed to `quest-studio` for cleaner storage paths
- Removed non-working Ctrl+Enter keybinding (use F5 to run queries)
- ADO data source options simplified to Manual and URL only
- Removed double-click to filter feature in results

### Fixed

- Kusto Explorer import no longer applies wrong database to all clusters
- Query preview now visible inside loading card
- Results history no longer shows type icons

## [0.4.0] - 2025-01-28

### Added

- **Preview Panel** - Show detailed preview for Kusto rows and ADO work items
- **HTML Rendering** - ADO fields like Description, Repro Steps render as HTML
- **Cancel Button** - Stop running queries from the results panel
- **Device Code Auth** - Visible notification for GitHub Copilot authentication

### Changed

- Preview panel is now per-tab (closes when switching tabs)
- Updated walkthrough with button explanations

### Fixed

- Display name now saves correctly when adding clusters
- Rename cluster works for both cluster and database nodes

## [0.3.0] - 2025-01-25

### Added

- **Security Audit** - Removed sensitive data and internal references
- **GitHub Repository** - Public repo at github.com/InbarR/Quest
- **Comprehensive README** - Full documentation of features and architecture

## [0.1.0] - 2025-01-19

### Added

- Initial release
- **Kusto (KQL) Support**
  - Query Azure Data Explorer clusters
  - Schema-aware IntelliSense
  - Syntax highlighting
  - Azure AD authentication

- **Azure DevOps (WIQL) Support**
  - Query work items across projects
  - Field and macro autocomplete
  - Double-click to open work items in browser

- **Outlook (OQL) Support**
  - Query local Outlook via COM interop
  - KQL-like syntax for mail, calendar, contacts, tasks
  - Folder-aware field suggestions
  - Double-click to open items in Outlook

- **AI Features**
  - AI chat panel for query assistance
  - Query explanation
  - Natural language to query generation
  - Support for GitHub Models, Azure OpenAI, and Copilot

- **Results Viewer**
  - Tabbed results interface
  - Row highlighting and multi-select
  - Context menu with copy options
  - Export to CSV

- **Query Management**
  - Save favorite queries
  - Query history with retention settings
  - Results history for quick reference

### Known Issues

- Outlook queries only work on Windows (requires COM interop)
- Very large result sets may cause performance issues
