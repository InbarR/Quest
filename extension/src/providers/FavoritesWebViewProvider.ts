import * as vscode from 'vscode';
import { SidecarClient, PresetInfo } from '../sidecar/SidecarClient';

export class FavoritesWebViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'querystudio.presets';

    private _view?: vscode.WebviewView;
    private _presets: PresetInfo[] = [];
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
                    const preset = this._presets.find(p => p.id === message.id);
                    if (preset) {
                        vscode.commands.executeCommand('queryStudio.loadPreset', preset);
                    }
                    break;
                case 'delete':
                    const toDelete = this._presets.find(p => p.id === message.id);
                    if (toDelete) {
                        const confirm = await vscode.window.showWarningMessage(
                            `Delete "${toDelete.name}"?`,
                            { modal: true },
                            'Delete'
                        );
                        if (confirm === 'Delete') {
                            await this._client.deletePreset(message.id);
                            this.refresh();
                        }
                    }
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
            this._presets = await this._client.getPresets();
            // Filter by: not auto-saved AND matches current mode
            this._presets = this._presets.filter(p =>
                !p.isAutoSaved && p.type === this._currentMode
            );
            this._view.webview.postMessage({
                command: 'update',
                presets: this._presets
            });
        } catch (error) {
            console.error('Failed to load presets:', error);
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
        }
        .search-input {
            width: 100%;
            padding: 4px 8px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 2px;
            font-size: 12px;
            box-sizing: border-box;
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
        .item-type {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            text-transform: uppercase;
        }
        .item-delete {
            opacity: 0;
            padding: 2px 4px;
            cursor: pointer;
            font-size: 12px;
        }
        .item:hover .item-delete {
            opacity: 0.6;
        }
        .item-delete:hover {
            opacity: 1 !important;
            background: var(--vscode-toolbar-hoverBackground);
            border-radius: 3px;
        }
        .empty {
            padding: 16px;
            text-align: center;
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
        }
        .welcome {
            padding: 16px;
            text-align: center;
        }
        .welcome a {
            color: var(--vscode-textLink-foreground);
            cursor: pointer;
            text-decoration: none;
        }
        .welcome a:hover {
            text-decoration: underline;
        }
    </style>
</head>
<body>
    <div class="search-box">
        <input type="text" class="search-input" placeholder="Filter favorites..." id="searchInput" oninput="filter(this.value)">
    </div>
    <div class="list" id="list"></div>

    <script>
        const vscode = acquireVsCodeApi();
        let allPresets = [];

        window.addEventListener('message', event => {
            const msg = event.data;
            if (msg.command === 'update') {
                allPresets = msg.presets;
                render(allPresets);
            }
        });

        function filter(text) {
            const lower = text.toLowerCase();
            const filtered = allPresets.filter(p =>
                p.name.toLowerCase().includes(lower) ||
                p.query.toLowerCase().includes(lower)
            );
            render(filtered);
        }

        function render(presets) {
            const list = document.getElementById('list');

            if (presets.length === 0) {
                if (allPresets.length === 0) {
                    list.innerHTML = '<div class="welcome">No favorites yet.<br><br>Run a query and click ⭐ Save to add favorites.</div>';
                } else {
                    list.innerHTML = '<div class="empty">No matches</div>';
                }
                return;
            }

            list.innerHTML = presets.map(p => {
                const typeName = p.type === 'kusto' ? 'KQL' : p.type === 'ado' ? 'WIQL' : p.type === 'outlook' ? 'OQL' : p.type;
                return \`<div class="item" onclick="load('\${p.id}')" title="\${escapeHtml(p.query.substring(0, 200))}">
                    <div class="item-content">
                        <div class="item-name">\${escapeHtml(p.name)}</div>
                        <div class="item-type">\${typeName}</div>
                    </div>
                    <span class="item-delete" onclick="event.stopPropagation(); del('\${p.id}')" title="Delete">×</span>
                </div>\`;
            }).join('');
        }

        function load(id) {
            vscode.postMessage({ command: 'load', id });
        }

        function del(id) {
            vscode.postMessage({ command: 'delete', id });
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
