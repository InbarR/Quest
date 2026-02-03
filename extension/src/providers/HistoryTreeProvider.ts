import * as vscode from 'vscode';
import { SidecarClient, PresetInfo } from '../sidecar/SidecarClient';

export class HistoryTreeItem extends vscode.TreeItem {
    constructor(public readonly preset: PresetInfo) {
        super(preset.name || 'Untitled Query', vscode.TreeItemCollapsibleState.None);

        const date = new Date(preset.createdAt);
        const timeStr = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
        const dateStr = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

        this.description = `${dateStr} ${timeStr}`;
        this.tooltip = preset.query.substring(0, 300) + (preset.query.length > 300 ? '...' : '');
        this.contextValue = 'historyItem';

        this.command = {
            command: 'queryStudio.loadPreset',
            title: 'Load Query',
            arguments: [this.preset]
        };
    }
}

export class HistoryTreeProvider implements vscode.TreeDataProvider<HistoryTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<HistoryTreeItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private history: PresetInfo[] = [];
    private _filterText: string = '';

    constructor(private client: SidecarClient) {}

    refresh(): void {
        this._onDidChangeTreeData.fire(undefined);
    }

    setFilter(text: string): void {
        this._filterText = text.toLowerCase();
        this.refresh();
    }

    getFilter(): string {
        return this._filterText;
    }

    clearFilter(): void {
        this._filterText = '';
        this.refresh();
    }

    getTreeItem(element: HistoryTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: HistoryTreeItem): Promise<HistoryTreeItem[]> {
        if (element) {
            return [];
        }

        try {
            this.history = await this.client.getHistory(50);
            let filtered = this.history;

            // Apply filter if set
            if (this._filterText) {
                filtered = filtered.filter(p =>
                    (p.name || '').toLowerCase().includes(this._filterText) ||
                    p.query.toLowerCase().includes(this._filterText)
                );
            }

            return filtered
                .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
                .map(item => new HistoryTreeItem(item));
        } catch (error) {
            console.error('Failed to get history:', error);
            return [];
        }
    }
}
