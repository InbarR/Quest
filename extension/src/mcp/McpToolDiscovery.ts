import * as vscode from 'vscode';
import { McpConfigLoader } from './McpConfigLoader';
import { SidecarClient } from '../sidecar/SidecarClient';

/**
 * Represents a discovered MCP tool's schema.
 */
export interface McpToolInfo {
    serverName: string;
    toolName: string;
    description: string;
    parameters: McpToolParam[];
}

export interface McpToolParam {
    name: string;
    type: string;
    description: string;
    required: boolean;
}

/**
 * Discovers MCP tools available in the workspace using VS Code's Language Model Tools API.
 * Maps discovered tools to server names from the MCP config.
 * Pushes tool schemas to the sidecar for completions.
 */
export class McpToolDiscovery implements vscode.Disposable {
    private _tools: McpToolInfo[] = [];
    private _disposables: vscode.Disposable[] = [];
    private _onToolsChanged = new vscode.EventEmitter<McpToolInfo[]>();
    public readonly onToolsChanged = this._onToolsChanged.event;
    private _sidecarClient?: SidecarClient;
    private _retryTimer?: ReturnType<typeof setTimeout>;
    private _retryCount = 0;
    private static readonly MAX_RETRIES = 18; // Retry for ~3 minutes (MCP servers can be slow to start)
    private static readonly RETRY_INTERVAL_MS = 10_000; // 10 seconds

    constructor(private configLoader: McpConfigLoader) {
        this._disposables.push(this._onToolsChanged);

        // Re-discover when config changes
        this._disposables.push(
            configLoader.onConfigChanged(() => this.discoverTools())
        );

        // Listen for vscode.lm.tools changes if the API supports it
        if (typeof vscode.lm !== 'undefined' && (vscode.lm as any).onDidChangeTools) {
            this._disposables.push(
                (vscode.lm as any).onDidChangeTools(() => {
                    console.log('[McpToolDiscovery] vscode.lm.tools changed, re-discovering');
                    this.discoverTools();
                })
            );
        }
    }

    /**
     * Set the sidecar client for fallback schema retrieval.
     */
    setSidecarClient(client: SidecarClient) {
        this._sidecarClient = client;
    }

    /**
     * Start periodic re-discovery to catch MCP tools that register after extension startup.
     * MCP servers may take several seconds to start and register their tools with VS Code.
     * Once tools are found (or max retries reached), the timer stops.
     */
    startPeriodicDiscovery(): void {
        this._retryCount = 0;
        this._scheduleRetry();
    }

    private _scheduleRetry(): void {
        if (this._retryTimer) {
            clearTimeout(this._retryTimer);
        }
        if (this._retryCount >= McpToolDiscovery.MAX_RETRIES) {
            return;
        }
        this._retryTimer = setTimeout(async () => {
            this._retryCount++;
            const before = this._tools.length;
            await this.discoverTools();
            const after = this._tools.length;
            if (after > before) {
                console.log(`[McpToolDiscovery] Periodic re-discovery found ${after - before} new tools (total: ${after})`);
            }
            // Keep retrying if no tools found yet
            if (this._tools.length === 0 && this._retryCount < McpToolDiscovery.MAX_RETRIES) {
                this._scheduleRetry();
            }
        }, McpToolDiscovery.RETRY_INTERVAL_MS);
    }

    /**
     * Manually trigger a full re-discovery cycle. Resets the retry counter and
     * re-runs discovery immediately. Useful when the user knows MCP servers
     * have just started or configuration has changed.
     */
    async manualRefresh(): Promise<McpToolInfo[]> {
        console.log('[McpToolDiscovery] Manual refresh triggered');
        this._retryCount = 0;
        const tools = await this.discoverTools();
        // If still no tools, restart periodic discovery to keep trying
        if (tools.length === 0) {
            this._scheduleRetry();
        }
        return tools;
    }

    /**
     * Get all discovered MCP tools.
     */
    get tools(): McpToolInfo[] {
        return this._tools;
    }

