import * as vscode from 'vscode';

export interface Snippet {
    id: string;
    name: string;
    description: string;
    code: string;
    language: 'kql' | 'wiql' | 'oql' | 'all';
    category: string;
    isBuiltIn: boolean;
}

// Built-in KQL snippets
const KQL_SNIPPETS: Snippet[] = [
    // Time Filters
    {
        id: 'kql-time-ago',
        name: 'Time Filter (ago)',
        description: 'Filter records from the last N time units',
        code: '| where ${1:TimeColumn} > ago(${2:1h})',
        language: 'kql',
        category: 'Time Filters',
        isBuiltIn: true
    },
    {
        id: 'kql-time-between',
        name: 'Time Range (between)',
        description: 'Filter records between two dates',
        code: '| where ${1:TimeColumn} between (datetime(${2:2024-01-01}) .. datetime(${3:2024-12-31}))',
        language: 'kql',
        category: 'Time Filters',
        isBuiltIn: true
    },
    {
        id: 'kql-time-startofday',
        name: 'Start of Day',
        description: 'Filter records from start of current day',
        code: '| where ${1:TimeColumn} >= startofday(now())',
        language: 'kql',
        category: 'Time Filters',
        isBuiltIn: true
    },
    // Aggregations
    {
        id: 'kql-summarize-count',
        name: 'Count by Column',
        description: 'Count records grouped by column',
        code: '| summarize Count = count() by ${1:Column}',
        language: 'kql',
        category: 'Aggregations',
        isBuiltIn: true
    },
    {
        id: 'kql-summarize-avg',
        name: 'Average by Column',
        description: 'Calculate average grouped by column',
        code: '| summarize Avg = avg(${1:NumericColumn}) by ${2:GroupColumn}',
        language: 'kql',
        category: 'Aggregations',
        isBuiltIn: true
    },
    {
        id: 'kql-summarize-time',
        name: 'Time Series (bin)',
        description: 'Aggregate over time buckets',
        code: '| summarize ${1:count()} by bin(${2:TimeColumn}, ${3:1h})',
        language: 'kql',
        category: 'Aggregations',
        isBuiltIn: true
    },
    {
        id: 'kql-top-n',
        name: 'Top N Records',
        description: 'Get top N records by column',
        code: '| top ${1:10} by ${2:Column} ${3|desc,asc|}',
        language: 'kql',
        category: 'Aggregations',
        isBuiltIn: true
    },
    {
        id: 'kql-distinct',
        name: 'Distinct Values',
        description: 'Get distinct values from column',
        code: '| distinct ${1:Column}',
        language: 'kql',
        category: 'Aggregations',
        isBuiltIn: true
    },
    // Joins
    {
        id: 'kql-join-inner',
        name: 'Inner Join',
        description: 'Inner join with another table',
        code: '| join kind=inner (${1:OtherTable}) on ${2:KeyColumn}',
        language: 'kql',
        category: 'Joins',
        isBuiltIn: true
    },
    {
        id: 'kql-join-left',
        name: 'Left Outer Join',
        description: 'Left outer join with another table',
        code: '| join kind=leftouter (${1:OtherTable}) on ${2:KeyColumn}',
        language: 'kql',
        category: 'Joins',
        isBuiltIn: true
    },
    {
        id: 'kql-union',
        name: 'Union Tables',
        description: 'Combine results from multiple tables',
        code: '| union ${1:OtherTable}',
        language: 'kql',
        category: 'Joins',
        isBuiltIn: true
    },
    // String Operations
    {
        id: 'kql-contains',
        name: 'Contains Filter',
        description: 'Filter where column contains text',
        code: '| where ${1:Column} contains "${2:text}"',
        language: 'kql',
        category: 'String Operations',
        isBuiltIn: true
    },
    {
        id: 'kql-regex',
        name: 'Regex Match',
        description: 'Filter using regex pattern',
        code: '| where ${1:Column} matches regex "${2:pattern}"',
        language: 'kql',
        category: 'String Operations',
        isBuiltIn: true
    },
    {
        id: 'kql-extract',
        name: 'Extract Regex',
        description: 'Extract value using regex',
        code: '| extend ${1:NewColumn} = extract("${2:pattern}", ${3:1}, ${4:SourceColumn})',
        language: 'kql',
        category: 'String Operations',
        isBuiltIn: true
    },
    // Data Transformation
    {
        id: 'kql-extend',
        name: 'Add Computed Column',
        description: 'Add a new computed column',
        code: '| extend ${1:NewColumn} = ${2:expression}',
        language: 'kql',
        category: 'Data Transformation',
        isBuiltIn: true
    },
    {
        id: 'kql-project',
        name: 'Select Columns',
        description: 'Select specific columns',
        code: '| project ${1:Column1}, ${2:Column2}, ${3:Column3}',
        language: 'kql',
        category: 'Data Transformation',
        isBuiltIn: true
    },
    {
        id: 'kql-parse-json',
        name: 'Parse JSON',
        description: 'Parse JSON column and extract properties',
        code: '| extend ${1:Parsed} = parse_json(${2:JsonColumn})\n| extend ${3:Property} = ${1:Parsed}.${4:propertyName}',
        language: 'kql',
        category: 'Data Transformation',
        isBuiltIn: true
    },
    {
        id: 'kql-mv-expand',
        name: 'Expand Array',
        description: 'Expand array into multiple rows',
        code: '| mv-expand ${1:ArrayColumn}',
        language: 'kql',
        category: 'Data Transformation',
        isBuiltIn: true
    },
    // Visualization
    {
        id: 'kql-render-timechart',
        name: 'Render Time Chart',
        description: 'Render results as time chart',
        code: '| render timechart',
        language: 'kql',
        category: 'Visualization',
        isBuiltIn: true
    },
    {
        id: 'kql-render-barchart',
        name: 'Render Bar Chart',
        description: 'Render results as bar chart',
        code: '| render barchart',
        language: 'kql',
        category: 'Visualization',
        isBuiltIn: true
    },
    {
        id: 'kql-render-piechart',
        name: 'Render Pie Chart',
        description: 'Render results as pie chart',
        code: '| render piechart',
        language: 'kql',
        category: 'Visualization',
        isBuiltIn: true
    }
];

