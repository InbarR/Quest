import * as vscode from 'vscode';

// Common WIQL fields
const WIQL_FIELDS = [
    { name: 'System.Id', description: 'Work item ID' },
    { name: 'System.Title', description: 'Work item title' },
    { name: 'System.State', description: 'Work item state' },
    { name: 'System.WorkItemType', description: 'Type of work item' },
    { name: 'System.AssignedTo', description: 'Person assigned to the work item' },
    { name: 'System.CreatedDate', description: 'Date the work item was created' },
    { name: 'System.CreatedBy', description: 'Person who created the work item' },
    { name: 'System.ChangedDate', description: 'Date the work item was last changed' },
    { name: 'System.ChangedBy', description: 'Person who last changed the work item' },
    { name: 'System.AreaPath', description: 'Area path' },
    { name: 'System.IterationPath', description: 'Iteration path' },
    { name: 'System.TeamProject', description: 'Team project name' },
    { name: 'System.Tags', description: 'Tags assigned to work item' },
    { name: 'System.Description', description: 'Work item description' },
    { name: 'System.Parent', description: 'Parent work item ID' },
    { name: 'System.Reason', description: 'Reason for current state' },
    { name: 'Microsoft.VSTS.Common.Priority', description: 'Priority (1-4)' },
    { name: 'Microsoft.VSTS.Common.Severity', description: 'Severity level' },
    { name: 'Microsoft.VSTS.Common.ClosedDate', description: 'Date the work item was closed' },
    { name: 'Microsoft.VSTS.Scheduling.Effort', description: 'Effort estimate' },
    { name: 'Microsoft.VSTS.Scheduling.RemainingWork', description: 'Remaining work' },
    { name: 'Microsoft.VSTS.Scheduling.OriginalEstimate', description: 'Original estimate' },
    { name: 'Microsoft.VSTS.Scheduling.CompletedWork', description: 'Completed work' },
    { name: 'Microsoft.VSTS.Scheduling.StoryPoints', description: 'Story points' }
];

// WIQL Keywords
const WIQL_KEYWORDS = [
    'SELECT', 'FROM', 'WHERE', 'ORDER BY', 'GROUP BY', 'ASOF', 'MODE',
    'AND', 'OR', 'NOT', 'IN', 'EVER', 'UNDER', 'CONTAINS', 'ASC', 'DESC',
    'WorkItems', 'WorkItemLinks'
];

// WIQL Macros
const WIQL_MACROS = [
    { name: '@Me', description: 'Current user' },
    { name: '@Today', description: 'Current date' },
    { name: '@Project', description: 'Current project' },
    { name: '@TeamProject', description: 'Team project name' },
    { name: '@CurrentIteration', description: 'Current iteration path' },
    { name: '@RecentProjectActivity', description: 'Work items with recent activity' },
    { name: '@MyRecentActivity', description: 'Your recently accessed work items' },
    { name: '@FollowedWorkItems', description: 'Work items you follow' }
];

// Work item types
const WORK_ITEM_TYPES = [
    'Bug', 'Task', 'User Story', 'Feature', 'Epic', 'Issue', 'Test Case',
    'Test Plan', 'Test Suite', 'Shared Steps', 'Impediment', 'Product Backlog Item'
];

// States
const STATES = [
    'New', 'Active', 'Resolved', 'Closed', 'Removed', 'Design', 'Ready',
    'In Progress', 'Done', 'Approved', 'Committed'
];

