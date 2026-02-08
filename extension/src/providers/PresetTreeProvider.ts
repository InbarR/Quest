import * as vscode from 'vscode';
import { SidecarClient, PresetInfo } from '../sidecar/SidecarClient';

export class PresetTreeItem extends vscode.TreeItem {
    constructor(public readonly preset: PresetInfo) {
        super(preset.name, vscode.TreeItemCollapsibleState.None);

        const descPart = preset.description ? `${preset.description}\n\n` : '';
        this.tooltip = descPart + preset.query.substring(0, 200) + (preset.query.length > 200 ? '...' : '');
        this.description = preset.type.toUpperCase();
        this.contextValue = 'preset';

        this.command = {
            command: 'queryStudio.loadPreset',
            title: 'Load Query',
            arguments: [this.preset]
        };
    }
}

export class PresetTreeProvider implements vscode.TreeDataProvider<PresetTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<PresetTreeItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private presets: PresetInfo[] = [];
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

    getTreeItem(element: PresetTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: PresetTreeItem): Promise<PresetTreeItem[]> {
        if (element) {
            return [];
        }

        try {
            this.presets = await this.client.getPresets();
            let filtered = this.presets.filter(p => !p.isAutoSaved);

            // Apply filter if set
            if (this._filterText) {
                filtered = filtered.filter(p =>
                    p.name.toLowerCase().includes(this._filterText) ||
                    p.query.toLowerCase().includes(this._filterText)
                );
            }

            return filtered
                .sort((a, b) => a.name.localeCompare(b.name))
                .map(preset => new PresetTreeItem(preset));
        } catch (error) {
            console.error('Failed to get presets:', error);
            return [];
        }
    }
}