// Built-in WIQL snippets
const WIQL_SNIPPETS: Snippet[] = [
    // Basic Queries
    {
        id: 'wiql-my-items',
        name: 'My Work Items',
        description: 'Get work items assigned to me',
        code: 'SELECT [System.Id], [System.Title], [System.State]\nFROM WorkItems\nWHERE [System.AssignedTo] = @Me\nORDER BY [System.ChangedDate] DESC',
        language: 'wiql',
        category: 'Basic Queries',
        isBuiltIn: true
    },
    {
        id: 'wiql-recent-bugs',
        name: 'Recent Bugs',
        description: 'Get recent bugs in project',
        code: 'SELECT [System.Id], [System.Title], [System.State], [System.CreatedDate]\nFROM WorkItems\nWHERE [System.WorkItemType] = "Bug"\n  AND [System.CreatedDate] >= @Today - ${1:30}\nORDER BY [System.CreatedDate] DESC',
        language: 'wiql',
        category: 'Basic Queries',
        isBuiltIn: true
    },
    {
        id: 'wiql-active-items',
        name: 'Active Work Items',
        description: 'Get all active work items',
        code: 'SELECT [System.Id], [System.Title], [System.WorkItemType], [System.State]\nFROM WorkItems\nWHERE [System.State] = "Active"\nORDER BY [System.ChangedDate] DESC',
        language: 'wiql',
        category: 'Basic Queries',
        isBuiltIn: true
    },
    // Sprint Queries
    {
        id: 'wiql-current-sprint',
        name: 'Current Sprint Items',
        description: 'Get items in current iteration',
        code: 'SELECT [System.Id], [System.Title], [System.State], [System.AssignedTo]\nFROM WorkItems\nWHERE [System.IterationPath] = @CurrentIteration\nORDER BY [System.State]',
        language: 'wiql',
        category: 'Sprint Queries',
        isBuiltIn: true
    },
    {
        id: 'wiql-sprint-burndown',
        name: 'Sprint Work Remaining',
        description: 'Get remaining work in current sprint',
        code: 'SELECT [System.Id], [System.Title], [Microsoft.VSTS.Scheduling.RemainingWork]\nFROM WorkItems\nWHERE [System.IterationPath] = @CurrentIteration\n  AND [System.State] <> "Closed"\n  AND [System.State] <> "Done"',
        language: 'wiql',
        category: 'Sprint Queries',
        isBuiltIn: true
    },
    // Bug Tracking
    {
        id: 'wiql-critical-bugs',
        name: 'Critical/High Priority Bugs',
        description: 'Get critical and high priority bugs',
        code: 'SELECT [System.Id], [System.Title], [Microsoft.VSTS.Common.Priority], [System.State]\nFROM WorkItems\nWHERE [System.WorkItemType] = "Bug"\n  AND [Microsoft.VSTS.Common.Priority] <= 2\n  AND [System.State] <> "Closed"\nORDER BY [Microsoft.VSTS.Common.Priority]',
        language: 'wiql',
        category: 'Bug Tracking',
        isBuiltIn: true
    },
    {
        id: 'wiql-unassigned-bugs',
        name: 'Unassigned Bugs',
        description: 'Get bugs that are not assigned',
        code: 'SELECT [System.Id], [System.Title], [System.State], [System.CreatedDate]\nFROM WorkItems\nWHERE [System.WorkItemType] = "Bug"\n  AND [System.AssignedTo] = ""\n  AND [System.State] <> "Closed"',
        language: 'wiql',
        category: 'Bug Tracking',
        isBuiltIn: true
    },
    // Links
    {
        id: 'wiql-parent-children',
        name: 'Parent-Child Items',
        description: 'Get work items with their children',
        code: 'SELECT [System.Id], [System.Title], [System.State]\nFROM WorkItemLinks\nWHERE ([Source].[System.WorkItemType] = "${1:User Story}"\n  AND [System.Links.LinkType] = "System.LinkTypes.Hierarchy-Forward")\nMODE (Recursive)',
        language: 'wiql',
        category: 'Links',
        isBuiltIn: true
    }
];