export class WiqlCompletionProvider implements vscode.CompletionItemProvider {
    provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        context: vscode.CompletionContext
    ): vscode.CompletionItem[] {
        const items: vscode.CompletionItem[] = [];
        const linePrefix = document.lineAt(position).text.substring(0, position.character);

        // After '[', suggest field names
        if (linePrefix.endsWith('[')) {
            return this.getFieldCompletions();
        }

        // After '@', suggest macros
        if (linePrefix.match(/@\w*$/)) {
            return this.getMacroCompletions();
        }

        // In WHERE clause after '=', suggest values based on context
        if (this.isInWhereClause(document, position)) {
            const fieldMatch = linePrefix.match(/\[([^\]]+)\]\s*[=<>!]+\s*['"]?$/);
            if (fieldMatch) {
                const field = fieldMatch[1];
                return this.getValueCompletions(field);
            }
        }

        // Default: keywords and snippets
        items.push(...this.getKeywordCompletions());
        items.push(...this.getSnippetCompletions());

        return items;
    }

    private getFieldCompletions(): vscode.CompletionItem[] {
        return WIQL_FIELDS.map(field => {
            const item = new vscode.CompletionItem(field.name, vscode.CompletionItemKind.Field);
            item.detail = field.description;
            item.insertText = field.name + ']';
            item.sortText = '0' + field.name;
            return item;
        });
    }

    private getMacroCompletions(): vscode.CompletionItem[] {
        return WIQL_MACROS.map(macro => {
            const item = new vscode.CompletionItem(macro.name, vscode.CompletionItemKind.Variable);
            item.detail = macro.description;
            item.sortText = '0' + macro.name;
            return item;
        });
    }

    private getKeywordCompletions(): vscode.CompletionItem[] {
        return WIQL_KEYWORDS.map(kw => {
            const item = new vscode.CompletionItem(kw, vscode.CompletionItemKind.Keyword);
            item.detail = 'WIQL Keyword';
            item.sortText = '1' + kw;
            return item;
        });
    }

    private getSnippetCompletions(): vscode.CompletionItem[] {
        const snippets = [
            {
                label: 'SELECT basic',
                detail: 'Basic SELECT query',
                insertText: 'SELECT [System.Id], [System.Title], [System.State]\nFROM WorkItems\nWHERE [System.TeamProject] = @Project'
            },
            {
                label: 'SELECT assigned to me',
                detail: 'Work items assigned to current user',
                insertText: 'SELECT [System.Id], [System.Title], [System.State]\nFROM WorkItems\nWHERE [System.AssignedTo] = @Me\nAND [System.State] <> \'Closed\''
            },
            {
                label: 'SELECT bugs',
                detail: 'Active bugs query',
                insertText: 'SELECT [System.Id], [System.Title], [System.State], [Microsoft.VSTS.Common.Priority]\nFROM WorkItems\nWHERE [System.WorkItemType] = \'Bug\'\nAND [System.State] <> \'Closed\'\nORDER BY [Microsoft.VSTS.Common.Priority] ASC'
            },
            {
                label: 'SELECT sprint',
                detail: 'Current sprint items',
                insertText: 'SELECT [System.Id], [System.Title], [System.State], [System.AssignedTo]\nFROM WorkItems\nWHERE [System.IterationPath] = @CurrentIteration\nAND [System.State] <> \'Closed\''
            }
        ];

        return snippets.map(s => {
            const item = new vscode.CompletionItem(s.label, vscode.CompletionItemKind.Snippet);
            item.detail = s.detail;
            item.insertText = new vscode.SnippetString(s.insertText);
            item.sortText = '2' + s.label;
            return item;
        });
    }

    private getValueCompletions(field: string): vscode.CompletionItem[] {
        let values: string[] = [];

        if (field.includes('WorkItemType')) {
            values = WORK_ITEM_TYPES;
        } else if (field.includes('State')) {
            values = STATES;
        } else if (field.includes('Priority')) {
            values = ['1', '2', '3', '4'];
        } else if (field.includes('Severity')) {
            values = ['1 - Critical', '2 - High', '3 - Medium', '4 - Low'];
        }

        return values.map(v => {
            const item = new vscode.CompletionItem(v, vscode.CompletionItemKind.Value);
            item.insertText = `'${v}'`;
            return item;
        });
    }

    private isInWhereClause(document: vscode.TextDocument, position: vscode.Position): boolean {
        const textBefore = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
        const upperText = textBefore.toUpperCase();
        const whereIndex = upperText.lastIndexOf('WHERE');
        const orderByIndex = upperText.lastIndexOf('ORDER BY');
        const groupByIndex = upperText.lastIndexOf('GROUP BY');

        return whereIndex > -1 && whereIndex > Math.max(orderByIndex, groupByIndex);
    }
}
