import * as vscode from 'vscode';

// KQL Documentation
const KQL_DOCS: Record<string, { description: string; syntax?: string; example?: string }> = {
    // Operators
    'where': {
        description: 'Filters rows based on a condition.',
        syntax: 'T | where predicate',
        example: 'StormEvents | where State == "FLORIDA"'
    },
    'project': {
        description: 'Selects which columns to include, rename or drop.',
        syntax: 'T | project Column1, Column2, ...',
        example: 'StormEvents | project EventId, State, EventType'
    },
    'extend': {
        description: 'Creates calculated columns and appends them to the result set.',
        syntax: 'T | extend Column = Expression',
        example: 'T | extend Duration = EndTime - StartTime'
    },
    'summarize': {
        description: 'Groups rows and calculates aggregations.',
        syntax: 'T | summarize Aggregation by GroupColumn',
        example: 'StormEvents | summarize count() by State'
    },
    'join': {
        description: 'Merges rows of two tables by matching values.',
        syntax: 'T1 | join kind=inner T2 on Column',
        example: 'T1 | join kind=left (T2) on Id'
    },
    'union': {
        description: 'Combines rows from two or more tables.',
        syntax: 'T1 | union T2',
        example: 'Table1 | union Table2, Table3'
    },
    'sort': {
        description: 'Sorts rows by one or more columns.',
        syntax: 'T | sort by Column [asc|desc]',
        example: 'T | sort by Timestamp desc'
    },
    'top': {
        description: 'Returns the first N rows sorted by specified columns.',
        syntax: 'T | top N by Column [asc|desc]',
        example: 'T | top 10 by Count desc'
    },
    'take': {
        description: 'Returns up to N rows.',
        syntax: 'T | take N',
        example: 'T | take 100'
    },
    'distinct': {
        description: 'Returns distinct combination of provided columns.',
        syntax: 'T | distinct Column1, Column2',
        example: 'T | distinct State, City'
    },
    'mv-expand': {
        description: 'Expands multi-value dynamic arrays into rows.',
        syntax: 'T | mv-expand Column',
        example: 'T | mv-expand Tags'
    },
    'parse': {
        description: 'Extracts values from string expressions.',
        syntax: 'T | parse Column with Pattern',
        example: 'T | parse Message with "Error: " ErrorCode " at " Location'
    },
    'render': {
        description: 'Renders results as a chart.',
        syntax: 'T | render ChartType',
        example: 'T | render timechart'
    },

    // Functions
    'count': {
        description: 'Returns the count of records.',
        syntax: 'count()',
        example: 'T | summarize count()'
    },
    'sum': {
        description: 'Returns the sum of values.',
        syntax: 'sum(Expression)',
        example: 'T | summarize sum(Amount)'
    },
    'avg': {
        description: 'Returns the average of values.',
        syntax: 'avg(Expression)',
        example: 'T | summarize avg(Duration)'
    },
    'min': {
        description: 'Returns the minimum value.',
        syntax: 'min(Expression)',
        example: 'T | summarize min(Timestamp)'
    },
    'max': {
        description: 'Returns the maximum value.',
        syntax: 'max(Expression)',
        example: 'T | summarize max(Timestamp)'
    },
    'dcount': {
        description: 'Returns an estimate of the number of distinct values.',
        syntax: 'dcount(Expression)',
        example: 'T | summarize dcount(UserId)'
    },
    'ago': {
        description: 'Returns a timespan representing time before now.',
        syntax: 'ago(duration)',
        example: 'where Timestamp > ago(1h)'
    },
    'now': {
        description: 'Returns the current UTC datetime.',
        syntax: 'now()',
        example: 'where Timestamp < now()'
    },
    'strcat': {
        description: 'Concatenates strings.',
        syntax: 'strcat(string1, string2, ...)',
        example: 'extend FullName = strcat(FirstName, " ", LastName)'
    },
    'tostring': {
        description: 'Converts a value to string.',
        syntax: 'tostring(value)',
        example: 'extend IdStr = tostring(Id)'
    },
    'toint': {
        description: 'Converts a value to integer.',
        syntax: 'toint(value)',
        example: 'extend Count = toint(CountStr)'
    },
    'iif': {
        description: 'Returns one of two values based on condition.',
        syntax: 'iif(condition, ifTrue, ifFalse)',
        example: 'extend Status = iif(Count > 0, "Active", "Inactive")'
    },
    'case': {
        description: 'Evaluates conditions and returns first matching result.',
        syntax: 'case(cond1, val1, cond2, val2, ..., default)',
        example: 'extend Level = case(Score > 90, "A", Score > 80, "B", "C")'
    },
    'bin': {
        description: 'Rounds values down to a multiple of bin size.',
        syntax: 'bin(value, binSize)',
        example: 'summarize count() by bin(Timestamp, 1h)'
    },
    'format_datetime': {
        description: 'Formats a datetime as a string.',
        syntax: 'format_datetime(datetime, format)',
        example: 'extend DateStr = format_datetime(Timestamp, "yyyy-MM-dd")'
    }
};

export class KqlHoverProvider implements vscode.HoverProvider {
    provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.Hover> {
        const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z_][a-zA-Z0-9_-]*/);
        if (!wordRange) {
            return null;
        }

        const word = document.getText(wordRange).toLowerCase();
        const doc = KQL_DOCS[word];

        if (!doc) {
            return null;
        }

        const markdown = new vscode.MarkdownString();
        markdown.appendMarkdown(`**${word}**\n\n`);
        markdown.appendMarkdown(`${doc.description}\n\n`);

        if (doc.syntax) {
            markdown.appendMarkdown(`**Syntax:**\n`);
            markdown.appendCodeblock(doc.syntax, 'kql');
        }

        if (doc.example) {
            markdown.appendMarkdown(`**Example:**\n`);
            markdown.appendCodeblock(doc.example, 'kql');
        }

        return new vscode.Hover(markdown, wordRange);
    }
}