// Built-in OQL snippets (Outlook Query Language)
const OQL_SNIPPETS: Snippet[] = [
    // Inbox Queries
    {
        id: 'oql-inbox-today',
        name: 'Today\'s Emails',
        description: 'Get emails received today',
        code: 'Inbox\n| where received >= today()\n| take 50',
        language: 'oql',
        category: 'Inbox Queries',
        isBuiltIn: true
    },
    {
        id: 'oql-inbox-unread',
        name: 'Unread Emails',
        description: 'Get unread emails from inbox',
        code: 'Inbox\n| where isread == false\n| take 100',
        language: 'oql',
        category: 'Inbox Queries',
        isBuiltIn: true
    },
    {
        id: 'oql-inbox-from',
        name: 'Emails from Sender',
        description: 'Get emails from a specific sender',
        code: 'Inbox\n| where from contains "${1:sender@example.com}"\n| take 50',
        language: 'oql',
        category: 'Inbox Queries',
        isBuiltIn: true
    },
    {
        id: 'oql-inbox-subject',
        name: 'Emails by Subject',
        description: 'Search emails by subject',
        code: 'Inbox\n| where subject contains "${1:search term}"\n| take 50',
        language: 'oql',
        category: 'Inbox Queries',
        isBuiltIn: true
    },
    {
        id: 'oql-inbox-attachments',
        name: 'Emails with Attachments',
        description: 'Get emails that have attachments',
        code: 'Inbox\n| where hasattachments == true\n| take 50',
        language: 'oql',
        category: 'Inbox Queries',
        isBuiltIn: true
    },
    // Sent Items
    {
        id: 'oql-sent-recent',
        name: 'Recent Sent Emails',
        description: 'Get recently sent emails',
        code: 'SentItems\n| where sent >= ago(7d)\n| take 50',
        language: 'oql',
        category: 'Sent Items',
        isBuiltIn: true
    },
    {
        id: 'oql-sent-to',
        name: 'Sent to Recipient',
        description: 'Get emails sent to specific person',
        code: 'SentItems\n| where to contains "${1:recipient@example.com}"\n| take 50',
        language: 'oql',
        category: 'Sent Items',
        isBuiltIn: true
    },
    // Calendar
    {
        id: 'oql-calendar-today',
        name: 'Today\'s Meetings',
        description: 'Get meetings scheduled for today',
        code: 'Calendar\n| where start >= startofday(now()) and start < startofday(now()) + 1d\n| project subject, start, end, location',
        language: 'oql',
        category: 'Calendar',
        isBuiltIn: true
    },
    {
        id: 'oql-calendar-week',
        name: 'This Week\'s Meetings',
        description: 'Get meetings for current week',
        code: 'Calendar\n| where start >= startofweek(now()) and start < startofweek(now()) + 7d\n| project subject, start, end, location, organizer',
        language: 'oql',
        category: 'Calendar',
        isBuiltIn: true
    },
    // Filters
    {
        id: 'oql-high-importance',
        name: 'High Importance Emails',
        description: 'Get high importance emails',
        code: 'Inbox\n| where importance == "High"\n| take 50',
        language: 'oql',
        category: 'Filters',
        isBuiltIn: true
    },
    {
        id: 'oql-date-range',
        name: 'Emails in Date Range',
        description: 'Get emails within a date range',
        code: '${1:Inbox}\n| where received >= datetime(${2:2024-01-01}) and received < datetime(${3:2024-12-31})\n| take 100',
        language: 'oql',
        category: 'Filters',
        isBuiltIn: true
    }
];

