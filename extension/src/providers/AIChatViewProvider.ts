import * as vscode from 'vscode';
import { SidecarClient } from '../sidecar/SidecarClient';

interface ChatMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: string;
    kqlQuery?: string;
    clusterUrl?: string;
    database?: string;
    clusterName?: string;
}

interface ZeroPromptSuggestion {
    text: string;
    source: 'history' | 'favorite' | 'common';
    icon: string;
}

/**
 * AI Chat View Provider - Renders in the sidebar as a WebviewView
 */
export class AIChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'querystudio.aiChat';

    private _view?: vscode.WebviewView;
    private _messages: ChatMessage[] = [];
    private _isProcessing = false;
    private _sessionId?: string;
    private _currentMode: 'kusto' | 'ado' | 'outlook' = 'kusto';
    private _suggestions: ZeroPromptSuggestion[] = [];
    private _disposables: vscode.Disposable[] = [];

    private _onInsertQuery?: (query: string) => void;
    private _onApplyQuery?: (query: string, cluster?: string, database?: string) => void;
    private _onSelectCluster?: (clusterUrl: string, database: string) => void;
    private _activeClusterUrl?: string;
    private _activeDatabase?: string;
    private _activeClusterName?: string;
    private _activeClusterType?: 'kusto' | 'ado' | 'outlook';
    private _inputHistory: string[] = [];
    private static readonly INPUT_HISTORY_KEY = 'aiChat.inputHistory';
    private static readonly INPUT_HISTORY_MAX = 100;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly client: SidecarClient,
        private readonly outputChannel: vscode.OutputChannel,
        private readonly context: vscode.ExtensionContext
    ) {
        // Load persisted input history
        this._inputHistory = this.context.globalState.get<string[]>(AIChatViewProvider.INPUT_HISTORY_KEY, []);
    }

    private async saveInputHistory(input: string) {
        // Add to history if not duplicate of last entry
        if (this._inputHistory.length === 0 || this._inputHistory[this._inputHistory.length - 1] !== input) {
            this._inputHistory.push(input);
            // Limit history size
            if (this._inputHistory.length > AIChatViewProvider.INPUT_HISTORY_MAX) {
                this._inputHistory = this._inputHistory.slice(-AIChatViewProvider.INPUT_HISTORY_MAX);
            }
            await this.context.globalState.update(AIChatViewProvider.INPUT_HISTORY_KEY, this._inputHistory);
        }
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

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(
            message => this._handleMessage(message),
            null,
            this._disposables
        );

        // Update context bar on editor change
        vscode.window.onDidChangeActiveTextEditor(() => {
            this._updateContextBar();
        }, null, this._disposables);

        // Initial context update
        setTimeout(() => this._updateContextBar(), 500);

        // Send persisted input history to webview
        setTimeout(() => {
            if (this._inputHistory.length > 0) {
                webviewView.webview.postMessage({ command: 'initHistory', history: this._inputHistory });
            }
        }, 100);

        // Clean up on dispose
        webviewView.onDidDispose(() => {
            while (this._disposables.length) {
                const disposable = this._disposables.pop();
                if (disposable) {
                    disposable.dispose();
                }
            }
        });
    }

    public setOnInsertQuery(callback: (query: string) => void) {
        this._onInsertQuery = callback;
    }

    public setOnApplyQuery(callback: (query: string, cluster?: string, database?: string) => void) {
        this._onApplyQuery = callback;
    }

    public setOnSelectCluster(callback: (clusterUrl: string, database: string) => void) {
        this._onSelectCluster = callback;
    }

    public setActiveCluster(clusterUrl: string, database: string, name: string, type: 'kusto' | 'ado' | 'outlook') {
        this._activeClusterUrl = clusterUrl;
        this._activeDatabase = database;
        this._activeClusterName = name;
        this._activeClusterType = type;
    }

    public sendMessage(text: string) {
        this._handleUserMessage(text, { includeCurrentQuery: true });
    }

    public reveal() {
        if (this._view) {
            this._view.show(true);
        }
    }

    public async setMode(mode: 'kusto' | 'ado' | 'outlook') {
        this._currentMode = mode;
        await this._loadSuggestions();
        this._updateView();
    }

    private async _loadSuggestions() {
        const suggestions: ZeroPromptSuggestion[] = [];

        try {
            const [history, favorites] = await Promise.all([
                this.client.getHistory(20),
                this.client.getPresets()
            ]);

            const modeHistory = history.filter(h => h.type === this._currentMode);

            const historyPatterns = new Set<string>();
            for (const item of modeHistory.slice(0, 3)) {
                const pattern = this._extractQueryPattern(item.query);
                if (pattern && !historyPatterns.has(pattern)) {
                    historyPatterns.add(pattern);
                    suggestions.push({
                        text: `Similar to: ${item.name || pattern}`,
                        source: 'history',
                        icon: ''
                    });
                }
            }

            const modeFavorites = favorites.filter(f => f.type === this._currentMode && !f.isAutoSaved);

            for (const fav of modeFavorites.slice(0, 3)) {
                suggestions.push({
                    text: `Like my favorite: ${fav.name}`,
                    source: 'favorite',
                    icon: ''
                });
            }
        } catch (error) {
            this.outputChannel.appendLine(`[AI Chat] Failed to load suggestions: ${error}`);
        }

        const commonSuggestions = this._getCommonSuggestions();
        suggestions.push(...commonSuggestions);

        this._suggestions = suggestions.slice(0, 6);
    }

    private _extractQueryPattern(query: string): string {
        const firstLine = query.split('\n')[0].trim();
        if (firstLine.length > 40) {
            return firstLine.substring(0, 40) + '...';
        }
        return firstLine;
    }

    private _getCommonSuggestions(): ZeroPromptSuggestion[] {
        if (this._currentMode === 'kusto') {
            return [
                { text: 'Write a query to count events by type', source: 'common', icon: '' },
                { text: 'Help me filter results by time range', source: 'common', icon: '' },
                { text: 'Create a summarize query with charts', source: 'common', icon: '' }
            ];
        } else if (this._currentMode === 'ado') {
            return [
                { text: 'Find all open bugs assigned to me', source: 'common', icon: '' },
                { text: 'Query work items modified this week', source: 'common', icon: '' },
                { text: 'List tasks in current sprint', source: 'common', icon: '' }
            ];
        } else {
            return [
                { text: 'Find emails from last week with attachments', source: 'common', icon: '' },
                { text: 'Search for unread emails from specific sender', source: 'common', icon: '' },
                { text: 'List calendar appointments for today', source: 'common', icon: '' }
            ];
        }
    }

    private _getModeDisplayName(): string {
        switch (this._currentMode) {
            case 'kusto': return 'KQL (Kusto Query Language)';
            case 'ado': return 'WIQL (Azure DevOps Work Items)';
            case 'outlook': return 'OQL (Outlook Queries)';
        }
    }

    private _getModeIcon(): string {
        switch (this._currentMode) {
            case 'kusto': return 'K';
            case 'ado': return 'A';
            case 'outlook': return 'O';
        }
    }

    private async _handleMessage(message: any) {
        switch (message.command) {
            case 'sendMessage':
                // Save to persistent history
                if (message.text && message.text.trim()) {
                    await this.saveInputHistory(message.text.trim());
                }
                await this._handleUserMessage(message.text, message.context);
                break;
            case 'insertQuery':
                if (this._onInsertQuery && message.query) {
                    this._onInsertQuery(message.query);
                }
                break;
            case 'applyQuery':
                if (this._onApplyQuery && message.query) {
                    this._onApplyQuery(message.query, message.cluster, message.database);
                }
                break;
            case 'copyQuery':
                if (message.query) {
                    vscode.env.clipboard.writeText(message.query);
                    vscode.window.showInformationMessage('Query copied to clipboard');
                }
                break;
            case 'clearChat':
                this._messages = [];
                this._sessionId = undefined;
                this.outputChannel.appendLine('[AI Chat] Chat cleared - session reset');
                this._updateView();
                break;
            case 'selectCluster':
                if (this._onSelectCluster && message.clusterUrl && message.database) {
                    this._onSelectCluster(message.clusterUrl, message.database);
                }
                break;
            case 'addClusterToQuery':
                // Add cluster().database() prefix to the query
                if (this._onApplyQuery && message.query && message.clusterUrl && message.database) {
                    const prefixedQuery = `cluster('${message.clusterUrl}').database('${message.database}')\n${message.query}`;
                    this._onApplyQuery(prefixedQuery);
                }
                break;
            case 'quickAction':
                await this._handleQuickAction(message.action);
                break;
            case 'sendFeedback':
                this._openFeedback();
                break;
        }
    }

    private _openFeedback() {
        const version = '0.4.1';
        const title = encodeURIComponent('Feedback: ');
        const body = encodeURIComponent(`## Description\n\n\n\n---\n**Environment:**\n- Quest: v${version}\n- VS Code: ${vscode.version}\n- OS: ${process.platform}`);
        const issueUrl = `https://github.com/InbarR/Quest/issues/new?title=${title}&body=${body}`;
        vscode.env.openExternal(vscode.Uri.parse(issueUrl));
    }

    private async _handleQuickAction(action: string) {
        const editor = vscode.window.activeTextEditor;
        const currentQuery = editor?.document.getText() || '';

        if (!currentQuery.trim()) {
            vscode.window.showWarningMessage('No query in the active editor');
            return;
        }

        let prompt = '';
        switch (action) {
            case 'fix':
                prompt = `Fix the following query. Identify any syntax errors, logical issues, or improvements needed:\n\n${currentQuery}`;
                break;
            case 'improve':
                prompt = `Improve this query for better performance, readability, or add useful columns:\n\n${currentQuery}`;
                break;
            case 'explain':
                prompt = `Explain what this query does step by step:\n\n${currentQuery}`;
                break;
            case 'comment':
                prompt = `Add inline comments to this query explaining each step:\n\n${currentQuery}`;
                break;
        }

        if (prompt) {
            await this._handleUserMessage(prompt, { includeCurrentQuery: false });
        }
    }

    private async _handleUserMessage(text: string, context?: { includeCurrentQuery?: boolean }) {
        if (this._isProcessing || !text.trim()) return;

        this._isProcessing = true;
        this.outputChannel.appendLine(`[AI Chat] Sending message: ${text.substring(0, 100)}...`);

        const userMessage: ChatMessage = {
            role: 'user',
            content: text,
            timestamp: new Date().toLocaleTimeString()
        };
        this._messages.push(userMessage);
        this._updateView();

        this._view?.webview.postMessage({ command: 'setTyping', isTyping: true });

        try {
            const editor = vscode.window.activeTextEditor;
            const currentQuery = context?.includeCurrentQuery !== false ? editor?.document.getText() : undefined;
            const languageId = editor?.document.languageId;

            this.outputChannel.appendLine(`[AI Chat] Context - Query type: ${languageId}, Has query: ${!!currentQuery}, Query length: ${currentQuery?.length || 0}`);

            let favorites: string[] = [];
            let recentQueries: string[] = [];
            let presetsWithCluster: { name: string; query: string; clusterUrl?: string; database?: string; type: string }[] = [];

            try {
                const presets = await this.client.getPresets();
                // Filter presets by type matching current mode AND not auto-saved
                const filteredPresets = presets.filter(p => !p.isAutoSaved && p.type === this._currentMode).slice(0, 10);

                // Store presets with cluster info for later matching
                presetsWithCluster = filteredPresets.map(p => ({
                    name: p.name,
                    query: p.query,
                    clusterUrl: p.clusterUrl,
                    database: p.database,
                    type: p.type
                }));

                // Include cluster/database in favorites context for AI
                favorites = filteredPresets.map(p => {
                    const clusterInfo = p.clusterUrl ? ` [cluster: ${p.clusterUrl}, db: ${p.database || 'default'}]` : '';
                    return `"${p.name}"${clusterInfo}: ${p.query.substring(0, 200)}${p.query.length > 200 ? '...' : ''}`;
                });

                const history = await this.client.getHistory(10);
                recentQueries = history
                    .filter(p => p.isAutoSaved)
                    .slice(0, 5)
                    .map(p => p.query.substring(0, 200) + (p.query.length > 200 ? '...' : ''));
            } catch (e) {
                this.outputChannel.appendLine(`[AI Chat] Failed to load favorites/history for context: ${e}`);
            }

            const response = await this.client.aiChat({
                message: text,
                mode: this._currentMode,
                sessionId: this._sessionId,
                context: {
                    currentQuery,
                    favorites: favorites.length > 0 ? favorites : undefined,
                    recentQueries: recentQueries.length > 0 ? recentQueries : undefined
                }
            });

            if (response.sessionId) {
                this._sessionId = response.sessionId;
            }

            this.outputChannel.appendLine(`[AI Chat] Response received (session: ${response.sessionId}): ${response.message?.substring(0, 100) || '(empty)'}...`);

            if (!response.message || response.message.trim() === '') {
                throw new Error('AI returned empty response. Check Output > Quest for details.');
            }

            const extractedQuery = this._extractQuery(response.message);

            // Try to find cluster/database info
            // 1. Check if AI mentioned a preset name - use that preset's cluster (presets already filtered by type)
            // 2. Otherwise use the active cluster ONLY if its type matches the current mode
            let clusterUrl: string | undefined;
            let database: string | undefined;
            let clusterName: string | undefined;

            // Use active cluster only if its type matches current mode
            if (this._activeClusterType === this._currentMode) {
                clusterUrl = this._activeClusterUrl;
                database = this._activeDatabase;
                clusterName = this._activeClusterName;
            }

            // Check if AI referenced a preset by name (presets are already filtered by type)
            for (const preset of presetsWithCluster) {
                if (response.message.toLowerCase().includes(preset.name.toLowerCase()) && preset.clusterUrl) {
                    clusterUrl = preset.clusterUrl;
                    database = preset.database;
                    // Extract cluster name from URL
                    try {
                        const uri = new URL(clusterUrl);
                        clusterName = uri.hostname.split('.')[0];
                    } catch {
                        clusterName = clusterUrl;
                    }
                    this.outputChannel.appendLine(`[AI Chat] Found preset "${preset.name}" (type: ${preset.type}) with cluster: ${clusterUrl}/${database}`);
                    break;
                }
            }

            const assistantMessage: ChatMessage = {
                role: 'assistant',
                content: response.message,
                timestamp: new Date().toLocaleTimeString(),
                kqlQuery: extractedQuery,
                clusterUrl: extractedQuery ? clusterUrl : undefined,
                database: extractedQuery ? database : undefined,
                clusterName: extractedQuery ? clusterName : undefined
            };
            this._messages.push(assistantMessage);

        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'Unknown error';
            this.outputChannel.appendLine(`[AI Chat] Error: ${errorMsg}`);
            this.outputChannel.show(true);

            this._messages.push({
                role: 'assistant',
                content: `Sorry, I encountered an error: ${errorMsg}\n\nCheck the Output panel (Quest) for more details.`,
                timestamp: new Date().toLocaleTimeString()
            });
        } finally {
            this._isProcessing = false;
            this._view?.webview.postMessage({ command: 'setTyping', isTyping: false });
            this._updateView();
        }
    }

    private _extractQuery(text: string): string | undefined {
        const codeBlockRegex = /```(?:kql|kusto|wiql|oql|outlook)?\s*([\s\S]*?)```/gi;
        const matches = [...text.matchAll(codeBlockRegex)];

        if (matches.length > 0) {
            return matches[matches.length - 1][1].trim();
        }

        return undefined;
    }

    private _updateView() {
        if (!this._view) return;
        this._view.webview.postMessage({
            command: 'updateMessages',
            messages: this._messages,
            modeDisplayName: this._getModeDisplayName(),
            modeIcon: this._getModeIcon(),
            suggestions: this._suggestions
        });
        this._updateContextBar();
    }

    private async _updateContextBar() {
        if (!this._view) return;
        try {
            const editor = vscode.window.activeTextEditor;
            const queryLanguages = ['kql', 'wiql', 'oql'];
            const hasQuery = editor && queryLanguages.includes(editor.document.languageId) && editor.document.getText().trim().length > 0;
            const currentQuery = hasQuery ? editor!.document.getText().trim() : '';

            let favorites: { id: string; name: string; query: string }[] = [];
            let recentHistory: { id: string; name: string; query: string }[] = [];

            try {
                const presets = await this.client.getPresets();
                favorites = presets
                    .filter(p => !p.isAutoSaved && p.type === this._currentMode)
                    .slice(0, 10)
                    .map(p => ({ id: p.id, name: p.name, query: p.query.substring(0, 100) }));

                const history = await this.client.getHistory(10);
                recentHistory = history
                    .filter(p => p.isAutoSaved && p.type === this._currentMode)
                    .slice(0, 10)
                    .map(p => ({ id: p.id, name: p.name, query: p.query.substring(0, 100) }));
            } catch { }

            this._view.webview.postMessage({
                command: 'updateContext',
                context: {
                    hasQuery,
                    currentQuery: currentQuery.substring(0, 100),
                    hasFavorites: favorites.length > 0,
                    favoritesCount: favorites.length,
                    favorites,
                    hasHistory: recentHistory.length > 0,
                    historyCount: recentHistory.length,
                    recentHistory
                }
            });
        } catch { }
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'unsafe-inline';">
    <title>AI Chat</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: var(--vscode-font-family);
            font-size: 12px;
            color: var(--vscode-foreground);
            background: var(--vscode-sideBar-background);
            height: 100vh;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }
        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 8px 10px;
            background: var(--vscode-sideBarSectionHeader-background);
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .header-title {
            font-weight: 600;
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .header-icon {
            width: 16px;
            height: 16px;
            display: flex;
            align-items: center;
            justify-content: center;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border-radius: 3px;
            font-size: 9px;
            font-weight: bold;
        }
        .status-dot {
            width: 5px;
            height: 5px;
            background: #4CAF50;
            border-radius: 50%;
        }
        .header-actions {
            display: flex;
            gap: 2px;
        }
        .icon-btn {
            background: transparent;
            border: none;
            color: var(--vscode-descriptionForeground);
            cursor: pointer;
            padding: 4px;
            border-radius: 3px;
            font-size: 12px;
            transition: background 0.1s;
        }
        .icon-btn:hover {
            background: var(--vscode-toolbar-hoverBackground);
            color: var(--vscode-foreground);
        }
        .new-chat-btn {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: none;
            padding: 3px 8px;
            border-radius: 3px;
            cursor: pointer;
            font-size: 10px;
            font-weight: 500;
            transition: background 0.1s;
        }
        .new-chat-btn:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        .context-bar {
            display: flex;
            gap: 4px;
            padding: 6px 10px;
            background: var(--vscode-textBlockQuote-background);
            border-bottom: 1px solid var(--vscode-panel-border);
            flex-wrap: wrap;
            align-items: center;
            font-size: 10px;
            position: relative;
        }
        .context-chip-wrapper {
            position: relative;
        }
        .context-chip {
            display: flex;
            align-items: center;
            gap: 3px;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            padding: 1px 6px;
            border-radius: 3px;
            font-size: 9px;
            cursor: pointer;
            transition: background 0.1s;
        }
        .context-chip:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        .context-chip.active {
            background: var(--vscode-testing-iconPassed, #4caf50);
        }
        .context-chip.inactive {
            opacity: 0.5;
        }
        .context-dropdown {
            position: absolute;
            top: 100%;
            left: 0;
            min-width: 200px;
            max-width: 300px;
            max-height: 250px;
            overflow-y: auto;
            background: var(--vscode-dropdown-background);
            border: 1px solid var(--vscode-dropdown-border);
            border-radius: 4px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            z-index: 100;
            display: none;
            margin-top: 4px;
        }
        .context-dropdown.visible {
            display: block;
        }
        .context-dropdown-header {
            padding: 6px 10px;
            font-size: 10px;
            font-weight: 600;
            color: var(--vscode-foreground);
            border-bottom: 1px solid var(--vscode-panel-border);
            background: var(--vscode-sideBarSectionHeader-background);
        }
        .context-dropdown-item {
            padding: 6px 10px;
            font-size: 11px;
            cursor: pointer;
            display: flex;
            align-items: flex-start;
            gap: 6px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .context-dropdown-item:last-child {
            border-bottom: none;
        }
        .context-dropdown-item:hover {
            background: var(--vscode-list-hoverBackground);
        }
        .context-dropdown-item .item-name {
            font-weight: 500;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .context-dropdown-item .item-preview {
            font-size: 10px;
            opacity: 0.7;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            max-width: 180px;
        }
        .context-dropdown-empty {
            padding: 10px;
            font-size: 10px;
            color: var(--vscode-disabledForeground);
            text-align: center;
        }
        .chat-container {
            flex: 1;
            overflow-y: auto;
            padding: 10px;
            scroll-behavior: smooth;
        }
        .message {
            margin-bottom: 10px;
            animation: fadeIn 0.15s ease-out;
        }
        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(4px); }
            to { opacity: 1; transform: translateY(0); }
        }
        .message-bubble {
            padding: 8px 10px;
            border-radius: 4px;
            max-width: 95%;
            line-height: 1.4;
        }
        .message.user .message-bubble {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            margin-left: auto;
        }
        .message.assistant .message-bubble {
            background: var(--vscode-editor-inactiveSelectionBackground);
            border: 1px solid var(--vscode-panel-border);
        }
        .message-meta {
            font-size: 9px;
            color: var(--vscode-descriptionForeground);
            margin-top: 3px;
            padding: 0 4px;
        }
        .message.user .message-meta { text-align: right; }
        .message-content {
            white-space: pre-wrap;
            word-wrap: break-word;
        }
        .message-content code {
            background: rgba(0,0,0,0.2);
            padding: 1px 4px;
            border-radius: 2px;
            font-family: var(--vscode-editor-font-family);
            font-size: 11px;
        }
        .message-content pre {
            background: var(--vscode-textCodeBlock-background);
            padding: 8px;
            border-radius: 3px;
            overflow-x: auto;
            margin: 6px 0;
            border: 1px solid var(--vscode-panel-border);
            font-size: 10px;
        }
        .message-content pre code {
            padding: 0;
            background: none;
        }
        .query-actions {
            display: flex;
            gap: 6px;
            margin-top: 8px;
            flex-wrap: wrap;
        }
        .query-actions button {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: none;
            padding: 3px 8px;
            border-radius: 3px;
            cursor: pointer;
            font-size: 10px;
            font-weight: 500;
            transition: background 0.1s;
        }
        .query-actions button:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        .query-actions button.primary {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        .cluster-chip {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            padding: 2px 8px;
            border-radius: 10px;
            font-size: 10px;
            cursor: pointer;
            margin-bottom: 6px;
            transition: background 0.15s;
            border: 1px solid transparent;
        }
        .cluster-chip:hover {
            background: var(--vscode-button-secondaryHoverBackground);
            border-color: var(--vscode-focusBorder);
        }
        .cluster-chip .icon {
            font-size: 12px;
        }
        .cluster-chip .cluster-name {
            font-weight: 500;
        }
        .cluster-chip .db-name {
            opacity: 0.8;
        }
        .input-area {
            padding: 10px;
            background: var(--vscode-sideBar-background);
            border-top: 1px solid var(--vscode-panel-border);
        }
        .quick-actions {
            display: flex;
            gap: 4px;
            margin-bottom: 8px;
            flex-wrap: wrap;
        }
        .quick-btn {
            background: var(--vscode-editor-inactiveSelectionBackground);
            color: var(--vscode-foreground);
            border: 1px solid var(--vscode-panel-border);
            padding: 3px 8px;
            border-radius: 3px;
            cursor: pointer;
            font-size: 10px;
            transition: background 0.1s;
        }
        .quick-btn:hover {
            background: var(--vscode-button-secondaryBackground);
            border-color: var(--vscode-button-secondaryBackground);
        }
        .input-wrapper {
            display: flex;
            flex-direction: column;
            gap: 6px;
        }
        textarea {
            width: 100%;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            padding: 8px;
            border-radius: 3px;
            resize: none;
            font-family: var(--vscode-font-family);
            font-size: 12px;
            min-height: 60px;
            max-height: 100px;
        }
        textarea:focus {
            outline: 1px solid var(--vscode-focusBorder);
        }
        .send-btn {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 6px 12px;
            border-radius: 3px;
            cursor: pointer;
            font-weight: 600;
            font-size: 11px;
            transition: background 0.1s;
            align-self: flex-end;
        }
        .send-btn:hover {
            background: var(--vscode-button-hoverBackground);
        }
        .send-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        .typing-indicator {
            display: none;
            padding: 8px 10px;
            color: var(--vscode-descriptionForeground);
            font-size: 11px;
            background: var(--vscode-editor-inactiveSelectionBackground);
            border-radius: 3px;
            margin: 0 10px 10px;
        }
        .typing-indicator.visible {
            display: block;
        }
        .welcome {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            height: 100%;
            padding: 20px;
            text-align: center;
        }
        .welcome-icon {
            font-size: 24px;
            margin-bottom: 12px;
            opacity: 0.9;
        }
        .welcome h3 {
            color: var(--vscode-foreground);
            margin-bottom: 6px;
            font-size: 13px;
            font-weight: 600;
        }
        .welcome p {
            margin: 3px 0;
            font-size: 11px;
            line-height: 1.4;
            color: var(--vscode-descriptionForeground);
        }
        .footer {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 4px 10px;
            font-size: 9px;
            color: var(--vscode-descriptionForeground);
            border-top: 1px solid var(--vscode-panel-border);
            background: var(--vscode-sideBarSectionHeader-background);
        }
        .footer .brand {
            font-weight: 600;
            color: var(--vscode-foreground);
        }
        .footer .feedback-link {
            cursor: pointer;
            opacity: 0.8;
            display: flex;
            align-items: center;
            gap: 3px;
        }
        .footer .feedback-link:hover {
            opacity: 1;
            color: var(--vscode-textLink-foreground);
        }
    </style>
</head>
<body>
    <div class="header">
        <span class="header-title">
            <span class="header-icon">AI</span>
            Quest AI Assistant
            <span class="status-dot"></span>
        </span>
        <div class="header-actions">
            <button class="new-chat-btn" onclick="clearChat()" title="Start a new chat conversation">+ New Chat</button>
        </div>
    </div>
    <div class="context-bar" id="contextBar">
        <div class="context-chip-wrapper">
            <span class="context-chip" id="contextQuery" onclick="toggleDropdown('editor')" title="Current query from editor">Editor</span>
            <div class="context-dropdown" id="dropdownEditor">
                <div class="context-dropdown-header">Current Editor Query</div>
                <div id="editorQueryContent" class="context-dropdown-empty">No query in editor</div>
            </div>
        </div>
        <div class="context-chip-wrapper">
            <span class="context-chip" id="contextFavorites" onclick="toggleDropdown('favorites')" title="Your saved favorite queries">Favorites</span>
            <div class="context-dropdown" id="dropdownFavorites">
                <div class="context-dropdown-header">Favorite Queries</div>
                <div id="favoritesContent" class="context-dropdown-empty">No favorites</div>
            </div>
        </div>
        <div class="context-chip-wrapper">
            <span class="context-chip" id="contextHistory" onclick="toggleDropdown('history')" title="Recent query history">History</span>
            <div class="context-dropdown" id="dropdownHistory">
                <div class="context-dropdown-header">Recent Queries</div>
                <div id="historyContent" class="context-dropdown-empty">No history</div>
            </div>
        </div>
    </div>
    <div class="chat-container" id="chatContainer"></div>
    <div class="typing-indicator" id="typingIndicator">Thinking...</div>
    <div class="input-area">
        <div class="quick-actions">
            <button class="quick-btn" onclick="quickAction('fix')">Fix</button>
            <button class="quick-btn" onclick="quickAction('improve')">Improve</button>
            <button class="quick-btn" onclick="quickAction('explain')">Explain</button>
        </div>
        <div class="input-wrapper">
            <textarea id="messageInput" placeholder="Ask about your queries..." rows="2"></textarea>
            <button class="send-btn" id="sendBtn" onclick="sendMessage()">Send</button>
        </div>
    </div>
    <div class="footer">
        <span><span class="brand">Quest</span> | by Inbar Rotem</span>
        <span class="feedback-link" onclick="sendFeedback()" title="Send feedback or report a bug">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                <path d="M19 8h-1.81c-.45-.78-1.07-1.45-1.82-1.96l.93-.93c.39-.39.39-1.02 0-1.41-.39-.39-1.02-.39-1.41 0l-1.47 1.47C12.96 5.06 12.49 5 12 5s-.96.06-1.41.17L9.11 3.7c-.39-.39-1.02-.39-1.41 0-.39.39-.39 1.02 0 1.41l.92.93C7.88 6.55 7.26 7.22 6.81 8H5c-.55 0-1 .45-1 1s.45 1 1 1h1.09c-.05.33-.09.66-.09 1v1H5c-.55 0-1 .45-1 1s.45 1 1 1h1v1c0 .34.04.67.09 1H5c-.55 0-1 .45-1 1s.45 1 1 1h1.81c1.04 1.79 2.97 3 5.19 3s4.15-1.21 5.19-3H19c.55 0 1-.45 1-1s-.45-1-1-1h-1.09c.05-.33.09-.66.09-1v-1h1c.55 0 1-.45 1-1s-.45-1-1-1h-1v-1c0-.34-.04-.67-.09-1H19c.55 0 1-.45 1-1s-.45-1-1-1zm-6 8h-2v-2h2v2zm0-4h-2v-2h2v2z"/>
            </svg>
            Feedback
        </span>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let messages = [];
        let isTyping = false;
        let modeDisplayName = 'KQL (Kusto Query Language)';
        let modeIcon = 'K';
        let suggestions = [];

        window.addEventListener('message', event => {
            const msg = event.data;
            switch (msg.command) {
                case 'updateMessages':
                    messages = msg.messages;
                    if (msg.modeDisplayName) modeDisplayName = msg.modeDisplayName;
                    if (msg.modeIcon) modeIcon = msg.modeIcon;
                    if (msg.suggestions) suggestions = msg.suggestions;
                    renderMessages();
                    break;
                case 'setTyping':
                    isTyping = msg.isTyping;
                    document.getElementById('typingIndicator').classList.toggle('visible', isTyping);
                    document.getElementById('sendBtn').disabled = isTyping;
                    break;
                case 'updateContext':
                    updateContextBar(msg.context);
                    break;
                case 'initHistory':
                    // Load persisted input history
                    if (msg.history && Array.isArray(msg.history)) {
                        messageHistory = msg.history;
                        historyIndex = messageHistory.length;
                    }
                    break;
            }
        });

        let currentContext = {};

        function updateContextBar(ctx) {
            currentContext = ctx;
            const queryChip = document.getElementById('contextQuery');
            const favChip = document.getElementById('contextFavorites');
            const histChip = document.getElementById('contextHistory');

            queryChip.classList.toggle('active', ctx.hasQuery);
            queryChip.classList.toggle('inactive', !ctx.hasQuery);

            favChip.classList.toggle('active', ctx.hasFavorites);
            favChip.classList.toggle('inactive', !ctx.hasFavorites);
            favChip.textContent = ctx.hasFavorites ? ctx.favoritesCount + ' Fav' : 'Favorites';

            histChip.classList.toggle('active', ctx.hasHistory);
            histChip.classList.toggle('inactive', !ctx.hasHistory);
            histChip.textContent = ctx.hasHistory ? ctx.historyCount + ' Recent' : 'History';

            // Update dropdown contents
            updateEditorDropdown(ctx);
            updateFavoritesDropdown(ctx);
            updateHistoryDropdown(ctx);
        }

        function updateEditorDropdown(ctx) {
            const content = document.getElementById('editorQueryContent');
            if (ctx.hasQuery && ctx.currentQuery) {
                content.className = '';
                content.innerHTML = '<div class="context-dropdown-item" onclick="insertFromContext(\\'editor\\')"><div class="item-preview">' + escapeHtml(ctx.currentQuery) + '</div></div>';
            } else {
                content.className = 'context-dropdown-empty';
                content.textContent = 'No query in editor';
            }
        }

        function updateFavoritesDropdown(ctx) {
            const content = document.getElementById('favoritesContent');
            if (ctx.favorites && ctx.favorites.length > 0) {
                content.className = '';
                content.innerHTML = ctx.favorites.map(f =>
                    '<div class="context-dropdown-item" onclick="insertFromFavorite(\\'' + escapeHtml(f.id) + '\\')">' +
                    '<div><div class="item-name">' + escapeHtml(f.name) + '</div>' +
                    '<div class="item-preview">' + escapeHtml(f.query) + '</div></div></div>'
                ).join('');
            } else {
                content.className = 'context-dropdown-empty';
                content.textContent = 'No favorites';
            }
        }

        function updateHistoryDropdown(ctx) {
            const content = document.getElementById('historyContent');
            if (ctx.recentHistory && ctx.recentHistory.length > 0) {
                content.className = '';
                content.innerHTML = ctx.recentHistory.map(h =>
                    '<div class="context-dropdown-item" onclick="insertFromHistory(\\'' + escapeHtml(h.id) + '\\')">' +
                    '<div><div class="item-name">' + escapeHtml(h.name) + '</div>' +
                    '<div class="item-preview">' + escapeHtml(h.query) + '</div></div></div>'
                ).join('');
            } else {
                content.className = 'context-dropdown-empty';
                content.textContent = 'No history';
            }
        }

        function toggleDropdown(type) {
            const dropdowns = ['dropdownEditor', 'dropdownFavorites', 'dropdownHistory'];
            const targetId = 'dropdown' + type.charAt(0).toUpperCase() + type.slice(1);

            dropdowns.forEach(id => {
                const dropdown = document.getElementById(id);
                if (id === targetId) {
                    dropdown.classList.toggle('visible');
                } else {
                    dropdown.classList.remove('visible');
                }
            });
        }

        function insertFromContext(type) {
            if (currentContext.currentQuery) {
                const input = document.getElementById('messageInput');
                input.value = 'About this query: ' + currentContext.currentQuery.substring(0, 50) + '...';
                input.focus();
            }
            closeAllDropdowns();
        }

        function insertFromFavorite(id) {
            const fav = currentContext.favorites?.find(f => f.id === id);
            if (fav) {
                const input = document.getElementById('messageInput');
                input.value = 'About "' + fav.name + '": ';
                input.focus();
            }
            closeAllDropdowns();
        }

        function insertFromHistory(id) {
            const hist = currentContext.recentHistory?.find(h => h.id === id);
            if (hist) {
                const input = document.getElementById('messageInput');
                input.value = 'About this query: ' + hist.query.substring(0, 50) + '...';
                input.focus();
            }
            closeAllDropdowns();
        }

        function closeAllDropdowns() {
            document.querySelectorAll('.context-dropdown').forEach(d => d.classList.remove('visible'));
        }

        // Close dropdowns when clicking outside
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.context-chip-wrapper')) {
                closeAllDropdowns();
            }
        });

        function sendFeedback() {
            vscode.postMessage({ command: 'sendFeedback' });
        }

        function renderMessages() {
            const container = document.getElementById('chatContainer');

            if (messages.length === 0) {
                container.innerHTML = \`
                    <div class="welcome">
                        <div class="welcome-icon">\${modeIcon}</div>
                        <h3>Query Assistant</h3>
                        <p>Ask me about <strong style="color: var(--vscode-textLink-foreground)">\${modeDisplayName}</strong></p>
                    </div>
                \`;
                return;
            }

            container.innerHTML = messages.map((msg, index) => renderMessage(msg, index)).join('');
            container.scrollTop = container.scrollHeight;
        }

        function escapeHtml(text) {
            if (!text) return '';
            const div = document.createElement('div');
            div.textContent = String(text);
            return div.innerHTML;
        }

        function renderMessage(msg, index) {
            const content = formatContent(msg.content);
            const queryActions = msg.kqlQuery ? renderQueryActions(msg.kqlQuery, msg.clusterUrl, msg.database, msg.clusterName, index) : '';

            return \`
                <div class="message \${msg.role}">
                    <div class="message-bubble">
                        <div class="message-content">\${content}</div>
                        \${queryActions}
                    </div>
                    <div class="message-meta">\${msg.timestamp}</div>
                </div>
            \`;
        }

        function formatContent(text) {
            text = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            text = text.replace(/\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g, '<pre><code>$2</code></pre>');
            text = text.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
            text = text.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
            text = text.replace(/\\*([^*]+)\\*/g, '<em>$1</em>');
            return text;
        }

        function renderQueryActions(query, clusterUrl, database, clusterName, messageIndex) {
            const encodedQuery = btoa(unescape(encodeURIComponent(query)));
            const encodedCluster = clusterUrl ? btoa(unescape(encodeURIComponent(clusterUrl))) : '';
            const encodedDb = database ? btoa(unescape(encodeURIComponent(database))) : '';

            // Render cluster chip if we have cluster info
            let clusterChip = '';
            if (clusterUrl && database) {
                const displayName = clusterName || clusterUrl;
                clusterChip = \`
                    <div class="cluster-chip" data-cluster="\${encodedCluster}" data-database="\${encodedDb}" data-query="\${encodedQuery}" title="Click to select this data source">
                        <span class="icon">⚡</span>
                        <span class="cluster-name">\${escapeHtml(displayName)}</span>
                        <span class="db-name">/ \${escapeHtml(database)}</span>
                    </div>
                \`;
            }

            return \`
                \${clusterChip}
                <div class="query-actions">
                    <button class="primary query-btn" data-action="apply" data-query="\${encodedQuery}" data-cluster="\${encodedCluster}" data-database="\${encodedDb}">Use</button>
                    <button class="query-btn" data-action="copy" data-query="\${encodedQuery}">Copy</button>
                </div>
            \`;
        }

        document.addEventListener('click', function(e) {
            // Handle cluster chip click
            const chip = e.target.closest('.cluster-chip');
            if (chip) {
                const encodedCluster = chip.dataset.cluster;
                const encodedDb = chip.dataset.database;
                const encodedQuery = chip.dataset.query;

                if (encodedCluster && encodedDb) {
                    const clusterUrl = decodeURIComponent(escape(atob(encodedCluster)));
                    const database = decodeURIComponent(escape(atob(encodedDb)));
                    const query = encodedQuery ? decodeURIComponent(escape(atob(encodedQuery))) : null;

                    // Send message to select cluster or show options
                    vscode.postMessage({
                        command: 'selectCluster',
                        clusterUrl: clusterUrl,
                        database: database,
                        query: query
                    });
                }
                return;
            }

            // Handle query button click
            const btn = e.target.closest('.query-btn');
            if (!btn) return;

            const action = btn.dataset.action;
            const encodedQuery = btn.dataset.query;
            const encodedCluster = btn.dataset.cluster;
            const encodedDb = btn.dataset.database;

            if (!encodedQuery) return;

            const query = decodeURIComponent(escape(atob(encodedQuery)));
            const clusterUrl = encodedCluster ? decodeURIComponent(escape(atob(encodedCluster))) : null;
            const database = encodedDb ? decodeURIComponent(escape(atob(encodedDb))) : null;

            switch (action) {
                case 'apply':
                    vscode.postMessage({ command: 'applyQuery', query: query, cluster: clusterUrl, database: database });
                    break;
                case 'copy':
                    vscode.postMessage({ command: 'copyQuery', query: query });
                    break;
            }
        });

        let messageHistory = [];
        let historyIndex = -1;
        let currentDraft = '';

        function sendMessage() {
            const input = document.getElementById('messageInput');
            const text = input.value.trim();
            if (!text || isTyping) return;

            if (messageHistory.length === 0 || messageHistory[messageHistory.length - 1] !== text) {
                messageHistory.push(text);
            }
            historyIndex = messageHistory.length;
            currentDraft = '';

            vscode.postMessage({ command: 'sendMessage', text: text, context: { includeCurrentQuery: true } });
            input.value = '';
        }

        function quickAction(action) {
            vscode.postMessage({ command: 'quickAction', action: action });
        }

        function clearChat() {
            vscode.postMessage({ command: 'clearChat' });
        }

        document.getElementById('messageInput').addEventListener('keydown', (e) => {
            const input = e.target;

            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            } else if (e.key === 'ArrowUp' && messageHistory.length > 0) {
                const atStart = input.selectionStart === 0 && input.selectionEnd === 0;
                const singleLine = !input.value.includes('\\n');

                if (atStart || singleLine) {
                    e.preventDefault();
                    if (historyIndex === messageHistory.length) {
                        currentDraft = input.value;
                    }
                    if (historyIndex > 0) {
                        historyIndex--;
                        input.value = messageHistory[historyIndex];
                    }
                }
            } else if (e.key === 'ArrowDown' && messageHistory.length > 0) {
                const atEnd = input.selectionStart === input.value.length;
                const singleLine = !input.value.includes('\\n');

                if (atEnd || singleLine) {
                    e.preventDefault();
                    if (historyIndex < messageHistory.length - 1) {
                        historyIndex++;
                        input.value = messageHistory[historyIndex];
                    } else if (historyIndex === messageHistory.length - 1) {
                        historyIndex = messageHistory.length;
                        input.value = currentDraft;
                    }
                }
            }
        });

        renderMessages();
    </script>
</body>
</html>`;
    }
}
