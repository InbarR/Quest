import * as vscode from 'vscode';
import { SidecarClient } from '../../sidecar/SidecarClient';
import { McpqlCompletionProvider } from './mcpqlCompletionProvider';

export function registerMcpqlLanguage(
    context: vscode.ExtensionContext,
    client: SidecarClient,
    getServerNames: () => string[],
    getToolsForServer: (serverName: string) => { toolName: string; description: string; parameters: { name: string; type: string; description: string; required: boolean }[] }[]
) {
    const completionProvider = new McpqlCompletionProvider(getServerNames, getToolsForServer);

    // Register for file scheme
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            { language: 'mcpql', scheme: 'file' },
            completionProvider
        )
    );

    // Register for untitled scheme (new unsaved files)
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            { language: 'mcpql', scheme: 'untitled' },
            completionProvider
        )
    );

    // Register for vscode-userdata scheme
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            { language: 'mcpql', scheme: 'vscode-userdata' },
            completionProvider
        )
    );

    // Register with specific triggers
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            { language: 'mcpql' },
            completionProvider,
            '|', '.', ' ', '('
        )
    );

    // Register document formatting
    context.subscriptions.push(
        vscode.languages.registerDocumentFormattingEditProvider(
            { language: 'mcpql' },
            {
                provideDocumentFormattingEdits(document: vscode.TextDocument): vscode.TextEdit[] {
                    return formatMcpqlDocument(document);
                }
            }
        )
    );

    // Register hover provider
    context.subscriptions.push(
        vscode.languages.registerHoverProvider(
            { language: 'mcpql' },
            {
                provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | null {
                    return provideMcpqlHover(document, position, getServerNames, getToolsForServer);
                }
            }
        )
    );
}

function formatMcpqlDocument(document: vscode.TextDocument): vscode.TextEdit[] {
    const edits: vscode.TextEdit[] = [];
    const text = document.getText();

    // Formatting rules for MCPQL
    let formatted = text
        // Ensure post-processing pipes are on new lines (but not the first pipe in source)
        .replace(/\)\s*\|\s*(where|project|take|sort|count|extend)\b/g, ')\n| $1')
        .replace(/\|\s*(where|project|take|sort|count|extend)\b/g, '\n| $1')
        // Don't break the source pipe: server | tool(...)
        .replace(/\n\|\s*(\w[\w-]*\s*\()/g, ' | $1')
        // Clean up multiple spaces
        .replace(/  +/g, ' ')
        // Clean up multiple newlines
        .replace(/\n\n+/g, '\n\n')
        // Trim trailing whitespace per line
        .replace(/[ \t]+$/gm, '')
        // Ensure first line doesn't start with newline
        .replace(/^\n+/, '');

    if (formatted !== text) {
        const fullRange = new vscode.Range(
            document.positionAt(0),
            document.positionAt(text.length)
        );
        edits.push(vscode.TextEdit.replace(fullRange, formatted));
    }

    return edits;
}

function provideMcpqlHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    getServerNames: () => string[],
    getToolsForServer: (name: string) => { toolName: string; description: string; parameters: { name: string; type: string; description: string; required: boolean }[] }[]
): vscode.Hover | null {
    const wordRange = document.getWordRangeAtPosition(position, /[\w-]+/);
    if (!wordRange) return null;

    const word = document.getText(wordRange);

    // Check if it's a server name
    const servers = getServerNames();
    if (servers.includes(word)) {
        const tools = getToolsForServer(word);
        const toolList = tools.map(t => `- \`${t.toolName}\`: ${t.description}`).join('\n');
        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**MCP Server: ${word}**\n\n`);
        md.appendMarkdown(`Available tools:\n${toolList || '_No tools discovered yet_'}`);
        return new vscode.Hover(md, wordRange);
    }

    // Check if it's a tool name
    for (const server of servers) {
        const tools = getToolsForServer(server);
        const tool = tools.find(t => t.toolName === word || t.toolName.endsWith(`_${word}`));
        if (tool) {
            const md = new vscode.MarkdownString();
            md.appendMarkdown(`**MCP Tool: ${tool.toolName}**\n\n`);
            md.appendMarkdown(`${tool.description}\n\n`);
            if (tool.parameters.length > 0) {
                md.appendMarkdown(`**Parameters:**\n`);
                for (const p of tool.parameters) {
                    const req = p.required ? ' *(required)*' : '';
                    md.appendMarkdown(`- \`${p.name}\` (${p.type})${req}: ${p.description}\n`);
                }
            }
            return new vscode.Hover(md, wordRange);
        }
    }

    // Check if it's a keyword
    const keywords: Record<string, string> = {
        'where': 'Filter rows by a condition.\n\nSyntax: `| where column == \'value\'`',
        'project': 'Select specific columns.\n\nSyntax: `| project col1, col2, col3`',
        'take': 'Limit the number of rows returned.\n\nSyntax: `| take 10`',
        'sort': 'Sort rows by a column.\n\nSyntax: `| sort by column [asc|desc]`',
        'count': 'Count total rows.\n\nSyntax: `| count`',
        'extend': 'Add a computed column.\n\nSyntax: `| extend newCol = expression`',
        'contains': 'String contains (case-insensitive).',
        'startswith': 'String starts with.',
        'endswith': 'String ends with.',
        'has': 'String contains (case-insensitive).',
    };

    if (keywords[word.toLowerCase()]) {
        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**${word}**\n\n${keywords[word.toLowerCase()]}`);
        return new vscode.Hover(md, wordRange);
    }

    return null;
}
