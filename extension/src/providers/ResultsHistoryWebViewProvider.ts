import * as vscode from 'vscode';
import { SidecarClient, ResultHistoryItem } from '../sidecar/SidecarClient';

export class ResultsHistoryWebViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'querystudio.resultsHistory';

    private _view?: vscode.WebviewView;
    private _history: ResultHistoryItem[] = [];
    private _currentMode: 'kusto' | 'ado' | 'outlook' = 'kusto';
    private _onViewResult?: (item: ResultHistoryItem) => void;
    private _pendingRefresh = false;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _client: SidecarClient
    ) {}

    public setMode(mode: 'kusto' | 'ado' | 'outlook') {
        this._currentMode = mode;
        this.refresh();
    }

    public setOnViewResult(callback: (item: ResultHistoryItem) => void) {
        this._onViewResult = callback;
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

        webviewView.webview.html = this._getHtmlForWebview();

        webviewView.webview.onDidReceiveMessage(async message => {
            switch (message.command) {
                case 'loadResults':
                    const item = this._history.find(r => r.id === message.id);
                    if (item && this._onViewResult) {
                        this._onViewResult(item);
                    }
                    break;
                case 'loadQuery':
                    const toLoad = this._history.find(r => r.id === message.id);
                    if (toLoad) {
                        // Open query in a new editor
                        const doc = await vscode.workspace.openTextDocument({
                            content: toLoad.query,
                            language: toLoad.type === 'ado' ? 'wiql' : 'kql'
                        });
                        await vscode.window.showTextDocument(doc);
                    }
                    break;
                case 'openFile':
                    const fileItem = this._history.find(r => r.id === message.id);
                    if (fileItem && fileItem.filePath) {
                        const uri = vscode.Uri.file(fileItem.filePath);
                        await vscode.commands.executeCommand('vscode.open', uri);
                    } else {
                        vscode.window.showWarningMessage('No file associated with this result');
                    }
                    break;
                case 'openFolder':
                    const folderItem = this._history.find(r => r.id === message.id);
                    if (folderItem && folderItem.filePath) {
                        const uri = vscode.Uri.file(folderItem.filePath);
                        await vscode.commands.executeCommand('revealFileInOS', uri);
                    } else {
                        vscode.window.showWarningMessage('No file associated with this result');
                    }
                    break;
                case 'deleteResult':
                    await this._deleteResult(message.id);
                    break;
                case 'clearAll':
                    const confirm = await vscode.window.showWarningMessage(
                        'Clear all saved results?',
                        { modal: true },
                        'Clear'
                    );
                    if (confirm === 'Clear') {
                        await this._clearAllResults();
                    }
                    break;
                case 'refresh':
                    this.refresh();
                    break;
            }
        });

        // Do initial refresh, or process pending refresh from before view was ready
        this._pendingRefresh = false;
        this.refresh();
    }

    public async addResult(item: ResultHistoryItem) {
        try {
            await this._client.saveResultHistory(item);
            this.refresh();
        } catch (error) {
            console.error('Failed to save result history:', error);
        }
    }

    private async _deleteResult(id: string) {
        try {
            await this._client.deleteResultHistory(id);
            this.refresh();
        } catch (error) {
            console.error('Failed to delete result:', error);
        }
    }

    private async _clearAllResults() {
        try {
            await this._client.clearResultHistory();
            this.refresh();
            vscode.window.showInformationMessage('Results history cleared');
        } catch (error) {
            console.error('Failed to clear results history:', error);
        }
    }

    public async refresh() {
        if (!this._view) {
            // Mark for refresh when view becomes available
            this._pendingRefresh = true;
            return;
        }

        try {
            const config = vscode.workspace.getConfiguration('queryStudio');
            const retentionDays = config.get<number>('resultsHistory.retentionDays', 14);

            let history = await this._client.getResultHistory(100);

            // Filter by current mode
            this._history = history.filter(r => r.type === this._currentMode);

            // Apply retention filter
            const cutoffDate = new Date();
            cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
            this._history = this._history.filter(r => new Date(r.createdAt) >= cutoffDate);

            this._view.webview.postMessage({
                command: 'update',
                history: this._history
            });
        } catch (error) {
            console.error('Failed to load results history:', error);
            // Show empty state on error
            this._history = [];
            this._view.webview.postMessage({
                command: 'update',
                history: []
            });
        }
    }

    private _getHtmlForWebview(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body {
            padding: 0;
            margin: 0;
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
        }
        .search-box {
            padding: 6px 8px;
            position: sticky;
            top: 0;
            background: var(--vscode-sideBar-background);
            border-bottom: 1px solid var(--vscode-panel-border);
            display: flex;
            gap: 4px;
            align-items: center;
            z-index: 1;
        }
        .search-input {
            flex: 1;
            padding: 4px 8px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 2px;
            font-size: 12px;
            box-sizing: border-box;
        }
        .toolbar-btn {
            padding: 4px 6px;
            background: transparent;
            color: var(--vscode-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 2px;
            cursor: pointer;
            font-size: 11px;
            opacity: 0.7;
        }
        .toolbar-btn:hover {
            opacity: 1;
            background: var(--vscode-toolbar-hoverBackground);
        }
        .search-input:focus {
            outline: 1px solid var(--vscode-focusBorder);
        }
        .list {
            padding: 0;
        }
        .item {
            padding: 6px 8px;
            cursor: pointer;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .item:hover {
            background: var(--vscode-list-hoverBackground);
        }
        .item-content {
            min-width: 0;
        }
        .item-title {
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            font-size: 12px;
            font-weight: 500;
            display: flex;
            align-items: center;
            gap: 4px;
        }
        .type-icon {
            font-size: 11px;
            flex-shrink: 0;
        }
        .item-meta {
            display: flex;
            gap: 8px;
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            margin-top: 2px;
        }
        .item-query {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            margin-top: 2px;
            font-family: var(--vscode-editor-font-family, monospace);
        }
        .context-menu {
            position: fixed;
            background: var(--vscode-menu-background);
            border: 1px solid var(--vscode-menu-border);
            border-radius: 4px;
            padding: 4px 0;
            z-index: 1000;
            box-shadow: 0 2px 8px rgba(0,0,0,0.3);
            min-width: 150px;
        }
        .context-menu-item {
            padding: 6px 12px;
            cursor: pointer;
            font-size: 12px;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .context-menu-item:hover {
            background: var(--vscode-menu-selectionBackground);
            color: var(--vscode-menu-selectionForeground);
        }
        .context-menu-separator {
            height: 1px;
            background: var(--vscode-menu-separatorBackground);
            margin: 4px 0;
        }
        .badge {
            display: inline-block;
            padding: 1px 5px;
            border-radius: 8px;
            font-size: 9px;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
        }
        .badge.error {
            background: var(--vscode-inputValidation-errorBackground);
            color: var(--vscode-errorForeground);
        }
        .empty {
            padding: 16px;
            text-align: center;
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
        }
        .stats {
            padding: 4px 8px;
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            border-bottom: 1px solid var(--vscode-panel-border);
            display: flex;
            justify-content: space-between;
        }
    </style>
</head>
<body>
    <div class="search-box">
        <input type="text" class="search-input" placeholder="Filter results..." id="searchInput" oninput="filter()">
        <button class="toolbar-btn" onclick="clearAll()" title="Clear all saved results">🗑</button>
    </div>
    <div class="stats" id="stats"></div>
    <div class="list" id="list"></div>
    <div class="context-menu" id="contextMenu" style="display: none;"></div>

    <script>
        const vscode = acquireVsCodeApi();
        let allHistory = [];

        window.addEventListener('message', event => {
            const msg = event.data;
            if (msg.command === 'update') {
                allHistory = msg.history;
                filter();
            }
        });

        function filter() {
            const text = document.getElementById('searchInput').value.toLowerCase();
            let filtered = allHistory;

            // Apply text filter
            if (text) {
                filtered = filtered.filter(r =>
                    (r.title || '').toLowerCase().includes(text) ||
                    (r.query || '').toLowerCase().includes(text) ||
                    (r.clusterUrl || '').toLowerCase().includes(text) ||
                    (r.database || '').toLowerCase().includes(text)
                );
            }

            updateStats(filtered);
            render(filtered);
        }

        function updateStats(items) {
            const stats = document.getElementById('stats');
            const successCount = items.filter(r => r.success).length;
            const errorCount = items.filter(r => !r.success).length;
            const totalRows = items.reduce((sum, r) => sum + (r.rowCount || 0), 0);
            stats.innerHTML = '<span>' + items.length + ' results</span><span>' + totalRows.toLocaleString() + ' total rows</span>';
        }

        function render(items) {
            const list = document.getElementById('list');

            if (items.length === 0) {
                if (allHistory.length === 0) {
                    list.innerHTML = '<div class="empty">No results yet.<br><br>Run queries to see results history.</div>';
                } else {
                    list.innerHTML = '<div class="empty">No matches</div>';
                }
                return;
            }

            list.innerHTML = items.map(r => {
                const date = new Date(r.createdAt);
                const timeStr = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
                const dateStr = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
                const duration = r.executionTimeMs > 0 ? (r.executionTimeMs / 1000).toFixed(2) + 's' : '';
                const rowBadge = r.success ? '<span class="badge">' + (r.rowCount || 0).toLocaleString() + ' rows</span>' : '<span class="badge error">Error</span>';
                const queryPreview = escapeHtml((r.query || '').substring(0, 80).replace(/\\n/g, ' '));

                // Type icon based on query source
                const typeIcon = r.type === 'kusto' ? 'Ⓚ' : r.type === 'ado' ? 'Ⓐ' : r.type === 'outlook' ? '📧' : '📄';
                const typeName = r.type === 'kusto' ? 'KQL' : r.type === 'ado' ? 'WIQL' : r.type === 'outlook' ? 'OQL' : '';

                return \`<div class="item" data-id="\${r.id}" ondblclick="viewResult('\${r.id}')" oncontextmenu="showContextMenu(event, '\${r.id}')" title="\${escapeHtml(r.query || '')}">
                    <div class="item-content">
                        <div class="item-title"><span class="type-icon" title="\${typeName}">\${typeIcon}</span> \${escapeHtml(r.title || 'Query')}</div>
                        <div class="item-meta">
                            <span>\${dateStr} \${timeStr}</span>
                            \${duration ? '<span>' + duration + '</span>' : ''}
                            \${rowBadge}
                        </div>
                        <div class="item-query">\${queryPreview}</div>
                    </div>
                </div>\`;
            }).join('');
        }

        function viewResult(id) {
            vscode.postMessage({ command: 'loadResults', id });
        }

        function loadResults(id) {
            vscode.postMessage({ command: 'loadResults', id });
        }

        function loadQuery(id) {
            vscode.postMessage({ command: 'loadQuery', id });
        }

        function openFile(id) {
            vscode.postMessage({ command: 'openFile', id });
        }

        function openFolder(id) {
            vscode.postMessage({ command: 'openFolder', id });
        }

        function deleteResult(id) {
            vscode.postMessage({ command: 'deleteResult', id });
        }

        function clearAll() {
            vscode.postMessage({ command: 'clearAll' });
        }

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text || '';
            return div.innerHTML;
        }

        let currentContextId = null;

        function showContextMenu(event, id) {
            event.preventDefault();
            event.stopPropagation();
            currentContextId = id;

            const menu = document.getElementById('contextMenu');
            menu.innerHTML = \`
                <div class="context-menu-item" onclick="loadResults(currentContextId); hideContextMenu();">Load Results</div>
                <div class="context-menu-item" onclick="loadQuery(currentContextId); hideContextMenu();">Load Query</div>
                <div class="context-menu-separator"></div>
                <div class="context-menu-item" onclick="openFile(currentContextId); hideContextMenu();">Open File</div>
                <div class="context-menu-item" onclick="openFolder(currentContextId); hideContextMenu();">Open Folder</div>
                <div class="context-menu-separator"></div>
                <div class="context-menu-item" onclick="deleteResult(currentContextId); hideContextMenu();">Delete</div>
            \`;

            menu.style.display = 'block';
            menu.style.left = event.clientX + 'px';
            menu.style.top = event.clientY + 'px';

            // Adjust if menu goes off screen
            const rect = menu.getBoundingClientRect();
            if (rect.right > window.innerWidth) {
                menu.style.left = (window.innerWidth - rect.width - 5) + 'px';
            }
            if (rect.bottom > window.innerHeight) {
                menu.style.top = (window.innerHeight - rect.height - 5) + 'px';
            }
        }

        function hideContextMenu() {
            document.getElementById('contextMenu').style.display = 'none';
            currentContextId = null;
        }

        // Hide context menu on click elsewhere
        document.addEventListener('click', hideContextMenu);
        document.addEventListener('scroll', hideContextMenu);
    </script>
</body>
</html>`;
    }
}
