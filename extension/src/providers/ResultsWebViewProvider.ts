import * as vscode from 'vscode';
import { QueryResult } from '../sidecar/SidecarClient';

interface ColorRule {
    columnIndex: number;
    columnName: string;
    valueColors: Map<string, { bg: string; fg: string }>;
}

interface ResultTab {
    id: string;
    title: string;
    result: QueryResult;
    query?: string;
    clusterUrl?: string;
    database?: string;
    colorRules?: ColorRule[];
    queryType?: 'kusto' | 'ado' | 'outlook';
    isLoading?: boolean;
    filterText?: string;
    filterMode?: 'filter' | 'highlight';
}

export class ResultsWebViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'querystudio.results';

    private _view?: vscode.WebviewView;
    private readonly _extensionUri: vscode.Uri;
    private _tabs: ResultTab[] = [];
    private _activeTabId: string | null = null;
    private _tabCounter = 0;
    private _loadingTabId: string | null = null;

    private _onSaveAsPreset?: (query: string, title: string) => void;
    private _onSetQuery?: (query: string, clusterUrl: string, database: string) => void;
    private _onReRun?: (query: string, clusterUrl: string, database: string) => void;
    private _onOpenOutlookItem?: (entryId: string) => void;
    private _onDirectOpenOutlookItem?: (entryId: string) => void;
    private _context?: vscode.ExtensionContext;
    private _columnPresets: Map<string, { widths: Record<number, number>, order: string[] }> = new Map();

    constructor(extensionUri: vscode.Uri, context?: vscode.ExtensionContext) {
        this._extensionUri = extensionUri;
        this._context = context;
        this._loadColumnPresets();
    }

    private _loadColumnPresets() {
        if (this._context) {
            const stored = this._context.globalState.get<Record<string, { widths: Record<number, number>, order: string[] }>>('columnPresets', {});
            this._columnPresets = new Map(Object.entries(stored));
        }
    }

    private async _saveColumnPresets() {
        if (this._context) {
            const obj = Object.fromEntries(this._columnPresets);
            await this._context.globalState.update('columnPresets', obj);
        }
    }

    public getColumnPresetNames(): string[] {
        return Array.from(this._columnPresets.keys());
    }

    public async saveColumnPreset(name: string, widths: Record<number, number>, order: string[]) {
        this._columnPresets.set(name, { widths, order });
        await this._saveColumnPresets();
    }

    public deleteColumnPreset(name: string) {
        this._columnPresets.delete(name);
        this._saveColumnPresets();
    }

    public getColumnPreset(name: string) {
        return this._columnPresets.get(name);
    }

    public setOnSaveAsPreset(callback: (query: string, title: string) => void) {
        this._onSaveAsPreset = callback;
    }

    public setOnSetQuery(callback: (query: string, clusterUrl: string, database: string) => void) {
        this._onSetQuery = callback;
    }

    public setOnReRun(callback: (query: string, clusterUrl: string, database: string) => void) {
        this._onReRun = callback;
    }

    public setOnOpenOutlookItem(callback: (entryId: string) => void) {
        this._onOpenOutlookItem = callback;
    }

    public setOnDirectOpenOutlookItem(callback: (entryId: string) => void) {
        this._onDirectOpenOutlookItem = callback;
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(message => {
            this._handleMessage(message);
        });

        // If we have pending tabs, update the view now that it's available
        if (this._tabs.length > 0) {
            this._updateView();
        }
    }

    private _handleMessage(message: any) {
        const activeTab = this._tabs.find(t => t.id === this._activeTabId);

        switch (message.command) {
            case 'export':
                if (activeTab) {
                    this._exportResults(activeTab.result, message.format);
                }
                break;
            case 'copyCell':
                vscode.env.clipboard.writeText(message.value);
                break;
            case 'copyRow':
                vscode.env.clipboard.writeText(message.value);
                break;
            case 'copyColumn':
                vscode.env.clipboard.writeText(message.value);
                break;
            case 'copyAllRows':
                vscode.env.clipboard.writeText(message.value);
                break;
            case 'copyQuery':
                if (activeTab?.query) {
                    const clusterForKql = this._formatClusterDisplayName(activeTab.clusterUrl || '');
                    const queryWithPrefix = activeTab.clusterUrl && activeTab.database
                        ? `cluster('${clusterForKql}').database('${activeTab.database}').\n${activeTab.query}`
                        : activeTab.query;
                    vscode.env.clipboard.writeText(queryWithPrefix);
                }
                break;
            case 'setQuery':
                // For Outlook mode, clusterUrl and database can be empty
                if (activeTab?.query && this._onSetQuery) {
                    this._onSetQuery(activeTab.query, activeTab.clusterUrl || '', activeTab.database || '');
                }
                break;
            case 'reRun':
                // For Outlook mode, clusterUrl and database can be empty
                if (activeTab?.query && this._onReRun) {
                    this._onReRun(activeTab.query, activeTab.clusterUrl || '', activeTab.database || '');
                }
                break;
            case 'cancelQuery':
                vscode.commands.executeCommand('queryStudio.cancelQuery');
                break;
            case 'openInAdx':
                if (activeTab?.query && activeTab.clusterUrl && activeTab.database) {
                    this._openInAdx(activeTab.query, activeTab.clusterUrl, activeTab.database);
                }
                break;
            case 'openInAdo':
                if (activeTab?.query && activeTab.clusterUrl && activeTab.database) {
                    this._openInAdo(activeTab.query, activeTab.clusterUrl, activeTab.database);
                }
                break;
            case 'saveAsPreset':
                if (activeTab?.query && this._onSaveAsPreset) {
                    this._onSaveAsPreset(activeTab.query, activeTab.title);
                }
                break;
            case 'selectTab':
                // Save filter state of the old tab before switching
                if (this._activeTabId && message.filterText !== undefined) {
                    const oldTab = this._tabs.find(t => t.id === this._activeTabId);
                    if (oldTab) {
                        oldTab.filterText = message.filterText;
                        oldTab.filterMode = message.filterMode;
                    }
                }
                this._activeTabId = message.tabId;
                this._updateView();
                break;
            case 'closeTab':
                this._closeTab(message.tabId);
                break;
            case 'closeAllTabs':
                this._tabs = [];
                this._activeTabId = null;
                this._updateView();
                break;
            case 'closeOtherTabs':
                this._tabs = this._tabs.filter(t => t.id === message.tabId);
                this._activeTabId = message.tabId;
                this._updateView();
                break;
            case 'closeEmptyTabs':
                const emptyRemoved = this._tabs.filter(t => t.result && t.result.rows && t.result.rows.length > 0);
                if (emptyRemoved.length !== this._tabs.length) {
                    this._tabs = emptyRemoved;
                    if (this._tabs.length === 0) {
                        this._activeTabId = null;
                    } else if (!this._tabs.find(t => t.id === this._activeTabId)) {
                        this._activeTabId = this._tabs[0].id;
                    }
                    this._updateView();
                }
                break;
            case 'renameTab':
                const tab = this._tabs.find(t => t.id === message.tabId);
                if (tab) {
                    this._renameTab(tab);
                }
                break;
            case 'searchAllTabs':
                this._searchAllTabs(message.searchText);
                break;
            case 'openLink':
                if (message.url) {
                    vscode.env.openExternal(vscode.Uri.parse(message.url));
                }
                break;
            case 'showJson':
                if (message.json) {
                    this._showJsonDocument(message.json, message.title);
                }
                break;
            case 'addColorRule':
                this._addColorRule(message.columnIndex, message.columnName, message.cellValue);
                break;
            case 'clearColorRules':
                this._clearColorRules();
                break;
            case 'openOutlookItem':
                if (activeTab?.result.success && activeTab.queryType === 'outlook' && this._onOpenOutlookItem) {
                    const entryIdColIdx = activeTab.result.columns.findIndex(c => c.toLowerCase() === 'entryid');
                    if (entryIdColIdx >= 0 && message.rowIndex >= 0 && message.rowIndex < activeTab.result.rows.length) {
                        const entryId = String(activeTab.result.rows[message.rowIndex][entryIdColIdx] ?? '');
                        if (entryId) {
                            this._onOpenOutlookItem(entryId);
                        }
                    }
                }
                break;
            case 'directOpenOutlookItem':
                if (activeTab?.result.success && activeTab.queryType === 'outlook' && this._onDirectOpenOutlookItem) {
                    const entryIdIdx = activeTab.result.columns.findIndex(c => c.toLowerCase() === 'entryid');
                    if (entryIdIdx >= 0 && message.rowIndex >= 0 && message.rowIndex < activeTab.result.rows.length) {
                        const entryId = String(activeTab.result.rows[message.rowIndex][entryIdIdx] ?? '');
                        if (entryId) {
                            this._onDirectOpenOutlookItem(entryId);
                        }
                    }
                }
                break;
            case 'reportBug':
                this._openBugReport();
                break;
            case 'saveColumnPreset':
                this._promptSaveColumnPreset(message.widths, message.order);
                break;
            case 'loadColumnPreset':
                console.log('Received loadColumnPreset message:', message.name);
                this._loadColumnPresetByName(message.name);
                break;
            case 'deleteColumnPreset':
                this._deleteColumnPresetByName(message.name);
                break;
            case 'getColumnPresets':
                console.log('Received getColumnPresets message');
                this._sendColumnPresets();
                break;
        }
    }

    private _openBugReport() {
        const version = '0.4.1';
        const subject = encodeURIComponent('Quest Feedback');
        const body = encodeURIComponent(`\n\n---\nQuest v${version}\nVS Code: ${vscode.version}\nOS: ${process.platform}`);
        const mailtoUrl = `mailto:inrotem@microsoft.com?subject=${subject}&body=${body}`;
        vscode.env.openExternal(vscode.Uri.parse(mailtoUrl));
    }

    private async _promptSaveColumnPreset(widths: Record<number, number>, order: string[]) {
        const name = await vscode.window.showInputBox({
            prompt: 'Enter a name for this column preset',
            placeHolder: 'e.g., Default Layout, Wide Columns'
        });
        if (name) {
            await this.saveColumnPreset(name, widths, order);
            vscode.window.showInformationMessage(`Column preset "${name}" saved`);
            this._sendColumnPresets();
        }
    }

    private _loadColumnPresetByName(name: string) {
        console.log('Loading preset:', name);
        console.log('Available presets:', Array.from(this._columnPresets.keys()));
        const preset = this.getColumnPreset(name);
        console.log('Found preset:', preset);
        if (preset && this._view) {
            console.log('Sending applyColumnPreset message');
            this._view.webview.postMessage({
                command: 'applyColumnPreset',
                widths: preset.widths,
                order: preset.order
            });
        } else {
            console.log('Cannot apply preset - preset:', !!preset, 'view:', !!this._view);
        }
    }

    private async _deleteColumnPresetByName(name: string) {
        const confirm = await vscode.window.showWarningMessage(
            `Delete column preset "${name}"?`,
            { modal: true },
            'Delete'
        );
        if (confirm === 'Delete') {
            this.deleteColumnPreset(name);
            vscode.window.showInformationMessage(`Preset "${name}" deleted`);
            this._sendColumnPresets();
        }
    }

    private _sendColumnPresets() {
        const presetNames = this.getColumnPresetNames();
        console.log('_sendColumnPresets - sending presets:', presetNames);
        if (this._view) {
            this._view.webview.postMessage({
                command: 'columnPresetsList',
                presets: presetNames
            });
        } else {
            console.log('_sendColumnPresets - no view available');
        }
    }

    private async _addColorRule(columnIndex: number, columnName: string, cellValue?: string) {
        const activeTab = this._tabs.find(t => t.id === this._activeTabId);
        if (!activeTab || !activeTab.result.success) return;

        // Check if column already has color rules - if so, remove them (toggle behavior)
        if (activeTab.colorRules) {
            const existingIndex = activeTab.colorRules.findIndex(r => r.columnIndex === columnIndex);
            if (existingIndex >= 0) {
                activeTab.colorRules.splice(existingIndex, 1);
                this._updateView();
                return;
            }
        }

        // Get all unique values in the column
        const uniqueValues = new Set<string>();
        for (const row of activeTab.result.rows) {
            const val = String(row[columnIndex] ?? '');
            uniqueValues.add(val);
        }

        // ADX-style color palette (similar to Azure Data Explorer)
        const colorPalette = [
            { bg: '#4363d8', fg: '#FFFFFF' },  // Blue
            { bg: '#e6194B', fg: '#FFFFFF' },  // Red
            { bg: '#3cb44b', fg: '#FFFFFF' },  // Green
            { bg: '#f58231', fg: '#FFFFFF' },  // Orange
            { bg: '#911eb4', fg: '#FFFFFF' },  // Purple
            { bg: '#42d4f4', fg: '#000000' },  // Cyan
            { bg: '#f032e6', fg: '#FFFFFF' },  // Magenta
            { bg: '#bfef45', fg: '#000000' },  // Lime
            { bg: '#fabed4', fg: '#000000' },  // Pink
            { bg: '#469990', fg: '#FFFFFF' },  // Teal
            { bg: '#dcbeff', fg: '#000000' },  // Lavender
            { bg: '#9A6324', fg: '#FFFFFF' },  // Brown
            { bg: '#fffac8', fg: '#000000' },  // Beige
            { bg: '#800000', fg: '#FFFFFF' },  // Maroon
            { bg: '#aaffc3', fg: '#000000' },  // Mint
            { bg: '#808000', fg: '#FFFFFF' },  // Olive
            { bg: '#ffd8b1', fg: '#000000' },  // Apricot
            { bg: '#000075', fg: '#FFFFFF' },  // Navy
            { bg: '#a9a9a9', fg: '#000000' },  // Grey
            { bg: '#ffe119', fg: '#000000' },  // Yellow
        ];

        // Assign colors to values
        const valueColors = new Map<string, { bg: string; fg: string }>();
        let colorIndex = 0;
        for (const value of uniqueValues) {
            valueColors.set(value, colorPalette[colorIndex % colorPalette.length]);
            colorIndex++;
        }

        // Create the rule
        const rule: ColorRule = {
            columnIndex,
            columnName,
            valueColors
        };

        if (!activeTab.colorRules) {
            activeTab.colorRules = [];
        }
        activeTab.colorRules.push(rule);
        this._updateView();
    }

    private _clearColorRules() {
        const activeTab = this._tabs.find(t => t.id === this._activeTabId);
        if (activeTab) {
            activeTab.colorRules = [];
            this._updateView();
            vscode.window.showInformationMessage('Color rules cleared');
        }
    }

    private async _showJsonDocument(json: string, title: string) {
        try {
            // Try to parse and format JSON
            const parsed = JSON.parse(json);
            const formatted = JSON.stringify(parsed, null, 2);

            // Create a new untitled document with JSON content
            const doc = await vscode.workspace.openTextDocument({
                language: 'json',
                content: formatted
            });
            await vscode.window.showTextDocument(doc, { preview: true });
        } catch {
            // If not valid JSON, just show as plain text
            const doc = await vscode.workspace.openTextDocument({
                content: json
            });
            await vscode.window.showTextDocument(doc, { preview: true });
        }
    }

    private _searchAllTabs(searchText: string) {
        if (!searchText || this._tabs.length === 0) return;

        const results: { tabId: string; title: string; matchCount: number }[] = [];
        const regex = new RegExp(searchText, 'i');

        for (const tab of this._tabs) {
            if (!tab.result.success || !tab.result.rows) continue;

            let matchCount = 0;
            for (const row of tab.result.rows) {
                for (const cell of row) {
                    if (cell && regex.test(String(cell))) {
                        matchCount++;
                    }
                }
            }

            if (matchCount > 0) {
                results.push({ tabId: tab.id, title: tab.title, matchCount });
            }
        }

        if (results.length === 0) {
            vscode.window.showInformationMessage(`No matches found for "${searchText}" in any tab`);
            return;
        }

        // Show quick pick to jump to a tab with matches
        const items = results.map(r => ({
            label: r.title,
            description: `${r.matchCount} matches`,
            tabId: r.tabId
        }));

        vscode.window.showQuickPick(items, {
            placeHolder: `Found matches in ${results.length} tab(s). Select to jump to tab.`
        }).then(selected => {
            if (selected) {
                this._activeTabId = (selected as any).tabId;
                this._updateView();
            }
        });
    }

    private async _renameTab(tab: ResultTab) {
        const newName = await vscode.window.showInputBox({
            prompt: 'Enter new name for this result tab',
            value: tab.title.replace(/\s*\[\d+\]$/, ''),
            placeHolder: 'Result name'
        });
        if (newName) {
            const rowCount = tab.result.rowCount || 0;
            tab.title = `${newName} [${rowCount}]`;
            this._updateView();
        }
    }

    private _closeTab(tabId: string) {
        const index = this._tabs.findIndex(t => t.id === tabId);
        if (index >= 0) {
            this._tabs.splice(index, 1);
            if (this._activeTabId === tabId) {
                this._activeTabId = this._tabs.length > 0
                    ? this._tabs[Math.min(index, this._tabs.length - 1)].id
                    : null;
            }
            this._updateView();
        }
    }

    private _formatClusterDisplayName(cluster: string): string {
        if (!cluster) return '';
        const match = cluster.match(/https?:\/\/([^.]+)/);
        return match ? match[1] : cluster;
    }

    private _openInAdx(query: string, clusterUrl: string, database: string): void {
        try {
            const encodedQuery = encodeURIComponent(query);
            const clusterUri = clusterUrl.includes('://') ? clusterUrl : `https://${clusterUrl}.kusto.windows.net`;
            const adxUrl = `https://dataexplorer.azure.com/clusters/${encodeURIComponent(clusterUri)}/databases/${encodeURIComponent(database)}?query=${encodedQuery}`;
            vscode.env.openExternal(vscode.Uri.parse(adxUrl));
            vscode.window.showInformationMessage('Opened in Azure Data Explorer');
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to open in ADX: ${error}`);
        }
    }

    private _openInAdo(query: string, clusterUrl: string, database: string): void {
        try {
            const encodedQuery = encodeURIComponent(query);
            // clusterUrl is the ADO organization URL, database is the project name
            // Format: https://dev.azure.com/{org}/{project}/_queries/query/?wiql={encodedWiql}
            // or https://{org}.visualstudio.com/{project}/_queries/query/?wiql={encodedWiql}
            const adoUrl = `${clusterUrl}/${database}/_queries/query/?wiql=${encodedQuery}`;
            vscode.env.openExternal(vscode.Uri.parse(adoUrl));
            vscode.window.showInformationMessage('Opened in Azure DevOps');
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to open in ADO: ${error}`);
        }
    }

    public showLoading(query?: string, clusterUrl?: string, database?: string, queryType?: 'kusto' | 'ado' | 'outlook'): string {
        // Create a new tab for loading
        const tabId = `tab_${++this._tabCounter}`;
        this._loadingTabId = tabId; // Keep for backward compatibility

        // Add placeholder tab to _tabs array so it persists when switching tabs
        const loadingTab: ResultTab = {
            id: tabId,
            title: '⏳ Running...',
            result: {
                success: true,
                columns: [],
                rows: [],
                rowCount: 0,
                executionTimeMs: 0
            },
            isLoading: true,
            query: query,
            clusterUrl: clusterUrl,
            database: database,
            queryType: queryType
        };
        this._tabs.push(loadingTab);
        this._activeTabId = tabId;

        if (this._view) {
            this._view.show?.(true);
            this._view.webview.postMessage({
                command: 'showLoading',
                tabId: tabId,
                query: query,
                clusterUrl: clusterUrl,
                database: database,
                queryType: queryType,
                hasQuery: !!query,
                hasConnection: !!(clusterUrl && database) || queryType === 'outlook'
            });
        }
        return tabId;
    }

    public showResults(
        result: QueryResult,
        title: string = 'Query Results',
        query?: string,
        clusterUrl?: string,
        database?: string,
        queryType?: 'kusto' | 'ado' | 'outlook',
        loadingTabId?: string
    ) {
        const rowCount = result.rowCount || 0;
        const tabTitle = `${title} [${rowCount}]`;

        // Use the specific loading tab ID if provided, otherwise fall back to _loadingTabId, or create new
        const tabId = loadingTabId || this._loadingTabId || `tab_${++this._tabCounter}`;
        if (tabId === this._loadingTabId) {
            this._loadingTabId = null;
        }

        const newTab: ResultTab = {
            id: tabId,
            title: tabTitle,
            result: result,
            query: query,
            clusterUrl: clusterUrl,
            database: database,
            queryType: queryType
        };

        // Check if tab already exists (from loading state)
        const existingIndex = this._tabs.findIndex(t => t.id === tabId);
        if (existingIndex >= 0) {
            this._tabs[existingIndex] = newTab;
        } else {
            this._tabs.push(newTab);
        }

        this._activeTabId = tabId;

        // Reveal the results panel first to ensure it's initialized
        vscode.commands.executeCommand('querystudio.results.focus').then(() => {
            this._updateView();
        });
    }

    public showError(error: string, loadingTabId?: string) {
        const tabId = loadingTabId || this._loadingTabId || `tab_${++this._tabCounter}`;
        if (tabId === this._loadingTabId) {
            this._loadingTabId = null;
        }

        const errorResult: QueryResult = {
            success: false,
            error: error,
            columns: [],
            rows: [],
            rowCount: 0,
            executionTimeMs: 0
        };

        const newTab: ResultTab = {
            id: tabId,
            title: '❌ Error',
            result: errorResult
        };

        const existingIndex = this._tabs.findIndex(t => t.id === tabId);
        if (existingIndex >= 0) {
            this._tabs[existingIndex] = newTab;
        } else {
            this._tabs.push(newTab);
        }

        this._activeTabId = tabId;

        // Reveal the results panel first to ensure it's initialized
        vscode.commands.executeCommand('querystudio.results.focus').then(() => {
            this._updateView();
        });
    }

    private _updateView() {
        if (!this._view) return;

        const activeTab = this._tabs.find(t => t.id === this._activeTabId);

        // Convert Map to serializable format for colorRules
        const serializedColorRules = (activeTab?.colorRules || []).map(rule => ({
            columnIndex: rule.columnIndex,
            columnName: rule.columnName,
            valueColors: Object.fromEntries(rule.valueColors)
        }));

        this._view.webview.postMessage({
            command: 'updateState',
            tabs: this._tabs.map(t => ({ id: t.id, title: t.title, queryType: t.queryType, isLoading: t.isLoading })),
            activeTabId: this._activeTabId,
            activeResult: activeTab?.result,
            hasQuery: !!activeTab?.query,
            hasConnection: !!(activeTab?.clusterUrl && activeTab?.database) || activeTab?.queryType === 'outlook',
            colorRules: serializedColorRules,
            queryType: activeTab?.queryType,
            clusterUrl: activeTab?.clusterUrl,
            database: activeTab?.database,
            isLoading: activeTab?.isLoading || false,
            filterText: activeTab?.filterText || '',
            filterMode: activeTab?.filterMode || 'filter'
        });
    }

    private async _exportResults(result: QueryResult | undefined, format: 'csv' | 'json') {
        if (!result || !result.success) return;

        const content = format === 'csv'
            ? this._toCsv(result)
            : JSON.stringify({ columns: result.columns, rows: result.rows }, null, 2);

        const uri = await vscode.window.showSaveDialog({
            filters: { [format.toUpperCase()]: [format] },
            defaultUri: vscode.Uri.file(`query-results.${format}`)
        });

        if (uri) {
            await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));
            vscode.window.showInformationMessage(`Results exported to ${uri.fsPath}`);
        }
    }

    private _toCsv(result: QueryResult): string {
        const escape = (val: string) => {
            if (val.includes(',') || val.includes('"') || val.includes('\n')) {
                return `"${val.replace(/"/g, '""')}"`;
            }
            return val;
        };

        const header = result.columns.map(escape).join(',');
        const rows = result.rows.map(row => row.map(c => escape(String(c ?? ''))).join(','));
        return [header, ...rows].join('\n');
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'unsafe-inline';">
    <title>Query Results</title>
    <style>
        * { box-sizing: border-box; }
        body {
            padding: 0;
            margin: 0;
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background-color: var(--vscode-panel-background);
            height: 100vh;
            display: flex;
            flex-direction: column;
        }
        .tabs-bar {
            display: flex;
            background: var(--vscode-tab-inactiveBackground);
            border-bottom: 1px solid var(--vscode-panel-border);
            overflow-x: auto;
            flex-shrink: 0;
        }
        .tab {
            display: flex;
            align-items: center;
            padding: 6px 12px;
            cursor: pointer;
            border-right: 1px solid var(--vscode-panel-border);
            white-space: nowrap;
            font-size: 12px;
            max-width: 200px;
            gap: 6px;
        }
        .tab:hover {
            background: var(--vscode-tab-hoverBackground);
        }
        .tab.active {
            background: var(--vscode-tab-activeBackground);
            border-bottom: 2px solid var(--vscode-focusBorder);
        }
        .tab-icon {
            opacity: 0.7;
            font-size: 11px;
        }
        .tab-title {
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .tab-close {
            opacity: 0.6;
            font-size: 14px;
            padding: 0 2px;
        }
        .tab-close:hover {
            opacity: 1;
            background: var(--vscode-toolbar-hoverBackground);
            border-radius: 3px;
        }
        .toolbar {
            padding: 4px 8px;
            border-bottom: 1px solid var(--vscode-panel-border);
            display: flex;
            gap: 4px;
            align-items: center;
            background-color: var(--vscode-panel-background);
            flex-wrap: wrap;
            flex-shrink: 0;
        }
        .toolbar button {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: none;
            padding: 2px 6px;
            cursor: pointer;
            border-radius: 2px;
            font-size: 11px;
        }
        .toolbar button:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        .separator {
            width: 1px;
            height: 14px;
            background: var(--vscode-panel-border);
            margin: 0 2px;
        }
        .status {
            color: var(--vscode-descriptionForeground);
            font-size: 11px;
            margin-right: 6px;
        }
        .filter-group {
            display: flex;
            align-items: center;
            gap: 3px;
            margin-left: auto;
        }
        .filter-input {
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            padding: 2px 6px;
            border-radius: 2px;
            width: 160px;
            font-size: 11px;
        }
        .filter-input:focus {
            outline: 1px solid var(--vscode-focusBorder);
        }
        .container {
            flex: 1;
            overflow: auto;
            scrollbar-width: thin;
            scrollbar-color: var(--vscode-scrollbarSlider-background) transparent;
        }
        .container::-webkit-scrollbar {
            width: 10px;
            height: 10px;
        }
        .container::-webkit-scrollbar-track {
            background: transparent;
        }
        .container::-webkit-scrollbar-thumb {
            background: var(--vscode-scrollbarSlider-background);
            border-radius: 5px;
        }
        .container::-webkit-scrollbar-thumb:hover {
            background: var(--vscode-scrollbarSlider-hoverBackground);
        }
        .container::-webkit-scrollbar-corner {
            background: transparent;
        }
        table {
            border-collapse: collapse;
            table-layout: auto;
            font-size: 11px;
        }
        th, td {
            border: 1px solid var(--vscode-panel-border);
            padding: 3px 8px;
            text-align: left;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        th {
            background: var(--vscode-editor-background, #1e1e1e);
            position: sticky;
            top: 0;
            cursor: pointer;
            font-weight: 600;
            user-select: none;
            z-index: 2;
            border-bottom: 2px solid var(--vscode-panel-border);
            position: relative;
        }
        th:hover { background: var(--vscode-list-hoverBackground); }
        th.dragging { opacity: 0.5; }
        th.drag-over { border-left: 2px solid var(--vscode-focusBorder); }
        .resize-handle {
            position: absolute;
            right: 0;
            top: 0;
            bottom: 0;
            width: 5px;
            cursor: col-resize;
            background: transparent;
        }
        .resize-handle:hover, .resize-handle.resizing {
            background: var(--vscode-focusBorder);
        }
        .stats-dialog {
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-focusBorder);
            border-radius: 6px;
            padding: 16px 20px;
            min-width: 200px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.4);
            z-index: 2000;
            display: none;
        }
        .stats-dialog.visible { display: block; }
        .stats-dialog h3 {
            margin: 0 0 12px 0;
            font-size: 14px;
            color: var(--vscode-foreground);
            border-bottom: 1px solid var(--vscode-panel-border);
            padding-bottom: 8px;
        }
        .stats-dialog pre {
            margin: 0;
            font-family: var(--vscode-editor-font-family);
            font-size: 13px;
            line-height: 1.6;
            color: var(--vscode-foreground);
            white-space: pre-wrap;
        }
        .stats-dialog button {
            margin-top: 12px;
            padding: 4px 12px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 3px;
            cursor: pointer;
            font-size: 12px;
        }
        .stats-dialog button:hover {
            background: var(--vscode-button-hoverBackground);
        }
        .chart-container {
            display: none;
            padding: 16px;
            background: var(--vscode-editor-background);
            height: 100%;
            overflow: auto;
        }
        .chart-container.visible {
            display: block;
        }
        .chart-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 12px;
        }
        .chart-header h3 {
            margin: 0;
            font-size: 14px;
        }
        .chart-type-selector {
            display: flex;
            gap: 4px;
        }
        .chart-type-btn {
            padding: 4px 8px;
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: none;
            border-radius: 3px;
            cursor: pointer;
            font-size: 11px;
        }
        .chart-type-btn.active {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        .chart-svg {
            width: 100%;
            height: 300px;
            background: var(--vscode-editor-background);
        }
        .chart-legend {
            display: flex;
            flex-wrap: wrap;
            gap: 12px;
            margin-top: 12px;
            font-size: 11px;
        }
        .legend-item {
            display: flex;
            align-items: center;
            gap: 4px;
        }
        .legend-color {
            width: 12px;
            height: 12px;
            border-radius: 2px;
        }
        .pivot-container {
            display: none;
            flex-direction: column;
            height: 100%;
            padding: 8px;
            background: var(--vscode-editor-background);
        }
        .pivot-container.visible {
            display: flex;
        }
        .pivot-config {
            display: flex;
            gap: 16px;
            flex-wrap: wrap;
            padding: 8px;
            background: var(--vscode-sideBar-background);
            border-radius: 4px;
            margin-bottom: 8px;
        }
        .pivot-field {
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .pivot-field label {
            font-size: 12px;
            font-weight: 500;
            color: var(--vscode-descriptionForeground);
        }
        .pivot-field select {
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            padding: 4px 8px;
            border-radius: 3px;
            font-size: 12px;
            min-width: 120px;
        }
        .pivot-field select:focus {
            outline: 1px solid var(--vscode-focusBorder);
        }
        .pivot-table-wrapper {
            flex: 1;
            overflow: auto;
        }
        .pivot-placeholder {
            text-align: center;
            padding: 40px;
            color: var(--vscode-descriptionForeground);
        }
        .pivot-table {
            width: 100%;
            border-collapse: collapse;
            font-size: 12px;
        }
        .pivot-table th, .pivot-table td {
            padding: 6px 10px;
            text-align: right;
            border: 1px solid var(--vscode-panel-border);
        }
        .pivot-table th {
            background: var(--vscode-sideBarSectionHeader-background);
            font-weight: 600;
        }
        .pivot-table td.row-header {
            text-align: left;
            font-weight: 500;
            background: var(--vscode-sideBarSectionHeader-background);
        }
        .pivot-table td.total {
            font-weight: 600;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
        }
        .pivot-table tr.total-row td {
            font-weight: 600;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
        }
        .compare-container {
            display: none;
            flex-direction: column;
            height: 100%;
            background: var(--vscode-editor-background);
        }
        .compare-container.visible {
            display: flex;
        }
        .compare-header {
            display: flex;
            align-items: center;
            gap: 16px;
            padding: 8px 12px;
            background: var(--vscode-sideBar-background);
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .compare-select-group {
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .compare-select-group label {
            font-size: 12px;
            font-weight: 500;
        }
        .compare-select-group select {
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            padding: 4px 8px;
            border-radius: 3px;
            font-size: 12px;
            min-width: 150px;
        }
        .compare-stats {
            flex: 1;
            text-align: center;
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
        }
        .compare-stats .stat-added { color: var(--vscode-gitDecoration-addedResourceForeground, #4ec9b0); }
        .compare-stats .stat-removed { color: var(--vscode-gitDecoration-deletedResourceForeground, #f14c4c); }
        .compare-stats .stat-changed { color: var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d); }
        .compare-close {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: none;
            padding: 4px 10px;
            border-radius: 3px;
            cursor: pointer;
            font-size: 12px;
        }
        .compare-close:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        .compare-view {
            flex: 1;
            display: flex;
            overflow: hidden;
        }
        .compare-panel {
            flex: 1;
            overflow: auto;
            border-right: 1px solid var(--vscode-panel-border);
        }
        .compare-panel:last-child {
            border-right: none;
        }
        .compare-panel table {
            width: 100%;
            border-collapse: collapse;
            font-size: 12px;
        }
        .compare-panel th, .compare-panel td {
            padding: 4px 8px;
            text-align: left;
            border-bottom: 1px solid var(--vscode-panel-border);
            white-space: nowrap;
        }
        .compare-panel th {
            background: var(--vscode-sideBarSectionHeader-background);
            font-weight: 600;
            position: sticky;
            top: 0;
        }
        .compare-panel tr.row-added {
            background: rgba(78, 201, 176, 0.15);
        }
        .compare-panel tr.row-removed {
            background: rgba(241, 76, 76, 0.15);
        }
        .compare-panel tr.row-changed {
            background: rgba(226, 192, 141, 0.15);
        }
        .compare-panel td.cell-changed {
            background: rgba(226, 192, 141, 0.3);
            font-weight: 500;
        }
        .compare-placeholder {
            padding: 40px;
            text-align: center;
            color: var(--vscode-descriptionForeground);
        }
        th.highlight { background: var(--vscode-editor-findMatchHighlightBackground); }
        th.col-highlight { background: rgba(138, 43, 226, 0.35) !important; }
        tr:nth-child(even) { background: rgba(255,255,255,0.02); }
        tr:hover { background: var(--vscode-list-hoverBackground); }
        tr.selected { background: var(--vscode-list-activeSelectionBackground) !important; }
        tr.filter-match { background: var(--vscode-editor-findMatchHighlightBackground) !important; }
        tr.filter-match td { border-left: 3px solid var(--vscode-editor-findMatchBorder, #ffcc00); }
        td.cell-match { background: rgba(255, 204, 0, 0.5) !important; color: #000 !important; }
        mark { background: #ffcc00; color: #000; padding: 1px 2px; border-radius: 2px; font-weight: 500; }
        tr.user-highlight { background: rgba(0, 150, 200, 0.35) !important; }
        tr.user-highlight td { border-left: 3px solid #00bcd4; }
        td { cursor: pointer; }
        td:hover { background: var(--vscode-editor-selectionBackground); }
        td.highlight { background: var(--vscode-editor-findMatchHighlightBackground) !important; }
        td.col-highlight { background: rgba(138, 43, 226, 0.25) !important; }
        td.link { color: var(--vscode-textLink-foreground); text-decoration: underline; }
        .loading, .empty {
            display: flex;
            flex-direction: column;
            justify-content: center;
            align-items: center;
            height: 100%;
            padding: 20px;
            text-align: center;
        }
        .loading-spinner {
            width: 32px;
            height: 32px;
            border: 3px solid var(--vscode-panel-border);
            border-top-color: var(--vscode-focusBorder);
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin-bottom: 12px;
        }
        @keyframes spin {
            to { transform: rotate(360deg); }
        }
        .loading-text {
            color: var(--vscode-foreground);
            font-size: 13px;
            margin-bottom: 6px;
        }
        .loading-timer {
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
            font-variant-numeric: tabular-nums;
        }
        .loading-cancel {
            margin-top: 12px;
            padding: 6px 16px;
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
        }
        .loading-cancel:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        .loading-query {
            margin-top: 16px;
            max-width: 600px;
            max-height: 150px;
            overflow: auto;
            background: var(--vscode-textCodeBlock-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            padding: 8px 12px;
        }
        .loading-query pre {
            margin: 0;
            white-space: pre-wrap;
            word-break: break-word;
            font-family: var(--vscode-editor-font-family);
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
        }
        .error-container {
            display: flex;
            flex-direction: column;
            padding: 16px;
            height: 100%;
            box-sizing: border-box;
        }
        .error-banner {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 10px 14px;
            background: linear-gradient(135deg, rgba(200, 50, 50, 0.15) 0%, rgba(200, 50, 50, 0.08) 100%);
            border-left: 4px solid var(--vscode-errorForeground, #f44336);
            border-radius: 4px;
            margin-bottom: 12px;
        }
        .error-banner-icon {
            font-size: 18px;
            flex-shrink: 0;
        }
        .error-banner-text {
            font-weight: 600;
            font-size: 13px;
            color: var(--vscode-errorForeground, #f44336);
        }
        .error-message-box {
            flex: 1;
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            padding: 12px;
            overflow: auto;
            min-height: 100px;
            max-height: calc(100% - 100px);
        }
        .error-message-text {
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: 12px;
            line-height: 1.6;
            color: var(--vscode-foreground);
            white-space: pre-wrap;
            word-break: break-word;
            margin: 0;
        }
        .error-actions {
            display: flex;
            gap: 8px;
            margin-top: 12px;
            padding-top: 12px;
            border-top: 1px solid var(--vscode-panel-border);
        }
        .error-btn {
            display: flex;
            align-items: center;
            gap: 6px;
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: none;
            padding: 8px 14px;
            cursor: pointer;
            border-radius: 4px;
            font-size: 12px;
            font-weight: 500;
            transition: background 0.15s;
        }
        .error-btn:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        .error-btn.primary {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        .error-btn.primary:hover {
            background: var(--vscode-button-hoverBackground);
        }
        /* ADO Preview Panel */
        .ado-preview-panel {
            display: none;
            flex-direction: column;
            position: fixed;
            right: 0;
            top: 0;
            bottom: 0;
            width: 400px;
            max-width: 50vw;
            background: var(--vscode-sideBar-background);
            border-left: 1px solid var(--vscode-sideBar-border);
            z-index: 999;
            box-shadow: -4px 0 12px rgba(0,0,0,0.3);
        }
        .preview-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 10px 12px;
            background: var(--vscode-sideBarSectionHeader-background);
            border-bottom: 1px solid var(--vscode-sideBar-border);
            font-weight: 600;
            font-size: 12px;
        }
        .preview-close {
            background: none;
            border: none;
            color: var(--vscode-foreground);
            cursor: pointer;
            font-size: 18px;
            padding: 0 6px;
            opacity: 0.7;
        }
        .preview-close:hover { opacity: 1; }
        .preview-content {
            flex: 1;
            overflow-y: auto;
            padding: 12px;
        }
        .preview-title-bar {
            display: flex;
            gap: 10px;
            align-items: baseline;
            margin-bottom: 12px;
            padding-bottom: 10px;
            border-bottom: 1px solid var(--vscode-sideBar-border);
        }
        .preview-id {
            font-weight: 700;
            color: var(--vscode-textLink-foreground);
            font-size: 14px;
        }
        .preview-title {
            font-weight: 600;
            font-size: 13px;
        }
        .preview-table {
            width: 100%;
            border-collapse: collapse;
            font-size: 11px;
        }
        .preview-table tr {
            border-bottom: 1px solid var(--vscode-sideBar-border);
        }
        .preview-table tr.important {
            background: var(--vscode-list-hoverBackground);
        }
        .preview-table td {
            padding: 6px 4px;
            vertical-align: top;
        }
        .preview-table .field-name {
            font-weight: 500;
            color: var(--vscode-descriptionForeground);
            width: 120px;
            white-space: nowrap;
        }
        .preview-table .field-value {
            word-break: break-word;
        }
        .preview-actions {
            margin-top: 12px;
            padding-top: 12px;
            border-top: 1px solid var(--vscode-sideBar-border);
        }
        .preview-actions button {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 6px 12px;
            cursor: pointer;
            border-radius: 3px;
            font-size: 11px;
        }
        .preview-actions button:hover {
            background: var(--vscode-button-hoverBackground);
        }
        /* HTML content sections (Description, Repro Steps) */
        .preview-html-fields {
            margin-bottom: 12px;
        }
        .preview-html-section {
            margin-bottom: 12px;
            border: 1px solid var(--vscode-sideBar-border);
            border-radius: 4px;
            overflow: hidden;
        }
        .preview-html-header {
            background: var(--vscode-sideBarSectionHeader-background);
            padding: 6px 10px;
            font-weight: 600;
            font-size: 11px;
            border-bottom: 1px solid var(--vscode-sideBar-border);
        }
        .preview-html-content {
            padding: 10px;
            font-size: 12px;
            line-height: 1.5;
            max-height: 300px;
            overflow-y: auto;
            background: var(--vscode-editor-background);
        }
        .preview-html-content img {
            max-width: 100%;
            height: auto;
        }
        .preview-html-content a {
            color: var(--vscode-textLink-foreground);
        }
        .preview-html-content ul, .preview-html-content ol {
            margin: 8px 0;
            padding-left: 20px;
        }
        .preview-html-content p {
            margin: 8px 0;
        }
        .preview-html-content pre, .preview-html-content code {
            background: var(--vscode-textCodeBlock-background);
            padding: 2px 4px;
            border-radius: 3px;
            font-family: var(--vscode-editor-font-family);
        }
        .context-menu {
            position: fixed;
            background: var(--vscode-menu-background);
            border: 1px solid var(--vscode-menu-border);
            box-shadow: 0 2px 8px rgba(0,0,0,0.3);
            border-radius: 4px;
            padding: 4px 0;
            z-index: 1000;
            min-width: 150px;
        }
        .context-menu-item {
            padding: 4px 10px;
            cursor: pointer;
            font-size: 11px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .context-menu-item:hover {
            background: var(--vscode-menu-selectionBackground);
        }
        .context-menu-item.has-submenu::after {
            content: '▶';
            font-size: 8px;
            margin-left: 10px;
        }
        .context-menu-separator {
            height: 1px;
            background: var(--vscode-menu-separatorBackground);
            margin: 4px 0;
        }
        .submenu {
            position: absolute;
            left: 100%;
            top: 0;
            background: var(--vscode-menu-background);
            border: 1px solid var(--vscode-menu-border);
            box-shadow: 0 2px 8px rgba(0,0,0,0.3);
            border-radius: 4px;
            padding: 4px 0;
            min-width: 180px;
            display: none;
        }
        .context-menu-item:hover > .submenu {
            display: block;
        }
        .welcome {
            display: flex;
            flex-direction: column;
            justify-content: center;
            align-items: center;
            height: 100%;
            color: var(--vscode-descriptionForeground);
        }
        .footer {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 4px 12px;
            background: var(--vscode-statusBar-background, #007acc);
            border-top: 1px solid var(--vscode-statusBar-border, #007acc);
            font-size: 11px;
            color: var(--vscode-statusBar-foreground, #fff);
            flex-shrink: 0;
        }
        .footer a {
            color: var(--vscode-statusBar-foreground, #fff);
            text-decoration: none;
            opacity: 0.9;
        }
        .footer a:hover {
            opacity: 1;
            text-decoration: underline;
        }
        .footer .brand {
            font-weight: 600;
        }
        .footer .bug-report {
            cursor: pointer;
            padding: 2px 8px;
            border-radius: 3px;
            background: rgba(255,255,255,0.1);
        }
        .footer .bug-report:hover {
            background: rgba(255,255,255,0.2);
        }
        .column-selector {
            position: absolute;
            top: 100%;
            left: 0;
            background: var(--vscode-menu-background);
            border: 1px solid var(--vscode-menu-border);
            box-shadow: 0 2px 8px rgba(0,0,0,0.3);
            border-radius: 4px;
            padding: 6px 0;
            z-index: 1001;
            min-width: 180px;
            max-height: 300px;
            overflow-y: auto;
            display: none;
        }
        .column-selector.visible {
            display: block;
        }
        .column-selector-header {
            padding: 4px 10px 6px 10px;
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            border-bottom: 1px solid var(--vscode-menu-separatorBackground);
            margin-bottom: 4px;
            display: flex;
            justify-content: space-between;
        }
        .column-selector-header span {
            cursor: pointer;
            opacity: 0.8;
        }
        .column-selector-header span:hover {
            opacity: 1;
            text-decoration: underline;
        }
        .column-selector-item {
            padding: 4px 10px;
            font-size: 11px;
            cursor: grab;
            display: flex;
            align-items: center;
            gap: 6px;
            user-select: none;
        }
        .column-selector-item:hover {
            background: var(--vscode-menu-selectionBackground);
        }
        .column-selector-item.dragging {
            opacity: 0.5;
            background: var(--vscode-list-activeSelectionBackground);
        }
        .column-selector-item.drag-over {
            border-top: 2px solid var(--vscode-focusBorder);
        }
        .column-selector-item .drag-handle {
            cursor: grab;
            opacity: 0.5;
            margin-right: 4px;
        }
        .column-selector-item .drag-handle:hover {
            opacity: 1;
        }
        .column-selector-item input {
            cursor: pointer;
        }
        .preset-menu {
            min-width: 200px;
        }
        .preset-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 6px 10px;
            border-bottom: 1px solid var(--vscode-menu-separatorBackground);
            margin-bottom: 4px;
        }
        .preset-action {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: none;
            padding: 2px 6px;
            border-radius: 3px;
            cursor: pointer;
            font-size: 11px;
        }
        .preset-action:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        .preset-list {
            max-height: 200px;
            overflow-y: auto;
        }
        .preset-item {
            display: flex;
            align-items: center;
            padding: 4px 10px;
            cursor: pointer;
            gap: 6px;
        }
        .preset-item:hover {
            background: var(--vscode-menu-selectionBackground);
        }
        .preset-item-name {
            flex: 1;
            font-size: 12px;
        }
        .preset-item-delete {
            opacity: 0;
            color: var(--vscode-errorForeground);
            cursor: pointer;
            padding: 2px 4px;
        }
        .preset-item:hover .preset-item-delete {
            opacity: 0.7;
        }
        .preset-item-delete:hover {
            opacity: 1 !important;
        }
        .preset-empty {
            padding: 10px;
            text-align: center;
            color: var(--vscode-descriptionForeground);
            font-size: 11px;
        }
        .column-btn-wrapper {
            position: relative;
        }
    </style>
</head>
<body>
    <div class="tabs-bar" id="tabsBar"></div>
    <div class="toolbar" id="toolbar" style="display:none;">
        <span class="status" id="status"></span>
        <span class="status" id="duration" style="color: var(--vscode-charts-green, #4ec9b0);"></span>
        <div class="separator"></div>
        <button id="setQueryBtn" onclick="setQuery()">⬆ Set Query</button>
        <button id="copyQueryBtn" onclick="copyQuery()">📋 Copy</button>
        <button id="openAdxBtn" onclick="openInAdx()">🌐 ADX</button>
        <button id="openAdoBtn" onclick="openInAdo()">🌐 ADO</button>
        <button id="reRunBtn" onclick="reRun()">🔄 Re-Run</button>
        <div class="separator"></div>
        <button onclick="exportCsv()">💾 Save Result</button>
        <button onclick="toggleChart()" id="chartBtn" title="Toggle chart view">📊 Chart</button>
        <button onclick="togglePivot()" id="pivotBtn" title="Toggle pivot table view">🔀 Pivot</button>
        <button onclick="startCompare()" id="compareBtn" title="Compare two result tabs">⚖️ Compare</button>
        <div class="column-btn-wrapper">
            <button onclick="toggleColumnSelector(event)" id="columnsBtn" title="Select which columns to display">📑 Columns</button>
            <div class="column-selector" id="columnSelector"></div>
        </div>
        <div class="column-btn-wrapper">
            <button onclick="togglePresetMenu(event)" id="presetBtn" title="Column layout presets">📐 Presets</button>
            <div class="column-selector preset-menu" id="presetMenu">
                <div class="preset-header">
                    <span style="font-weight:600;">Column Presets</span>
                    <button onclick="saveCurrentPreset()" class="preset-action" title="Save current layout">💾 Save</button>
                </div>
                <div id="presetList" class="preset-list"></div>
            </div>
        </div>
        <button onclick="clearColorRules()" id="clearColorsBtn" style="display:none;" title="Clear all color rules">🎨 Clear Colors</button>
        <div class="filter-group">
            <span style="font-size:11px;">🔍</span>
            <input type="text" class="filter-input" id="filterInput" placeholder="col::value or text..." oninput="debounceFilter(this.value)" title="Filter: text (all cols), col::val (column filter), ::col (highlight), !pat (exclude)">
            <button onclick="toggleFilterMode()" id="filterModeBtn" style="padding:2px 6px;" title="Mode: Filter rows (click to switch to Highlight)">🔽</button>
            <button onclick="clearFilter()" style="padding:2px 4px;">✕</button>
            <button onclick="searchAllTabs()" style="padding:2px 6px;" title="Search across all result tabs">🔎 All</button>
        </div>
    </div>
    <div class="container" id="container">
        <div class="welcome">Run a query to see results<br><small>Press F5 or Shift+Enter in a .kql file</small></div>
    </div>
    <div class="chart-container" id="chartContainer">
        <div class="chart-header">
            <h3 id="chartTitle">Chart View</h3>
            <div class="chart-type-selector">
                <button class="chart-type-btn active" onclick="setChartType('line')">Line</button>
                <button class="chart-type-btn" onclick="setChartType('bar')">Bar</button>
                <button class="chart-type-btn" onclick="setChartType('area')">Area</button>
            </div>
        </div>
        <svg class="chart-svg" id="chartSvg"></svg>
        <div class="chart-legend" id="chartLegend"></div>
    </div>
    <div class="pivot-container" id="pivotContainer">
        <div class="pivot-config">
            <div class="pivot-field">
                <label>Rows:</label>
                <select id="pivotRowField" onchange="updatePivot()">
                    <option value="">Select column...</option>
                </select>
            </div>
            <div class="pivot-field">
                <label>Columns:</label>
                <select id="pivotColField" onchange="updatePivot()">
                    <option value="">Select column...</option>
                </select>
            </div>
            <div class="pivot-field">
                <label>Values:</label>
                <select id="pivotValueField" onchange="updatePivot()">
                    <option value="">Select column...</option>
                </select>
            </div>
            <div class="pivot-field">
                <label>Aggregate:</label>
                <select id="pivotAggFunc" onchange="updatePivot()">
                    <option value="count">Count</option>
                    <option value="sum">Sum</option>
                    <option value="avg">Average</option>
                    <option value="min">Min</option>
                    <option value="max">Max</option>
                </select>
            </div>
        </div>
        <div class="pivot-table-wrapper" id="pivotTableWrapper">
            <div class="pivot-placeholder">Select row, column, and value fields to create a pivot table</div>
        </div>
    </div>
    <div class="compare-container" id="compareContainer">
        <div class="compare-header">
            <div class="compare-select-group">
                <label>Left:</label>
                <select id="compareLeft" onchange="updateCompare()"></select>
            </div>
            <div class="compare-stats" id="compareStats"></div>
            <div class="compare-select-group">
                <label>Right:</label>
                <select id="compareRight" onchange="updateCompare()"></select>
            </div>
            <button onclick="closeCompare()" class="compare-close">✕ Close</button>
        </div>
        <div class="compare-view" id="compareView">
            <div class="compare-panel" id="compareLeftPanel"></div>
            <div class="compare-panel" id="compareRightPanel"></div>
        </div>
    </div>
    <div class="context-menu" id="contextMenu" style="display:none;"></div>
    <div class="context-menu" id="tabContextMenu" style="display:none;"></div>
    <div class="stats-dialog" id="statsDialog">
        <h3 id="statsTitle">Statistics</h3>
        <pre id="statsContent"></pre>
        <button onclick="closeStatsDialog()">OK</button>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let tabs = [];
        let activeTabId = null;
        let currentData = null;
        let originalData = null;
        let tabResultsCache = {}; // Cache results for each tab for comparison
        let sortColumn = -1;
        let sortAsc = true;
        let filterTimeout = null;
        let hasQuery = false;
        let hasConnection = false;
        let selectedRowIndex = -1;
        let highlightedColumns = [];
        let userHighlightedColumns = new Set();
        let colorRules = [];
        let queryStartTime = null;
        let timerInterval = null;
        let queryType = null;
        let clusterUrl = null;
        let database = null;
        let filterMode = 'filter'; // 'filter' or 'highlight'
        let currentFilterText = ''; // Current filter text for cell highlighting
        let isLoading = false; // Track if current tab is loading
        let loadingQuery = ''; // The query text being executed
        let hiddenColumns = new Set(); // Track which columns are hidden by index

        function startTimer() {
            queryStartTime = Date.now();
            if (timerInterval) clearInterval(timerInterval);
            timerInterval = setInterval(updateTimer, 100);
        }

        function stopTimer() {
            if (timerInterval) {
                clearInterval(timerInterval);
                timerInterval = null;
            }
        }

        function updateTimer() {
            if (!queryStartTime) return;
            const elapsed = ((Date.now() - queryStartTime) / 1000).toFixed(1);
            const timerEl = document.querySelector('.loading-timer');
            if (timerEl) {
                timerEl.textContent = elapsed + 's';
            }
        }

        window.addEventListener('message', event => {
            const msg = event.data;
            switch (msg.command) {
                case 'showLoading':
                    tabs.push({ id: msg.tabId, title: '⏳ Running...', queryType: msg.queryType });
                    activeTabId = msg.tabId;
                    hasQuery = msg.hasQuery;
                    hasConnection = msg.hasConnection;
                    queryType = msg.queryType;
                    clusterUrl = msg.clusterUrl;
                    database = msg.database;
                    loadingQuery = msg.query || '';
                    isLoading = true;
                    renderTabs();
                    // Show toolbar with relevant buttons during loading
                    const toolbar = document.getElementById('toolbar');
                    toolbar.style.display = 'flex';
                    document.getElementById('setQueryBtn').style.display = hasConnection ? 'inline-block' : 'none';
                    document.getElementById('copyQueryBtn').style.display = hasQuery ? 'inline-block' : 'none';
                    document.getElementById('openAdxBtn').style.display = 'none'; // Hide during loading
                    document.getElementById('openAdoBtn').style.display = 'none'; // Hide during loading
                    document.getElementById('reRunBtn').style.display = 'none'; // Hide during loading
                    document.getElementById('clearColorsBtn').style.display = 'none';
                    // Show loading with query preview and cancel button
                    const queryPreview = loadingQuery ? '<div class="loading-query"><pre>' + escapeHtml(loadingQuery.substring(0, 500) + (loadingQuery.length > 500 ? '...' : '')) + '</pre></div>' : '';
                    document.getElementById('container').innerHTML = '<div class="loading"><div class="loading-spinner"></div><div class="loading-text">Running query...</div><div class="loading-timer">0.0s</div><button class="loading-cancel" onclick="cancelQuery()">⏹ Cancel</button>' + queryPreview + '</div>';
                    startTimer();
                    break;
                case 'updateState':
                    stopTimer();
                    const tabChanged = activeTabId !== msg.activeTabId;
                    tabs = msg.tabs;
                    activeTabId = msg.activeTabId;
                    hasQuery = msg.hasQuery;
                    hasConnection = msg.hasConnection;
                    colorRules = msg.colorRules || [];
                    queryType = msg.queryType;
                    clusterUrl = msg.clusterUrl;
                    database = msg.database;
                    isLoading = msg.isLoading || false;
                    originalData = msg.activeResult ? JSON.parse(JSON.stringify(msg.activeResult)) : null;
                    currentData = msg.activeResult;
                    // Cache result for this tab (for comparison feature)
                    if (activeTabId && msg.activeResult) {
                        tabResultsCache[activeTabId] = msg.activeResult;
                    }
                    // Clean up cache for tabs that no longer exist
                    const tabIds = new Set(tabs.map(t => t.id));
                    Object.keys(tabResultsCache).forEach(id => {
                        if (!tabIds.has(id)) delete tabResultsCache[id];
                    });
                    // Clear row-specific state when tab changes (indices would be invalid)
                    if (tabChanged) {
                        highlightedRows.clear();
                        selectedRows.clear();
                        matchingRowIndices = [];
                        highlightedColumns = [];
                        userHighlightedColumns.clear();
                        selectedRowIndex = -1;
                        lastClickedRow = -1;
                        hiddenColumns.clear();
                        closeColumnSelector();
                        // Restore filter state for the new tab
                        const newFilterText = msg.filterText || '';
                        const newFilterMode = msg.filterMode || 'filter';
                        filterMode = newFilterMode;
                        currentFilterText = '';
                        const filterInput = document.getElementById('filterInput');
                        if (filterInput) {
                            filterInput.value = newFilterText;
                        }
                        // Update filter mode button
                        const filterModeBtn = document.getElementById('filterModeBtn');
                        if (filterModeBtn) {
                            filterModeBtn.textContent = filterMode === 'filter' ? '🔽' : '🖌️';
                            filterModeBtn.title = filterMode === 'filter' ? 'Mode: Filter rows (click to switch to Highlight)' : 'Mode: Highlight rows (click to switch to Filter)';
                        }
                        // Apply the filter if there's text
                        if (newFilterText && originalData) {
                            setTimeout(() => filterResults(newFilterText), 0);
                        }
                    }
                    renderTabs();
                    renderContent();
                    break;
                case 'columnPresetsList':
                    updatePresetList(msg.presets);
                    break;
                case 'applyColumnPreset':
                    applyColumnPreset(msg.widths, msg.order);
                    break;
            }
        });

        function getTypeIcon(queryType) {
            if (queryType === 'kusto') return 'Ⓚ';
            if (queryType === 'ado') return 'Ⓐ';
            if (queryType === 'outlook') return '📧';
            return '';
        }

        function renderTabs() {
            const bar = document.getElementById('tabsBar');
            bar.innerHTML = tabs.map(t => {
                return '<div class="tab' + (t.id === activeTabId ? ' active' : '') + '" data-id="' + t.id + '" onclick="selectTab(\\'' + t.id + '\\')" oncontextmenu="showTabContextMenu(event, \\'' + t.id + '\\')" onauxclick="onTabMiddleClick(event, \\'' + t.id + '\\')">' +
                    '<span class="tab-title">' + escapeHtml(t.title) + '</span>' +
                    '<span class="tab-close" onclick="event.stopPropagation(); closeTab(\\'' + t.id + '\\')">×</span>' +
                    '</div>';
            }).join('');
        }

        function onTabMiddleClick(e, id) {
            if (e.button === 1) { // Middle mouse button
                e.preventDefault();
                closeTab(id);
            }
        }

        function renderContent() {
            const toolbar = document.getElementById('toolbar');
            const container = document.getElementById('container');

            // Show loading spinner if this tab is loading
            if (isLoading) {
                toolbar.style.display = 'none';
                // Only create loading HTML if not already showing loading state
                if (!container.querySelector('.loading')) {
                    const elapsed = queryStartTime ? ((Date.now() - queryStartTime) / 1000).toFixed(1) : '0.0';
                    container.innerHTML = '<div class="loading"><div class="loading-spinner"></div><div class="loading-text">Running query...</div><div class="loading-timer">' + elapsed + 's</div><button class="loading-cancel" onclick="cancelQuery()">⏹ Cancel</button></div>';
                }
                if (!timerInterval) startTimer();
                return;
            }

            if (!currentData) {
                toolbar.style.display = 'none';
                container.innerHTML = '<div class="welcome">Run a query to see results<br><small>Press F5 or Shift+Enter in a .kql file</small></div>';
                return;
            }

            toolbar.style.display = 'flex';
            document.getElementById('setQueryBtn').style.display = hasConnection ? 'inline-block' : 'none';
            document.getElementById('copyQueryBtn').style.display = hasQuery ? 'inline-block' : 'none';
            document.getElementById('openAdxBtn').style.display = (hasConnection && queryType === 'kusto') ? 'inline-block' : 'none';
            document.getElementById('openAdoBtn').style.display = (hasConnection && queryType === 'ado') ? 'inline-block' : 'none';
            document.getElementById('reRunBtn').style.display = hasConnection ? 'inline-block' : 'none';
            document.getElementById('clearColorsBtn').style.display = colorRules.length > 0 ? 'inline-block' : 'none';

            if (!currentData.success) {
                container.innerHTML = '<div class="error-container">' +
                    '<div class="error-banner">' +
                    '<span class="error-banner-icon">✕</span>' +
                    '<span class="error-banner-text">Query Execution Failed</span>' +
                    '</div>' +
                    '<div class="error-message-box">' +
                    '<pre class="error-message-text">' + escapeHtml(currentData.error || 'Unknown error') + '</pre>' +
                    '</div>' +
                    '<div class="error-actions">' +
                    '<button class="error-btn" onclick="copyError()">Copy Error</button>' +
                    (hasConnection ? '<button class="error-btn primary" onclick="reRun()">Retry Query</button>' : '') +
                    '</div>' +
                    '</div>';
                document.getElementById('status').textContent = 'Error';
                return;
            }

            if (currentData.rows.length === 0) {
                container.innerHTML = '<div class="empty">No results returned</div>';
                document.getElementById('status').textContent = '0 rows';
                return;
            }

            const filtered = currentData.rows.length !== originalData.rows.length
                ? currentData.rows.length + '/' + originalData.rows.length
                : currentData.rowCount;
            document.getElementById('status').textContent = filtered + ' rows';

            // Show duration prominently
            const durationEl = document.getElementById('duration');
            if (currentData.executionTimeMs > 0) {
                const secs = (currentData.executionTimeMs / 1000).toFixed(2);
                durationEl.textContent = '⏱ ' + secs + 's';
                durationEl.style.display = 'inline';
            } else {
                durationEl.style.display = 'none';
            }

            container.innerHTML = buildTable(currentData.columns, currentData.rows);
        }

        function buildTable(columns, rows) {
            // Find ID column index for ADO work items
            const idColIndex = queryType === 'ado' ? columns.findIndex(c => c === 'Id' || c === 'System.Id') : -1;

            let html = '<table><thead><tr>';
            columns.forEach((col, i) => {
                if (hiddenColumns.has(i)) return; // Skip hidden columns
                const sortInd = sortColumn === i ? (sortAsc ? ' ↑' : ' ↓') : '';
                const hlClass = highlightedColumns.includes(i) ? ' highlight' : '';
                const userHlClass = userHighlightedColumns.has(i) ? ' col-highlight' : '';
                // Apply stored column width if available
                const widthStyle = columnWidths[i] ? 'width:' + columnWidths[i] + 'px;min-width:' + columnWidths[i] + 'px;max-width:' + columnWidths[i] + 'px;' : '';
                html += '<th class="' + hlClass + userHlClass + '" style="' + widthStyle + '" draggable="true" data-col="' + i + '" onclick="sortBy(' + i + ')" ondragstart="onColDragStart(event,' + i + ')" ondragover="onColDragOver(event)" ondragleave="onColDragLeave(event)" ondrop="onColDrop(event,' + i + ')">';
                html += '<span class="col-text">' + escapeHtml(col) + sortInd + '</span>';
                html += '<div class="resize-handle" onmousedown="startResize(event,' + i + ')"></div>';
                html += '</th>';
            });
            html += '</tr></thead><tbody>';
            rows.forEach((row, ri) => {
                const isSelected = selectedRows.has(ri);
                const isMatch = matchingRowIndices.includes(ri);
                const isHighlighted = highlightedRows.has(ri);
                const rowClass = (isSelected ? 'selected' : '') + (isMatch ? ' filter-match' : '') + (isHighlighted ? ' user-highlight' : '');
                html += '<tr class="' + rowClass.trim() + '">';
                row.forEach((cell, ci) => {
                    if (hiddenColumns.has(ci)) return; // Skip hidden columns
                    const v = cell ?? '';
                    const isLink = String(v).startsWith('http://') || String(v).startsWith('https://');
                    const isAdoId = ci === idColIndex && queryType === 'ado';
                    const hlClass = highlightedColumns.includes(ci) ? ' highlight' : '';
                    const userHlClass = userHighlightedColumns.has(ci) ? ' col-highlight' : '';
                    const linkClass = (isLink || isAdoId) ? ' link' : '';
                    const colorStyle = getColorStyle(ci, v);
                    // Apply stored column width if available
                    const widthStyle = columnWidths[ci] ? 'width:' + columnWidths[ci] + 'px;min-width:' + columnWidths[ci] + 'px;max-width:' + columnWidths[ci] + 'px;' : '';
                    // Check if cell matches current filter
                    const cellMatchClass = currentFilterText && cellMatchesFilter(v, currentFilterText) ? ' cell-match' : '';
                    const displayValue = currentFilterText && cellMatchClass ? highlightMatchInCell(v, currentFilterText) : escapeHtml(v);
                    html += '<td class="' + hlClass + userHlClass + linkClass + cellMatchClass + '" style="' + colorStyle + widthStyle + '" onclick="onCellClick(event,' + ri + ',' + ci + ')" oncontextmenu="showCellContextMenu(event,' + ri + ',' + ci + ')" ondblclick="onCellDblClick(event,' + ri + ',' + ci + ')" title="' + escapeHtml(v) + '">' + displayValue + '</td>';
                });
                html += '</tr>';
            });
            html += '</tbody></table>';
            return html;
        }

        function getAdoWorkItemUrl(id) {
            if (!clusterUrl || !database) return null;
            // Format: https://dev.azure.com/{org}/{project}/_workitems/edit/{id}
            // or https://{org}.visualstudio.com/{project}/_workitems/edit/{id}
            const url = clusterUrl.replace(/\\/$/, '');
            return url + '/' + database + '/_workitems/edit/' + id;
        }

        function getColorStyle(columnIndex, cellValue) {
            for (const rule of colorRules) {
                if (rule.columnIndex !== columnIndex) continue;
                const strValue = String(cellValue ?? '');
                const colorInfo = rule.valueColors[strValue];
                if (colorInfo) {
                    return 'background-color:' + colorInfo.bg + ';color:' + colorInfo.fg + ';';
                }
            }
            return '';
        }

        function selectTab(id) {
            // Send current filter state so it can be saved for the old tab
            const filterInput = document.getElementById('filterInput');
            vscode.postMessage({
                command: 'selectTab',
                tabId: id,
                filterText: filterInput ? filterInput.value : '',
                filterMode: filterMode
            });
        }
        function closeTab(id) { vscode.postMessage({ command: 'closeTab', tabId: id }); }
        function setQuery() { vscode.postMessage({ command: 'setQuery' }); }
        function copyQuery() { vscode.postMessage({ command: 'copyQuery' }); }
        function openInAdx() { vscode.postMessage({ command: 'openInAdx' }); }
        function openInAdo() { vscode.postMessage({ command: 'openInAdo' }); }
        function reRun() { vscode.postMessage({ command: 'reRun' }); }
        function cancelQuery() { vscode.postMessage({ command: 'cancelQuery' }); }
        function exportCsv() { vscode.postMessage({ command: 'export', format: 'csv' }); }
        function exportJson() { vscode.postMessage({ command: 'export', format: 'json' }); }
        function saveAsPreset() { vscode.postMessage({ command: 'saveAsPreset' }); }
        function clearColorRules() { vscode.postMessage({ command: 'clearColorRules' }); }
        function addColorRule(ci, col, val) { vscode.postMessage({ command: 'addColorRule', columnIndex: ci, columnName: col, cellValue: val }); }
        function copyError() { if (currentData && currentData.error) { vscode.postMessage({ command: 'copyCell', value: currentData.error }); } }

        function sortBy(col) {
            if (!currentData) return;
            if (sortColumn === col) { sortAsc = !sortAsc; } else { sortColumn = col; sortAsc = true; }
            currentData.rows.sort((a, b) => {
                const va = a[col] ?? '', vb = b[col] ?? '';
                const na = parseFloat(va), nb = parseFloat(vb);
                if (!isNaN(na) && !isNaN(nb)) return sortAsc ? na - nb : nb - na;
                return sortAsc ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va));
            });
            renderContent();
        }

        function debounceFilter(text) {
            clearTimeout(filterTimeout);
            filterTimeout = setTimeout(() => filterResults(text), 150);
        }

        function filterResults(text) {
            if (!originalData) return;
            highlightedColumns = [];
            matchingRowIndices = [];
            currentFilterText = '';

            if (!text || !text.trim()) {
                currentData = JSON.parse(JSON.stringify(originalData));
                renderContent();
                return;
            }

            currentFilterText = text.trim();

            const ft = text.trim();

            // Column::value filter
            if (ft.includes('::') && !ft.startsWith('::')) {
                const [colPat, valPat] = ft.split('::');
                const cols = originalData.columns.map((c, i) => ({ c, i })).filter(x => x.c.toLowerCase().includes(colPat.toLowerCase())).map(x => x.i);
                if (cols.length) {
                    highlightedColumns = cols;
                    const re = safeRegex(valPat);

                    if (filterMode === 'highlight') {
                        // Highlight mode: show all rows but mark matching ones
                        currentData = JSON.parse(JSON.stringify(originalData));
                        matchingRowIndices = originalData.rows.map((r, i) => cols.some(ci => r[ci] && re.test(String(r[ci]))) ? i : -1).filter(i => i >= 0);
                    } else {
                        // Filter mode: only show matching rows
                        currentData = { ...originalData, rows: originalData.rows.filter(r => cols.some(i => r[i] && re.test(String(r[i])))) };
                        currentData.rowCount = currentData.rows.length;
                    }
                    renderContent();
                    return;
                }
            }

            // Column highlight (::colname)
            if (ft.startsWith('::')) {
                const colPat = ft.substring(2).toLowerCase();
                const newHighlight = originalData.columns.map((c, i) => ({ c, i })).filter(x => x.c.toLowerCase().includes(colPat)).map(x => x.i);
                if (JSON.stringify(highlightedColumns) === JSON.stringify(newHighlight)) {
                    highlightedColumns = [];
                    document.getElementById('filterInput').value = '';
                } else {
                    highlightedColumns = newHighlight;
                }
                currentData = JSON.parse(JSON.stringify(originalData));
                renderContent();
                // Scroll to first matched column after render completes
                if (highlightedColumns.length > 0) {
                    requestAnimationFrame(() => {
                        requestAnimationFrame(() => scrollToColumn(highlightedColumns[0]));
                    });
                }
                return;
            }

            // General text filter
            const neg = ft.startsWith('!');
            const pat = neg ? ft.substring(1) : ft;
            const re = safeRegex(pat);

            if (filterMode === 'highlight' && !neg) {
                // Highlight mode: show all rows but mark matching ones
                currentData = JSON.parse(JSON.stringify(originalData));
                matchingRowIndices = originalData.rows.map((r, i) => r.some(c => c && re.test(String(c))) ? i : -1).filter(i => i >= 0);
            } else {
                // Filter mode: only show matching rows
                currentData = { ...originalData, rows: originalData.rows.filter(r => { const m = r.some(c => c && re.test(String(c))); return neg ? !m : m; }) };
                currentData.rowCount = currentData.rows.length;
            }
            renderContent();
        }

        function safeRegex(p) { try { return new RegExp(p, 'i'); } catch { return new RegExp(escapeRegex(p), 'i'); } }
        function escapeRegex(s) { return s.replace(/[-\\/\\\\^$*+?.()|[\\]{}]/g, '\\\\$&'); }
        function cellMatchesFilter(cellValue, filterText) {
            if (!filterText || !cellValue) return false;
            const ft = filterText;
            // Skip column highlight syntax
            if (ft.startsWith('::')) return false;
            // Handle column::value syntax
            if (ft.includes('::') && !ft.startsWith('::')) {
                const valPat = ft.split('::')[1];
                if (!valPat) return false;
                const re = safeRegex(valPat);
                return re.test(String(cellValue));
            }
            // Handle exclude syntax
            if (ft.startsWith('!')) return false;
            // General text match
            const re = safeRegex(ft);
            return re.test(String(cellValue));
        }
        function highlightMatchInCell(cellValue, filterText) {
            if (!cellValue || !filterText) return escapeHtml(cellValue);
            const ft = filterText;
            let pat = ft;
            // Handle column::value syntax
            if (ft.includes('::') && !ft.startsWith('::')) {
                pat = ft.split('::')[1];
            }
            if (!pat || ft.startsWith('::') || ft.startsWith('!')) return escapeHtml(cellValue);
            try {
                const escaped = escapeHtml(String(cellValue));
                const re = new RegExp('(' + escapeRegex(pat) + ')', 'gi');
                return escaped.replace(re, '<mark>$1</mark>');
            } catch { return escapeHtml(cellValue); }
        }
        function clearFilter() { document.getElementById('filterInput').value = ''; highlightedColumns = []; matchingRowIndices = []; currentFilterText = ''; if (originalData) { currentData = JSON.parse(JSON.stringify(originalData)); renderContent(); } }
        function scrollToColumn(colIndex) {
            const container = document.getElementById('container');
            const table = container.querySelector('table');
            if (!table) return;
            const headerCells = table.querySelectorAll('thead th');
            if (colIndex >= 0 && colIndex < headerCells.length) {
                const cell = headerCells[colIndex + 1]; // +1 for row number column
                if (cell) {
                    const containerRect = container.getBoundingClientRect();
                    const cellRect = cell.getBoundingClientRect();
                    const scrollLeft = cellRect.left - containerRect.left + container.scrollLeft - (containerRect.width / 2) + (cellRect.width / 2);
                    container.scrollTo({ left: Math.max(0, scrollLeft), behavior: 'smooth' });
                }
            }
        }
        function showFilterHelp() { alert('Filter Syntax:\\n\\n• text: search all columns\\n• col::val: filter column by value\\n• ::col: highlight column\\n• !pat: exclude matches\\n• Regex supported'); }
        function toggleFilterMode() {
            filterMode = filterMode === 'filter' ? 'highlight' : 'filter';
            const btn = document.getElementById('filterModeBtn');
            btn.textContent = filterMode === 'filter' ? '🔽' : '🖌️';
            btn.title = filterMode === 'filter' ? 'Mode: Filter rows (click to switch to Highlight)' : 'Mode: Highlight rows (click to switch to Filter)';
            // Re-apply current filter
            const text = document.getElementById('filterInput').value;
            if (text) filterResults(text);
        }
        let matchingRowIndices = [];
        let highlightedRows = new Set();
        let selectedRows = new Set();
        let lastClickedRow = -1;

        function toggleRowHighlight(rowIndex) {
            if (highlightedRows.has(rowIndex)) {
                highlightedRows.delete(rowIndex);
            } else {
                highlightedRows.add(rowIndex);
            }
            renderContent();
        }

        function toggleColumnHighlight(colIndex) {
            if (userHighlightedColumns.has(colIndex)) {
                userHighlightedColumns.delete(colIndex);
            } else {
                userHighlightedColumns.add(colIndex);
            }
            renderContent();
        }

        function clearColumnHighlights() {
            userHighlightedColumns.clear();
            renderContent();
        }

        function clearRowHighlights() {
            highlightedRows.clear();
            renderContent();
        }

        function searchAllTabs() {
            const text = document.getElementById('filterInput').value.trim();
            if (!text) { alert('Enter search text in the filter box first'); return; }
            vscode.postMessage({ command: 'searchAllTabs', searchText: text });
        }

        function onCellClick(e, ri, ci) {
            const isCtrl = e.ctrlKey || e.metaKey;
            const isShift = e.shiftKey;

            if (isCtrl) {
                // Toggle single row selection
                if (selectedRows.has(ri)) {
                    selectedRows.delete(ri);
                } else {
                    selectedRows.add(ri);
                }
                selectedRowIndex = ri;
            } else if (isShift && lastClickedRow >= 0) {
                // Range selection
                const start = Math.min(lastClickedRow, ri);
                const end = Math.max(lastClickedRow, ri);
                for (let i = start; i <= end; i++) {
                    selectedRows.add(i);
                }
                selectedRowIndex = ri;
            } else {
                // Single selection (clear others)
                selectedRows.clear();
                selectedRows.add(ri);
                selectedRowIndex = ri;
            }

            lastClickedRow = ri;
            renderContent();
        }
        function onCellDblClick(e, ri, ci) {
            const v = String(currentData.rows[ri][ci] ?? '');
            // Handle regular URLs
            if (v.startsWith('http://') || v.startsWith('https://')) {
                vscode.postMessage({ command: 'openLink', url: v });
                return;
            }
            // Handle ADO work item IDs - double-click anywhere on row opens item
            if (queryType === 'ado') {
                const columns = currentData.columns;
                const idColIdx = columns.findIndex(c => c.toLowerCase() === 'id' || c.toLowerCase() === 'system.id');
                if (idColIdx >= 0) {
                    const workItemId = currentData.rows[ri][idColIdx];
                    const url = getAdoWorkItemUrl(workItemId);
                    if (url) {
                        vscode.postMessage({ command: 'openLink', url: url });
                        return;
                    }
                }
            }
            // Handle Outlook items - double-click opens email/item
            if (queryType === 'outlook') {
                vscode.postMessage({ command: 'openOutlookItem', rowIndex: ri });
                return;
            }
            // Default: filter by this value
            document.getElementById('filterInput').value = currentData.columns[ci] + '::' + v;
            filterResults(document.getElementById('filterInput').value);
        }

        // ADO Work Item Preview Panel
        let previewPanel = null;
        // Check if a field contains HTML content
        function isHtmlField(colName) {
            const htmlFields = ['description', 'reprosteps', 'repro steps', 'system.description', 'microsoft.vsts.tcm.reprosteps', 'acceptancecriteria', 'resolution'];
            return htmlFields.some(f => colName.toLowerCase().replace(/[^a-z]/g, '').includes(f.replace(/[^a-z]/g, '')));
        }

        // Sanitize HTML for safe display (basic sanitization)
        function sanitizeHtml(html) {
            if (!html) return '';
            // Remove script tags and event handlers
            let safe = String(html)
                .replace(/<script[^>]*>[\s\S]*?<\\/script>/gi, '')
                .replace(/on\\w+\\s*=\\s*["'][^"']*["']/gi, '')
                .replace(/javascript:/gi, '');
            return safe;
        }

        function showPreview(ri) {
            if (!currentData || ri < 0 || ri >= currentData.rows.length) return;

            const row = currentData.rows[ri];
            const columns = currentData.columns;
            const isAdo = queryType === 'ado';
            const headerTitle = isAdo ? 'Work Item Details' : 'Row Details';

            // Create or update preview panel
            if (!previewPanel) {
                previewPanel = document.createElement('div');
                previewPanel.id = 'adoPreviewPanel';
                previewPanel.className = 'ado-preview-panel';
                document.body.appendChild(previewPanel);
            }

            // Build preview content
            let html = '<div class="preview-header"><span>' + headerTitle + '</span><button class="preview-close" onclick="closePreview()">×</button></div>';
            html += '<div class="preview-content">';

            // For ADO: Get ID and Title for header
            if (isAdo) {
                const idIdx = columns.findIndex(c => c.toLowerCase() === 'id' || c.toLowerCase() === 'system.id');
                const titleIdx = columns.findIndex(c => c.toLowerCase() === 'title' || c.toLowerCase() === 'system.title');

                if (idIdx >= 0 && titleIdx >= 0) {
                    const id = row[idIdx];
                    const title = row[titleIdx];
                    html += '<div class="preview-title-bar">';
                    html += '<span class="preview-id">#' + escapeHtml(String(id)) + '</span>';
                    html += '<span class="preview-title">' + escapeHtml(String(title)) + '</span>';
                    html += '</div>';
                }
            }

            // Separate HTML fields for ADO (show them in expandable sections)
            const htmlFieldsContent = [];
            const regularFields = [];

            columns.forEach((col, i) => {
                const val = row[i];
                if (isAdo && isHtmlField(col) && val) {
                    htmlFieldsContent.push({ name: col.replace('System.', '').replace('Microsoft.VSTS.TCM.', ''), value: val });
                } else {
                    regularFields.push({ col, i, val });
                }
            });

            // Show HTML fields first (Description, Repro Steps, etc.)
            if (htmlFieldsContent.length > 0) {
                html += '<div class="preview-html-fields">';
                htmlFieldsContent.forEach(field => {
                    html += '<div class="preview-html-section">';
                    html += '<div class="preview-html-header">' + escapeHtml(field.name) + '</div>';
                    html += '<div class="preview-html-content">' + sanitizeHtml(field.value) + '</div>';
                    html += '</div>';
                });
                html += '</div>';
            }

            // Show regular fields in table
            html += '<table class="preview-table">';
            regularFields.forEach(({ col, i, val }) => {
                const displayVal = val === null || val === undefined ? '<em>null</em>' : escapeHtml(String(val));
                // Highlight important fields
                const isImportant = isAdo && ['state', 'assignedto', 'workitemtype', 'priority', 'severity', 'createddate', 'changeddate'].some(f => col.toLowerCase().includes(f));
                html += '<tr class="' + (isImportant ? 'important' : '') + '">';
                html += '<td class="field-name">' + escapeHtml(col.replace('System.', '')) + '</td>';
                html += '<td class="field-value">' + displayVal + '</td>';
                html += '</tr>';
            });
            html += '</table>';

            // Open in browser button for ADO
            if (isAdo) {
                const idIdx = columns.findIndex(c => c.toLowerCase() === 'id' || c.toLowerCase() === 'system.id');
                if (idIdx >= 0) {
                    const workItemId = row[idIdx];
                    const url = getAdoWorkItemUrl(workItemId);
                    if (url) {
                        html += '<div class="preview-actions"><button onclick="vscode.postMessage({ command: \\'openLink\\', url: \\'' + url + '\\' })">🔗 Open in Browser</button></div>';
                    }
                }
            }

            html += '</div>';
            previewPanel.innerHTML = html;
            previewPanel.style.display = 'flex';
        }

        // Backward compatibility alias
        function showAdoPreview(ri) { showPreview(ri); }

        function closePreview() {
            if (previewPanel) {
                previewPanel.style.display = 'none';
            }
        }

        function showCellContextMenu(e, ri, ci) {
            e.preventDefault();
            const v = String(currentData.rows[ri][ci] ?? '');
            const col = currentData.columns[ci];
            const menu = document.getElementById('contextMenu');
            menu.innerHTML = '';

            // Copy Cell (most common action - outside submenu)
            addMenuItem(menu, '📋 Copy Cell', () => vscode.postMessage({ command: 'copyCell', value: v }));

            // Other copy options in submenu
            const copySubmenu = addSubmenuItem(menu, '📋 More Copy Options');
            addSubmenuChild(copySubmenu, 'Copy Row as JSON', () => {
                const obj = {}; currentData.columns.forEach((c, i) => obj[c] = currentData.rows[ri][i]);
                vscode.postMessage({ command: 'copyRow', value: JSON.stringify(obj, null, 2) });
            });
            addSubmenuChild(copySubmenu, 'Copy Column', () => {
                const vals = currentData.rows.map(r => String(r[ci] ?? '')).join('\\n');
                vscode.postMessage({ command: 'copyColumn', value: vals });
            });
            addSubmenuChild(copySubmenu, 'Copy Column Distinct', () => {
                const vals = [...new Set(currentData.rows.map(r => String(r[ci] ?? '')))].join(', ');
                vscode.postMessage({ command: 'copyColumn', value: vals });
            });
            addSubmenuChild(copySubmenu, 'Copy Selected Rows (CSV)', () => {
                const selectedIndices = Array.from(selectedRows).sort((a, b) => a - b);
                if (selectedIndices.length === 0) { alert('No rows selected'); return; }
                const header = currentData.columns.join(',');
                const rowsData = selectedIndices.map(i => currentData.rows[i].map(c => escapeCsv(String(c ?? ''))).join(',')).join('\\n');
                vscode.postMessage({ command: 'copyAllRows', value: header + '\\n' + rowsData });
            });
            addSubmenuChild(copySubmenu, 'Copy All Rows (CSV)', () => {
                const header = currentData.columns.join(',');
                const rows = currentData.rows.map(r => r.map(c => escapeCsv(String(c ?? ''))).join(',')).join('\\n');
                vscode.postMessage({ command: 'copyAllRows', value: header + '\\n' + rows });
            });

            // Open in Browser (ADO or Outlook)
            if (queryType === 'ado') {
                const idColIdx = currentData.columns.findIndex(c => c.toLowerCase() === 'id' || c.toLowerCase() === 'system.id');
                if (idColIdx >= 0) {
                    const workItemId = currentData.rows[ri][idColIdx];
                    const url = getAdoWorkItemUrl(workItemId);
                    if (url) {
                        addMenuItem(menu, '🔗 Open in Browser', () => vscode.postMessage({ command: 'openLink', url: url }));
                    }
                }
                // Preview work item details
                addMenuItem(menu, '👁️ Preview Details', () => showAdoPreview(ri));
            }
            if (queryType === 'outlook') {
                addMenuItem(menu, '📧 Open in Outlook', () => vscode.postMessage({ command: 'directOpenOutlookItem', rowIndex: ri }));
                addMenuItem(menu, '👁️ Preview', () => vscode.postMessage({ command: 'openOutlookItem', rowIndex: ri }));
            }
            // Preview for Kusto results
            if (queryType === 'kusto') {
                addMenuItem(menu, '👁️ Preview Row', () => showPreview(ri));
            }

            // Link option
            if (v.startsWith('http://') || v.startsWith('https://')) {
                addMenuItem(menu, '🔗 Open Link', () => vscode.postMessage({ command: 'openLink', url: v }));
            }

            addMenuSep(menu);

            // Filter options
            const shortVal = v.length > 20 ? v.substring(0, 20) + '...' : v;
            const filterSubmenu = addSubmenuItem(menu, '🔍 Filter');
            addSubmenuChild(filterSubmenu, 'Filter: ' + col + '=' + shortVal, () => { document.getElementById('filterInput').value = col + '::' + v; filterResults(col + '::' + v); });
            addSubmenuChild(filterSubmenu, 'Filter Contains: ' + shortVal, () => { document.getElementById('filterInput').value = v; filterResults(v); });
            addSubmenuChild(filterSubmenu, 'Exclude: ' + shortVal, () => { document.getElementById('filterInput').value = '!' + v; filterResults('!' + v); });
            // Note: Column highlight is now a separate menu item with toggle behavior

            // Color rule option
            addMenuItem(menu, '🎨 Color by Value...', () => addColorRule(ci, col, v));

            // JSON options for complex values
            const jsonSubmenu = addSubmenuItem(menu, '{} View as JSON');
            if (v.startsWith('{') || v.startsWith('[')) {
                addSubmenuChild(jsonSubmenu, 'Show Cell as JSON', () => vscode.postMessage({ command: 'showJson', json: v, title: 'Cell: ' + col }));
            }
            addSubmenuChild(jsonSubmenu, 'Show Row as JSON', () => {
                const obj = {}; currentData.columns.forEach((c, i) => obj[c] = currentData.rows[ri][i]);
                vscode.postMessage({ command: 'showJson', json: JSON.stringify(obj), title: 'Row ' + (ri + 1) });
            });

            addMenuSep(menu);

            // Row highlight option
            const isRowHighlighted = highlightedRows.has(ri);
            addMenuItem(menu, isRowHighlighted ? '⬜ Remove Row Highlight (Space)' : '🟨 Highlight Row (Space)', () => toggleRowHighlight(ri));
            if (highlightedRows.size > 0) {
                addMenuItem(menu, '🧹 Clear Row Highlights', () => clearRowHighlights());
            }

            // Column highlight option (toggle with purple color)
            const isColHighlighted = userHighlightedColumns.has(ci);
            addMenuItem(menu, isColHighlighted ? '⬜ Remove Column Highlight' : '🟪 Highlight Column', () => toggleColumnHighlight(ci));
            if (userHighlightedColumns.size > 0) {
                addMenuItem(menu, '🧹 Clear Column Highlights', () => clearColumnHighlights());
            }

            // Selection info
            if (selectedRows.size > 1) {
                addMenuSep(menu);
                addMenuItem(menu, '✓ ' + selectedRows.size + ' rows selected', () => {});
                addMenuItem(menu, '⬜ Clear Selection', () => { selectedRows.clear(); selectedRowIndex = -1; renderContent(); });
            }

            // Numeric operations
            const numVal = parseFloat(v);
            if (!isNaN(numVal)) {
                addMenuSep(menu);
                addMenuItem(menu, 'Σ Sum Column', () => {
                    const sum = currentData.rows.reduce((s, r) => s + (parseFloat(r[ci]) || 0), 0);
                    showStatsDialog('Sum of ' + col, 'Sum: ' + sum.toLocaleString());
                });
                addMenuItem(menu, '📊 Column Stats', () => {
                    const nums = currentData.rows.map(r => parseFloat(r[ci])).filter(n => !isNaN(n));
                    const sum = nums.reduce((a, b) => a + b, 0);
                    const avg = sum / nums.length;
                    const min = Math.min(...nums);
                    const max = Math.max(...nums);
                    showStatsDialog(col + ' Statistics',
                        'Count: ' + nums.length + '\\n' +
                        'Sum: ' + sum.toLocaleString() + '\\n' +
                        'Average: ' + avg.toFixed(2) + '\\n' +
                        'Min: ' + min.toLocaleString() + '\\n' +
                        'Max: ' + max.toLocaleString());
                });
            }

            menu.style.display = 'block';
            menu.style.left = Math.min(e.pageX, window.innerWidth - 200) + 'px';
            menu.style.top = Math.min(e.pageY, window.innerHeight - 300) + 'px';
            setTimeout(() => document.addEventListener('click', () => menu.style.display = 'none', { once: true }), 0);
        }

        function addSubmenuItem(parent, label) {
            const wrapper = document.createElement('div');
            wrapper.className = 'context-menu-item has-submenu';
            wrapper.style.position = 'relative';
            wrapper.innerHTML = '<span>' + label + '</span>';
            const submenu = document.createElement('div');
            submenu.className = 'submenu';
            wrapper.appendChild(submenu);
            parent.appendChild(wrapper);
            return submenu;
        }

        function addSubmenuChild(submenu, label, fn) {
            const d = document.createElement('div');
            d.className = 'context-menu-item';
            d.textContent = label;
            d.onclick = (e) => { e.stopPropagation(); document.getElementById('contextMenu').style.display = 'none'; fn(); };
            submenu.appendChild(d);
        }

        function escapeCsv(val) {
            if (val.includes(',') || val.includes('"') || val.includes('\\n')) {
                return '"' + val.replace(/"/g, '""') + '"';
            }
            return val;
        }

        function showTabContextMenu(e, id) {
            e.preventDefault();
            const menu = document.getElementById('tabContextMenu');
            menu.innerHTML = '';
            addMenuItem(menu, '✏️ Rename', () => vscode.postMessage({ command: 'renameTab', tabId: id }));
            addMenuSep(menu);
            addMenuItem(menu, '❌ Close', () => vscode.postMessage({ command: 'closeTab', tabId: id }));
            addMenuItem(menu, '❌ Close Others', () => vscode.postMessage({ command: 'closeOtherTabs', tabId: id }));
            addMenuItem(menu, '❌ Close All', () => vscode.postMessage({ command: 'closeAllTabs' }));
            addMenuItem(menu, '🗑️ Close All Empty', () => vscode.postMessage({ command: 'closeEmptyTabs' }));
            menu.style.display = 'block';
            menu.style.left = e.pageX + 'px';
            menu.style.top = e.pageY + 'px';
            setTimeout(() => document.addEventListener('click', () => menu.style.display = 'none', { once: true }), 0);
        }

        function addMenuItem(menu, label, fn) {
            const d = document.createElement('div');
            d.className = 'context-menu-item';
            d.textContent = label;
            d.onclick = () => { menu.style.display = 'none'; fn(); };
            menu.appendChild(d);
        }
        function addMenuSep(menu) { const d = document.createElement('div'); d.className = 'context-menu-separator'; menu.appendChild(d); }
        function escapeHtml(t) { if (t == null) return ''; const d = document.createElement('div'); d.textContent = String(t); return d.innerHTML; }
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape') {
                document.getElementById('contextMenu').style.display = 'none';
                document.getElementById('tabContextMenu').style.display = 'none';
            }
            if (e.key === ' ' && selectedRowIndex >= 0 && !e.target.matches('input, textarea')) {
                e.preventDefault();
                toggleRowHighlight(selectedRowIndex);
            }
            // Arrow key navigation
            if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && currentData && currentData.rows && !e.target.matches('input, textarea')) {
                e.preventDefault();
                const maxIndex = currentData.rows.length - 1;
                let newIndex = selectedRowIndex;

                if (e.key === 'ArrowUp') {
                    newIndex = selectedRowIndex > 0 ? selectedRowIndex - 1 : 0;
                } else if (e.key === 'ArrowDown') {
                    newIndex = selectedRowIndex < maxIndex ? selectedRowIndex + 1 : maxIndex;
                }

                if (newIndex !== selectedRowIndex) {
                    if (e.shiftKey) {
                        // Extend selection
                        selectedRows.add(newIndex);
                    } else if (!e.ctrlKey) {
                        // Normal navigation - single selection
                        selectedRows.clear();
                        selectedRows.add(newIndex);
                    }
                    selectedRowIndex = newIndex;
                    lastClickedRow = newIndex;
                    renderContent();

                    // Scroll the selected row into view
                    setTimeout(() => {
                        const rows = document.querySelectorAll('tbody tr');
                        if (rows[newIndex]) {
                            rows[newIndex].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
                        }
                    }, 10);
                }
            }
            // Ctrl+A to select all
            if ((e.key === 'a' || e.key === 'A') && (e.ctrlKey || e.metaKey) && currentData && currentData.rows && !e.target.matches('input, textarea')) {
                e.preventDefault();
                selectedRows.clear();
                for (let i = 0; i < currentData.rows.length; i++) {
                    selectedRows.add(i);
                }
                renderContent();
            }
        });

        // Column resizing
        let resizingCol = null;
        let startX = 0;
        let startWidth = 0;
        let columnWidths = {};

        function startResize(e, colIndex) {
            e.stopPropagation();
            e.preventDefault();
            resizingCol = colIndex;
            const th = e.target.parentElement;
            startX = e.pageX;
            startWidth = th.offsetWidth;
            document.addEventListener('mousemove', doResize);
            document.addEventListener('mouseup', stopResize);
            e.target.classList.add('resizing');
        }

        function doResize(e) {
            if (resizingCol === null) return;
            const diff = e.pageX - startX;
            const newWidth = Math.max(50, startWidth + diff);
            const ths = document.querySelectorAll('th');
            if (ths[resizingCol]) {
                ths[resizingCol].style.width = newWidth + 'px';
                ths[resizingCol].style.minWidth = newWidth + 'px';
                ths[resizingCol].style.maxWidth = newWidth + 'px';
                columnWidths[resizingCol] = newWidth;
                // Also resize corresponding td cells
                const tds = document.querySelectorAll('td:nth-child(' + (resizingCol + 1) + ')');
                tds.forEach(td => {
                    td.style.width = newWidth + 'px';
                    td.style.minWidth = newWidth + 'px';
                    td.style.maxWidth = newWidth + 'px';
                });
            }
        }

        function stopResize(e) {
            document.querySelectorAll('.resize-handle').forEach(h => h.classList.remove('resizing'));
            document.removeEventListener('mousemove', doResize);
            document.removeEventListener('mouseup', stopResize);
            resizingCol = null;
        }

        // Column drag and drop reordering
        let draggedCol = null;

        function onColDragStart(e, colIndex) {
            if (resizingCol !== null) {
                e.preventDefault();
                return;
            }
            draggedCol = colIndex;
            e.target.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', colIndex);
        }

        function onColDragOver(e) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            const th = e.target.closest('th');
            if (th) th.classList.add('drag-over');
        }

        function onColDragLeave(e) {
            const th = e.target.closest('th');
            if (th) th.classList.remove('drag-over');
        }

        function onColDrop(e, targetCol) {
            e.preventDefault();
            const th = e.target.closest('th');
            if (th) th.classList.remove('drag-over');
            document.querySelectorAll('th').forEach(t => t.classList.remove('dragging'));

            if (draggedCol === null || draggedCol === targetCol) return;

            // Reorder columns in data
            const reorderArray = (arr) => {
                const item = arr.splice(draggedCol, 1)[0];
                arr.splice(targetCol > draggedCol ? targetCol - 1 : targetCol, 0, item);
                return arr;
            };

            currentData.columns = reorderArray([...currentData.columns]);
            currentData.rows = currentData.rows.map(row => reorderArray([...row]));
            originalData.columns = reorderArray([...originalData.columns]);
            originalData.rows = originalData.rows.map(row => reorderArray([...row]));

            // Reset sort since column indices changed
            sortColumn = -1;
            sortAsc = true;
            draggedCol = null;
            renderContent();
        }

        function reportBug() {
            vscode.postMessage({ command: 'reportBug' });
        }

        function showStatsDialog(title, content) {
            document.getElementById('statsTitle').textContent = title;
            document.getElementById('statsContent').textContent = content.replace(/\\\\n/g, '\\n');
            document.getElementById('statsDialog').classList.add('visible');
        }

        function closeStatsDialog() {
            document.getElementById('statsDialog').classList.remove('visible');
        }

        // Chart functionality
        let chartVisible = false;
        let chartType = 'line';
        const chartColors = ['#4fc3f7', '#81c784', '#ffb74d', '#f06292', '#ba68c8', '#4db6ac', '#aed581', '#ff8a65'];

        function toggleChart() {
            chartVisible = !chartVisible;
            const container = document.getElementById('container');
            const chartContainer = document.getElementById('chartContainer');

            if (chartVisible) {
                container.style.display = 'none';
                chartContainer.classList.add('visible');
                renderChart();
            } else {
                container.style.display = 'block';
                chartContainer.classList.remove('visible');
            }
        }

        function setChartType(type) {
            chartType = type;
            document.querySelectorAll('.chart-type-btn').forEach(btn => {
                btn.classList.toggle('active', btn.textContent.toLowerCase() === type);
            });
            renderChart();
        }

        function renderChart() {
            if (!currentData || !currentData.columns || !currentData.rows || currentData.rows.length === 0) return;

            const svg = document.getElementById('chartSvg');
            const legend = document.getElementById('chartLegend');
            const width = svg.clientWidth || 800;
            const height = svg.clientHeight || 300;
            const padding = { top: 20, right: 20, bottom: 40, left: 60 };
            const chartWidth = width - padding.left - padding.right;
            const chartHeight = height - padding.top - padding.bottom;

            // Find numeric columns (skip first column which is usually the X axis)
            const xCol = 0;
            const numericCols = [];
            for (let i = 1; i < currentData.columns.length; i++) {
                const hasNumeric = currentData.rows.some(r => !isNaN(parseFloat(r[i])));
                if (hasNumeric) numericCols.push(i);
            }

            if (numericCols.length === 0) {
                svg.innerHTML = '<text x="50%" y="50%" text-anchor="middle" fill="var(--vscode-foreground)">No numeric columns to chart</text>';
                legend.innerHTML = '';
                return;
            }

            // Get data ranges
            let minY = Infinity, maxY = -Infinity;
            numericCols.forEach(col => {
                currentData.rows.forEach(row => {
                    const val = parseFloat(row[col]);
                    if (!isNaN(val)) {
                        minY = Math.min(minY, val);
                        maxY = Math.max(maxY, val);
                    }
                });
            });

            // Add padding to Y range
            const yRange = maxY - minY || 1;
            minY = minY - yRange * 0.05;
            maxY = maxY + yRange * 0.05;

            // Scale functions
            const xScale = (i) => padding.left + (i / (currentData.rows.length - 1 || 1)) * chartWidth;
            const yScale = (v) => padding.top + chartHeight - ((v - minY) / (maxY - minY)) * chartHeight;

            let svgContent = '';

            // Grid lines
            for (let i = 0; i <= 5; i++) {
                const y = padding.top + (i / 5) * chartHeight;
                const val = maxY - (i / 5) * (maxY - minY);
                svgContent += '<line x1="' + padding.left + '" y1="' + y + '" x2="' + (width - padding.right) + '" y2="' + y + '" stroke="var(--vscode-panel-border)" stroke-dasharray="2,2"/>';
                svgContent += '<text x="' + (padding.left - 5) + '" y="' + (y + 4) + '" text-anchor="end" fill="var(--vscode-descriptionForeground)" font-size="10">' + val.toFixed(1) + '</text>';
            }

            // X axis labels (show ~10 labels max)
            const labelStep = Math.max(1, Math.floor(currentData.rows.length / 10));
            for (let i = 0; i < currentData.rows.length; i += labelStep) {
                const x = xScale(i);
                const label = String(currentData.rows[i][xCol]).substring(0, 12);
                svgContent += '<text x="' + x + '" y="' + (height - 10) + '" text-anchor="middle" fill="var(--vscode-descriptionForeground)" font-size="9" transform="rotate(-30 ' + x + ' ' + (height - 10) + ')">' + label + '</text>';
            }

            // Draw series
            numericCols.forEach((col, seriesIdx) => {
                const color = chartColors[seriesIdx % chartColors.length];
                const points = [];

                currentData.rows.forEach((row, i) => {
                    const val = parseFloat(row[col]);
                    if (!isNaN(val)) {
                        points.push({ x: xScale(i), y: yScale(val) });
                    }
                });

                if (points.length === 0) return;

                if (chartType === 'area') {
                    const areaPath = 'M' + points[0].x + ',' + (padding.top + chartHeight) + ' ' +
                        points.map(p => 'L' + p.x + ',' + p.y).join(' ') +
                        ' L' + points[points.length - 1].x + ',' + (padding.top + chartHeight) + ' Z';
                    svgContent += '<path d="' + areaPath + '" fill="' + color + '" fill-opacity="0.3"/>';
                }

                if (chartType === 'line' || chartType === 'area') {
                    const linePath = 'M' + points.map(p => p.x + ',' + p.y).join(' L');
                    svgContent += '<path d="' + linePath + '" fill="none" stroke="' + color + '" stroke-width="2"/>';
                    points.forEach(p => {
                        svgContent += '<circle cx="' + p.x + '" cy="' + p.y + '" r="3" fill="' + color + '"/>';
                    });
                } else if (chartType === 'bar') {
                    const barWidth = Math.max(2, (chartWidth / currentData.rows.length / numericCols.length) - 2);
                    points.forEach((p, i) => {
                        const x = p.x - (barWidth * numericCols.length / 2) + (seriesIdx * barWidth);
                        const barHeight = (padding.top + chartHeight) - p.y;
                        svgContent += '<rect x="' + x + '" y="' + p.y + '" width="' + barWidth + '" height="' + barHeight + '" fill="' + color + '" fill-opacity="0.8"/>';
                    });
                }
            });

            svg.innerHTML = svgContent;

            // Legend
            legend.innerHTML = numericCols.map((col, i) =>
                '<div class="legend-item"><div class="legend-color" style="background:' + chartColors[i % chartColors.length] + '"></div>' + currentData.columns[col] + '</div>'
            ).join('');
        }

        // Pivot table functionality
        let pivotVisible = false;

        function togglePivot() {
            pivotVisible = !pivotVisible;
            const container = document.getElementById('container');
            const chartContainer = document.getElementById('chartContainer');
            const pivotContainer = document.getElementById('pivotContainer');

            if (pivotVisible) {
                container.style.display = 'none';
                chartContainer.classList.remove('visible');
                pivotContainer.classList.add('visible');
                chartVisible = false;
                populatePivotFields();
            } else {
                container.style.display = 'block';
                pivotContainer.classList.remove('visible');
            }
        }

        function populatePivotFields() {
            if (!currentData || !currentData.columns) return;

            const rowSelect = document.getElementById('pivotRowField');
            const colSelect = document.getElementById('pivotColField');
            const valueSelect = document.getElementById('pivotValueField');

            const options = '<option value="">Select column...</option>' +
                currentData.columns.map((col, i) =>
                    '<option value="' + i + '">' + escapeHtml(col) + '</option>'
                ).join('');

            rowSelect.innerHTML = options;
            colSelect.innerHTML = options;
            valueSelect.innerHTML = options;
        }

        function updatePivot() {
            const rowField = parseInt(document.getElementById('pivotRowField').value);
            const colField = parseInt(document.getElementById('pivotColField').value);
            const valueField = parseInt(document.getElementById('pivotValueField').value);
            const aggFunc = document.getElementById('pivotAggFunc').value;

            const wrapper = document.getElementById('pivotTableWrapper');

            if (isNaN(rowField) || isNaN(colField)) {
                wrapper.innerHTML = '<div class="pivot-placeholder">Select row and column fields to create a pivot table</div>';
                return;
            }

            if (!currentData || !currentData.rows || currentData.rows.length === 0) {
                wrapper.innerHTML = '<div class="pivot-placeholder">No data available</div>';
                return;
            }

            // Build pivot data structure
            const rowValues = new Set();
            const colValues = new Set();
            const pivotData = new Map(); // Map<rowKey, Map<colKey, values[]>>

            currentData.rows.forEach(row => {
                const rowKey = String(row[rowField] ?? '');
                const colKey = String(row[colField] ?? '');
                const value = isNaN(valueField) ? 1 : parseFloat(row[valueField]) || 0;

                rowValues.add(rowKey);
                colValues.add(colKey);

                if (!pivotData.has(rowKey)) {
                    pivotData.set(rowKey, new Map());
                }
                if (!pivotData.get(rowKey).has(colKey)) {
                    pivotData.get(rowKey).set(colKey, []);
                }
                pivotData.get(rowKey).get(colKey).push(value);
            });

            const sortedRows = Array.from(rowValues).sort();
            const sortedCols = Array.from(colValues).sort();

            // Calculate aggregated values
            function aggregate(values, func) {
                if (!values || values.length === 0) return null;
                switch (func) {
                    case 'count': return values.length;
                    case 'sum': return values.reduce((a, b) => a + b, 0);
                    case 'avg': return values.reduce((a, b) => a + b, 0) / values.length;
                    case 'min': return Math.min(...values);
                    case 'max': return Math.max(...values);
                    default: return values.length;
                }
            }

            function formatValue(val) {
                if (val === null || val === undefined) return '-';
                if (Number.isInteger(val)) return val.toLocaleString();
                return val.toLocaleString(undefined, { maximumFractionDigits: 2 });
            }

            // Build HTML table
            let html = '<table class="pivot-table"><thead><tr>';
            html += '<th>' + escapeHtml(currentData.columns[rowField]) + '</th>';
            sortedCols.forEach(col => {
                html += '<th>' + escapeHtml(col) + '</th>';
            });
            html += '<th class="total">Total</th></tr></thead><tbody>';

            // Column totals accumulator
            const colTotals = new Map();
            sortedCols.forEach(col => colTotals.set(col, []));
            let grandTotal = [];

            sortedRows.forEach(rowKey => {
                html += '<tr>';
                html += '<td class="row-header">' + escapeHtml(rowKey) + '</td>';
                let rowTotal = [];

                sortedCols.forEach(colKey => {
                    const values = pivotData.get(rowKey)?.get(colKey) || [];
                    const aggValue = aggregate(values, aggFunc);
                    html += '<td>' + formatValue(aggValue) + '</td>';

                    if (values.length > 0) {
                        rowTotal = rowTotal.concat(values);
                        colTotals.get(colKey).push(...values);
                        grandTotal = grandTotal.concat(values);
                    }
                });

                html += '<td class="total">' + formatValue(aggregate(rowTotal, aggFunc)) + '</td>';
                html += '</tr>';
            });

            // Total row
            html += '<tr class="total-row">';
            html += '<td class="row-header">Total</td>';
            sortedCols.forEach(colKey => {
                const values = colTotals.get(colKey);
                html += '<td>' + formatValue(aggregate(values, aggFunc)) + '</td>';
            });
            html += '<td class="total">' + formatValue(aggregate(grandTotal, aggFunc)) + '</td>';
            html += '</tr>';

            html += '</tbody></table>';
            wrapper.innerHTML = html;
        }

        // Result comparison functionality
        let compareVisible = false;

        function startCompare() {
            if (tabs.length < 2) {
                alert('Need at least 2 result tabs to compare');
                return;
            }

            compareVisible = true;
            document.getElementById('container').style.display = 'none';
            document.getElementById('chartContainer').classList.remove('visible');
            document.getElementById('pivotContainer').classList.remove('visible');
            document.getElementById('compareContainer').classList.add('visible');
            chartVisible = false;
            pivotVisible = false;

            populateCompareSelects();
        }

        function closeCompare() {
            compareVisible = false;
            document.getElementById('compareContainer').classList.remove('visible');
            document.getElementById('container').style.display = 'block';
        }

        function populateCompareSelects() {
            const leftSelect = document.getElementById('compareLeft');
            const rightSelect = document.getElementById('compareRight');

            const options = tabs.map(t =>
                '<option value="' + t.id + '">' + escapeHtml(t.title) + '</option>'
            ).join('');

            leftSelect.innerHTML = options;
            rightSelect.innerHTML = options;

            // Select first two tabs by default
            if (tabs.length >= 2) {
                leftSelect.value = tabs[0].id;
                rightSelect.value = tabs[1].id;
                updateCompare();
            }
        }

        function updateCompare() {
            const leftId = document.getElementById('compareLeft').value;
            const rightId = document.getElementById('compareRight').value;

            const leftTab = tabs.find(t => t.id === leftId);
            const rightTab = tabs.find(t => t.id === rightId);

            if (!leftTab || !rightTab) return;

            // Get results from cache
            const leftData = tabResultsCache[leftId];
            const rightData = tabResultsCache[rightId];

            if (!leftData || !rightData || !leftData.columns || !rightData.columns) {
                const leftMsg = leftData ? '' : 'Switch to "' + leftTab.title + '" tab first to load its data';
                const rightMsg = rightData ? '' : 'Switch to "' + rightTab.title + '" tab first to load its data';
                document.getElementById('compareLeftPanel').innerHTML = '<div class="compare-placeholder">' + (leftMsg || 'No data') + '</div>';
                document.getElementById('compareRightPanel').innerHTML = '<div class="compare-placeholder">' + (rightMsg || 'No data') + '</div>';
                document.getElementById('compareStats').innerHTML = leftMsg || rightMsg ? '<span style="color: var(--vscode-notificationsWarningIcon-foreground);">⚠️ Click each tab to load data before comparing</span>' : '';
                return;
            }

            // Create row hashes for comparison
            function hashRow(row) {
                return JSON.stringify(row);
            }

            const leftHashes = new Map();
            const rightHashes = new Map();

            leftData.rows.forEach((row, i) => {
                const hash = hashRow(row);
                if (!leftHashes.has(hash)) leftHashes.set(hash, []);
                leftHashes.get(hash).push(i);
            });

            rightData.rows.forEach((row, i) => {
                const hash = hashRow(row);
                if (!rightHashes.has(hash)) rightHashes.set(hash, []);
                rightHashes.get(hash).push(i);
            });

            // Find differences
            const leftOnly = new Set();
            const rightOnly = new Set();
            const common = new Set();

            leftHashes.forEach((indices, hash) => {
                if (rightHashes.has(hash)) {
                    indices.forEach(i => common.add(i));
                } else {
                    indices.forEach(i => leftOnly.add(i));
                }
            });

            rightHashes.forEach((indices, hash) => {
                if (!leftHashes.has(hash)) {
                    indices.forEach(i => rightOnly.add(i));
                }
            });

            // Render comparison panels
            function renderPanel(data, uniqueRows, panelId, isLeft) {
                const panel = document.getElementById(panelId);
                let html = '<table><thead><tr>';
                data.columns.forEach(col => {
                    html += '<th>' + escapeHtml(col) + '</th>';
                });
                html += '</tr></thead><tbody>';

                data.rows.forEach((row, i) => {
                    const rowClass = uniqueRows.has(i) ? (isLeft ? 'row-removed' : 'row-added') : '';
                    html += '<tr class="' + rowClass + '">';
                    row.forEach(cell => {
                        const val = cell === null || cell === undefined ? '' : String(cell);
                        html += '<td>' + escapeHtml(val.length > 100 ? val.substring(0, 100) + '...' : val) + '</td>';
                    });
                    html += '</tr>';
                });

                html += '</tbody></table>';
                panel.innerHTML = html;
            }

            renderPanel(leftData, leftOnly, 'compareLeftPanel', true);
            renderPanel(rightData, rightOnly, 'compareRightPanel', false);

            // Update stats
            const stats = document.getElementById('compareStats');
            stats.innerHTML =
                '<span class="stat-removed">◀ ' + leftOnly.size + ' only in left</span> | ' +
                '<span>' + common.size + ' matching</span> | ' +
                '<span class="stat-added">' + rightOnly.size + ' only in right ▶</span>';
        }

        // Column selector functionality
        function toggleColumnSelector(event) {
            event.stopPropagation();
            const selector = document.getElementById('columnSelector');
            const isVisible = selector.classList.contains('visible');
            if (isVisible) {
                closeColumnSelector();
            } else {
                updateColumnSelector();
                selector.classList.add('visible');
            }
        }

        function closeColumnSelector() {
            document.getElementById('columnSelector').classList.remove('visible');
        }

        function updateColumnSelector() {
            if (!currentData || !currentData.columns) return;
            const selector = document.getElementById('columnSelector');
            const visibleCount = currentData.columns.length - hiddenColumns.size;
            let html = '<div class="column-selector-header">' +
                '<span onclick="showAllColumns()">Show All</span>' +
                '<span onclick="hideAllColumns()">Hide All</span>' +
                '</div>';
            currentData.columns.forEach((col, i) => {
                const checked = !hiddenColumns.has(i) ? 'checked' : '';
                html += '<div class="column-selector-item" draggable="true" data-col-idx="' + i + '" ' +
                    'ondragstart="onColSelectorDragStart(event,' + i + ')" ' +
                    'ondragover="onColSelectorDragOver(event)" ' +
                    'ondragleave="onColSelectorDragLeave(event)" ' +
                    'ondrop="onColSelectorDrop(event,' + i + ')" ' +
                    'ondragend="onColSelectorDragEnd(event)">' +
                    '<span class="drag-handle">☰</span>' +
                    '<input type="checkbox" ' + checked + ' onchange="toggleColumn(' + i + ')" onclick="event.stopPropagation()">' +
                    '<span>' + escapeHtml(col) + '</span>' +
                    '</div>';
            });
            selector.innerHTML = html;
        }

        let colSelectorDragIdx = null;

        function onColSelectorDragStart(e, idx) {
            colSelectorDragIdx = idx;
            e.target.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
        }

        function onColSelectorDragOver(e) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            e.target.closest('.column-selector-item')?.classList.add('drag-over');
        }

        function onColSelectorDragLeave(e) {
            e.target.closest('.column-selector-item')?.classList.remove('drag-over');
        }

        function onColSelectorDragEnd(e) {
            colSelectorDragIdx = null;
            document.querySelectorAll('.column-selector-item').forEach(el => {
                el.classList.remove('dragging', 'drag-over');
            });
        }

        function onColSelectorDrop(e, targetIdx) {
            e.preventDefault();
            e.target.closest('.column-selector-item')?.classList.remove('drag-over');
            if (colSelectorDragIdx === null || colSelectorDragIdx === targetIdx) return;

            // Reorder columns
            const fromIdx = colSelectorDragIdx;
            const toIdx = targetIdx;

            // Reorder in currentData and originalData
            const moveColumn = (arr, from, to) => {
                const item = arr.splice(from, 1)[0];
                arr.splice(to, 0, item);
            };

            const moveRowCells = (rows, from, to) => {
                rows.forEach(row => {
                    const cell = row.splice(from, 1)[0];
                    row.splice(to, 0, cell);
                });
            };

            // Move column name
            moveColumn(currentData.columns, fromIdx, toIdx);
            moveColumn(originalData.columns, fromIdx, toIdx);

            // Move row data
            moveRowCells(currentData.rows, fromIdx, toIdx);
            moveRowCells(originalData.rows, fromIdx, toIdx);

            // Update hidden columns set (indices changed)
            const newHidden = new Set();
            hiddenColumns.forEach(hiddenIdx => {
                if (hiddenIdx === fromIdx) {
                    newHidden.add(toIdx);
                } else if (fromIdx < toIdx) {
                    if (hiddenIdx > fromIdx && hiddenIdx <= toIdx) {
                        newHidden.add(hiddenIdx - 1);
                    } else {
                        newHidden.add(hiddenIdx);
                    }
                } else {
                    if (hiddenIdx >= toIdx && hiddenIdx < fromIdx) {
                        newHidden.add(hiddenIdx + 1);
                    } else {
                        newHidden.add(hiddenIdx);
                    }
                }
            });
            hiddenColumns = newHidden;

            // Update columnWidths indices
            const newWidths = {};
            Object.keys(columnWidths).forEach(key => {
                let idx = parseInt(key);
                if (idx === fromIdx) {
                    newWidths[toIdx] = columnWidths[key];
                } else if (fromIdx < toIdx) {
                    if (idx > fromIdx && idx <= toIdx) {
                        newWidths[idx - 1] = columnWidths[key];
                    } else {
                        newWidths[idx] = columnWidths[key];
                    }
                } else {
                    if (idx >= toIdx && idx < fromIdx) {
                        newWidths[idx + 1] = columnWidths[key];
                    } else {
                        newWidths[idx] = columnWidths[key];
                    }
                }
            });
            columnWidths = newWidths;

            colSelectorDragIdx = null;
            renderContent();
            updateColumnSelector();
        }

        function toggleColumn(colIndex) {
            if (hiddenColumns.has(colIndex)) {
                hiddenColumns.delete(colIndex);
            } else {
                // Don't allow hiding all columns
                if (hiddenColumns.size >= currentData.columns.length - 1) {
                    return;
                }
                hiddenColumns.add(colIndex);
            }
            renderContent();
            updateColumnSelector();
        }

        function showAllColumns() {
            hiddenColumns.clear();
            renderContent();
            updateColumnSelector();
        }

        function hideAllColumns() {
            // Keep at least one column visible (first one)
            hiddenColumns.clear();
            if (currentData && currentData.columns) {
                for (let i = 1; i < currentData.columns.length; i++) {
                    hiddenColumns.add(i);
                }
            }
            renderContent();
            updateColumnSelector();
        }

        // Column Presets functions
        let columnPresets = [];

        function togglePresetMenu(event) {
            event.stopPropagation();
            const menu = document.getElementById('presetMenu');
            const isVisible = menu.classList.contains('visible');
            closeColumnSelector(); // Close other menus
            if (isVisible) {
                closePresetMenu();
            } else {
                vscode.postMessage({ command: 'getColumnPresets' });
                menu.classList.add('visible');
            }
        }

        function closePresetMenu() {
            document.getElementById('presetMenu').classList.remove('visible');
        }

        function updatePresetList(presets) {
            console.log('updatePresetList called with:', presets);
            columnPresets = presets;
            const list = document.getElementById('presetList');
            if (!presets || presets.length === 0) {
                list.innerHTML = '<div class="preset-empty">No saved presets</div>';
                return;
            }
            list.innerHTML = presets.map((name, idx) =>
                '<div class="preset-item" data-preset-idx="' + idx + '">' +
                    '<span class="preset-item-name">' + escapeHtml(name) + '</span>' +
                    '<span class="preset-item-delete" data-delete-idx="' + idx + '">×</span>' +
                '</div>'
            ).join('');

            // Add click handlers using event delegation
            console.log('Adding click handlers for', presets.length, 'presets');
            list.querySelectorAll('.preset-item').forEach((item, idx) => {
                const presetName = presets[idx];
                console.log('Adding handler for preset:', presetName);
                item.addEventListener('click', (e) => {
                    console.log('Preset item clicked, target:', e.target);
                    if (!e.target.classList.contains('preset-item-delete')) {
                        console.log('Calling loadPreset with:', presetName);
                        loadPreset(presetName);
                    }
                });
            });
            list.querySelectorAll('.preset-item-delete').forEach((btn, idx) => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    deletePreset(presets[idx]);
                });
            });
        }

        function saveCurrentPreset() {
            if (!currentData || !currentData.columns) {
                return;
            }
            vscode.postMessage({
                command: 'saveColumnPreset',
                widths: columnWidths,
                order: currentData.columns
            });
            closePresetMenu();
        }

        function loadPreset(name) {
            console.log('loadPreset called with:', name);
            vscode.postMessage({ command: 'loadColumnPreset', name: name });
            closePresetMenu();
        }

        function deletePreset(name) {
            vscode.postMessage({ command: 'deleteColumnPreset', name: name });
        }

        function applyColumnPreset(widths, order) {
            console.log('applyColumnPreset called with widths:', widths, 'order:', order);
            if (!currentData || !currentData.columns) {
                console.log('No currentData or columns');
                return;
            }

            // Reorder columns to match preset order if columns match
            if (order && order.length > 0) {
                const newColumns = [];
                const newRows = currentData.rows.map(row => []);
                const origNewRows = originalData.rows.map(row => []);

                order.forEach(colName => {
                    const idx = currentData.columns.indexOf(colName);
                    if (idx >= 0) {
                        newColumns.push(colName);
                        currentData.rows.forEach((row, ri) => {
                            newRows[ri].push(row[idx]);
                        });
                        originalData.rows.forEach((row, ri) => {
                            origNewRows[ri].push(row[idx]);
                        });
                    }
                });

                // Add any columns not in preset (new columns)
                currentData.columns.forEach((col, idx) => {
                    if (!newColumns.includes(col)) {
                        newColumns.push(col);
                        currentData.rows.forEach((row, ri) => {
                            newRows[ri].push(row[idx]);
                        });
                        originalData.rows.forEach((row, ri) => {
                            origNewRows[ri].push(row[idx]);
                        });
                    }
                });

                currentData.columns = newColumns;
                currentData.rows = newRows;
                originalData.columns = [...newColumns];
                originalData.rows = origNewRows;
            }

            // Apply widths
            if (widths) {
                columnWidths = { ...widths };
            }

            renderContent();
        }

        // Close column selector when clicking outside
        document.addEventListener('click', function(e) {
            const selector = document.getElementById('columnSelector');
            const btn = document.getElementById('columnsBtn');
            const presetMenu = document.getElementById('presetMenu');
            const presetBtn = document.getElementById('presetBtn');
            if (!selector.contains(e.target) && e.target !== btn) {
                closeColumnSelector();
            }
            if (presetMenu && presetBtn && !presetMenu.contains(e.target) && e.target !== presetBtn) {
                closePresetMenu();
            }
        });
    </script>
    <div class="footer">
        <span><span class="brand">Quest</span> v0.4.1 | by Inbar Rotem</span>
        <span>
            <span class="bug-report" onclick="reportBug()" title="Report a bug or send feedback">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="vertical-align: middle; margin-right: 4px;">
                    <path d="M19 8h-1.81c-.45-.78-1.07-1.45-1.82-1.96l.93-.93c.39-.39.39-1.02 0-1.41-.39-.39-1.02-.39-1.41 0l-1.47 1.47C12.96 5.06 12.49 5 12 5s-.96.06-1.41.17L9.11 3.7c-.39-.39-1.02-.39-1.41 0-.39.39-.39 1.02 0 1.41l.92.93C7.88 6.55 7.26 7.22 6.81 8H5c-.55 0-1 .45-1 1s.45 1 1 1h1.09c-.05.33-.09.66-.09 1v1H5c-.55 0-1 .45-1 1s.45 1 1 1h1v1c0 .34.04.67.09 1H5c-.55 0-1 .45-1 1s.45 1 1 1h1.81c1.04 1.79 2.97 3 5.19 3s4.15-1.21 5.19-3H19c.55 0 1-.45 1-1s-.45-1-1-1h-1.09c.05-.33.09-.66.09-1v-1h1c.55 0 1-.45 1-1s-.45-1-1-1h-1v-1c0-.34-.04-.67-.09-1H19c.55 0 1-.45 1-1s-.45-1-1-1zm-6 8h-2v-2h2v2zm0-4h-2v-2h2v2z"/>
                </svg>
                Report Bug / Feedback
            </span>
        </span>
    </div>
</body>
</html>`;
    }
}
