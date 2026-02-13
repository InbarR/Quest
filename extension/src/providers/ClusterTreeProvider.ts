import * as vscode from 'vscode';
import { SidecarClient, ClusterInfo } from '../sidecar/SidecarClient';

// Represents a cluster node (groups multiple databases)
export class ClusterTreeItem extends vscode.TreeItem {
    constructor(
        public readonly clusterUrl: string,
        public readonly clusterName: string,
        public readonly databases: ClusterInfo[],
        public readonly clusterType: 'kusto' | 'ado' | 'outlook',
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
            iconName = clusterType === 'kusto' ? 'server' : 'organization';
        }

        this.iconPath = new vscode.ThemeIcon(iconName, iconColor);
    }
}

export class DatabaseTreeItem extends vscode.TreeItem {
    constructor(
        public readonly cluster: ClusterInfo,
        public readonly isActive: boolean = false,
        public readonly tableCount: number = 0,
        public readonly areaPath?: string
    ) {
        // ADO databases with area path are expandable to show it
        const collapsible = cluster.type === 'ado' && areaPath
            ? vscode.TreeItemCollapsibleState.Expanded
            : vscode.TreeItemCollapsibleState.None;
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
    private currentMode: 'kusto' | 'ado' | 'outlook' = 'kusto';
    private tableCounts: Map<string, number> = new Map(); // key: clusterId or "url|database"

    constructor(private client: SidecarClient) {}

    refresh(): void {
        this._onDidChangeTreeData.fire(undefined);
    }

    setMode(mode: 'kusto' | 'ado' | 'outlook'): void {
        this.currentMode = mode;
        this.refresh();
    }

    getMode(): 'kusto' | 'ado' | 'outlook' {
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

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
        if (!element) {
            // Root level - show clusters grouped by URL
            try {
                this.clusters = await this.client.getClusters();

                // Filter clusters based on current mode
                const filteredClusters = this.clusters.filter(c => c.type === this.currentMode);

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
                return new DatabaseTreeItem(db, isActive, tableCount, areaPath);
            });
        }

        if (element instanceof DatabaseTreeItem && element.areaPath) {
            return [new AreaPathTreeItem(element.areaPath, element.cluster)];
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
}