// Combine all built-in snippets
const BUILT_IN_SNIPPETS: Snippet[] = [...KQL_SNIPPETS, ...WIQL_SNIPPETS, ...OQL_SNIPPETS];

export class SnippetsWebViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'querystudio.snippets';

    private _view?: vscode.WebviewView;
    private _customSnippets: Snippet[] = [];
    private _currentMode: 'kusto' | 'ado' | 'outlook' = 'kusto';
    private _context: vscode.ExtensionContext;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        context: vscode.ExtensionContext
    ) {
        this._context = context;
        this._loadCustomSnippets();
    }

    public setMode(mode: 'kusto' | 'ado' | 'outlook') {
        this._currentMode = mode;
        this._updateView();
    }

    private _loadCustomSnippets() {
        this._customSnippets = this._context.globalState.get<Snippet[]>('customSnippets', []);
    }

    private async _saveCustomSnippets() {
        await this._context.globalState.update('customSnippets', this._customSnippets);
    }

    public async addCustomSnippet(snippet: Omit<Snippet, 'id' | 'isBuiltIn'>): Promise<Snippet> {
        const newSnippet: Snippet = {
            ...snippet,
            id: `custom-${Date.now()}`,
            isBuiltIn: false
        };
        this._customSnippets.push(newSnippet);
        await this._saveCustomSnippets();
        this._updateView();
        return newSnippet;
    }

    public async deleteCustomSnippet(id: string): Promise<void> {
        this._customSnippets = this._customSnippets.filter(s => s.id !== id);
        await this._saveCustomSnippets();
        this._updateView();
    }

    public getAllSnippets(): Snippet[] {
        return [...BUILT_IN_SNIPPETS, ...this._customSnippets];
    }

    public getSnippetsForMode(mode: 'kusto' | 'ado' | 'outlook'): Snippet[] {
        const lang = mode === 'kusto' ? 'kql' : mode === 'ado' ? 'wiql' : 'oql';
        return this.getAllSnippets().filter(s => s.language === lang || s.language === 'all');
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview();

        webviewView.webview.onDidReceiveMessage(async message => {
            switch (message.command) {
                case 'insert':
                    const snippet = this.getAllSnippets().find(s => s.id === message.id);
                    if (snippet) {
                        await this._insertSnippet(snippet);
                    }
                    break;
                case 'delete':
                    const toDelete = this._customSnippets.find(s => s.id === message.id);
                    if (toDelete) {
                        const confirm = await vscode.window.showWarningMessage(
                            `Delete snippet "${toDelete.name}"?`,
                            { modal: true },
                            'Delete'
                        );
                        if (confirm === 'Delete') {
                            await this.deleteCustomSnippet(message.id);
                        }
                    }
                    break;
                case 'saveNew':
                    await this._promptSaveSnippet();
                    break;
                case 'refresh':
                    this._updateView();
                    break;
            }
        });

        this._updateView();
    }

    private async _insertSnippet(snippet: Snippet) {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('No active editor to insert snippet');
            return;
        }

        // Insert as snippet with placeholders
        const snippetString = new vscode.SnippetString(snippet.code);
        await editor.insertSnippet(snippetString);
    }

    private async _promptSaveSnippet() {
        const editor = vscode.window.activeTextEditor;
        const selection = editor?.selection;
        const selectedText = editor && selection && !selection.isEmpty
            ? editor.document.getText(selection)
            : '';

        const name = await vscode.window.showInputBox({
            prompt: 'Snippet name',
            placeHolder: 'e.g., My Custom Query'
        });
        if (!name) return;

        const description = await vscode.window.showInputBox({
            prompt: 'Snippet description',
            placeHolder: 'e.g., Filters active items by date'
        });
        if (!description) return;

        const code = await vscode.window.showInputBox({
            prompt: 'Snippet code (use ${1:placeholder} for placeholders)',
            value: selectedText,
            placeHolder: '| where Column == "${1:value}"'
        });
        if (!code) return;

        const categoryOptions = ['Custom', 'Time Filters', 'Aggregations', 'Joins', 'Filters', 'Other'];
        const category = await vscode.window.showQuickPick(categoryOptions, {
            placeHolder: 'Select category'
        });
        if (!category) return;

        const langMap: Record<string, 'kql' | 'wiql' | 'oql' | 'all'> = {
            'KQL (Kusto)': 'kql',
            'WIQL (Azure DevOps)': 'wiql',
            'OQL (Outlook)': 'oql',
            'All Languages': 'all'
        };
        const langChoice = await vscode.window.showQuickPick(Object.keys(langMap), {
            placeHolder: 'Select language'
        });
        if (!langChoice) return;

        await this.addCustomSnippet({
            name,
            description,
            code,
            category,
            language: langMap[langChoice]
        });

        vscode.window.showInformationMessage(`Snippet "${name}" saved!`);
    }

    private _updateView() {
        if (!this._view) return;

        const lang = this._currentMode === 'kusto' ? 'kql' : this._currentMode === 'ado' ? 'wiql' : 'oql';
        const snippets = this.getAllSnippets().filter(s => s.language === lang || s.language === 'all');

        // Group by category
        const grouped = new Map<string, Snippet[]>();
        for (const snippet of snippets) {
            const cat = snippet.category;
            if (!grouped.has(cat)) {
                grouped.set(cat, []);
            }
            grouped.get(cat)!.push(snippet);
        }

        this._view.webview.postMessage({
            command: 'update',
            snippets,
            grouped: Object.fromEntries(grouped),
            mode: this._currentMode
        });
    }

    private _getHtmlForWebview(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body {
            padding: 0;
            margin: 0;
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
        }
        .toolbar {
            padding: 6px 8px;
            position: sticky;
            top: 0;
            background: var(--vscode-sideBar-background);
            border-bottom: 1px solid var(--vscode-panel-border);
            display: flex;
            gap: 6px;
        }
        .toolbar input {
            flex: 1;
            padding: 4px 8px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 2px;
            font-size: 12px;
        }
        .toolbar input:focus {
            outline: 1px solid var(--vscode-focusBorder);
        }
        .toolbar button {
            padding: 4px 8px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 2px;
            cursor: pointer;
            font-size: 11px;
        }
        .toolbar button:hover {
            background: var(--vscode-button-hoverBackground);
        }
        .category {
            margin-bottom: 4px;
        }
        .category-header {
            padding: 6px 8px;
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
            color: var(--vscode-descriptionForeground);
            background: var(--vscode-sideBarSectionHeader-background);
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 4px;
        }
        .category-header:hover {
            background: var(--vscode-list-hoverBackground);
        }
        .category-header .arrow {
            transition: transform 0.2s;
        }
        .category-header.collapsed .arrow {
            transform: rotate(-90deg);
        }
        .category-items {
            overflow: hidden;
        }
        .category-items.collapsed {
            display: none;
        }
        .item {
            display: flex;
            align-items: flex-start;
            padding: 6px 8px 6px 16px;
            cursor: pointer;
            gap: 8px;
        }
        .item:hover {
            background: var(--vscode-list-hoverBackground);
        }
        .item-content {
            flex: 1;
            min-width: 0;
        }
        .item-name {
            font-size: 13px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .item-desc {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .item-actions {
            display: flex;
            gap: 2px;
            opacity: 0;
        }
        .item:hover .item-actions {
            opacity: 1;
        }
        .item-btn {
            padding: 2px 6px;
            font-size: 11px;
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: none;
            border-radius: 2px;
            cursor: pointer;
        }
        .item-btn:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        .item-btn.delete {
            color: var(--vscode-errorForeground);
        }
        .badge {
            font-size: 9px;
            padding: 1px 4px;
            border-radius: 8px;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            margin-left: 4px;
        }
        .empty {
            padding: 16px;
            text-align: center;
            color: var(--vscode-descriptionForeground);
        }
        .mode-indicator {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            padding: 4px 8px;
            background: var(--vscode-sideBarSectionHeader-background);
        }
    </style>
</head>
<body>
    <div class="toolbar">
        <input type="text" id="search" placeholder="Search snippets..." oninput="filter(this.value)">
        <button onclick="saveNew()" title="Save selection as snippet">+ Save</button>
    </div>
    <div class="mode-indicator" id="modeIndicator"></div>
    <div id="list"></div>

    <script>
        const vscode = acquireVsCodeApi();
        let allSnippets = [];
        let groupedSnippets = {};
        let currentMode = 'kusto';
        let collapsedCategories = new Set();

        window.addEventListener('message', event => {
            const msg = event.data;
            if (msg.command === 'update') {
                allSnippets = msg.snippets;
                groupedSnippets = msg.grouped;
                currentMode = msg.mode;
                document.getElementById('modeIndicator').textContent =
                    currentMode === 'kusto' ? 'KQL Snippets' :
                    currentMode === 'ado' ? 'WIQL Snippets' : 'OQL Snippets';
                render(groupedSnippets);
            }
        });

        function filter(text) {
            const lower = text.toLowerCase();
            if (!text) {
                render(groupedSnippets);
                return;
            }
            const filtered = allSnippets.filter(s =>
                s.name.toLowerCase().includes(lower) ||
                s.description.toLowerCase().includes(lower) ||
                s.code.toLowerCase().includes(lower)
            );
            // Regroup filtered
            const grouped = {};
            for (const s of filtered) {
                if (!grouped[s.category]) grouped[s.category] = [];
                grouped[s.category].push(s);
            }
            render(grouped);
        }

        function render(grouped) {
            const list = document.getElementById('list');
            const categories = Object.keys(grouped).sort();

            if (categories.length === 0) {
                list.innerHTML = '<div class="empty">No snippets found</div>';
                return;
            }

            list.innerHTML = categories.map(cat => {
                const items = grouped[cat];
                const collapsed = collapsedCategories.has(cat);
                return \`
                    <div class="category">
                        <div class="category-header \${collapsed ? 'collapsed' : ''}" onclick="toggleCategory('\${escapeHtml(cat)}')">
                            <span class="arrow">▼</span>
                            \${escapeHtml(cat)}
                            <span class="badge">\${items.length}</span>
                        </div>
                        <div class="category-items \${collapsed ? 'collapsed' : ''}">
                            \${items.map(s => \`
                                <div class="item" ondblclick="insert('\${s.id}')" title="\${escapeHtml(s.code)}">
                                    <div class="item-content">
                                        <div class="item-name">\${escapeHtml(s.name)}\${s.isBuiltIn ? '' : ' <span class="badge">custom</span>'}</div>
                                        <div class="item-desc">\${escapeHtml(s.description)}</div>
                                    </div>
                                    <div class="item-actions">
                                        <button class="item-btn" onclick="event.stopPropagation(); insert('\${s.id}')">Insert</button>
                                        \${!s.isBuiltIn ? '<button class="item-btn delete" onclick="event.stopPropagation(); del(\\'' + s.id + '\\')">×</button>' : ''}
                                    </div>
                                </div>
                            \`).join('')}
                        </div>
                    </div>
                \`;
            }).join('');
        }

        function toggleCategory(cat) {
            if (collapsedCategories.has(cat)) {
                collapsedCategories.delete(cat);
            } else {
                collapsedCategories.add(cat);
            }
            render(groupedSnippets);
        }

        function insert(id) {
            vscode.postMessage({ command: 'insert', id });
        }

        function del(id) {
            vscode.postMessage({ command: 'delete', id });
        }

        function saveNew() {
            vscode.postMessage({ command: 'saveNew' });
        }

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text || '';
            return div.innerHTML;
        }
    </script>
</body>
</html>`;
    }
}
