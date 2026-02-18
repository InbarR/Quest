import * as vscode from 'vscode';
import { SidecarClient, ClusterInfo } from '../sidecar/SidecarClient';

// Represents a cluster node (groups multiple databases)
export class ClusterTreeItem extends vscode.TreeItem {
    constructor(
        public readonly clusterUrl: string,
        public readonly clusterName: string,
        public readonly databases: ClusterInfo[],
        public readonly clusterType: 'kusto' | 'ado' | 'outlook' | 'mcp',
        public readonly hasActiveDatabase: boolean = false
    ) {
        super(clusterName, databases.length > 1
            ? vscode.TreeItemCollapsibleState.Expanded
            : vscode.TreeItemCollapsibleState.Collapsed);

        this.tooltip = clusterUrl;
        this.contextValue = 'cluster';

        // Set icon based on type and status
        let iconName: string;
        let iconColor: vscode.ThemeColor | undefined;

        if (hasActiveDatabase) {
            iconName = 'pass-filled';
            iconColor = new vscode.ThemeColor('charts.green');
        } else if (databases.some(d => d.isFavorite)) {
            iconName = 'star-full';
            iconColor = new vscode.ThemeColor('charts.yellow');
        } else {
            iconName = clusterType === 'kusto' ? 'server' : clusterType === 'mcp' ? 'plug' : 'organization';
        }

        this.iconPath = new vscode.ThemeIcon(iconName, iconColor);
    }
}

export class DatabaseTreeItem extends vscode.TreeItem {
    constructor(
        public readonly cluster: ClusterInfo,
        public readonly isActive: boolean = false,
        public readonly tableCount: number = 0,
        public readonly areaPath?: string,
        public readonly hasTableNames: boolean = false
    ) {
        // Expandable if: ADO with area path, or has loaded table names
        const collapsible = hasTableNames
            ? vscode.TreeItemCollapsibleState.Collapsed
            : (cluster.type === 'ado' && areaPath
                ? vscode.TreeItemCollapsibleState.Expanded
                : vscode.TreeItemCollapsibleState.None);
        super(cluster.database, collapsible);

        this.tooltip = `Database: ${cluster.database}\nCluster: ${cluster.url}`;
        // Use type-specific context value for different context menus
        this.contextValue = cluster.type === 'ado' ? 'adoDatabase' : 'database';

        let iconColor: vscode.ThemeColor | undefined;
        const parts: string[] = [];

        if (isActive) {
            iconColor = new vscode.ThemeColor('charts.green');
            parts.push('● Active');
        }

        if (tableCount > 0) {
            parts.push(`${tableCount} tables`);
            this.tooltip += `\nSchema: ${tableCount} tables`;
        }

        this.iconPath = new vscode.ThemeIcon('database', iconColor);
        this.description = parts.join(' · ');

        // Click to set as active
        this.command = {
            command: 'queryStudio.setActiveCluster',
            title: 'Set as Active',
            arguments: [this.cluster]
        };
    }
}

export class TableTreeItem extends vscode.TreeItem {
    constructor(
        public readonly tableName: string,
        public readonly cluster: ClusterInfo
    ) {
        super(tableName, vscode.TreeItemCollapsibleState.None);
        this.tooltip = `${tableName}\nClick to insert into query`;
        this.contextValue = 'table';
        this.iconPath = new vscode.ThemeIcon('symbol-field', new vscode.ThemeColor('descriptionForeground'));

        // Click inserts table name into active editor
        this.command = {
            command: 'queryStudio.insertTableName',
            title: 'Insert Table Name',
            arguments: [tableName]
        };
    }
}

export class AreaPathTreeItem extends vscode.TreeItem {
    constructor(
        public readonly areaPathValue: string,
        public readonly cluster: ClusterInfo
    ) {
        super(areaPathValue, vscode.TreeItemCollapsibleState.None);

        this.tooltip = `Default Area Path: ${areaPathValue}`;
        this.contextValue = 'areaPath';
        this.iconPath = new vscode.ThemeIcon('bookmark', new vscode.ThemeColor('descriptionForeground'));
        this.description = 'Area Path';
    }
}

export class ClusterGroupItem extends vscode.TreeItem {
    constructor(
        public readonly groupType: 'kusto' | 'ado',
        public readonly clusters: ClusterInfo[],
        public readonly hasActiveInGroup: boolean = false
    ) {
        super(
            groupType === 'kusto' ? 'Ⓚ KUSTO (KQL)' : 'Ⓐ AZURE DEVOPS (WIQL)',
            vscode.TreeItemCollapsibleState.Expanded
        );

        // Use distinct icons and colors for each type
        const iconName = groupType === 'kusto' ? 'graph' : 'tasklist';
        const iconColor = hasActiveInGroup
            ? new vscode.ThemeColor('charts.green')
            : new vscode.ThemeColor('descriptionForeground');

        this.iconPath = new vscode.ThemeIcon(iconName, iconColor);
        this.contextValue = 'clusterGroup';
        this.description = `${clusters.length} source${clusters.length !== 1 ? 's' : ''}`;
    }
}

