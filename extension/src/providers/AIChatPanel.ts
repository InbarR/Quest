import * as vscode from 'vscode';
import { SidecarClient } from '../sidecar/SidecarClient';

interface ChatMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: string;
    kqlQuery?: string;
}

/**
 * AI Chat Panel - Opens in the secondary sidebar (right side) as a WebviewPanel
 */
interface ZeroPromptSuggestion {
    text: string;
    source: 'history' | 'favorite' | 'common';
    icon: string;
}

export class AIChatPanel {
    public static currentPanel: AIChatPanel | undefined;
    public static readonly viewType = 'querystudio.aiChatPanel';

    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private _messages: ChatMessage[] = [];
    private _isProcessing = false;
    private _sessionId?: string;  // Track AI session for conversation continuity
    private _currentMode: 'kusto' | 'ado' | 'outlook' | 'mcp' = 'kusto';
    private _suggestions: ZeroPromptSuggestion[] = [];

    private _onInsertQuery?: (query: string) => void;
    private _onApplyQuery?: (query: string, cluster?: string, database?: string) => void;

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        private client: SidecarClient,
        private outputChannel: vscode.OutputChannel
    ) {
        this._panel = panel;
        this._extensionUri = extensionUri;

        this._panel.webview.html = this._getHtmlForWebview(this._panel.webview);

        // Listen for when the panel is disposed
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        // Handle messages from the webview
        this._panel.webview.onDidReceiveMessage(
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
    }

    /**
     * Create or show the AI Chat panel in the secondary sidebar
     */
    public static createOrShow(
        extensionUri: vscode.Uri,
        client: SidecarClient,
        outputChannel: vscode.OutputChannel
    ): AIChatPanel {
        // If we already have a panel, show it
        if (AIChatPanel.currentPanel) {
            AIChatPanel.currentPanel._panel.reveal(vscode.ViewColumn.Beside);
            return AIChatPanel.currentPanel;
        }

        // Create a new panel beside the current editor (can be moved to secondary sidebar)
        const panel = vscode.window.createWebviewPanel(
            AIChatPanel.viewType,
            'QS Chat',
            {
                viewColumn: vscode.ViewColumn.Beside,
                preserveFocus: true
            },
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri]
            }
        );

        // Set a custom icon
        panel.iconPath = {
            light: vscode.Uri.joinPath(extensionUri, 'resources', 'ai-light.svg'),
            dark: vscode.Uri.joinPath(extensionUri, 'resources', 'ai-dark.svg')
        };

        AIChatPanel.currentPanel = new AIChatPanel(panel, extensionUri, client, outputChannel);
        return AIChatPanel.currentPanel;
    }

    public setOnInsertQuery(callback: (query: string) => void) {
        this._onInsertQuery = callback;
    }

    public setOnApplyQuery(callback: (query: string, cluster?: string, database?: string) => void) {
        this._onApplyQuery = callback;
    }

    public sendMessage(text: string) {
        this._handleUserMessage(text, { includeCurrentQuery: true });
    }

    public reveal() {
        this._panel.reveal(vscode.ViewColumn.Two);
    }

    public async setMode(mode: 'kusto' | 'ado' | 'outlook' | 'mcp') {
        this._currentMode = mode;
        await this._loadSuggestions();
        this._updateView();
    }

    private async _loadSuggestions() {
        const suggestions: ZeroPromptSuggestion[] = [];

        try {
            // Load history and favorites in parallel for better performance
            const [history, favorites] = await Promise.all([
                this.client.getHistory(20),
                this.client.getPresets()
            ]);

            const modeHistory = history.filter(h => h.type === this._currentMode);

            // Get unique query patterns from history
            const historyPatterns = new Set<string>();
            for (const item of modeHistory.slice(0, 3)) {
                const pattern = this._extractQueryPattern(item.query);
                if (pattern && !historyPatterns.has(pattern)) {
                    historyPatterns.add(pattern);
                    suggestions.push({
                        text: `Similar to: ${item.name || pattern}`,
                        source: 'history',
                        icon: '🕐'
                    });
                }
            }

            const modeFavorites = favorites.filter(f => f.type === this._currentMode && !f.isAutoSaved);

            for (const fav of modeFavorites.slice(0, 3)) {
                suggestions.push({
                    text: `Like my favorite: ${fav.name}`,
                    source: 'favorite',
                    icon: '⭐'
                });
            }
        } catch (error) {
            this.outputChannel.appendLine(`[AI Chat] Failed to load suggestions: ${error}`);
        }

        // Add common suggestions based on mode
        const commonSuggestions = this._getCommonSuggestions();
        suggestions.push(...commonSuggestions);

        this._suggestions = suggestions.slice(0, 6); // Limit to 6 suggestions
    }

    private _extractQueryPattern(query: string): string {
        // Extract a brief pattern from the query
        const firstLine = query.split('\n')[0].trim();
        if (firstLine.length > 40) {
            return firstLine.substring(0, 40) + '...';
        }
        return firstLine;
    }

    private _getCommonSuggestions(): ZeroPromptSuggestion[] {
        if (this._currentMode === 'kusto') {
            return [
                { text: 'Write a query to count events by type', source: 'common', icon: '💡' },
                { text: 'Help me filter results by time range', source: 'common', icon: '💡' },
                { text: 'Create a summarize query with charts', source: 'common', icon: '💡' }
            ];
        } else if (this._currentMode === 'ado') {
            return [
                { text: 'Find all open bugs assigned to me', source: 'common', icon: '💡' },
                { text: 'Query work items modified this week', source: 'common', icon: '💡' },
                { text: 'List tasks in current sprint', source: 'common', icon: '💡' }
            ];
        } else {
            return [
                { text: 'Find emails from last week with attachments', source: 'common', icon: '💡' },
                { text: 'Search for unread emails from specific sender', source: 'common', icon: '💡' },
                { text: 'List calendar appointments for today', source: 'common', icon: '💡' }
            ];
        }
    }

    private _getModeDisplayName(): string {
        switch (this._currentMode) {
            case 'kusto': return 'KQL (Kusto Query Language)';
            case 'ado': return 'WIQL (Azure DevOps Work Items)';
            case 'outlook': return 'OQL (Outlook Queries)';
            case 'mcp': return 'MCPQL (MCP Queries)';
        }
    }

    private _getModeIcon(): string {
        switch (this._currentMode) {
            case 'kusto': return 'Ⓚ';
            case 'ado': return 'Ⓐ';
            case 'outlook': return '📧';
            case 'mcp': return '🔌';
        }
    }

    private async _handleMessage(message: any) {
        switch (message.command) {
            case 'sendMessage':
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
                this._sessionId = undefined;  // Reset session to get fresh system prompt
                this.outputChannel.appendLine('[AI Chat] Chat cleared - session reset');
                this._updateView();
                break;
            case 'quickAction':
                await this._handleQuickAction(message.action);
                break;
        }
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

        // Add user message
        const userMessage: ChatMessage = {
            role: 'user',
            content: text,
            timestamp: new Date().toLocaleTimeString()
        };
        this._messages.push(userMessage);
        this._updateView();

        // Show typing indicator
        this._panel.webview.postMessage({ command: 'setTyping', isTyping: true });

        try {
            // Get current context
            const editor = vscode.window.activeTextEditor;
            const currentQuery = context?.includeCurrentQuery !== false ? editor?.document.getText() : undefined;
            const languageId = editor?.document.languageId;

            this.outputChannel.appendLine(`[AI Chat] Context - Query type: ${languageId}, Has query: ${!!currentQuery}, Query length: ${currentQuery?.length || 0}`);
            if (currentQuery) {
                this.outputChannel.appendLine(`[AI Chat] Current query preview: ${currentQuery.substring(0, 100)}...`);
            }

            // Get favorites and history for context
            let favorites: string[] = [];
            let recentQueries: string[] = [];

            try {
                const presets = await this.client.getPresets();
                favorites = presets
                    .filter(p => !p.isAutoSaved)
                    .slice(0, 10)
                    .map(p => `"${p.name}": ${p.query.substring(0, 200)}${p.query.length > 200 ? '...' : ''}`);

                const history = await this.client.getHistory(10);
                recentQueries = history
                    .filter(p => p.isAutoSaved)
                    .slice(0, 5)
                    .map(p => p.query.substring(0, 200) + (p.query.length > 200 ? '...' : ''));
            } catch (e) {
                this.outputChannel.appendLine(`[AI Chat] Failed to load favorites/history for context: ${e}`);
            }

            this.outputChannel.appendLine(`[AI Chat] Context - Favorites: ${favorites.length}, Recent: ${recentQueries.length}, SessionId: ${this._sessionId || 'new'}`);

            // Call sidecar AI with full context including mode
            const response = await this.client.aiChat({
                message: text,
                mode: this._currentMode,  // Pass current mode (kusto, ado, outlook)
                sessionId: this._sessionId,  // Pass existing session or undefined for new
                context: {
                    currentQuery,
                    favorites: favorites.length > 0 ? favorites : undefined,
                    recentQueries: recentQueries.length > 0 ? recentQueries : undefined
                }
            });

            // Store session ID for conversation continuity
            if (response.sessionId) {
                this._sessionId = response.sessionId;
            }

            this.outputChannel.appendLine(`[AI Chat] Response received (session: ${response.sessionId}): ${response.message?.substring(0, 100) || '(empty)'}...`);

            // Check if response is empty
            if (!response.message || response.message.trim() === '') {
                throw new Error('AI returned empty response. Check Output > Quest for details.');
            }

            // Extract KQL/WIQL from response
            const extractedQuery = this._extractQuery(response.message);

            // Add assistant message
            const assistantMessage: ChatMessage = {
                role: 'assistant',
                content: response.message,
                timestamp: new Date().toLocaleTimeString(),
                kqlQuery: extractedQuery
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
            this._panel.webview.postMessage({ command: 'setTyping', isTyping: false });
            this._updateView();
        }
    }

    private _extractQuery(text: string): string | undefined {
        // Look for code blocks with kql, kusto, wiql, oql, or outlook
        const codeBlockRegex = /```(?:kql|kusto|wiql|oql|outlook)?\s*([\s\S]*?)```/gi;
        const matches = [...text.matchAll(codeBlockRegex)];

        if (matches.length > 0) {
            // Return the last code block (usually the final/corrected query)
            return matches[matches.length - 1][1].trim();
        }

        return undefined;
    }

    private _updateView() {
        this._panel.webview.postMessage({
            command: 'updateMessages',
            messages: this._messages,
            modeDisplayName: this._getModeDisplayName(),
            modeIcon: this._getModeIcon(),
            suggestions: this._suggestions
        });
        this._updateContextBar();
    }

    private async _updateContextBar() {
        try {
            const editor = vscode.window.activeTextEditor;
            const queryLanguages = ['kql', 'wiql', 'oql'];
            const hasQuery = editor && queryLanguages.includes(editor.document.languageId) && editor.document.getText().trim().length > 0;

            let favoritesCount = 0;
            let historyCount = 0;

            try {
                const presets = await this.client.getPresets();
                favoritesCount = presets.filter(p => !p.isAutoSaved).length;

                const history = await this.client.getHistory(10);
                historyCount = history.filter(p => p.isAutoSaved).length;
            } catch { }

            this._panel.webview.postMessage({
                command: 'updateContext',
                context: {
                    hasQuery,
                    hasFavorites: favoritesCount > 0,
                    favoritesCount,
                    hasHistory: historyCount > 0,
                    historyCount
                }
            });
        } catch { }
    }

    public dispose() {
        AIChatPanel.currentPanel = undefined;

        // Clean up resources
        this._panel.dispose();

        while (this._disposables.length) {
            const disposable = this._disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'unsafe-inline';">
    <title>QS Chat</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: var(--vscode-font-family);
            font-size: 13px;
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
            height: 100vh;
            display: flex;
            flex-direction: column;
            margin: 0 auto;
            padding: 0;
            max-width: 450px;
        }
        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 10px 16px;
            background: var(--vscode-sideBar-background);
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .header-title {
            font-weight: 600;
            font-size: 14px;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .header-icon {
            width: 18px;
            height: 18px;
            display: flex;
            align-items: center;
            justify-content: center;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border-radius: 3px;
            font-size: 11px;
            font-weight: bold;
        }
        .status-dot {
            width: 6px;
            height: 6px;
            background: #4CAF50;
            border-radius: 50%;
        }
        .header-actions {
            display: flex;
            gap: 4px;
        }
        .icon-btn {
            background: transparent;
            border: none;
            color: var(--vscode-descriptionForeground);
            cursor: pointer;
            padding: 6px;
            border-radius: 3px;
            font-size: 14px;
            transition: background 0.1s;
        }
        .icon-btn:hover {
            background: var(--vscode-toolbar-hoverBackground);
            color: var(--vscode-foreground);
        }
        .chat-container {
            flex: 1;
            overflow-y: auto;
            padding: 16px;
            scroll-behavior: smooth;
        }
        .message {
            margin-bottom: 12px;
            animation: fadeIn 0.15s ease-out;
        }
        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(4px); }
            to { opacity: 1; transform: translateY(0); }
        }
        .message-bubble {
            padding: 10px 14px;
            border-radius: 4px;
            max-width: 90%;
            line-height: 1.5;
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
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            margin-top: 4px;
            padding: 0 4px;
        }
        .message.user .message-meta { text-align: right; }
        .message-content {
            white-space: pre-wrap;
            word-wrap: break-word;
        }
        .message-content code {
            background: rgba(0,0,0,0.2);
            padding: 2px 6px;
            border-radius: 2px;
            font-family: var(--vscode-editor-font-family);
            font-size: 12px;
        }
        .message-content pre {
            background: var(--vscode-textCodeBlock-background);
            padding: 12px;
            border-radius: 3px;
            overflow-x: auto;
            margin: 8px 0;
            border: 1px solid var(--vscode-panel-border);
            font-size: 12px;
        }
        .message-content pre code {
            padding: 0;
            background: none;
        }
        .query-actions {
            display: flex;
            gap: 8px;
            margin-top: 10px;
        }
        .query-actions button {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: none;
            padding: 5px 10px;
            border-radius: 3px;
            cursor: pointer;
            font-size: 11px;
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
        .input-area {
            padding: 16px;
            background: var(--vscode-sideBar-background);
            border-top: 1px solid var(--vscode-panel-border);
        }
        .context-bar {
            display: flex;
            gap: 6px;
            padding: 8px 16px;
            background: var(--vscode-textBlockQuote-background);
            border-bottom: 1px solid var(--vscode-panel-border);
            flex-wrap: wrap;
            align-items: center;
            font-size: 11px;
        }
        .context-bar-label {
            color: var(--vscode-descriptionForeground);
            font-weight: 500;
        }
        .context-chip {
            display: flex;
            align-items: center;
            gap: 4px;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            padding: 2px 8px;
            border-radius: 3px;
            font-size: 10px;
        }
        .context-chip.active {
            background: var(--vscode-testing-iconPassed, #4caf50);
        }
        .context-chip.inactive {
            opacity: 0.5;
        }
        .quick-actions {
            display: flex;
            gap: 8px;
            margin-bottom: 10px;
            flex-wrap: wrap;
        }
        .quick-btn {
            background: var(--vscode-editor-inactiveSelectionBackground);
            color: var(--vscode-foreground);
            border: 1px solid var(--vscode-panel-border);
            padding: 5px 10px;
            border-radius: 3px;
            cursor: pointer;
            font-size: 11px;
            transition: background 0.1s;
        }
        .quick-btn:hover {
            background: var(--vscode-button-secondaryBackground);
            border-color: var(--vscode-button-secondaryBackground);
        }
        .input-wrapper {
            display: flex;
            gap: 8px;
            align-items: flex-end;
        }
        textarea {
            flex: 1;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            padding: 10px;
            border-radius: 3px;
            resize: none;
            font-family: var(--vscode-font-family);
            font-size: 13px;
            min-height: 50px;
            max-height: 120px;
        }
        textarea:focus {
            outline: 1px solid var(--vscode-focusBorder);
        }
        .send-btn {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 10px 16px;
            border-radius: 3px;
            cursor: pointer;
            font-weight: 600;
            font-size: 13px;
            transition: background 0.1s;
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
            padding: 10px 14px;
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
            background: var(--vscode-editor-inactiveSelectionBackground);
            border-radius: 3px;
            margin: 0 16px 12px;
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
            padding: 32px;
            text-align: center;
        }
        .welcome-icon {
            font-size: 36px;
            margin-bottom: 16px;
            opacity: 0.9;
        }
        .welcome h3 {
            color: var(--vscode-foreground);
            margin-bottom: 8px;
            font-size: 16px;
            font-weight: 600;
        }
        .welcome p {
            margin: 4px 0;
            font-size: 13px;
            line-height: 1.5;
            color: var(--vscode-descriptionForeground);
            max-width: 280px;
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
            <button class="icon-btn" onclick="clearChat()" title="Clear chat">🧹</button>
        </div>
    </div>
    <div class="context-bar" id="contextBar">
        <span class="context-bar-label">Context:</span>
        <span class="context-chip" id="contextQuery" title="Current query from editor">📝 Editor</span>
        <span class="context-chip" id="contextFavorites" title="Your saved favorite queries">⭐ Favorites</span>
        <span class="context-chip" id="contextHistory" title="Recent query history">📜 History</span>
    </div>
    <div class="chat-container" id="chatContainer"></div>
    <div class="typing-indicator" id="typingIndicator">🤔 Thinking...</div>
    <div class="input-area">
        <div class="quick-actions">
            <button class="quick-btn" onclick="quickAction('fix')">🔧 Fix</button>
            <button class="quick-btn" onclick="quickAction('improve')">✨ Improve</button>
            <button class="quick-btn" onclick="quickAction('explain')">📖 Explain</button>
        </div>
        <div class="input-wrapper">
            <textarea id="messageInput" placeholder="Ask about KQL, WIQL, or OQL queries..." rows="2"></textarea>
            <button class="send-btn" id="sendBtn" onclick="sendMessage()">Send</button>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let messages = [];
        let isTyping = false;
        let modeDisplayName = 'KQL (Kusto Query Language)';
        let modeIcon = 'Ⓚ';
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
            }
        });

        function updateContextBar(ctx) {
            const queryChip = document.getElementById('contextQuery');
            const favChip = document.getElementById('contextFavorites');
            const histChip = document.getElementById('contextHistory');

            queryChip.classList.toggle('active', ctx.hasQuery);
            queryChip.classList.toggle('inactive', !ctx.hasQuery);

            favChip.classList.toggle('active', ctx.hasFavorites);
            favChip.classList.toggle('inactive', !ctx.hasFavorites);
            favChip.textContent = ctx.hasFavorites ? '⭐ ' + ctx.favoritesCount + ' Favorites' : '⭐ Favorites';

            histChip.classList.toggle('active', ctx.hasHistory);
            histChip.classList.toggle('inactive', !ctx.hasHistory);
            histChip.textContent = ctx.hasHistory ? '📜 ' + ctx.historyCount + ' Recent' : '📜 History';
        }

        function renderMessages() {
            const container = document.getElementById('chatContainer');

            if (messages.length === 0) {
                container.innerHTML = \`
                    <div class="welcome">
                        <div class="welcome-icon">\${modeIcon}</div>
                        <h3>QS Chat</h3>
                        <p>Ask me anything about <strong style="color: var(--vscode-textLink-foreground)">\${modeDisplayName}</strong></p>
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

        function escapeForAttr(str) {
            return str.replace(/'/g, "\\\\'").replace(/"/g, '&quot;');
        }

        function renderMessage(msg, index) {
            const content = formatContent(msg.content);
            const queryActions = msg.kqlQuery ? renderQueryActions(msg.kqlQuery, index) : '';

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

        function setExample(text) {
            document.getElementById('messageInput').value = text;
            document.getElementById('messageInput').focus();
        }

        function formatContent(text) {
            // Escape HTML
            text = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

            // Format code blocks
            text = text.replace(/\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g, '<pre><code>$2</code></pre>');

            // Format inline code
            text = text.replace(/\`([^\`]+)\`/g, '<code>$1</code>');

            // Format bold
            text = text.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');

            // Format italic
            text = text.replace(/\\*([^*]+)\\*/g, '<em>$1</em>');

            return text;
        }

        function renderQueryActions(query, messageIndex) {
            // Encode query as base64 to safely embed in HTML attribute
            const encodedQuery = btoa(unescape(encodeURIComponent(query)));
            return \`
                <div class="query-actions">
                    <button class="primary query-btn" data-action="apply" data-query="\${encodedQuery}">▶ Use Query</button>
                    <button class="query-btn" data-action="copy" data-query="\${encodedQuery}">📋 Copy</button>
                </div>
            \`;
        }

        // Event delegation for query action buttons
        document.addEventListener('click', function(e) {
            const btn = e.target.closest('.query-btn');
            if (!btn) return;

            const action = btn.dataset.action;
            const encodedQuery = btn.dataset.query;

            if (!encodedQuery) {
                console.error('No query found on button');
                return;
            }

            // Decode the query from base64
            const query = decodeURIComponent(escape(atob(encodedQuery)));

            switch (action) {
                case 'apply':
                    vscode.postMessage({ command: 'applyQuery', query: query });
                    break;
                case 'copy':
                    vscode.postMessage({ command: 'copyQuery', query: query });
                    break;
            }
        });

        // Message history for up/down arrow navigation
        let messageHistory = [];
        let historyIndex = -1;
        let currentDraft = '';

        function sendMessage() {
            const input = document.getElementById('messageInput');
            const text = input.value.trim();
            if (!text || isTyping) return;

            // Add to history (avoid duplicates)
            if (messageHistory.length === 0 || messageHistory[messageHistory.length - 1] !== text) {
                messageHistory.push(text);
            }
            historyIndex = messageHistory.length;  // Reset to end
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

        // Handle Enter key (send), Shift+Enter (newline), and Up/Down (history)
        document.getElementById('messageInput').addEventListener('keydown', (e) => {
            const input = e.target;

            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            } else if (e.key === 'ArrowUp' && messageHistory.length > 0) {
                // Only navigate history if cursor is at start or single line
                const atStart = input.selectionStart === 0 && input.selectionEnd === 0;
                const singleLine = !input.value.includes('\\n');

                if (atStart || singleLine) {
                    e.preventDefault();
                    // Save current input as draft when starting to navigate
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

        // Initial render to show welcome screen
        renderMessages();
    </script>
</body>
</html>`;
    }
}
