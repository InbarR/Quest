import * as vscode from 'vscode';

// Post-processing operators available in MCPQL
const MCPQL_OPERATORS = [
    { name: 'where', description: 'Filter rows by a condition' },
    { name: 'project', description: 'Select specific columns to display' },
    { name: 'take', description: 'Limit the number of returned rows' },
    { name: 'sort', description: 'Sort rows by a column' },
    { name: 'count', description: 'Count total rows' },
    { name: 'extend', description: 'Add a computed column' },
];

const COMPARISON_OPERATORS = [
    { name: '==', description: 'Equal to' },
    { name: '!=', description: 'Not equal to' },
    { name: '>', description: 'Greater than' },
    { name: '<', description: 'Less than' },
    { name: '>=', description: 'Greater than or equal' },
    { name: '<=', description: 'Less than or equal' },
    { name: 'contains', description: 'String contains (case-insensitive)' },
    { name: 'startswith', description: 'String starts with' },
    { name: 'endswith', description: 'String ends with' },
    { name: 'has', description: 'String contains word' },
    { name: 'matches', description: 'Regex match' },
];

const LOGICAL_OPERATORS = [
    { name: 'and', description: 'Logical AND — combine conditions' },
    { name: 'or', description: 'Logical OR — alternative conditions' },
    { name: 'not', description: 'Logical NOT — negate condition' },
];

interface McpToolInfo {
    toolName: string;
    description: string;
    parameters: { name: string; type: string; description: string; required: boolean }[];
}

export class McpqlCompletionProvider implements vscode.CompletionItemProvider {
    constructor(
        private getServerNames: () => string[],
        private getToolsForServer: (serverName: string) => McpToolInfo[]
    ) {}

    provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken,
        _context: vscode.CompletionContext
    ): vscode.CompletionItem[] {
        const items: vscode.CompletionItem[] = [];
        const linePrefix = document.lineAt(position).text.substring(0, position.character);
        const fullText = document.getText(new vscode.Range(new vscode.Position(0, 0), position));

        // At query start — suggest server names and snippets
        if (this.isAtQueryStart(fullText, linePrefix)) {
            items.push(...this.getServerCompletions());
            items.push(...this.getSnippetCompletions());
            return items;
        }

        // After pipe with no keyword yet — suggest operators or tool name
        if (linePrefix.match(/\|\s*$/)) {
            const server = this.detectServer(fullText);
            const hasTool = this.detectTool(fullText);
            if (server && !hasTool) {
                // First pipe after server — suggest tools
                items.push(...this.getToolCompletions(server));
            }
            // Always suggest post-processing operators after pipe
            items.push(...this.getOperatorCompletions());
            return items;
        }

        // After dot (server.tool syntax) — suggest tools
        const dotMatch = linePrefix.match(/([\w-]+)\.\s*$/);
        if (dotMatch) {
            return this.getToolCompletions(dotMatch[1]);
        }

        // Inside parentheses — suggest parameters
        const parenContext = this.getParenContext(linePrefix, fullText);
        if (parenContext) {
            return this.getParameterCompletions(parenContext.server, parenContext.tool, parenContext.usedParams);
        }

        // After 'where' keyword — suggest column names (from discovered tool schema)
        if (linePrefix.match(/\|\s*where\s+$/i)) {
            return this.getColumnCompletions(fullText);
        }

        // After 'and'/'or' in where clause — suggest column names
        if (linePrefix.match(/\|\s*where\s+.+\s+(and|or)\s+$/i)) {
            return this.getColumnCompletions(fullText);
        }

        // After 'project' — suggest column names
        if (linePrefix.match(/\|\s*project\s+$/i) || linePrefix.match(/\|\s*project\s+[\w,\s]*,\s*$/i)) {
            return this.getColumnCompletions(fullText);
        }

        // After 'sort by' — suggest column names
        if (linePrefix.match(/\|\s*sort\s+by\s+$/i) || linePrefix.match(/\|\s*sort\s+$/i)) {
            items.push(...this.getColumnCompletions(fullText));
            // Also suggest 'by' keyword if just 'sort'
            if (linePrefix.match(/\|\s*sort\s+$/i)) {
                const byItem = new vscode.CompletionItem('by', vscode.CompletionItemKind.Keyword);
                byItem.detail = 'Sort direction keyword';
                byItem.sortText = '0by';
                items.push(byItem);
            }
            return items;
        }

        // After column name in sort — suggest asc/desc
        if (linePrefix.match(/\|\s*sort\s+by\s+\w+\s+$/i)) {
            return this.getSortDirectionCompletions();
        }

        // After 'take' — suggest numbers
        if (linePrefix.match(/\|\s*take\s+$/i)) {
            return this.getTakeCompletions();
        }

        // After 'extend' — suggest column name pattern
        if (linePrefix.match(/\|\s*extend\s+$/i)) {
            return this.getExtendCompletions();
        }

        // After a field name — suggest comparison operators
        if (this.isAfterColumnName(linePrefix, fullText)) {
            return this.getComparisonOperatorCompletions();
        }

        // Default: offer everything contextually
        items.push(...this.getOperatorCompletions());
        if (!linePrefix.includes('|')) {
            items.push(...this.getServerCompletions());
        }
        items.push(...this.getSnippetCompletions());

        return items;
    }

    private isAtQueryStart(text: string, linePrefix: string): boolean {
        const trimmed = text.trim();
        if (!trimmed) return true;

        // Only comments before cursor
        if (trimmed.split('\n').every(line =>
            line.trim().startsWith('//') || line.trim() === ''
        )) {
            return true;
        }

        const lineTrimmed = linePrefix.trim();
        if (!lineTrimmed || (!lineTrimmed.includes('|') && !lineTrimmed.includes('.'))) {
            const lines = text.split('\n');
            const hasServer = lines.some(line => {
                const t = line.trim();
                if (t.startsWith('//') || t === '') return false;
                return this.getServerNames().some(s =>
                    t.toLowerCase().startsWith(s.toLowerCase())
                );
            });
            if (!hasServer) return true;
        }
        return false;
    }

    private detectServer(text: string): string | null {
        const lines = text.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('//')) continue;
            // Match: servername | tool(...) or servername.tool(...)
            const pipeMatch = trimmed.match(/^([\w-]+)\s*\|/);
            if (pipeMatch) return pipeMatch[1];
            const dotMatch = trimmed.match(/^([\w-]+)\./);
            if (dotMatch) return dotMatch[1];
            // Just server name alone
            const nameMatch = trimmed.match(/^([\w-]+)\s*$/);
            if (nameMatch) {
                const servers = this.getServerNames();
                if (servers.includes(nameMatch[1])) return nameMatch[1];
            }
        }
        return null;
    }

    private detectTool(text: string): string | null {
        // Look for tool invocation: server | tool( or server.tool(
        const pipeToolMatch = text.match(/[\w-]+\s*\|\s*([\w-]+)\s*\(/);
        if (pipeToolMatch) return pipeToolMatch[1];
        const dotToolMatch = text.match(/[\w-]+\.([\w-]+)\s*\(/);
        if (dotToolMatch) return dotToolMatch[1];
        return null;
    }

    private getParenContext(linePrefix: string, fullText: string): { server: string; tool: string; usedParams: string[] } | null {
        // Check if we're inside a tool invocation parentheses
        // Pattern: server | tool(param1='val', param2=123, <cursor>
        // or: server.tool(param1='val', <cursor>
        const openParenIdx = linePrefix.lastIndexOf('(');
        if (openParenIdx === -1) return null;

        const closeParenIdx = linePrefix.lastIndexOf(')');
        if (closeParenIdx > openParenIdx) return null; // We're past the closing paren

        const beforeParen = linePrefix.substring(0, openParenIdx).trimEnd();
        // Extract tool name — it should be the last identifier before (
        const toolMatch = beforeParen.match(/([\w-]+)\s*$/);
        if (!toolMatch) return null;

        const toolName = toolMatch[1];
        const server = this.detectServer(fullText);
        if (!server) return null;

        // Find already-used parameter names
        const insideParen = linePrefix.substring(openParenIdx + 1);
        const usedParams: string[] = [];
        const paramRegex = /([\w-]+)\s*=/g;
        let match;
        while ((match = paramRegex.exec(insideParen)) !== null) {
            usedParams.push(match[1]);
        }

        return { server, tool: toolName, usedParams };
    }

    private isAfterColumnName(linePrefix: string, fullText: string): boolean {
        // After a word followed by space in a where context
        if (linePrefix.match(/\|\s*where\s+.+\s+(and|or)\s+\w+\s+$/i)) return true;
        if (linePrefix.match(/\|\s*where\s+\w+\s+$/i)) return true;
        return false;
    }

    // ---- Completion generators ----

    private getServerCompletions(): vscode.CompletionItem[] {
        return this.getServerNames().map(name => {
            const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Module);
            item.detail = `MCP Server: ${name}`;
            item.insertText = name;
            item.sortText = '0' + name;
            return item;
        });
    }

    private getToolCompletions(serverName: string): vscode.CompletionItem[] {
        const tools = this.getToolsForServer(serverName);
        return tools.map(tool => {
            const item = new vscode.CompletionItem(tool.toolName, vscode.CompletionItemKind.Function);
            item.detail = tool.description;

            // Build snippet with required params
            const requiredParams = tool.parameters.filter(p => p.required);
            if (requiredParams.length > 0) {
                const paramSnippets = requiredParams.map((p, i) =>
                    `${p.name}='\${${i + 1}:${p.type === 'string' ? p.name : p.type}}'`
                );
                item.insertText = new vscode.SnippetString(`${tool.toolName}(${paramSnippets.join(', ')})`);
            } else {
                item.insertText = new vscode.SnippetString(`${tool.toolName}($0)`);
            }

            item.sortText = '0' + tool.toolName;
            return item;
        });
    }

    private getParameterCompletions(serverName: string, toolName: string, usedParams: string[]): vscode.CompletionItem[] {
        const tools = this.getToolsForServer(serverName);
        const tool = tools.find(t => t.toolName === toolName || t.toolName.endsWith(`_${toolName}`));
        if (!tool) return [];

        return tool.parameters
            .filter(p => !usedParams.includes(p.name))
            .map(p => {
                const item = new vscode.CompletionItem(p.name, vscode.CompletionItemKind.Property);
                item.detail = `${p.description} (${p.type})${p.required ? ' — required' : ''}`;
                if (p.type === 'string') {
                    item.insertText = new vscode.SnippetString(`${p.name}='\${1}'`);
                } else if (p.type === 'boolean') {
                    item.insertText = new vscode.SnippetString(`${p.name}=\${1|true,false|}`);
                } else if (p.type === 'number' || p.type === 'integer') {
                    item.insertText = new vscode.SnippetString(`${p.name}=\${1:0}`);
                } else {
                    item.insertText = new vscode.SnippetString(`${p.name}=\${1}`);
                }
                // Sort required params first
                item.sortText = (p.required ? '0' : '1') + p.name;
                return item;
            });
    }

    private getColumnCompletions(fullText: string): vscode.CompletionItem[] {
        // Columns come from tool parameters and any previously seen result columns
        const server = this.detectServer(fullText);
        const toolName = this.detectTool(fullText);
        if (!server || !toolName) return [];

        const tools = this.getToolsForServer(server);
        const tool = tools.find(t => t.toolName === toolName || t.toolName.endsWith(`_${toolName}`));
        if (!tool) return [];

        // Use parameter names as potential column names (common pattern)
        return tool.parameters.map(p => {
            const item = new vscode.CompletionItem(p.name, vscode.CompletionItemKind.Field);
            item.detail = `Column: ${p.description} (${p.type})`;
            item.sortText = '1' + p.name;
            return item;
        });
    }

    private getOperatorCompletions(): vscode.CompletionItem[] {
        return MCPQL_OPERATORS.map(op => {
            const item = new vscode.CompletionItem(op.name, vscode.CompletionItemKind.Keyword);
            item.detail = op.description;
            item.sortText = '0' + op.name;
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

    private getSortDirectionCompletions(): vscode.CompletionItem[] {
        return [
            { name: 'asc', description: 'Ascending order' },
            { name: 'desc', description: 'Descending order' },
        ].map(d => {
            const item = new vscode.CompletionItem(d.name, vscode.CompletionItemKind.Keyword);
            item.detail = d.description;
            return item;
        });
    }

    private getTakeCompletions(): vscode.CompletionItem[] {
        return [10, 50, 100, 500, 1000].map(n => {
            const item = new vscode.CompletionItem(n.toString(), vscode.CompletionItemKind.Value);
            item.detail = `Limit to ${n} results`;
            return item;
        });
    }

    private getExtendCompletions(): vscode.CompletionItem[] {
        const item = new vscode.CompletionItem('newColumn', vscode.CompletionItemKind.Snippet);
        item.detail = 'Add a computed column';
        item.insertText = new vscode.SnippetString('${1:columnName} = ${2:expression}');
        return [item];
    }

    private getSnippetCompletions(): vscode.CompletionItem[] {
        const servers = this.getServerNames();
        if (servers.length === 0) {
            // Provide a generic template snippet
            return [{
                label: 'MCPQL Query Template',
                detail: 'Basic MCPQL query template',
                insertText: '${1:server} | ${2:tool}(${3:params})\n| take 10'
            }].map(s => {
                const item = new vscode.CompletionItem(s.label, vscode.CompletionItemKind.Snippet);
                item.detail = s.detail;
                item.insertText = new vscode.SnippetString(s.insertText);
                item.sortText = '2' + s.label;
                return item;
            });
        }

        const snippets: { label: string; detail: string; insertText: string }[] = [];

        for (const server of servers.slice(0, 3)) { // Limit to first 3 servers
            const tools = this.getToolsForServer(server);
            for (const tool of tools.slice(0, 2)) { // First 2 tools per server
                const requiredParams = tool.parameters.filter(p => p.required);
                let paramStr: string;
                if (requiredParams.length > 0) {
                    const parts = requiredParams.map((p, i) =>
                        `${p.name}='\${${i + 1}:${p.name}}'`
                    );
                    paramStr = parts.join(', ');
                } else {
                    paramStr = '';
                }
                snippets.push({
                    label: `${server} → ${tool.toolName}`,
                    detail: tool.description,
                    insertText: `${server} | ${tool.toolName}(${paramStr})\n| take 10`
                });
            }
        }

        return snippets.map(s => {
            const item = new vscode.CompletionItem(s.label, vscode.CompletionItemKind.Snippet);
            item.detail = s.detail;
            item.insertText = new vscode.SnippetString(s.insertText);
            item.sortText = '2' + s.label;
            return item;
        });
    }
}
