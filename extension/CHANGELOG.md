# Change Log

All notable changes to the "Quest" extension will be documented in this file.

## [0.6.2] - 2026-02-15

### Added

- **Multi-Cluster Screenshot Extraction** - "From Screenshot" now detects ALL clusters and databases in the image, with a multi-select picker to choose which to add
- **Get Databases** - Right-click a cluster to discover and add databases from the server
- **Show Tables** - Right-click a database to list its tables in the tree (uses cached schema when available)
- **Click Table to Insert** - Click a table name in the tree to insert it into the active query editor
- **Edit Connection** - Right-click any cluster or database to edit its URL, database, and display name
- **Multi-Select Remove** - Select multiple data sources and remove them all at once
- **Data Sources Filter** - Search icon in the title bar to filter clusters by name, database, or URL
- **Mode in Panel Title** - Data Sources title now shows the current mode (KQL / ADO / Outlook)
- **Keyboard Shortcuts Filter** - Search input to quickly find shortcuts in the keyboard shortcuts panel
- **Copy Connection Info** - Now works on both cluster and individual database nodes, with confirmation toast

### Fixed

- **Query Type from Mode, Not File** - Current mode now always determines query type, regardless of file extension (.wiql files no longer force ADO mode)
- **Mail Preview** - Preview now works even when queries use `| project` without EntryId
- **Dot in Cluster Name** - Names like `m365dprd.westeurope` now correctly resolve to `.kusto.windows.net`
- **Panels Load Empty** - Favorites, History, and Data Sources now refresh when the sidecar server connects

### Changed

- **Fetch Schema Button** - Removed from title bar (still available in database right-click menu)

## [0.5.6] - 2026-02-07

### Added

- **Run Submenu** - Combined Run Query and Run in Same Tab into a single dropdown menu
- **VS Code Marketplace Badge** - Added clickable marketplace link to README

### Changed

- **Show Example Button** - Moved to visible toolbar position (was hidden in overflow menu)
- **Toolbar Layout** - Reorganized for better visibility of common actions

### Fixed

- **Run Query Tooltip** - Removed duplicate "F5" from tooltip (VS Code adds it automatically)

## [0.5.5] - 2026-02-07

### Added

- **Active View Mode Buttons** - Chart, Pivot, and Compare buttons now highlight when active with mutual exclusion
- **F12 Filter Focus** - Press F12 in results view to jump to the filter input
- **AI System Prompt Editor** - View and customize the AI system prompt from the chat context bar
- **Dynamic Version Display** - Footer version is now read from package.json instead of hardcoded

### Fixed

- Version display in results footer and bug report links now always matches the installed version

## [0.5.2] - 2026-02-04

### Changed

- Use VS Code built-in GitHub auth for AI chat

## [0.5.1] - 2026-02-04

### Changed

- Bump version for marketplace metadata updates

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
