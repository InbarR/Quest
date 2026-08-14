import * as vscode from 'vscode';
import { SidecarClient, PresetInfo } from '../sidecar/SidecarClient';
import { SHARED_STYLES } from './webviewTheme';

export class HistoryWebViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'querystudio.history';

    private _view?: vscode.WebviewView;
    private _history: PresetInfo[] = [];
    private _currentMode: 'kusto' | 'ado' | 'outlook' | 'mcp' = 'kusto';

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _client: SidecarClient
    ) {}

    public setMode(mode: 'kusto' | 'ado' | 'outlook' | 'mcp') {
        this._currentMode = mode;
        this.refresh();
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
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
            const history = await this._client.getHistory(100);
            // Filter by current mode
            this._history = history.filter(p => (p.type || 'kusto') === this._currentMode);
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
        ${SHARED_STYLES}
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
            z-index: 1;
            background: var(--vscode-sideBar-background);
            border-bottom: 1px solid var(--vscode-panel-border);
            display: flex;
            gap: 6px;
            align-items: center;
        }
        .search-box > .qi { font-size: 13px; opacity: 0.6; }
        .search-input {
            flex: 1;
            min-width: 0;
            padding: 3px 8px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border, transparent);
            border-radius: 4px;
            font-size: 12px;
            font-family: inherit;
            box-sizing: border-box;
        }
        .search-input:focus {
            outline: none;
            border-color: var(--vscode-focusBorder);
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
    </style>
</head>
<body>
    <div class="search-box">
        <span class="qi qi-search"></span>
        <input type="text" class="search-input" placeholder="Filter history..." id="searchInput" oninput="filter(this.value)">
        <button class="q-icon-btn" onclick="clearAll()" title="Clear all history"><span class="qi qi-trash"></span></button>
    </div>
    <div class="q-list" id="list"></div>

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
                    list.innerHTML = '<div class="q-empty"><span class="qi qi-history"></span><div>No history yet</div><small>Run a query to build history.</small></div>';
                } else {
                    list.innerHTML = '<div class="q-empty"><span class="qi qi-search"></span><div>No matches</div></div>';
                }
                return;
            }

            list.innerHTML = items.map(p => {
                const date = new Date(p.createdAt);
                const timeStr = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
                const dateStr = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
                return \`<div class="q-row" onclick="load('\${p.id}')" title="\${escapeHtml(p.query.substring(0, 200))}">
                    <div class="q-row-main">
                        <div class="item-name">\${escapeHtml(p.name || 'Query')}</div>
                        <div class="item-time">\${dateStr} \${timeStr}</div>
                    </div>
                    <div class="q-row-actions">
                        <button class="q-icon-btn" onclick="event.stopPropagation(); save('\${p.id}')" title="Save as Favorite"><span class="qi qi-star"></span></button>
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
