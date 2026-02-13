import * as vscode from 'vscode';

// Outlook folders
const OQL_FOLDERS = [
    { name: 'Inbox', description: 'Received mail messages' },
    { name: 'SentMail', description: 'Sent mail messages' },
    { name: 'Drafts', description: 'Draft messages' },
    { name: 'DeletedItems', description: 'Deleted items (Trash)' },
    { name: 'Calendar', description: 'Calendar events' },
    { name: 'Contacts', description: 'Contact entries' },
    { name: 'Tasks', description: 'Task items' },
    { name: 'Notes', description: 'Notes' },
    { name: 'Journal', description: 'Journal entries' },
    { name: 'Outbox', description: 'Outgoing messages' },
    { name: 'Junk', description: 'Junk/Spam mail' },
    { name: 'Rules', description: 'Outlook mail rules' }
];

// Mail fields
const MAIL_FIELDS = [
    { name: 'Subject', description: 'Email subject line', type: 'string' },
    { name: 'From', description: 'Sender display name', type: 'string' },
    { name: 'SenderEmail', description: 'Sender email address', type: 'string' },
    { name: 'To', description: 'Recipients', type: 'string' },
    { name: 'CC', description: 'CC recipients', type: 'string' },
    { name: 'ReceivedTime', description: 'Date and time received', type: 'datetime' },
    { name: 'SentTime', description: 'Date and time sent', type: 'datetime' },
    { name: 'HasAttachments', description: 'Whether email has attachments', type: 'bool' },
    { name: 'AttachmentCount', description: 'Number of attachments', type: 'int' },
    { name: 'Importance', description: 'Email importance level', type: 'string' },
    { name: 'UnRead', description: 'Whether email is unread', type: 'bool' },
    { name: 'Categories', description: 'Email categories/tags', type: 'string' },
    { name: 'Size', description: 'Email size in KB', type: 'string' },
    { name: 'BodyPreview', description: 'First 100 chars of body', type: 'string' },
    { name: 'ConversationTopic', description: 'Email thread topic', type: 'string' },
    { name: 'Body', description: 'Email body text', type: 'string' }
];

// Calendar fields
const CALENDAR_FIELDS = [
    { name: 'Subject', description: 'Event subject', type: 'string' },
    { name: 'Start', description: 'Event start time', type: 'datetime' },
    { name: 'End', description: 'Event end time', type: 'datetime' },
    { name: 'Location', description: 'Event location', type: 'string' },
    { name: 'Organizer', description: 'Event organizer', type: 'string' },
    { name: 'IsRecurring', description: 'Whether event is recurring', type: 'bool' },
    { name: 'RecurrenceState', description: 'Single, Occurrence, or Master', type: 'string' },
    { name: 'BusyStatus', description: 'Busy status (Free, Busy, Tentative, OOF)', type: 'string' },
    { name: 'AllDayEvent', description: 'Whether it is an all-day event', type: 'bool' },
    { name: 'RequiredAttendees', description: 'Required attendees', type: 'string' },
    { name: 'OptionalAttendees', description: 'Optional attendees', type: 'string' }
];

// Contact fields
const CONTACT_FIELDS = [
    { name: 'FullName', description: 'Contact full name', type: 'string' },
    { name: 'Email1Address', description: 'Primary email address', type: 'string' },
    { name: 'Email2Address', description: 'Secondary email address', type: 'string' },
    { name: 'CompanyName', description: 'Company name', type: 'string' },
    { name: 'BusinessPhone', description: 'Business phone number', type: 'string' },
    { name: 'MobilePhone', description: 'Mobile phone number', type: 'string' },
    { name: 'JobTitle', description: 'Job title', type: 'string' },
    { name: 'Department', description: 'Department', type: 'string' }
];

// Task fields
const TASK_FIELDS = [
    { name: 'Subject', description: 'Task subject', type: 'string' },
    { name: 'DueDate', description: 'Task due date', type: 'datetime' },
    { name: 'StartDate', description: 'Task start date', type: 'datetime' },
    { name: 'Status', description: 'Task status', type: 'string' },
    { name: 'PercentComplete', description: 'Completion percentage', type: 'int' },
    { name: 'Owner', description: 'Task owner', type: 'string' },
    { name: 'Importance', description: 'Task importance', type: 'string' }
];

