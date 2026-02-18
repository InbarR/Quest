import * as vscode from 'vscode';
import { SidecarClient } from '../sidecar/SidecarClient';

interface ChatMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: string;
    kqlQuery?: string;
}

interface ZeroPromptSuggestion {
    text: string;
    source: 'history' | 'favorite' | 'common';
    icon: string;
}

export class AIChatWebViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'querystudio.aiChat';

    private _view?: vscode.WebviewView;
    private readonly _extensionUri: vscode.Uri;
    private _messages: ChatMessage[] = [];
    private _isProcessing = false;
    private _currentMode: 'kusto' | 'ado' | 'outlook' | 'mcp' = 'kusto';
    private _suggestions: ZeroPromptSuggestion[] = [];

    private _onInsertQuery?: (query: string) => void;
    private _onApplyQuery?: (query: string, cluster?: string, database?: string) => void;

    constructor(
        extensionUri: vscode.Uri,
        private client: SidecarClient,
        private outputChannel: vscode.OutputChannel
    ) {
        this._extensionUri = extensionUri;
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
            for (const item of modeHistory.slice(0, 5)) {
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
        if (firstLine.length > 50) {
            return firstLine.substring(0, 50) + '...';
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
            case 'kusto': return 'KQL';
            case 'ado': return 'WIQL';
            case 'outlook': return 'OQL';
            case 'mcp': return 'MCPQL';
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

    public setOnInsertQuery(callback: (query: string) => void) {
        this._onInsertQuery = callback;
    }

    public setOnApplyQuery(callback: (query: string, cluster?: string, database?: string) => void) {
        this._onApplyQuery = callback;
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
                }
                break;
            case 'clearChat':
                this._messages = [];
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
        this._view?.webview.postMessage({ command: 'setTyping', isTyping: true });

        try {
            // Get current context
            const editor = vscode.window.activeTextEditor;
            const currentQuery = context?.includeCurrentQuery !== false ? editor?.document.getText() : undefined;
            const languageId = editor?.document.languageId;

            this.outputChannel.appendLine(`[AI Chat] Context - Query type: ${languageId}, Has query: ${!!currentQuery}`);

            // Call sidecar AI
            const response = await this.client.sendAIMessage(text, {
                currentQuery,
                queryType: languageId === 'wiql' ? 'ado' : 'kusto'
            });

            this.outputChannel.appendLine(`[AI Chat] Response received: ${response.message?.substring(0, 100) || '(empty)'}...`);

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
            this._view?.webview.postMessage({ command: 'setTyping', isTyping: false });
            this._updateView();
        }
    }

    private _extractQuery(text: string): string | undefined {
        // Look for code blocks with kql, kusto, or wiql
        const codeBlockRegex = /```(?:kql|kusto|wiql)?\s*([\s\S]*?)```/gi;
        const matches = [...text.matchAll(codeBlockRegex)];

        if (matches.length > 0) {
            // Return the last code block (usually the final/corrected query)
            return matches[matches.length - 1][1].trim();
        }

        return undefined;
    }

    public sendMessage(text: string) {
        this._handleUserMessage(text, { includeCurrentQuery: true });
    }

    private _updateView() {
        if (!this._view) return;

        this._view.webview.postMessage({
            command: 'updateMessages',
            messages: this._messages,
            modeDisplayName: this._getModeDisplayName(),
            modeIcon: this._getModeIcon()
        });
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
        .chat-container {
            flex: 1;
            overflow-y: auto;
            padding: 8px;
        }
        .message {
            margin-bottom: 12px;
            padding: 8px 12px;
            border-radius: 8px;
            max-width: 95%;
        }
        .message.user {
            background: #1E3A52;
            margin-left: auto;
            border-bottom-right-radius: 2px;
        }
        .message.assistant {
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-bottom-left-radius: 2px;
        }
        .message-header {
            display: flex;
            justify-content: space-between;
            margin-bottom: 4px;
            font-size: 11px;
        }
        .sender {
            font-weight: 600;
        }
        .sender.user { color: #4A9EFF; }
        .sender.assistant { color: #CE9178; }
        .timestamp {
            color: var(--vscode-descriptionForeground);
        }
        .message-content {
            white-space: pre-wrap;
            word-wrap: break-word;
            line-height: 1.4;
        }
        .message-content code {
            background: var(--vscode-textCodeBlock-background);
            padding: 1px 4px;
            border-radius: 3px;
            font-family: var(--vscode-editor-font-family);
        }
        .message-content pre {
            background: var(--vscode-textCodeBlock-background);
            padding: 8px;
            border-radius: 4px;
            overflow-x: auto;
            margin: 8px 0;
        }
        .message-content pre code {
            padding: 0;
            background: none;
        }
        .query-actions {
            display: flex;
            gap: 4px;
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
            font-size: 11px;
        }
        .query-actions button:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        .query-actions button.primary {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        .input-container {
            padding: 8px;
            border-top: 1px solid var(--vscode-panel-border);
            background: var(--vscode-panel-background);
        }
        .quick-actions {
            display: flex;
            gap: 4px;
            margin-bottom: 8px;
            flex-wrap: wrap;
        }
        .quick-actions button {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: none;
            padding: 3px 8px;
            border-radius: 3px;
            cursor: pointer;
            font-size: 11px;
        }
        .quick-actions button:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        .input-row {
            display: flex;
            gap: 4px;
        }
        textarea {
            flex: 1;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            padding: 6px 8px;
            border-radius: 4px;
            resize: none;
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            min-height: 60px;
            max-height: 120px;
        }
        textarea:focus {
            outline: 1px solid var(--vscode-focusBorder);
        }
        .send-btn {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
            font-weight: 500;
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
            padding: 8px 12px;
            color: var(--vscode-descriptionForeground);
            font-style: italic;
        }
        .typing-indicator.visible {
            display: block;
        }
        .welcome {
            text-align: center;
            padding: 24px 16px;
            color: var(--vscode-descriptionForeground);
        }
        .welcome-icon {
            font-size: 28px;
            margin-bottom: 12px;
        }
        .welcome h3 {
            color: var(--vscode-foreground);
            margin-bottom: 8px;
            font-size: 14px;
        }
        .welcome p {
            margin: 4px 0;
            font-size: 12px;
        }
        .welcome .mode-name {
            color: var(--vscode-textLink-foreground);
            font-weight: 600;
        }
        .clear-btn {
            position: absolute;
            top: 4px;
            right: 4px;
            background: transparent;
            border: none;
            color: var(--vscode-descriptionForeground);
            cursor: pointer;
            padding: 4px;
            font-size: 12px;
            border-radius: 3px;
        }
        .clear-btn:hover {
            color: var(--vscode-foreground);
            background: var(--vscode-toolbar-hoverBackground);
        }
        .header {
            position: relative;
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 6px 8px;
            border-bottom: 1px solid var(--vscode-panel-border);
            font-size: 12px;
            color: var(--vscode-foreground);
            font-weight: 500;
        }
        .header-icon {
            width: 16px;
            height: 16px;
            display: flex;
            align-items: center;
            justify-content: center;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border-radius: 2px;
            font-size: 9px;
            font-weight: bold;
        }
    </style>
</head>
<body>
    <div class="header">
        <span class="header-icon">AI</span>
        <span>Quest AI Assistant</span>
        <button class="clear-btn" onclick="clearChat()" title="Clear chat">🧹</button>
    </div>
    <div class="chat-container" id="chatContainer">
        <div class="welcome" id="welcome">
            <div class="welcome-icon" id="modeIcon">Ⓚ</div>
            <h3>Quest AI Assistant</h3>
            <p>Ask me anything about <span class="mode-name" id="modeName">KQL</span></p>
        </div>
    </div>
    <div class="typing-indicator" id="typingIndicator">AI is thinking...</div>
    <div class="input-container">
        <div class="quick-actions">
            <button onclick="quickAction('fix')">🔧 Fix Query</button>
            <button onclick="quickAction('improve')">✨ Improve</button>
            <button onclick="quickAction('explain')">📖 Explain</button>
            <button onclick="quickAction('comment')">💬 Add Comments</button>
        </div>
        <div class="input-row">
            <textarea id="messageInput" placeholder="Ask me about KQL or WIQL queries..." rows="2"></textarea>
            <button class="send-btn" id="sendBtn" onclick="sendMessage()">Send</button>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let messages = [];
        let isTyping = false;
        let modeDisplayName = 'KQL';
        let modeIcon = 'Ⓚ';

        window.addEventListener('message', event => {
            const msg = event.data;
            switch (msg.command) {
                case 'updateMessages':
                    messages = msg.messages;
                    if (msg.modeDisplayName) modeDisplayName = msg.modeDisplayName;
                    if (msg.modeIcon) modeIcon = msg.modeIcon;
                    renderMessages();
                    break;
                case 'setTyping':
                    isTyping = msg.isTyping;
                    document.getElementById('typingIndicator').classList.toggle('visible', isTyping);
                    document.getElementById('sendBtn').disabled = isTyping;
                    break;
            }
        });

        function renderMessages() {
            const container = document.getElementById('chatContainer');
            const welcome = document.getElementById('welcome');

            // Update mode info
            const modeNameEl = document.getElementById('modeName');
            const modeIconEl = document.getElementById('modeIcon');
            if (modeNameEl) modeNameEl.textContent = modeDisplayName;
            if (modeIconEl) modeIconEl.textContent = modeIcon;

            if (messages.length === 0) {
                welcome.style.display = 'block';
                container.innerHTML = '';
                container.appendChild(welcome);
                return;
            }

            welcome.style.display = 'none';
            container.innerHTML = messages.map(msg => renderMessage(msg)).join('');
            container.scrollTop = container.scrollHeight;
        }

        function renderMessage(msg) {
            const senderName = msg.role === 'user' ? 'You' : 'AI';
            const content = formatContent(msg.content);
            const queryActions = msg.kqlQuery ? renderQueryActions(msg.kqlQuery) : '';

            return \`
                <div class="message \${msg.role}">
                    <div class="message-header">
                        <span class="sender \${msg.role}">\${senderName}</span>
                        <span class="timestamp">\${msg.timestamp}</span>
                    </div>
                    <div class="message-content">\${content}</div>
                    \${queryActions}
                </div>
            \`;
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

        function renderQueryActions(query) {
            const escapedQuery = query.replace(/'/g, "\\\\'").replace(/\\n/g, '\\\\n');
            return \`
                <div class="query-actions">
                    <button class="primary" onclick="applyQuery('\${escapedQuery}')">▶ Apply Query</button>
                    <button onclick="insertQuery('\${escapedQuery}')">📝 Insert</button>
                    <button onclick="copyQuery('\${escapedQuery}')">📋 Copy</button>
                </div>
            \`;
        }

        function sendMessage() {
            const input = document.getElementById('messageInput');
            const text = input.value.trim();
            if (!text || isTyping) return;

            vscode.postMessage({ command: 'sendMessage', text: text, context: { includeCurrentQuery: true } });
            input.value = '';
        }

        function quickAction(action) {
            vscode.postMessage({ command: 'quickAction', action: action });
        }

        function applyQuery(query) {
            vscode.postMessage({ command: 'applyQuery', query: query.replace(/\\\\n/g, '\\n').replace(/\\\\'/g, "'") });
        }

        function insertQuery(query) {
            vscode.postMessage({ command: 'insertQuery', query: query.replace(/\\\\n/g, '\\n').replace(/\\\\'/g, "'") });
        }

        function copyQuery(query) {
            vscode.postMessage({ command: 'copyQuery', query: query.replace(/\\\\n/g, '\\n').replace(/\\\\'/g, "'") });
        }

        function clearChat() {
            vscode.postMessage({ command: 'clearChat' });
        }

        function escapeHtml(text) {
            if (!text) return '';
            const div = document.createElement('div');
            div.textContent = String(text);
            return div.innerHTML;
        }

        // Handle Enter key (send) vs Shift+Enter (newline)
        document.getElementById('messageInput').addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });
    </script>
</body>
</html>`;
    }
}
