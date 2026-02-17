import * as vscode from 'vscode';
import { McpToolDiscovery } from './McpToolDiscovery';

/**
 * Parsed MCPQL query — client-side lightweight parse for tool invocation.
 */
export interface ParsedMcpQuery {
    serverName: string;
    toolName: string;
    parameters: Record<string, string | number | boolean>;
    hasPostProcessing: boolean;
    originalQuery: string;
}

/**
 * Handles MCP tool invocation on the extension side.
 * 
 * Flow:
 * 1. User writes MCPQL query and presses F5
 * 2. McpQueryExecutor parses the query to extract server/tool/params
 * 3. Invokes the MCP tool via vscode.lm.invokeTool()
 * 4. Sends the raw JSON result + original query to the sidecar
 * 5. Sidecar applies post-processing (where, project, take, sort) and returns QueryResult
 */
export class McpQueryExecutor implements vscode.Disposable {
    private _disposables: vscode.Disposable[] = [];

    constructor(private toolDiscovery: McpToolDiscovery) {}

    /**
     * Check if a query should be handled by MCP (quick check).
     */
    isMcpQuery(query: string): boolean {
        const trimmed = query.trim();
        // Pattern: identifier | identifier(...)  or  identifier.identifier(...)
        return /^\w[\w-]*\s*[|.]\s*\w[\w-]*\s*\(/.test(trimmed);
    }

    /**
     * Parse an MCPQL query to extract server name, tool name, and parameters.
     * This is a lightweight client-side parse — full parsing happens on the sidecar.
     */
    parseQuery(query: string): ParsedMcpQuery | null {
        const trimmed = query.trim();
        
        // Match: serverName | toolName(params) or serverName.toolName(params)
        const match = trimmed.match(/^(\w[\w-]*)\s*[|.]\s*(\w[\w-]*)\s*\(([\s\S]*?)\)/);
        if (!match) {
            return null;
        }

        const [, serverName, toolName, paramsStr] = match;
        const parameters = this.parseParameters(paramsStr);

        // Check if there's post-processing after the tool call
        const afterToolCall = trimmed.substring(match[0].length).trim();
        const hasPostProcessing = afterToolCall.startsWith('|');

        return {
            serverName,
            toolName,
            parameters,
            hasPostProcessing,
            originalQuery: query
        };
    }

    /**
     * Execute an MCP tool invocation via VS Code's Language Model Tools API.
     * Returns the raw JSON result string.
     */
    async executeTool(parsed: ParsedMcpQuery): Promise<string> {
        // Find the matching VS Code tool
        const vsCodeToolName = this.resolveToolName(parsed.serverName, parsed.toolName);
        
        if (!vsCodeToolName) {
            throw new Error(`MCP tool not found: ${parsed.serverName}.${parsed.toolName}. ` +
                `Make sure the MCP server is configured in .vscode/mcp.json and running.`);
        }

        // Invoke the tool using VS Code's API
        try {
            const result = await vscode.lm.invokeTool(vsCodeToolName, {
                input: parsed.parameters,
                toolInvocationToken: undefined
            });

            // Extract text content from the tool result
            const textParts: string[] = [];
            for (const part of result.content) {
                if (part instanceof vscode.LanguageModelTextPart) {
                    textParts.push(part.value);
                }
            }

            const resultText = textParts.join('');
            
            // Try to parse as JSON; if it's already JSON, return as-is
            try {
                JSON.parse(resultText);
                return resultText;
            } catch {
                // If not valid JSON, wrap in a simple JSON structure
                return JSON.stringify([{ result: resultText }]);
            }
        } catch (err: any) {
            throw new Error(`MCP tool invocation failed: ${err.message || err}`);
        }
    }

    /**
     * Resolve the actual VS Code tool name from server + tool names.
     * Handles the mcp_serverName_toolName naming convention.
     */
    private resolveToolName(serverName: string, toolName: string): string | undefined {
        if (!vscode.lm?.tools) {
            return undefined;
        }

        const normalizedServer = serverName.replace(/-/g, '_');

        // Try exact tool name match first
        for (const tool of vscode.lm.tools) {
            if (tool.name === toolName) {
                return tool.name;
            }
        }

        // Try mcp_serverName_toolName pattern
        const mcpToolName = `mcp_${normalizedServer}_${toolName}`;
        for (const tool of vscode.lm.tools) {
            if (tool.name === mcpToolName) {
                return tool.name;
            }
        }

        // Try partial match: tool name contains the specified tool name
        for (const tool of vscode.lm.tools) {
            if (tool.name.toLowerCase().includes(normalizedServer.toLowerCase()) &&
                tool.name.toLowerCase().includes(toolName.toLowerCase())) {
                return tool.name;
            }
        }

        // Last resort: find any tool from the same server
        const serverTools = this.toolDiscovery.getToolsForServer(serverName);
        const matchedTool = serverTools.find(t => 
            t.toolName.toLowerCase().includes(toolName.toLowerCase())
        );
        return matchedTool?.toolName;
    }

    /**
     * Parse MCPQL parameter string into a key-value map.
     * Handles: param='value', param=123, param=true
     */
    private parseParameters(paramsStr: string): Record<string, string | number | boolean> {
        const params: Record<string, string | number | boolean> = {};
        if (!paramsStr.trim()) {
            return params;
        }

        // Split by commas (not inside quotes)
        const parts = this.splitParams(paramsStr);

        for (const part of parts) {
            const eqIndex = part.indexOf('=');
            if (eqIndex < 0) continue;

            const key = part.substring(0, eqIndex).trim();
            let value = part.substring(eqIndex + 1).trim();

            // Parse value type
            if ((value.startsWith("'") && value.endsWith("'")) ||
                (value.startsWith('"') && value.endsWith('"'))) {
                params[key] = value.slice(1, -1);
            } else if (value === 'true') {
                params[key] = true;
            } else if (value === 'false') {
                params[key] = false;
            } else if (!isNaN(Number(value))) {
                params[key] = Number(value);
            } else {
                params[key] = value;
            }
        }

        return params;
    }

    /**
     * Split parameter string by commas, respecting quoted values.
     */
    private splitParams(input: string): string[] {
        const parts: string[] = [];
        let current = '';
        let inQuote = false;
        let quoteChar = '';

        for (let i = 0; i < input.length; i++) {
            const ch = input[i];
            if (inQuote) {
                current += ch;
                if (ch === quoteChar) {
                    inQuote = false;
                }
            } else if (ch === "'" || ch === '"') {
                inQuote = true;
                quoteChar = ch;
                current += ch;
            } else if (ch === ',') {
                parts.push(current.trim());
                current = '';
            } else {
                current += ch;
            }
        }

        if (current.trim()) {
            parts.push(current.trim());
        }

        return parts;
    }

    dispose(): void {
        this._disposables.forEach(d => d.dispose());
    }
}