// Rules fields
const RULES_FIELDS = [
    { name: 'Name', description: 'Rule name', type: 'string' },
    { name: 'ExecutionOrder', description: 'Rule execution order', type: 'int' },
    { name: 'RuleType', description: 'Rule type (Send or Receive)', type: 'string' },
    { name: 'Conditions', description: 'Rule conditions', type: 'string' },
    { name: 'Actions', description: 'Rule actions', type: 'string' },
    { name: 'Exceptions', description: 'Rule exceptions', type: 'string' },
    { name: 'Enabled', description: 'Whether rule is enabled', type: 'bool' }
];

// OQL Operators
const OQL_OPERATORS = [
    { name: 'where', description: 'Filter results based on condition' },
    { name: 'take', description: 'Limit number of results' },
    { name: 'project', description: 'Select specific columns only' },
    { name: 'project-reorder', description: 'Reorder columns (specified first, then rest)' }
];

// Comparison operators
const COMPARISON_OPERATORS = [
    { name: 'contains', description: 'Contains substring (case-insensitive)' },
    { name: 'startswith', description: 'Starts with string' },
    { name: 'endswith', description: 'Ends with string' },
    { name: '==', description: 'Equals' },
    { name: '!=', description: 'Not equals' },
    { name: '>', description: 'Greater than' },
    { name: '<', description: 'Less than' },
    { name: '>=', description: 'Greater than or equals' },
    { name: '<=', description: 'Less than or equals' }
];

// Time functions
const TIME_FUNCTIONS = [
    { name: 'ago(1h)', description: 'Time 1 hour ago' },
    { name: 'ago(1d)', description: 'Time 1 day ago' },
    { name: 'ago(7d)', description: 'Time 7 days ago' },
    { name: 'ago(30d)', description: 'Time 30 days ago' },
    { name: 'ago(24h)', description: 'Time 24 hours ago' },
    { name: 'ago(30m)', description: 'Time 30 minutes ago' },
    { name: 'now()', description: 'Current time' }
];

// Boolean values
const BOOL_VALUES = ['true', 'false'];

// Importance values
const IMPORTANCE_VALUES = ['High', 'Normal', 'Low'];

// Task status values
const TASK_STATUS_VALUES = ['Not Started', 'In Progress', 'Completed', 'Waiting', 'Deferred'];

// Busy status values
const BUSY_STATUS_VALUES = ['Free', 'Busy', 'Tentative', 'OutOfOffice'];

