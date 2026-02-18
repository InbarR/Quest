import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

/**
 * MCP server configuration as defined in .vscode/mcp.json
 * Follows the standard VS Code MCP settings format.
 */
export interface McpServerConfig {
    command: string;
    args?: string[];
    env?: Record<string, string>;
}

export interface McpConfig {
    servers: Record<string, McpServerConfig>;
}

/**
 * Watches and loads MCP configuration from .vscode/mcp.json files in workspace folders.
 * Emits events when the configuration changes.
 */
export class McpConfigLoader implements vscode.Disposable {
    private _config: McpConfig = { servers: {} };
    private _watchers: vscode.FileSystemWatcher[] = [];
    private _onConfigChanged = new vscode.EventEmitter<McpConfig>();
    private _disposables: vscode.Disposable[] = [];

    public readonly onConfigChanged = this._onConfigChanged.event;

    constructor() {
        this._disposables.push(this._onConfigChanged);
    }

    /**
     * Initialize: load config from all workspace folders and start watching .vscode/mcp.json
     */
    async initialize(): Promise<void> {
        await this.loadAllConfigs();
        this.startWatching();
    }

    /**
     * Get the current merged MCP configuration across all workspace folders.
     */
    get config(): McpConfig {
        return this._config;
    }

    /**
     * Get all configured server names.
     */
    get serverNames(): string[] {
        return Object.keys(this._config.servers);
    }

    /**
     * Load MCP configurations from all workspace folders and VS Code settings, then merge.
     */
    private async loadAllConfigs(): Promise<void> {
        const mergedConfig: McpConfig = { servers: {} };

        // 1. Load from .vscode/mcp.json files in workspace folders
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders) {
            for (const folder of workspaceFolders) {
                const mcpJsonPath = path.join(folder.uri.fsPath, '.vscode', 'mcp.json');
                try {
                    const config = await this.loadConfigFile(mcpJsonPath);
                    if (config) {
                        // Merge servers (later folders override earlier ones for same server name)
                        Object.assign(mergedConfig.servers, config.servers);
                    }
                } catch (err) {
                    // Silently ignore missing/invalid files
                }
            }
        }

        // 2. Load from VS Code settings (workspace and user settings)
        // MCP servers can use different transports: stdio (command), sse (url), streamableHttp, etc.
        // Accept any server config entry, not just stdio ones with a 'command' property.
        try {
            const mcpSettings = vscode.workspace.getConfiguration('mcp');
            const settingsServers = mcpSettings.get<Record<string, any>>('servers');
            if (settingsServers && typeof settingsServers === 'object') {
                for (const [name, config] of Object.entries(settingsServers)) {
                    if (config && typeof config === 'object') {
                        // Accept any valid server config (stdio with command, sse with url, etc.)
                        mergedConfig.servers[name] = config as McpServerConfig;
                    }
                }
            }
        } catch {
            // Silently ignore settings read errors
        }

        this._config = mergedConfig;
        this._onConfigChanged.fire(this._config);
    }

    /**
     * Load a single MCP config file.
     */
    private async loadConfigFile(filePath: string): Promise<McpConfig | null> {
        try {
            if (!fs.existsSync(filePath)) {
                return null;
            }
            const content = fs.readFileSync(filePath, 'utf-8');
            const parsed = JSON.parse(content);

            // Validate structure
            if (!parsed || typeof parsed !== 'object') {
                return null;
            }

            // Support both { servers: {...} } and direct { "server-name": {...} } formats
            if (parsed.servers && typeof parsed.servers === 'object') {
                return parsed as McpConfig;
            }

            // Try treating the whole object as a servers map
            const hasServerEntries = Object.values(parsed).some(
                (v: any) => v && typeof v === 'object' && ('command' in v)
            );
            if (hasServerEntries) {
                return { servers: parsed };
            }

            return null;
        } catch {
            return null;
        }
    }

    /**
     * Start watching .vscode/mcp.json files and VS Code settings for changes.
     */
    private startWatching(): void {
        // Watch for mcp.json changes in all workspace folders
        const watcher = vscode.workspace.createFileSystemWatcher('**/.vscode/mcp.json');
        watcher.onDidCreate(() => this.loadAllConfigs());
        watcher.onDidChange(() => this.loadAllConfigs());
        watcher.onDidDelete(() => this.loadAllConfigs());
        this._watchers.push(watcher);

        // Watch for VS Code settings changes (mcp.servers)
        this._disposables.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('mcp')) {
                    this.loadAllConfigs();
                }
            })
        );

        // Also watch for workspace folder changes
        this._disposables.push(
            vscode.workspace.onDidChangeWorkspaceFolders(() => {
                this.disposeWatchers();
                this.loadAllConfigs();
                this.startWatching();
            })
        );
    }

    private disposeWatchers(): void {
        this._watchers.forEach(w => w.dispose());
        this._watchers = [];
    }

    dispose(): void {
        this.disposeWatchers();
        this._disposables.forEach(d => d.dispose());
    }
}
