# Change Log

All notable changes to the "Quest" extension will be documented in this file.

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
  - Close all empty tabs feature

- **Query Management**
  - Save favorite queries
  - Query history with retention settings
  - Results history for quick reference

### Known Issues

- Outlook queries only work on Windows (requires COM interop)
- Very large result sets may cause performance issues