export class ClusterTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private clusters: ClusterInfo[] = [];
    private activeCluster: ClusterInfo | null = null;
    private currentMode: 'kusto' | 'ado' | 'outlook' | 'mcp' = 'kusto';
    private tableCounts: Map<string, number> = new Map(); // key: clusterId or "url|database"
    private tableNames: Map<string, string[]> = new Map(); // key: "url|database"
    private filterText: string = '';

    // MCP tool discovery callbacks
    private mcpGetServerNames: (() => string[]) | undefined;
    private mcpGetToolsForServer: ((serverName: string) => { toolName: string; description: string; parameters: { name: string; type: string; description: string; required: boolean }[] }[]) | undefined;

    constructor(private client: SidecarClient) {}

    setMcpDiscovery(
        getServerNames: () => string[],
        getToolsForServer: (serverName: string) => { toolName: string; description: string; parameters: { name: string; type: string; description: string; required: boolean }[] }[]
    ): void {
        this.mcpGetServerNames = getServerNames;
        this.mcpGetToolsForServer = getToolsForServer;
    }

    setFilter(text: string): void {
        this.filterText = text;
        this.refresh();
    }

    getFilter(): string {
        return this.filterText;
    }

    refresh(): void {
        this._onDidChangeTreeData.fire(undefined);
    }

    setMode(mode: 'kusto' | 'ado' | 'outlook' | 'mcp'): void {
        this.currentMode = mode;
        this.refresh();
    }

    getMode(): 'kusto' | 'ado' | 'outlook' | 'mcp' {
        return this.currentMode;
    }

    setActiveCluster(cluster: ClusterInfo): void {
        this.activeCluster = cluster;
        this.refresh();
    }

    getActiveCluster(): ClusterInfo | null {
        return this.activeCluster;
    }

    setTableCount(clusterUrl: string, database: string, count: number): void {
        const key = `${clusterUrl.toLowerCase()}|${database.toLowerCase()}`;
        this.tableCounts.set(key, count);
        this.refresh();
    }

    getTableCount(clusterUrl: string, database: string): number {
        const key = `${clusterUrl.toLowerCase()}|${database.toLowerCase()}`;
        return this.tableCounts.get(key) || 0;
    }

    setTableNames(clusterUrl: string, database: string, tables: string[]): void {
        const key = `${clusterUrl.toLowerCase()}|${database.toLowerCase()}`;
        this.tableNames.set(key, tables);
        this.tableCounts.set(key, tables.length);
        this.refresh();
    }

    getTableNames(clusterUrl: string, database: string): string[] | undefined {
        const key = `${clusterUrl.toLowerCase()}|${database.toLowerCase()}`;
        return this.tableNames.get(key);
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
        if (!element) {
            // Root level - show clusters grouped by URL
            try {
                // MCP mode: show MCP servers from local discovery instead of sidecar clusters
                if (this.currentMode === 'mcp') {
                    return this.getMcpRootItems();
                }

                this.clusters = await this.client.getClusters();

                // Filter clusters based on current mode
                let filteredClusters = this.clusters.filter(c => c.type === this.currentMode);

                // Apply text filter if set
                if (this.filterText) {
                    const q = this.filterText.toLowerCase();
                    filteredClusters = filteredClusters.filter(c =>
                        c.name.toLowerCase().includes(q) ||
                        c.database.toLowerCase().includes(q) ||
                        c.url.toLowerCase().includes(q)
                    );
                }

                if (filteredClusters.length === 0) {
                    return [];
                }

                // Group clusters by normalized URL
                const clusterGroups = new Map<string, ClusterInfo[]>();
                for (const cluster of filteredClusters) {
                    const normalizedUrl = this.normalizeClusterUrl(cluster.url);
                    if (!clusterGroups.has(normalizedUrl)) {
                        clusterGroups.set(normalizedUrl, []);
                    }
                    clusterGroups.get(normalizedUrl)!.push(cluster);
                }

                // Convert groups to tree items
                const items: ClusterTreeItem[] = [];
                for (const [url, databases] of clusterGroups) {
                    // Sort databases alphabetically
                    databases.sort((a, b) => a.database.localeCompare(b.database));

                    // Use the first cluster's name as the group name
                    const clusterName = databases[0].name;
                    const clusterType = databases[0].type;
                    const hasActiveDatabase = databases.some(d => this.activeCluster?.id === d.id);

                    items.push(new ClusterTreeItem(
                        url,
                        clusterName,
                        databases,
                        clusterType,
                        hasActiveDatabase
                    ));
                }

                // Sort: favorites first, then alphabetically
                items.sort((a, b) => {
                    const aHasFav = a.databases.some(d => d.isFavorite);
                    const bHasFav = b.databases.some(d => d.isFavorite);
                    if (aHasFav !== bHasFav) {
                        return aHasFav ? -1 : 1;
                    }
                    return a.clusterName.localeCompare(b.clusterName);
                });

                return items;
            } catch (error) {
                console.error('Failed to get clusters:', error);
                return [];
            }
        }

        if (element instanceof ClusterTreeItem) {
            // Show databases under cluster
            const defaultAreaPath = vscode.workspace.getConfiguration('queryStudio.ado').get<string>('defaultAreaPath');
            return element.databases.map(db => {
                const isActive = this.activeCluster?.id === db.id;
                const tableCount = this.getTableCount(db.url, db.database);
                const areaPath = db.type === 'ado' ? defaultAreaPath : undefined;
                const hasTableNames = !!this.getTableNames(db.url, db.database);
                return new DatabaseTreeItem(db, isActive, tableCount, areaPath, hasTableNames);
            });
        }

        if (element instanceof DatabaseTreeItem) {
            const children: vscode.TreeItem[] = [];
            if (element.areaPath) {
                children.push(new AreaPathTreeItem(element.areaPath, element.cluster));
            }
            const tables = this.getTableNames(element.cluster.url, element.cluster.database);
            if (tables) {
                for (const table of tables) {
                    children.push(new TableTreeItem(table, element.cluster));
                }
            }
            return children;
        }

        // MCP server children: show tools
        if (element.contextValue === 'mcpServer' && this.mcpGetToolsForServer) {
            const serverName = element.label as string;
            const tools = this.mcpGetToolsForServer(serverName);
            return tools.map(tool => new McpToolTreeItem(
                serverName,
                tool.toolName,
                tool.description,
                tool.parameters
            ));
        }

        return [];
    }

    private normalizeClusterUrl(url: string): string {
        // Normalize URL for grouping (remove protocol, trailing slashes, lowercase)
        let normalized = url.toLowerCase().trim();
        normalized = normalized.replace(/^https?:\/\//, '');
        normalized = normalized.replace(/\/$/, '');
        return normalized;
    }

    private getMcpRootItems(): vscode.TreeItem[] {
        if (!this.mcpGetServerNames || !this.mcpGetToolsForServer) {
            const noConfig = new vscode.TreeItem('No MCP configuration found');
            noConfig.description = 'Add .vscode/mcp.json to get started';
            noConfig.iconPath = new vscode.ThemeIcon('info');
            return [noConfig];
        }

        const serverNames = this.mcpGetServerNames();
        if (serverNames.length === 0) {
            const noServers = new vscode.TreeItem('No MCP servers configured');
            noServers.description = 'Add servers to .vscode/mcp.json';
            noServers.iconPath = new vscode.ThemeIcon('info');
            return [noServers];
        }

        return serverNames.map(serverName => {
            const tools = this.mcpGetToolsForServer!(serverName);
            const item = new vscode.TreeItem(
                serverName,
                tools.length > 0
                    ? vscode.TreeItemCollapsibleState.Expanded
                    : vscode.TreeItemCollapsibleState.None
            );
            item.iconPath = new vscode.ThemeIcon('plug');
            item.contextValue = 'mcpServer';
            item.description = `${tools.length} tool${tools.length !== 1 ? 's' : ''}`;
            item.tooltip = `MCP Server: ${serverName}\n${tools.length} tool(s) available`;
            return item;
        });
    }
}

// MCP tool tree item for display under MCP servers
export class McpToolTreeItem extends vscode.TreeItem {
    constructor(
        public readonly serverName: string,
        public readonly toolName: string,
        public readonly toolDescription: string,
        public readonly parameters: { name: string; type: string; description: string; required: boolean }[]
    ) {
        super(toolName, vscode.TreeItemCollapsibleState.None);
        this.description = toolDescription;
        this.iconPath = new vscode.ThemeIcon('symbol-method');
        this.contextValue = 'mcpTool';

        const paramList = parameters.map(p =>
            `  ${p.required ? '*' : ' '} ${p.name}: ${p.type} — ${p.description}`
        ).join('\n');
        this.tooltip = `${toolName}\n${toolDescription}\n\nParameters:\n${paramList || '  (none)'}`;

        // Insert a query template when clicked
        const requiredParams = parameters.filter(p => p.required);
        const paramStr = requiredParams.map(p => `${p.name}='...'`).join(', ');
        this.command = {
            command: 'queryStudio.insertText',
            title: 'Insert Tool Query',
            arguments: [`${serverName} | ${toolName}(${paramStr})\n`]
        };
    }
}