    /**
     * Get all known MCP server names (from discovered tools only — not config, since
     * config names may not match VS Code's internal MCP server names).
     */
    getServerNames(): string[] {
        return [...new Set(this._tools.map(t => t.serverName))];
    }

    /**
     * Get tools for a specific MCP server.
     */
    getToolsForServer(serverName: string): McpToolInfo[] {
        return this._tools.filter(t => t.serverName === serverName);
    }

    /**
     * Discover MCP tools using VS Code's Language Model Tools API.
     * Auto-discovers all MCP tools (mcp_ prefix) from vscode.lm.tools,
     * always inferring server names from actual tool name patterns.
     * Falls back to sidecar schema cache, then to config-based stubs.
     */
    async discoverTools(): Promise<McpToolInfo[]> {
        try {
            let newTools: McpToolInfo[] = [];

            // Source 1: VS Code's language model tools API
            if (typeof vscode.lm !== 'undefined' && vscode.lm.tools) {
                const vsCodeTools = vscode.lm.tools;

                // Step 1: Collect all MCP-prefixed tools
                const mcpRawTools: { vsCodeName: string; tool: vscode.LanguageModelToolInformation }[] = [];
                for (const tool of vsCodeTools) {
                    if (tool.name.startsWith('mcp_')) {
                        mcpRawTools.push({ vsCodeName: tool.name, tool });
                    }
                }

                if (mcpRawTools.length > 0) {
                    // Step 2: Always infer server names from the actual tool names.
                    // Config server names may not match what VS Code uses internally
                    // (e.g., config has "icm" but VS Code uses "icm" or "ICM").
                    const inferredNames = this.inferServerNames(mcpRawTools.map(t => t.vsCodeName));

                    // Step 3: Map each tool to a server + clean tool name
                    for (const { vsCodeName, tool } of mcpRawTools) {
                        const match = this.findServerForTool(vsCodeName, inferredNames);
                        if (!match) {
                            continue;
                        }

                        const params = this.extractParameters(tool);
                        newTools.push({
                            serverName: match.serverName,
                            toolName: match.mcpqlToolName,
                            description: tool.description || '',
                            parameters: params
                        });
                    }

                    console.log(`[McpToolDiscovery] Found ${newTools.length} tools from vscode.lm.tools (${mcpRawTools.length} raw mcp_ tools, servers: ${inferredNames.join(', ')})`);
                }
            }

            // Source 2: If no tools from vscode.lm.tools, try the sidecar schema cache.
            // Only use sidecar results that have real tool descriptions (not stubs).
            if (newTools.length === 0 && this._sidecarClient) {
                try {
                    const sidecarTools = await this.getToolsFromSidecar();
                    // Filter out stub entries (stubs have toolName ending with "_tools" and generic descriptions)
                    const realTools = sidecarTools.filter(t =>
                        !t.toolName.endsWith('_tools') || t.description.length > 50
                    );
                    if (realTools.length > 0) {
                        newTools = realTools;
                        console.log(`[McpToolDiscovery] Sidecar fallback: ${realTools.length} tools`);
                    }
                } catch {
                    // Sidecar might not be ready yet
                }
            }

            // Source 3: If still no tools, generate stub entries from MCP config.
            // This gives the AI at least the server names so it can inform the user
            // which servers are configured, even before the servers fully start.
            if (newTools.length === 0) {
                const configStubs = this.getToolsFromConfig();
                if (configStubs.length > 0) {
                    newTools = configStubs;
                    console.log(`[McpToolDiscovery] Config stub fallback: ${configStubs.length} server stubs from ${[...new Set(configStubs.map(t => t.serverName))].join(', ')}`);
                }
            }

            // Only update cache if we got REAL results, or if cache was empty.
            // Never downgrade from real tools to stubs.
            if (newTools.length > 0) {
                const currentHasRealTools = this._tools.some(t => !t.description.startsWith('[stub]'));
                const newHasRealTools = newTools.some(t => !t.description.startsWith('[stub]'));

                // Upgrade: stubs → real tools (always accept)
                // Same level: accept if different
                // Downgrade: real → stubs (reject, keep cached)
                if (newHasRealTools || !currentHasRealTools) {
                    if (newTools.length !== this._tools.length || !this._toolsEqual(newTools, this._tools)) {
                        this._tools = newTools;
                        this._onToolsChanged.fire(this._tools);
                    }
                }
            }
            // If newTools is empty but we have cached tools, keep the cache

            return this._tools;
        } catch (err) {
            console.error('MCP tool discovery failed:', err);
            return this._tools; // Return cached tools on error instead of empty
        }
    }

