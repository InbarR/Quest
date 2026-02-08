import * as vscode from 'vscode';
import { Writable, Readable } from 'stream';
import * as readline from 'readline';

// Request/Response types
export interface HealthCheckResponse {
    status: 'ok' | 'error';
    version: string;
    timestamp: string;
}

export interface ClusterInfo {
    id: string;
    name: string;
    url: string;
    database: string;
    type: 'kusto' | 'ado' | 'outlook';
    isFavorite: boolean;
    organization?: string;
}

export interface PresetInfo {
    id: string;
    name: string;
    query: string;
    description?: string;  // User description of what this query does
    clusterUrl?: string;
    database?: string;
    type: 'kusto' | 'ado' | 'outlook';
    createdAt: string;
    isAutoSaved: boolean;
}

export interface QueryRequest {
    query: string;
    clusterUrl: string;
    database: string;
    type: 'kusto' | 'ado' | 'outlook';
    timeout?: number;
    maxResults?: number;
}

export interface QueryResult {
    success: boolean;
    columns: string[];
    rows: string[][];
    rowCount: number;
    executionTimeMs: number;
    error?: string;
}

export interface SchemaInfo {
    tables: TableInfo[];
}

export interface TableInfo {
    name: string;
    columns: ColumnInfo[];
}

export interface ColumnInfo {
    name: string;
    type: string;
}

export interface CompletionRequest {
    query: string;
    position: number;
    clusterUrl?: string;
    database?: string;
}

export interface CompletionItem {
    label: string;
    kind: string;
    detail?: string;
    insertText?: string;
}

export interface AiChatRequest {
    message: string;
    mode?: 'kusto' | 'ado' | 'outlook';  // Current query mode
    context?: {
        currentQuery?: string;
        clusterUrl?: string;
        database?: string;
        schema?: SchemaInfo;
        availableTables?: string[];  // List of table names from connected database
        favorites?: string[];  // Array of favorite query names and snippets
        recentQueries?: string[];  // Array of recent query snippets
        personaInstructions?: string;  // Custom persona system prompt
        systemPromptOverride?: string;  // Full system prompt override
    };
    sessionId?: string;
}

export interface AiChatResponse {
    message: string;
    sessionId: string;
    suggestedQuery?: string;
    authRequired?: boolean;
}

export interface ResultHistoryItem {
    id: string;
    query: string;
    title: string;
    clusterUrl?: string;
    database?: string;
    rowCount: number;
    executionTimeMs: number;
    success: boolean;
    error?: string;
    createdAt: string;
    type: 'kusto' | 'ado' | 'outlook';
    columns?: string[];
    sampleRows?: any[][];
    filePath?: string;
}

export interface MailPreviewResult {
    subject?: string;
    from?: string;
    fromEmail?: string;
    to?: string;
    cc?: string;
    receivedTime?: string;
    body?: string;
    htmlBody?: string;
    hasAttachments?: boolean;
    attachmentCount?: number;
    importance?: string;
    isRead?: boolean;
    error?: string;
}

export interface MarkReadResult {
    success: boolean;
    isRead: boolean;
    error?: string;
}

export interface ExtractDataSourceFromImageRequest {
    imageBase64: string;
    imageMimeType: string;
    mode: 'kusto' | 'ado';
}

export interface ExtractedDataSourceInfo {
    success: boolean;
    clusterUrl?: string;
    database?: string;
    displayName?: string;
    organization?: string;
    type: 'kusto' | 'ado';
    error?: string;
    confidence: number;
}

export interface KustoExplorerConnection {
    name: string;
    clusterUrl: string;
    database?: string;
}

export interface ImportKustoExplorerResponse {
    success: boolean;
    connections: KustoExplorerConnection[];
    error?: string;
}

export class SidecarClient {
    private stdin: Writable;
    private outputChannel: vscode.OutputChannel;
    private pendingRequests: Map<number, { resolve: (value: any) => void; reject: (error: any) => void }> = new Map();
    private nextId = 1;

    constructor(stdin: Writable, stdout: Readable, outputChannel: vscode.OutputChannel) {
        this.stdin = stdin;
        this.outputChannel = outputChannel;

        // Read newline-delimited JSON responses
        const rl = readline.createInterface({ input: stdout });
        rl.on('line', (line) => {
            if (!line.trim()) return;
            try {
                const response = JSON.parse(line);
                this.handleResponse(response);
            } catch (e) {
                this.outputChannel.appendLine(`Failed to parse response: ${line}`);
            }
        });
    }

    private handleResponse(response: any): void {
        if (response.id !== undefined) {
            const pending = this.pendingRequests.get(response.id);
            if (pending) {
                this.pendingRequests.delete(response.id);
                if (response.error) {
                    pending.reject(new Error(response.error.message || JSON.stringify(response.error)));
                } else {
                    pending.resolve(response.result);
                }
            }
        }
    }

    private sendRequest<T>(method: string, params?: any, timeoutMs: number = 30000): Promise<T> {
        return new Promise((resolve, reject) => {
            // Check if stream is still writable
            if (!this.stdin || this.stdin.destroyed || !this.stdin.writable) {
                reject(new Error('Server connection lost. Please reload VS Code.'));
                return;
            }

            const id = this.nextId++;
            const request = {
                jsonrpc: '2.0',
                id,
                method,
                params: params || {}
            };

            this.pendingRequests.set(id, { resolve, reject });

            const json = JSON.stringify(request) + '\n';
            try {
                this.stdin.write(json, (err) => {
                    if (err) {
                        this.pendingRequests.delete(id);
                        reject(new Error(`Failed to send request: ${err.message}`));
                    }
                });
            } catch (e) {
                this.pendingRequests.delete(id);
                reject(new Error(`Server connection error: ${e instanceof Error ? e.message : 'Unknown error'}`));
                return;
            }

            // Timeout (configurable per method)
            setTimeout(() => {
                if (this.pendingRequests.has(id)) {
                    this.pendingRequests.delete(id);
                    reject(new Error(`Request ${method} timed out after ${timeoutMs}ms`));
                }
            }, timeoutMs);
        });
    }

