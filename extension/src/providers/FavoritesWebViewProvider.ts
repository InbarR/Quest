import * as vscode from 'vscode';
import { SidecarClient, PresetInfo } from '../sidecar/SidecarClient';
import { SHARED_STYLES } from './webviewTheme';

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
                !p.isAutoSaved && (p.type || 'kusto') === this._currentMode
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
        ${SHARED_STYLES}
        body {
            padding: 0;
            margin: 0;
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
        }
        .search-box {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 6px 8px;
            position: sticky;
            top: 0;
            z-index: 1;
            background: var(--vscode-sideBar-background);
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .search-box .qi { font-size: 13px; opacity: 0.6; }
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
        .item-type {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            text-transform: uppercase;
            letter-spacing: 0.04em;
        }
    </style>
</head>
<body>
    <div class="search-box">
        <span class="qi qi-search"></span>
        <input type="text" class="search-input" placeholder="Filter favorites..." id="searchInput" oninput="filter(this.value)">
    </div>
    <div class="q-list" id="list"></div>

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
                    list.innerHTML = '<div class="q-empty"><span class="qi qi-star"></span><div>No favorites yet</div><small>Run a query and save it to add one.</small></div>';
                } else {
                    list.innerHTML = '<div class="q-empty"><span class="qi qi-search"></span><div>No matches</div></div>';
                }
                return;
            }

            list.innerHTML = presets.map(p => {
                const typeName = p.type === 'kusto' ? 'KQL' : p.type === 'ado' ? 'WIQL' : p.type === 'outlook' ? 'OQL' : p.type;
                return \`<div class="q-row" onclick="load('\${p.id}')" title="\${escapeHtml(p.query.substring(0, 200))}">
                    <div class="q-row-main">
                        <div class="item-name">\${escapeHtml(p.name)}</div>
                        <div class="item-type">\${typeName}</div>
                    </div>
                    <div class="q-row-actions">
                        <button class="q-icon-btn" onclick="event.stopPropagation(); del('\${p.id}')" title="Delete"><span class="qi qi-trash"></span></button>
                    </div>
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