    /**
     * Generate stub tool entries from the MCP configuration (.vscode/mcp.json or VS Code settings).
     * These stubs contain only the server name, giving the AI enough context to
     * know which servers are configured. The actual tool names will be discovered
     * later when the MCP servers start.
     */
    private getToolsFromConfig(): McpToolInfo[] {
        const serverNames = this.configLoader.serverNames;
        if (serverNames.length === 0) {
            return [];
        }

        return serverNames.map(name => ({
            serverName: name,
            toolName: `${name}_tools`,
            description: `[stub] MCP server "${name}" is configured but tools have not been discovered yet. The server may still be starting. Try "Quest: Refresh MCP Tools" or wait a moment.`,
            parameters: []
        }));
    }

    /**
     * Quick check if two tool arrays represent the same set.
     */
    private _toolsEqual(a: McpToolInfo[], b: McpToolInfo[]): boolean {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (a[i].serverName !== b[i].serverName || a[i].toolName !== b[i].toolName) return false;
        }
        return true;
    }

    /**
     * Retrieve MCP tool schemas from the sidecar's cached schema.
     * This is a fallback when vscode.lm.tools doesn't have the tools.
     */
    private async getToolsFromSidecar(): Promise<McpToolInfo[]> {
        if (!this._sidecarClient) {
            return [];
        }

        const result = await this._sidecarClient.getMcpSchema();
        if (!result?.servers) {
            return [];
        }

        const tools: McpToolInfo[] = [];
        for (const [serverName, serverTools] of Object.entries(result.servers)) {
            if (!Array.isArray(serverTools)) continue;
            for (const tool of serverTools) {
                tools.push({
                    serverName,
                    toolName: tool.name || (tool as any).toolName || '',
                    description: tool.description || '',
                    parameters: (tool.parameters || []).map((p: any) => ({
                        name: p.name || '',
                        type: p.type || 'string',
                        description: p.description || '',
                        required: p.required || false
                    }))
                });
            }
        }

        return tools;
    }

    /**
     * Infer MCP server names from tool name patterns when no config is available.
     * VS Code MCP tools follow: mcp_<serverName>_<toolName>
     * Server names may contain underscores (e.g., "azure_mcp" → tools named "mcp_azure_mcp_<tool>").
     * 
     * Algorithm: find the longest common prefix segments shared by multiple tools.
     * If there are tool names like mcp_azure_mcp_cosmos, mcp_azure_mcp_aks, mcp_azure_mcp_sql,
     * the common server prefix is "azure_mcp".
     * For a single tool like mcp_github_list_issues, the server is "github".
     */
    private inferServerNames(toolNames: string[]): string[] {
        if (toolNames.length === 0) {
            return [];
        }

        // Strip 'mcp_' prefix and split into segments
        const stripped = toolNames.map(n => n.substring(4)); // remove 'mcp_'
        const segmented = stripped.map(n => n.split('_'));

        // Group tools by their first segment as an initial server candidate
        const groups = new Map<string, string[][]>();
        for (const segs of segmented) {
            const firstSeg = segs[0];
            if (!groups.has(firstSeg)) {
                groups.set(firstSeg, []);
            }
            groups.get(firstSeg)!.push(segs);
        }

        const serverNames: string[] = [];
        for (const [, groupSegs] of groups) {
            if (groupSegs.length === 1) {
                // Single tool: server name is the first segment
                serverNames.push(groupSegs[0][0]);
            } else {
                // Multiple tools: find the longest common prefix
                // The common prefix is the server name, the remainder is the tool name
                const prefix = this.longestCommonPrefix(groupSegs);
                // The prefix must leave at least 1 segment for the tool name
                const serverSegCount = Math.max(1, prefix.length - 1);
                const serverName = groupSegs[0].slice(0, serverSegCount).join('_');
                if (!serverNames.includes(serverName)) {
                    serverNames.push(serverName);
                }
            }
        }

        return serverNames;
    }

    /**
     * Find the longest common prefix segments among arrays of segments.
     */
    private longestCommonPrefix(segmentArrays: string[][]): string[] {
        if (segmentArrays.length === 0) return [];
        const first = segmentArrays[0];
        const prefix: string[] = [];
        for (let i = 0; i < first.length; i++) {
            if (segmentArrays.every(segs => i < segs.length && segs[i] === first[i])) {
                prefix.push(first[i]);
            } else {
                break;
            }
        }
        return prefix;
    }

    /**
     * Try to match a VS Code tool name to a known server.
     * VS Code MCP tools follow the pattern: mcp_serverName_toolName
     * Returns both the server name and the clean MCPQL tool name (with prefix stripped).
     */
    private findServerForTool(toolName: string, serverNames: string[]): { serverName: string; mcpqlToolName: string } | undefined {
        // Sort servers by name length descending so longer/more specific names match first
        // e.g., "azure_mcp" should match before "azure"
        const sortedServers = [...serverNames].sort((a, b) => b.length - a.length);

        for (const server of sortedServers) {
            const prefix = `mcp_${server}_`;
            if (toolName.startsWith(prefix)) {
                const mcpqlToolName = toolName.substring(prefix.length);
                if (mcpqlToolName.length > 0) {
                    return { serverName: server, mcpqlToolName };
                }
            }
            // Also check with hyphens converted to underscores
            const normalizedServer = server.replace(/-/g, '_');
            if (normalizedServer !== server) {
                const normalizedPrefix = `mcp_${normalizedServer}_`;
                if (toolName.startsWith(normalizedPrefix)) {
                    const mcpqlToolName = toolName.substring(normalizedPrefix.length);
                    if (mcpqlToolName.length > 0) {
                        return { serverName: server, mcpqlToolName };
                    }
                }
            }
        }

        // Fallback: extract first segment after mcp_ as server, rest as tool
        const stripped = toolName.substring(4); // remove 'mcp_'
        const firstUnderscore = stripped.indexOf('_');
        if (firstUnderscore > 0) {
            return {
                serverName: stripped.substring(0, firstUnderscore),
                mcpqlToolName: stripped.substring(firstUnderscore + 1)
            };
        }

        return undefined;
    }

    /**
     * Extract parameter information from a VS Code LanguageModelToolInformation.
     */
    private extractParameters(tool: vscode.LanguageModelToolInformation): McpToolParam[] {
        const params: McpToolParam[] = [];

        try {
            // The inputSchema is a JSON Schema object
            const schema = tool.inputSchema;
            if (schema && typeof schema === 'object' && 'properties' in schema) {
                const properties = (schema as any).properties || {};
                const required = (schema as any).required || [];

                for (const [name, propSchema] of Object.entries(properties)) {
                    const prop = propSchema as any;
                    params.push({
                        name,
                        type: prop.type || 'string',
                        description: prop.description || '',
                        required: required.includes(name)
                    });
                }
            }
        } catch {
            // Silently handle schema parsing errors
        }

        return params;
    }

    /**
     * Convert discovered tools to the format expected by the sidecar's mcp/setSchema RPC.
     */
    toSchemaPayload(): { serverName: string; toolName: string; description: string; parameters: { name: string; type: string; description: string; required: boolean }[] }[] {
        return this._tools.map(t => ({
            serverName: t.serverName,
            toolName: t.toolName,
            description: t.description,
            parameters: t.parameters
        }));
    }

    dispose(): void {
        if (this._retryTimer) {
            clearTimeout(this._retryTimer);
        }
        this._disposables.forEach(d => d.dispose());
    }
}
