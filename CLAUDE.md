# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Quest (Query Studio) is a VS Code extension for querying multiple data sources with AI assistance:
- **KQL** (Kusto Query Language) - Azure Data Explorer
- **WIQL** (Work Item Query Language) - Azure DevOps
- **OQL** (Outlook Query Language) - Local Outlook via COM interop

## Architecture

**Two-component system:**
1. **VS Code Extension** (`extension/`) - TypeScript frontend handling UI, language support, and VS Code integration
2. **Sidecar Server** (`server/`) - .NET 8 backend handling data source connections and query execution

**Communication:** JSON-RPC via StreamJsonRpc over stdin/stdout between extension and sidecar.

**Key directories:**
- `extension/src/commands/` - Command handlers
- `extension/src/languages/` - KQL, WIQL, OQL language support (completion, hover, syntax)
- `extension/src/providers/` - WebView providers for results, AI chat, favorites, history
- `server/Handlers/` - JSON-RPC request handlers (QueryHandler, SchemaHandler, etc.)
- `server/Services/` - Business logic and data source implementations

## Build Commands

### Full Build (creates .vsix package)
```powershell
./build-extension.ps1
```

### Server Only
```bash
cd server
dotnet build
dotnet publish -c Release -r win-x64 --self-contained true
```

### Extension Only
```bash
cd extension
npm install
npm run compile    # TypeScript compilation
npm run watch      # Watch mode for development
npm run lint       # ESLint
npm run package    # Create .vsix
```

### Running Tests
```bash
# Server tests (xUnit)
cd server.Tests
dotnet test

# Run specific test
dotnet test --filter "FullyQualifiedName~QueryHandlerTests"

# Extension tests (Mocha)
cd extension
npm test
```

## Development Setup

1. **Prerequisites:** .NET 8 SDK, Node.js LTS, VS Code
2. **Install dependencies:** `cd extension && npm install`
3. **Build server:** `cd server && dotnet build`
4. **Debug:** Press F5 in VS Code to launch Extension Development Host

## Key Dependencies

- **Server:** StreamJsonRpc, MyTools.Core, MyUtils (project references to sibling `../MyTools/` directory)
- **Extension:** VS Code API 1.85+, TypeScript 5.3

## Constraints

- Windows-only for Outlook queries (COM interop)
- Server publishes as self-contained single-file executable (~50MB+)

<!-- BACKLOG.MD GUIDELINES START -->
# Instructions for the usage of Backlog.md CLI Tool

## Backlog.md: Comprehensive Project Management Tool via CLI

### Assistant Objective

Efficiently manage all project tasks, status, and documentation using the Backlog.md CLI, ensuring all project metadata
remains fully synchronized and up-to-date.

### Core Capabilities

- **Task Management**: Create, edit, assign, prioritize, and track tasks with full metadata
- **Search**: Fuzzy search across tasks, documents, and decisions with `backlog search`
- **Acceptance Criteria**: Granular control with add/remove/check/uncheck by index
- **Definition of Done checklists**: Per-task DoD items with add/remove/check/uncheck
- **Board Visualization**: Terminal-based Kanban board (`backlog board`) and web UI (`backlog browser`)
- **Git Integration**: Automatic tracking of task states across branches
- **Dependencies**: Task relationships and subtask hierarchies
- **Documentation & Decisions**: Structured docs and architectural decision records
- **Export & Reporting**: Generate markdown reports and board snapshots
- **AI-Optimized**: `--plain` flag provides clean text output for AI processing

### Key Understanding

- **Tasks** live in `backlog/tasks/` as `task-<id> - <title>.md` files
- **You interact via CLI only**: `backlog task create`, `backlog task edit`, etc.
- **Use `--plain` flag** for AI-friendly output when viewing/listing
- **Never bypass the CLI** - It handles Git, metadata, file naming, and relationships

---

# CRITICAL: NEVER EDIT TASK FILES DIRECTLY. Edit Only via CLI

**ALL task operations MUST use the Backlog.md CLI commands**

- **DO**: Use `backlog task edit` and other CLI commands
- **DO**: Use `backlog task create` to create new tasks
- **DO**: Use `backlog task edit <id> --check-ac <index>` to mark acceptance criteria
- **DON'T**: Edit markdown files directly
- **DON'T**: Manually change checkboxes in files
- **DON'T**: Add or modify text in task files without using CLI

**Why?** Direct file editing breaks metadata synchronization, Git tracking, and task relationships.

---

## Typical Workflow

```bash
# 1. Identify work
backlog task list -s "To Do" --plain

# 2. Read task details
backlog task 42 --plain

# 3. Start work: assign yourself & change status
backlog task edit 42 -s "In Progress" -a @myself

# 4. Add implementation plan
backlog task edit 42 --plan "1. Analyze\n2. Refactor\n3. Test"

# 5. Share the plan with the user and wait for approval (do not write code yet)

# 6. Work on the task (write code, test, etc.)

# 7. Mark acceptance criteria as complete (supports multiple in one command)
backlog task edit 42 --check-ac 1 --check-ac 2 --check-ac 3

# 8. Add Final Summary (PR Description)
backlog task edit 42 --final-summary "Refactored using strategy pattern, updated tests"

# 9. Mark task as done
backlog task edit 42 -s Done
```

## Quick Reference

### Task Operations
| Action | Command |
|--------|---------|
| View task | `backlog task 42 --plain` |
| List tasks | `backlog task list --plain` |
| Search tasks | `backlog search "topic" --plain` |
| Create task | `backlog task create "Title" -d "Description" --ac "Criterion"` |
| Change status | `backlog task edit 42 -s "In Progress"` |
| Assign | `backlog task edit 42 -a @name` |
| Check AC | `backlog task edit 42 --check-ac 1` |
| Add notes | `backlog task edit 42 --notes "Progress"` |
| Add final summary | `backlog task edit 42 --final-summary "PR description"` |

### Multi-line Input (PowerShell)
```powershell
backlog task edit 42 --notes "Line1`nLine2"
```

## Task intake and backlog policy
- When the user mentions tasks, TODOs, follow-ups, or future work in a prompt:
  - If the task is not executed immediately, add it to the backlog
  - Do not drop or merely acknowledge pending tasks
- Every backlog item must be explicit and trackable
- After completing any task, check the backlog and continue working
- Automatically pull the highest-priority unblocked task
- Continue until blocked or backlog is empty
- Never be idle while backlog tasks exist
- Only stop if explicit user input is required

<!-- BACKLOG.MD GUIDELINES END -->
