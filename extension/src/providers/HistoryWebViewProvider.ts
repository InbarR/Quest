import * as vscode from 'vscode';
import { SidecarClient, PresetInfo } from '../sidecar/SidecarClient';

export class HistoryWebViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'querystudio.history';

    private _view?: vscode.WebviewView;
    private _history: PresetInfo[] = [];
    private _currentMode: 'kusto' | 'ado' | 'outlook' = 'kusto';

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _client: SidecarClient
    ) {}

    public setMode(mode: 'kusto' | 'ado' | 'outlook') {
        this._currentMode = mode;
        this.refresh();
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
                case 'load':
                    const preset = this._history.find(p => p.id === message.id);
                    if (preset) {
                        vscode.commands.executeCommand('queryStudio.loadPreset', preset);
                    }
                    break;
                case 'saveAsFavorite':
                    const toSave = this._history.find(p => p.id === message.id);
                    if (toSave) {
                        const name = await vscode.window.showInputBox({
                            prompt: 'Enter a name for this favorite',
                            value: toSave.name,
                            placeHolder: 'My Query'
                        });
                        if (name) {
                            await this._client.savePreset({
                                ...toSave,
                                id: Date.now().toString(),
                                name: name,
                                isAutoSaved: false
                            });
                            vscode.window.showInformationMessage(`Saved as "${name}"`);
                            vscode.commands.executeCommand('queryStudio.refreshFavorites');
                        }
                    }
                    break;
                case 'clearAll':
                    vscode.commands.executeCommand('queryStudio.clearHistory');
                    break;
                case 'refresh':
                    this.refresh();
                    break;
            }
        });

        this.refresh();
    }

    public async refresh() {
        if (!this._view) return;

        try {
            let history = await this._client.getHistory(100);
            // Filter by current mode
            this._history = history.filter(p => p.type === this._currentMode);
            this._view.webview.postMessage({
                command: 'update',
                history: this._history
            });
        } catch (error) {
            console.error('Failed to load history:', error);
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
        .clear-btn {
            padding: 4px 6px;
            background: transparent;
            color: var(--vscode-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 2px;
            cursor: pointer;
            font-size: 11px;
            opacity: 0.7;
        }
        .clear-btn:hover {
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
            display: flex;
            align-items: center;
            padding: 4px 8px;
            cursor: pointer;
        }
        .item:hover {
            background: var(--vscode-list-hoverBackground);
        }
        .item-content {
            flex: 1;
            min-width: 0;
        }
        .item-name {
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            font-size: 13px;
        }
        .item-time {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
        }
        .item-actions {
            display: flex;
            gap: 2px;
            opacity: 0;
        }
        .item:hover .item-actions {
            opacity: 1;
        }
        .item-action {
            padding: 2px 4px;
            cursor: pointer;
            font-size: 11px;
            border-radius: 3px;
        }
        .item-action:hover {
            background: var(--vscode-toolbar-hoverBackground);
        }
        .empty {
            padding: 16px;
            text-align: center;
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
        }
    </style>
</head>
<body>
    <div class="search-box">
        <input type="text" class="search-input" placeholder="Filter history..." id="searchInput" oninput="filter(this.value)">
        <button class="clear-btn" onclick="clearAll()" title="Clear all history">🗑</button>
    </div>
    <div class="list" id="list"></div>

    <script>
        const vscode = acquireVsCodeApi();
        let allHistory = [];

        window.addEventListener('message', event => {
            const msg = event.data;
            if (msg.command === 'update') {
                allHistory = msg.history;
                render(allHistory);
            }
        });

        function filter(text) {
            const lower = text.toLowerCase();
            const filtered = allHistory.filter(p =>
                (p.name || '').toLowerCase().includes(lower) ||
                p.query.toLowerCase().includes(lower)
            );
            render(filtered);
        }

        function render(items) {
            const list = document.getElementById('list');

            if (items.length === 0) {
                if (allHistory.length === 0) {
                    list.innerHTML = '<div class="empty">No history yet.<br><br>Run queries to build history.</div>';
                } else {
                    list.innerHTML = '<div class="empty">No matches</div>';
                }
                return;
            }

            list.innerHTML = items.map(p => {
                const date = new Date(p.createdAt);
                const timeStr = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
                const dateStr = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
                return \`<div class="item" onclick="load('\${p.id}')" title="\${escapeHtml(p.query.substring(0, 200))}">
                    <div class="item-content">
                        <div class="item-name">\${escapeHtml(p.name || 'Query')}</div>
                        <div class="item-time">\${dateStr} \${timeStr}</div>
                    </div>
                    <div class="item-actions">
                        <span class="item-action" onclick="event.stopPropagation(); save('\${p.id}')" title="Save as Favorite">⭐</span>
                    </div>
                </div>\`;
            }).join('');
        }

        function load(id) {
            vscode.postMessage({ command: 'load', id });
        }

        function save(id) {
            vscode.postMessage({ command: 'saveAsFavorite', id });
        }

        function clearAll() {
            vscode.postMessage({ command: 'clearAll' });
        }

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text || '';
            return div.innerHTML;
        }
    </script>
</body>
</html>`;
    }
}