export class OqlCompletionProvider implements vscode.CompletionItemProvider {
    provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        context: vscode.CompletionContext
    ): vscode.CompletionItem[] {
        const items: vscode.CompletionItem[] = [];
        const linePrefix = document.lineAt(position).text.substring(0, position.character);
        const fullText = document.getText();
        const textBeforeCursor = document.getText(new vscode.Range(new vscode.Position(0, 0), position));

        // At the beginning or after newline - suggest folders
        if (this.isAtQueryStart(textBeforeCursor, linePrefix)) {
            return this.getFolderCompletions();
        }

        // After pipe '|' - suggest operators
        if (linePrefix.match(/\|\s*$/)) {
            return this.getOperatorCompletions();
        }

        // After operator keyword followed by space - suggest fields
        if (linePrefix.match(/\|\s*where\s+$/i)) {
            return this.getFieldCompletions(this.detectFolder(fullText));
        }

        // After 'project' or 'project-reorder' - suggest fields
        if (linePrefix.match(/\|\s*project(?:-reorder)?\s+$/i) || linePrefix.match(/\|\s*project(?:-reorder)?\s+[\w,\s]*,\s*$/i)) {
            return this.getFieldCompletions(this.detectFolder(fullText));
        }

        // After field name and before operator - suggest comparison operators
        if (this.isAfterFieldName(linePrefix)) {
            return this.getComparisonOperatorCompletions();
        }

        // After comparison operator - suggest values
        const fieldMatch = linePrefix.match(/(\w+)\s+(?:contains|startswith|endswith|==|!=|>=?|<=?)\s*"?$/i);
        if (fieldMatch) {
            return this.getValueCompletions(fieldMatch[1], this.detectFolder(fullText));
        }

        // After 'take' - suggest numbers
        if (linePrefix.match(/\|\s*take\s+$/i)) {
            return this.getTakeCompletions();
        }

        // After 'and' or 'or' in where clause - suggest fields
        if (linePrefix.match(/\|\s*where\s+.+\s+(and|or)\s+$/i)) {
            return this.getFieldCompletions(this.detectFolder(fullText));
        }

        // Default completions - always include folders when on a line that looks like start of query
        const folder = this.detectFolder(fullText);

        // If we're on a line without a pipe and no folder detected yet, include folders
        if (!linePrefix.includes('|') && !this.hasFolderOnLine(linePrefix)) {
            items.push(...this.getFolderCompletions());
        }

        items.push(...this.getOperatorCompletions());
        items.push(...this.getFieldCompletions(folder));
        items.push(...this.getSnippetCompletions());

        return items;
    }

    private isAtQueryStart(text: string, linePrefix: string): boolean {
        const trimmed = text.trim();

        // Empty document
        if (!trimmed) {
            return true;
        }

        // Only comments before cursor
        if (trimmed.split('\n').every(line => line.trim().startsWith('//') || line.trim().startsWith('--') || line.trim() === '')) {
            return true;
        }

        // Current line is empty or only has partial text that could be a folder name
        const lineTrimmed = linePrefix.trim();
        if (!lineTrimmed || (!lineTrimmed.includes('|') && !this.hasFolderOnLine(linePrefix))) {
            // Check if any previous non-comment line has a folder - if not, we're at query start
            const lines = text.split('\n');
            const hasFolder = lines.some(line => {
                const t = line.trim();
                if (t.startsWith('//') || t.startsWith('--') || t === '') return false;
                return OQL_FOLDERS.some(f => t.toLowerCase().startsWith(f.name.toLowerCase()));
            });
            if (!hasFolder) {
                return true;
            }
        }

        return false;
    }

    private hasFolderOnLine(linePrefix: string): boolean {
        const trimmed = linePrefix.trim().toLowerCase();
        return OQL_FOLDERS.some(f => trimmed.startsWith(f.name.toLowerCase()) &&
            (trimmed.length === f.name.length || trimmed[f.name.length] === ' ' || trimmed[f.name.length] === '\t'));
    }

    private detectFolder(text: string): string {
        const lines = text.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('//')) continue;
            const folderMatch = trimmed.match(/^(\w+)/);
            if (folderMatch) {
                return folderMatch[1].toLowerCase();
            }
        }
        return 'inbox';
    }

    private isAfterFieldName(linePrefix: string): boolean {
        // After a field name with space but no operator yet
        return !!linePrefix.match(/\b(Subject|From|SenderEmail|To|CC|ReceivedTime|SentTime|HasAttachments|AttachmentCount|Importance|UnRead|Body|BodyPreview|Categories|Size|ConversationTopic|Start|End|Location|Organizer|IsRecurring|RecurrenceState|BusyStatus|AllDayEvent|RequiredAttendees|OptionalAttendees|FullName|Email1Address|Email2Address|CompanyName|BusinessPhone|MobilePhone|JobTitle|Department|DueDate|StartDate|Status|PercentComplete|Owner|Name|ExecutionOrder|RuleType|Conditions|Actions|Exceptions|Enabled)\s+$/i);
    }

    private getFolderCompletions(): vscode.CompletionItem[] {
        return OQL_FOLDERS.map(folder => {
            const item = new vscode.CompletionItem(folder.name, vscode.CompletionItemKind.Class);
            item.detail = folder.description;
            item.insertText = folder.name;
            item.sortText = '0' + folder.name;
            return item;
        });
    }

    private getOperatorCompletions(): vscode.CompletionItem[] {
        return OQL_OPERATORS.map(op => {
            const item = new vscode.CompletionItem(op.name, vscode.CompletionItemKind.Keyword);
            item.detail = op.description;
            item.sortText = '0' + op.name;
            return item;
        });
    }

    private getFieldCompletions(folder: string): vscode.CompletionItem[] {
        let fields: Array<{ name: string; description: string; type: string }>;

        switch (folder) {
            case 'calendar':
                fields = CALENDAR_FIELDS;
                break;
            case 'contacts':
                fields = CONTACT_FIELDS;
                break;
            case 'tasks':
                fields = TASK_FIELDS;
                break;
            case 'rules':
                fields = RULES_FIELDS;
                break;
            default:
                fields = MAIL_FIELDS;
        }

        return fields.map(field => {
            const item = new vscode.CompletionItem(field.name, vscode.CompletionItemKind.Field);
            item.detail = `${field.description} (${field.type})`;
            item.sortText = '1' + field.name;
            return item;
        });
    }

    private getComparisonOperatorCompletions(): vscode.CompletionItem[] {
        return COMPARISON_OPERATORS.map(op => {
            const item = new vscode.CompletionItem(op.name, vscode.CompletionItemKind.Operator);
            item.detail = op.description;
            item.sortText = '0' + op.name;
            return item;
        });
    }

    private getValueCompletions(fieldName: string, folder: string): vscode.CompletionItem[] {
        const items: vscode.CompletionItem[] = [];
        const fieldLower = fieldName.toLowerCase();

        // Boolean fields
        if (['hasattachments', 'unread', 'isrecurring', 'alldayevent', 'enabled'].includes(fieldLower)) {
            return BOOL_VALUES.map(v => {
                const item = new vscode.CompletionItem(v, vscode.CompletionItemKind.Value);
                item.insertText = v;
                return item;
            });
        }

        // Importance field
        if (fieldLower === 'importance') {
            return IMPORTANCE_VALUES.map(v => {
                const item = new vscode.CompletionItem(v, vscode.CompletionItemKind.Value);
                item.insertText = `"${v}"`;
                return item;
            });
        }

        // Task status
        if (fieldLower === 'status' && folder === 'tasks') {
            return TASK_STATUS_VALUES.map(v => {
                const item = new vscode.CompletionItem(v, vscode.CompletionItemKind.Value);
                item.insertText = `"${v}"`;
                return item;
            });
        }

        // Busy status
        if (fieldLower === 'busystatus') {
            return BUSY_STATUS_VALUES.map(v => {
                const item = new vscode.CompletionItem(v, vscode.CompletionItemKind.Value);
                item.insertText = `"${v}"`;
                return item;
            });
        }

        // DateTime fields - suggest time functions
        if (['receivedtime', 'senttime', 'senton', 'start', 'end', 'duedate', 'startdate'].includes(fieldLower)) {
            return TIME_FUNCTIONS.map(fn => {
                const item = new vscode.CompletionItem(fn.name, vscode.CompletionItemKind.Function);
                item.detail = fn.description;
                return item;
            });
        }

        return items;
    }

    private getTakeCompletions(): vscode.CompletionItem[] {
        const suggestions = [10, 50, 100, 500, 1000];
        return suggestions.map(n => {
            const item = new vscode.CompletionItem(n.toString(), vscode.CompletionItemKind.Value);
            item.detail = `Limit to ${n} results`;
            return item;
        });
    }

    private getSnippetCompletions(): vscode.CompletionItem[] {
        const snippets = [
            {
                label: 'Recent Inbox',
                detail: 'Get recent inbox messages',
                insertText: 'Inbox\n| take 100'
            },
            {
                label: 'Search Subject',
                detail: 'Search emails by subject',
                insertText: 'Inbox\n| where Subject contains "${1:search term}"\n| take 100'
            },
            {
                label: 'Emails from Last Week',
                detail: 'Get emails from the past 7 days',
                insertText: 'Inbox\n| where ReceivedTime > ago(7d)\n| take 100'
            },
            {
                label: 'Unread Messages',
                detail: 'Get unread messages',
                insertText: 'Inbox\n| where UnRead == true\n| take 50'
            },
            {
                label: 'From Sender',
                detail: 'Find emails from a specific sender',
                insertText: 'Inbox\n| where From contains "${1:sender}"\n| take 100'
            },
            {
                label: 'Calendar Events',
                detail: 'Get calendar events',
                insertText: 'Calendar\n| take 50'
            },
            {
                label: 'Sent Items',
                detail: 'Get sent emails',
                insertText: 'SentMail\n| take 100'
            },
            {
                label: 'Contacts',
                detail: 'Get all contacts',
                insertText: 'Contacts\n| take 100'
            },
            {
                label: 'Tasks',
                detail: 'Get all tasks',
                insertText: 'Tasks\n| take 50'
            },
            {
                label: 'Combined Filters',
                detail: 'Multiple filter conditions',
                insertText: 'Inbox\n| where Subject contains "${1:keyword}"\n| where ReceivedTime > ago(30d)\n| take 50'
            },
            {
                label: 'Mail Rules',
                detail: 'Get Outlook mail rules',
                insertText: 'Rules\n| take 100'
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
}