    // Health & Lifecycle
    async healthCheck(): Promise<HealthCheckResponse> {
        return this.sendRequest('health/check');
    }

    async shutdown(): Promise<void> {
        return this.sendRequest('shutdown');
    }

    // Cluster Management
    async getClusters(): Promise<ClusterInfo[]> {
        return this.sendRequest('cluster/list');
    }

    async addCluster(cluster: ClusterInfo): Promise<void> {
        return this.sendRequest('cluster/add', cluster);
    }

    async removeCluster(id: string): Promise<void> {
        return this.sendRequest('cluster/remove', { id });
    }

    async setClusterFavorite(id: string, favorite: boolean): Promise<void> {
        return this.sendRequest('cluster/setFavorite', { id, favorite });
    }

    async renameCluster(id: string, name: string): Promise<void> {
        return this.sendRequest('cluster/rename', { id, name });
    }

    // Preset Management
    async getPresets(): Promise<PresetInfo[]> {
        return this.sendRequest('preset/list');
    }

    async savePreset(preset: PresetInfo): Promise<void> {
        return this.sendRequest('preset/save', preset);
    }

    async deletePreset(id: string): Promise<void> {
        return this.sendRequest('preset/delete', { id });
    }

    async getHistory(limit: number = 100): Promise<PresetInfo[]> {
        return this.sendRequest('history/list', { limit });
    }

    async clearHistory(): Promise<{ cleared: number }> {
        return this.sendRequest('history/clear');
    }

    // Results History Management
    async getResultHistory(limit: number = 50): Promise<ResultHistoryItem[]> {
        return this.sendRequest('resultHistory/list', { limit });
    }

    async saveResultHistory(item: ResultHistoryItem): Promise<void> {
        return this.sendRequest('resultHistory/save', item);
    }

    async deleteResultHistory(id: string): Promise<void> {
        return this.sendRequest('resultHistory/delete', { id });
    }

    async clearResultHistory(): Promise<{ cleared: number }> {
        return this.sendRequest('resultHistory/clear');
    }

    // Query Execution (5 minute timeout for long-running queries)
    async executeQuery(request: QueryRequest): Promise<QueryResult> {
        return this.sendRequest('query/execute', request, 300000);
    }

    async cancelQuery(): Promise<void> {
        return this.sendRequest('query/cancel');
    }

    // Schema & Completions
    async getSchema(clusterUrl: string, database: string): Promise<SchemaInfo> {
        return this.sendRequest('schema/get', { clusterUrl, database });
    }

    async fetchSchema(clusterUrl: string, database: string, forceRefresh: boolean = false): Promise<{ success: boolean; tableCount: number; error?: string }> {
        return this.sendRequest('schema/fetch', { clusterUrl, database, forceRefresh });
    }

    async clearSchemaCache(clusterUrl?: string, database?: string): Promise<{ success: boolean }> {
        return this.sendRequest('schema/clearCache', { clusterUrl, database });
    }

    async getSchemaCacheStats(): Promise<{ totalCached: number; validCached: number; oldestCache?: string }> {
        return this.sendRequest('schema/cacheStats', {});
    }

    async getCompletions(request: CompletionRequest): Promise<CompletionItem[]> {
        return this.sendRequest('schema/completions', request);
    }

    // AI (longer timeout for AI requests - 120 seconds)
    async getSystemPrompt(mode: string): Promise<string> {
        const result = await this.sendRequest<{ systemPrompt: string }>('ai/getSystemPrompt', { mode });
        return result.systemPrompt;
    }

    async aiChat(request: AiChatRequest): Promise<AiChatResponse> {
        return this.sendRequest('ai/chat', request, 120000);
    }

    async aiGenerateTitle(query: string): Promise<string> {
        const result = await this.sendRequest<{ title: string }>('ai/generateTitle', { query });
        return result.title;
    }

    async extractDataSourceFromImage(request: ExtractDataSourceFromImageRequest): Promise<ExtractedDataSourceInfo> {
        return this.sendRequest('ai/extractFromImage', request, 60000);  // 60s timeout for vision
    }

    async clearAiToken(): Promise<{ success: boolean; error?: string }> {
        return this.sendRequest('ai/clearToken', {});
    }

    async setAiToken(token: string): Promise<{ success: boolean }> {
        return this.sendRequest('ai/setToken', { token });
    }

    // Import from Kusto Explorer
    async importFromKustoExplorer(filePath?: string): Promise<ImportKustoExplorerResponse> {
        return this.sendRequest('import/kustoExplorer', { filePath });
    }

    // Outlook
    async openOutlookItem(entryId: string): Promise<void> {
        return this.sendRequest('outlook/openItem', { entryId });
    }

    async getMailPreview(entryId: string): Promise<MailPreviewResult> {
        return this.sendRequest('outlook/getPreview', { entryId });
    }

    async markEmailRead(entryId: string, markAsRead: boolean): Promise<MarkReadResult> {
        return this.sendRequest('outlook/markRead', { entryId, markAsRead });
    }

    /**
     * Convenience method for sending AI messages with context
     */
    async sendAIMessage(
        message: string,
        context?: { currentQuery?: string; queryType?: 'kusto' | 'ado' }
    ): Promise<AiChatResponse> {
        return this.aiChat({
            message,
            context: context ? {
                currentQuery: context.currentQuery,
                clusterUrl: undefined,
                database: undefined
            } : undefined
        });
    }
}
