import * as vscode from 'vscode';
import { SidecarClient } from '../sidecar/SidecarClient';
import { getActiveConnection } from '../commands/queryCommands';
import { McpToolDiscovery } from '../mcp/McpToolDiscovery';

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
    private _currentMode: 'kusto' | 'ado' | 'outlook' | 'mcp' = 'kusto';
    private _suggestions: ZeroPromptSuggestion[] = [];
    private _disposables: vscode.Disposable[] = [];

    private _onInsertQuery?: (query: string) => void;
    private _onApplyQuery?: (query: string, cluster?: string, database?: string) => void;
    private _onSelectCluster?: (clusterUrl: string, database: string) => void;
    private _activeClusterUrl?: string;
    private _activeDatabase?: string;
    private _activeClusterName?: string;
    private _activeClusterType?: 'kusto' | 'ado' | 'outlook' | 'mcp';
    private _inputHistory: string[] = [];
    private _currentPersona: string = '';
    private _customSystemPrompt: string | undefined;
    private _mcpToolDiscovery?: McpToolDiscovery;
    private _selectedMcpServer?: string;
    private _selectedMcpTool?: string;
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
        // Load default persona from settings
        const config = vscode.workspace.getConfiguration('queryStudio.ai');
        this._currentPersona = config.get<string>('defaultPersona') || '';
    }

    public setMcpToolDiscovery(discovery: McpToolDiscovery) {
        this._mcpToolDiscovery = discovery;
    }

    /**
     * Interactive MCP server/tool selection flow.
     * Shows VS Code QuickPick to guide the user through choosing a server and tool
     * before sending to the AI. Returns the filtered tools or undefined if cancelled.
     */
    private async _selectMcpScope(allTools: { serverName: string; toolName: string; description?: string; parameters?: { name: string; type: string; description?: string; required: boolean }[] }[]): Promise<typeof allTools | undefined> {
        // Group tools by server
        const serverMap = new Map<string, typeof allTools>();
        for (const tool of allTools) {
            const list = serverMap.get(tool.serverName) || [];
            list.push(tool);
            serverMap.set(tool.serverName, list);
        }
        const serverNames = [...serverMap.keys()].sort();

        // Step 1: Server selection
        const serverItems: vscode.QuickPickItem[] = [
            { label: '$(globe) All Servers', description: `${allTools.length} tools across ${serverNames.length} servers`, detail: 'Send all tools to the AI (may be slow for large tool sets)' },
            { label: '', kind: vscode.QuickPickItemKind.Separator },
            ...serverNames.map(name => {
                const tools = serverMap.get(name)!;
                return {
                    label: `$(server) ${name}`,
                    description: `${tools.length} tools`,
                    detail: tools.slice(0, 3).map(t => t.toolName).join(', ') + (tools.length > 3 ? ` +${tools.length - 3} more` : '')
                };
            })
        ];

        const selectedServer = await vscode.window.showQuickPick(serverItems, {
            title: 'MCP Server Selection',
            placeHolder: 'Which MCP server would you like to query?',
            matchOnDescription: true,
            matchOnDetail: true
        });
        if (!selectedServer) return undefined; // cancelled

        if (selectedServer.label === '$(globe) All Servers') {
            this._selectedMcpServer = undefined;
            this._selectedMcpTool = undefined;
            this._updateMcpContextChips();
            return allTools;
        }

        // Extract server name (remove codicon prefix)
        const serverName = selectedServer.label.replace('$(server) ', '');
        this._selectedMcpServer = serverName;
        const serverTools = serverMap.get(serverName) || [];

        // Step 2: Tool selection
        const toolItems: vscode.QuickPickItem[] = [
            { label: '$(layers) All Tools', description: `${serverTools.length} tools from ${serverName}`, detail: 'Send all tools from this server to the AI' },
            { label: '', kind: vscode.QuickPickItemKind.Separator },
            ...serverTools.map(tool => ({
                label: `$(tools) ${tool.toolName}`,
                description: tool.description ? (tool.description.length > 80 ? tool.description.substring(0, 80) + '...' : tool.description) : '',
                detail: tool.parameters?.map(p => `${p.name}${p.required ? '*' : ''}: ${p.type}`).join(', ') || 'No parameters'
            }))
        ];

        const selectedTool = await vscode.window.showQuickPick(toolItems, {
            title: `Tools from ${serverName}`,
            placeHolder: `Which tool do you want help with? (${serverTools.length} available)`,
            matchOnDescription: true,
            matchOnDetail: true
        });
        if (!selectedTool) return undefined; // cancelled

        if (selectedTool.label === '$(layers) All Tools') {
            this._selectedMcpTool = undefined;
            this._updateMcpContextChips();
            return serverTools;
        }

        // Single tool selected
        const toolName = selectedTool.label.replace('$(tools) ', '');
        this._selectedMcpTool = toolName;
        this._updateMcpContextChips();
        return serverTools.filter(t => t.toolName === toolName);
    }

    /**
     * Prompts the user to change the selected MCP server via QuickPick
     */
    private async _changeMcpServer() {
        if (!this._mcpToolDiscovery) return;
        await this._mcpToolDiscovery.discoverTools();
        const tools = this._mcpToolDiscovery.tools;
        if (tools.length === 0) {
            vscode.window.showWarningMessage('No MCP tools discovered. Check that MCP servers are running.');
            return;
        }

        const allMcpTools = tools.map(t => ({
            serverName: t.serverName,
            toolName: t.toolName,
            description: t.description || undefined,
            parameters: t.parameters.map(p => ({ name: p.name, type: p.type, description: p.description || undefined, required: p.required }))
        }));

        // Just run the server portion of selection
        const serverMap = new Map<string, typeof allMcpTools>();
        for (const tool of allMcpTools) {
            const list = serverMap.get(tool.serverName) || [];
            list.push(tool);
            serverMap.set(tool.serverName, list);
        }
        const serverNames = [...serverMap.keys()].sort();

        const serverItems: vscode.QuickPickItem[] = [
            { label: '$(globe) All Servers', description: `${allMcpTools.length} tools across ${serverNames.length} servers` },
            { label: '', kind: vscode.QuickPickItemKind.Separator },
            ...serverNames.map(name => ({
                label: `$(server) ${name}`,
                description: `${(serverMap.get(name) || []).length} tools`,
            }))
        ];

        const selected = await vscode.window.showQuickPick(serverItems, {
            title: 'Change MCP Server',
            placeHolder: 'Select an MCP server',
            matchOnDescription: true
        });
        if (!selected) return;

        if (selected.label === '$(globe) All Servers') {
            this._selectedMcpServer = undefined;
            this._selectedMcpTool = undefined;
        } else {
            this._selectedMcpServer = selected.label.replace('$(server) ', '');
            this._selectedMcpTool = undefined;
        }
        this._updateMcpContextChips();
        this.outputChannel.appendLine(`[AI Chat] MCP server changed to: ${this._selectedMcpServer || 'All Servers'}`);
    }

    /**
     * Prompts the user to change the selected MCP tool via QuickPick
     */
    private async _changeMcpTool() {
        if (!this._mcpToolDiscovery) return;
        const tools = this._mcpToolDiscovery.tools;
        const serverName = this._selectedMcpServer;

        const serverTools = serverName
            ? tools.filter(t => t.serverName === serverName)
            : tools;

        if (serverTools.length === 0) {
            vscode.window.showWarningMessage(serverName ? `No tools found for server "${serverName}".` : 'No MCP tools discovered.');
            return;
        }

        const toolItems: vscode.QuickPickItem[] = [
            { label: '$(layers) All Tools', description: `${serverTools.length} tools${serverName ? ` from ${serverName}` : ''}` },
            { label: '', kind: vscode.QuickPickItemKind.Separator },
            ...serverTools.map(t => ({
                label: `$(tools) ${t.toolName}`,
                description: t.description ? (t.description.length > 80 ? t.description.substring(0, 80) + '...' : t.description) : '',
            }))
        ];

        const selected = await vscode.window.showQuickPick(toolItems, {
            title: serverName ? `Tools from ${serverName}` : 'All MCP Tools',
            placeHolder: 'Select a tool to focus on',
            matchOnDescription: true
        });
        if (!selected) return;

        if (selected.label === '$(layers) All Tools') {
            this._selectedMcpTool = undefined;
        } else {
            this._selectedMcpTool = selected.label.replace('$(tools) ', '');
        }
        this._updateMcpContextChips();
        this.outputChannel.appendLine(`[AI Chat] MCP tool changed to: ${this._selectedMcpTool || 'All Tools'}`);
    }

    /**
     * Sends current MCP server/tool selection state to the webview context bar
     */
    private _updateMcpContextChips() {
        this._view?.webview.postMessage({
            command: 'updateMcpContext',
            server: this._selectedMcpServer || null,
            tool: this._selectedMcpTool || null,
            isMcpMode: this._currentMode === 'mcp'
        });
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

    public setActiveCluster(clusterUrl: string, database: string, name: string, type: 'kusto' | 'ado' | 'outlook' | 'mcp') {
        this._activeClusterUrl = clusterUrl;
        this._activeDatabase = database;
        this._activeClusterName = name;
        this._activeClusterType = type;
    }

    public sendMessage(text: string) {
        this._handleUserMessage(text, { includeCurrentQuery: true });
    }

    public get isVisible(): boolean {
        return this._view?.visible ?? false;
    }

    public reveal() {
        if (this._view) {
            this._view.show(true);
        }
    }

    public async setMode(mode: 'kusto' | 'ado' | 'outlook' | 'mcp') {
        this._currentMode = mode;
        // Clear MCP selection when switching away from MCP mode
        if (mode !== 'mcp') {
            this._selectedMcpServer = undefined;
            this._selectedMcpTool = undefined;
        }
        await this._loadSuggestions();
        this._updateView();
        this._updateMcpContextChips();
    }

    /**
     * Gets a GitHub token from VS Code's built-in authentication provider.
     * This reuses the same GitHub session the user has for Copilot, etc.
     */
    public async ensureGithubToken(createIfNone: boolean = false): Promise<string | undefined> {
        try {
            const session = await vscode.authentication.getSession('github', ['read:user'], { createIfNone });
            if (session) {
                this.outputChannel.appendLine('[AI] GitHub token obtained from VS Code auth');
                return session.accessToken;
            }
        } catch (e) {
            this.outputChannel.appendLine(`[AI] Failed to get GitHub session: ${e}`);
        }
        return undefined;
    }

    public setPersona(personaName: string) {
        this._currentPersona = personaName;
        this._updateView();
        this.outputChannel.appendLine(`[AI Chat] Persona set to: ${personaName || 'Default Assistant'}`);
    }

    private _getPersonaPrompt(): string | undefined {
        if (!this._currentPersona) return undefined;
        const config = vscode.workspace.getConfiguration('queryStudio.ai');
        const personas: { name: string; prompt: string }[] = config.get('personas') || [];
        const persona = personas.find(p => p.name === this._currentPersona);
        return persona?.prompt;
    }

    private _getPersonaInfo(): { name: string; icon: string } | null {
        if (!this._currentPersona) return null;
        const config = vscode.workspace.getConfiguration('queryStudio.ai');
        const personas: { name: string; prompt: string; icon?: string }[] = config.get('personas') || [];
        const persona = personas.find(p => p.name === this._currentPersona);
        if (persona) {
            return { name: persona.name, icon: persona.icon || '$(account)' };
        }
        return null;
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
        } else if (this._currentMode === 'mcp') {
            return [
                { text: 'List available tools from my MCP servers', source: 'common', icon: '' },
                { text: 'Query data from my MCP data source', source: 'common', icon: '' },
                { text: 'Show me how to filter MCP tool results', source: 'common', icon: '' }
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
            case 'mcp': return 'MCPQL (MCP Queries)';
        }
    }

    private _getModeIcon(): string {
        switch (this._currentMode) {
            case 'kusto': return 'K';
            case 'ado': return 'A';
            case 'outlook': return 'O';
            case 'mcp': return 'M';
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
            case 'runQuery':
                if (message.query) {
                    // Apply the query first, then run it
                    if (this._onApplyQuery) {
                        this._onApplyQuery(message.query, message.cluster, message.database);
                    }
                    // Small delay to ensure query is applied, then run
                    setTimeout(() => {
                        vscode.commands.executeCommand('queryStudio.runQuery');
                    }, 100);
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
            case 'selectPersona':
                vscode.commands.executeCommand('queryStudio.selectAiPersona');
                break;
            case 'managePersonas':
                vscode.commands.executeCommand('queryStudio.manageAiPersonas');
                break;
            case 'getSystemPrompt':
                try {
                    const defaultPrompt = await this.client.getSystemPrompt(this._currentMode);
                    this._view?.webview.postMessage({
                        command: 'systemPrompt',
                        prompt: this._customSystemPrompt ?? defaultPrompt,
                        isCustom: !!this._customSystemPrompt,
                        defaultPrompt
                    });
                } catch (e) {
                    this.outputChannel.appendLine(`[AI Chat] Failed to get system prompt: ${e}`);
                }
                break;
            case 'updateSystemPrompt':
                this._customSystemPrompt = message.prompt || undefined;
                this.outputChannel.appendLine(`[AI Chat] System prompt ${this._customSystemPrompt ? 'customized' : 'reset to default'}`);
                this._view?.webview.postMessage({
                    command: 'systemPromptSaved',
                    isCustom: !!this._customSystemPrompt
                });
                break;
            case 'changeMcpServer':
                await this._changeMcpServer();
                break;
            case 'changeMcpTool':
                await this._changeMcpTool();
                break;
        }
    }

    private _openFeedback() {
        // Open the feedback panel instead of GitHub directly
        vscode.commands.executeCommand('queryStudio.reportIssue');
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

    /**
     * Detect the intended query mode based on keywords in user message
     */
    private _detectIntendedMode(text: string): 'kusto' | 'ado' | 'outlook' | null {
        const lowerText = text.toLowerCase();

        // Email/Outlook keywords
        const outlookKeywords = [
            'email', 'emails', 'mail', 'mails', 'inbox', 'outlook',
            'sent mail', 'sent items', 'drafts', 'unread',
            'from:', 'to:', 'subject:', 'attachment',
            'received', 'sender', 'recipient'
        ];

        // Work item/ADO keywords
        const adoKeywords = [
            'work item', 'work items', 'workitem', 'workitems',
            'bug', 'bugs', 'task', 'tasks', 'user story', 'user stories',
            'feature', 'features', 'epic', 'epics', 'backlog',
            'sprint', 'iteration', 'area path', 'assigned to',
            'wiql', 'azure devops', 'ado', 'devops'
        ];

        // Kusto/KQL keywords
        const kustoKeywords = [
            'kusto', 'kql', 'azure data explorer', 'ade',
            'cluster', 'table', 'summarize', 'where', 'project',
            'logs', 'telemetry', 'metrics', 'traces', 'events'
        ];

        // Count matches for each mode
        let outlookScore = 0;
        let adoScore = 0;
        let kustoScore = 0;

        for (const keyword of outlookKeywords) {
            if (lowerText.includes(keyword)) outlookScore++;
        }
        for (const keyword of adoKeywords) {
            if (lowerText.includes(keyword)) adoScore++;
        }
        for (const keyword of kustoKeywords) {
            if (lowerText.includes(keyword)) kustoScore++;
        }

        // Only suggest mode change if there's a clear winner with at least 1 match
        const maxScore = Math.max(outlookScore, adoScore, kustoScore);
        if (maxScore === 0) return null;

        // Need at least 2x the score of other modes to switch, or the message is clearly about one mode
        if (outlookScore > 0 && outlookScore >= adoScore * 2 && outlookScore >= kustoScore * 2) {
            return 'outlook';
        }
        if (adoScore > 0 && adoScore >= outlookScore * 2 && adoScore >= kustoScore * 2) {
            return 'ado';
        }
        if (kustoScore > 0 && kustoScore >= outlookScore * 2 && kustoScore >= adoScore * 2) {
            return 'kusto';
        }

        return null;
    }

    private async _handleUserMessage(text: string, context?: { includeCurrentQuery?: boolean }) {
        if (this._isProcessing || !text.trim()) return;

        // Detect if user's message suggests a different mode
        // Never auto-switch AWAY from MCP mode — MCP is a meta-layer that can query
        // various data sources (DevOps, GitHub, databases, etc.) whose keywords overlap
        // with other modes. Switching away would silently break MCP query generation.
        if (this._currentMode !== 'mcp') {
            const detectedMode = this._detectIntendedMode(text);
            if (detectedMode && detectedMode !== this._currentMode) {
                // Check if Outlook is supported on this platform
                const isOutlookSupported = process.platform === 'win32';
                if (detectedMode === 'outlook' && !isOutlookSupported) {
                    // Don't auto-switch to Outlook on Mac/Linux
                    this.outputChannel.appendLine(`[AI Chat] Detected Outlook intent but not supported on ${process.platform}`);
                } else {
                    // Auto-switch mode
                    this.outputChannel.appendLine(`[AI Chat] Auto-switching from ${this._currentMode} to ${detectedMode} based on message content`);
                    await vscode.commands.executeCommand('queryStudio.setMode', detectedMode);
                    // Show notification
                    const modeNames: Record<string, string> = { kusto: 'Kusto (KQL)', ado: 'Azure DevOps (WIQL)', outlook: 'Outlook (OQL)' };
                    vscode.window.showInformationMessage(`Switched to ${modeNames[detectedMode]} mode based on your query`);
                }
            }
        }

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

                // Include description and cluster/database in favorites context for AI
                favorites = filteredPresets.map(p => {
                    const desc = p.description ? ` (${p.description})` : '';
                    const clusterInfo = p.clusterUrl ? ` [cluster: ${p.clusterUrl}, db: ${p.database || 'default'}]` : '';
                    return `"${p.name}"${desc}${clusterInfo}: ${p.query.substring(0, 200)}${p.query.length > 200 ? '...' : ''}`;
                });

                const history = await this.client.getHistory(10);
                recentQueries = history
                    .filter(p => p.isAutoSaved)
                    .slice(0, 5)
                    .map(p => p.query.substring(0, 200) + (p.query.length > 200 ? '...' : ''));
            } catch (e) {
                this.outputChannel.appendLine(`[AI Chat] Failed to load favorites/history for context: ${e}`);
            }

            // Get available tables from schema if connected
            let availableTables: string[] | undefined;
            try {
                const conn = getActiveConnection();
                this.outputChannel.appendLine(`[AI Chat] Connection: cluster=${conn.clusterUrl}, db=${conn.database}, mode=${this._currentMode}`);
                if (conn.clusterUrl && conn.database && this._currentMode === 'kusto') {
                    const schema = await this.client.getSchema(conn.clusterUrl, conn.database);
                    this.outputChannel.appendLine(`[AI Chat] Schema fetched: ${schema.tables?.length || 0} tables`);
                    if (schema.tables && schema.tables.length > 0) {
                        availableTables = schema.tables.map(t => t.name);
                        this.outputChannel.appendLine(`[AI Chat] Including tables: ${availableTables.slice(0, 10).join(', ')}...`);
                    }
                } else {
                    this.outputChannel.appendLine(`[AI Chat] Skipping schema: no connection or not kusto mode`);
                }
            } catch (e) {
                this.outputChannel.appendLine(`[AI Chat] Failed to load schema for context: ${e}`);
            }

            // Ensure GitHub token is available via VS Code auth before sending
            const ghToken = await this.ensureGithubToken(false);
            if (ghToken) {
                await this.client.setAiToken(ghToken);
            }

            // Get ADO-specific settings if in ADO mode
            let adoContext: { defaultAreaPath?: string; defaultProject?: string } | undefined;
            if (this._currentMode === 'ado') {
                const adoConfig = vscode.workspace.getConfiguration('queryStudio.ado');
                const defaultAreaPath = adoConfig.get<string>('defaultAreaPath');
                const defaultProject = adoConfig.get<string>('defaultProject');
                if (defaultAreaPath || defaultProject) {
                    adoContext = {
                        defaultAreaPath: defaultAreaPath || undefined,
                        defaultProject: defaultProject || undefined
                    };
                    this.outputChannel.appendLine(`[AI Chat] ADO context: areaPath=${defaultAreaPath}, project=${defaultProject}`);
                }
            }

            // Get MCP tools context if in MCP mode — interactive server/tool selection
            let mcpTools: { serverName: string; toolName: string; description?: string; parameters?: { name: string; type: string; description?: string; required: boolean }[] }[] | undefined;
            if (this._currentMode === 'mcp') {
                // Discover all available MCP tools
                let allMcpTools: typeof mcpTools = [];

                // Strategy 1: Use McpToolDiscovery (reads vscode.lm.tools + sidecar fallback)
                if (this._mcpToolDiscovery) {
                    await this._mcpToolDiscovery.discoverTools();
                    const tools = this._mcpToolDiscovery.tools;
                    if (tools.length > 0) {
                        allMcpTools = tools.map(t => ({
                            serverName: t.serverName,
                            toolName: t.toolName,
                            description: t.description || undefined,
                            parameters: t.parameters.length > 0 ? t.parameters.map(p => ({
                                name: p.name,
                                type: p.type,
                                description: p.description || undefined,
                                required: p.required
                            })) : undefined
                        }));
                    }
                }

                // Strategy 2: Direct sidecar query if discovery yielded nothing
                if (!allMcpTools || allMcpTools.length === 0) {
                    try {
                        const schemaResult = await this.client.getMcpSchema();
                        if (schemaResult?.servers) {
                            const sidecarTools: typeof mcpTools = [];
                            for (const [serverName, serverTools] of Object.entries(schemaResult.servers)) {
                                if (!Array.isArray(serverTools)) continue;
                                for (const tool of serverTools) {
                                    const toolName = tool.name || '';
                                    if (toolName.endsWith('_tools') && (!tool.description || tool.description.length < 50)) {
                                        continue;
                                    }
                                    sidecarTools.push({
                                        serverName,
                                        toolName,
                                        description: tool.description || undefined,
                                        parameters: (tool.parameters || []).map((p: any) => ({
                                            name: p.name || '',
                                            type: p.type || 'string',
                                            description: p.description || undefined,
                                            required: p.required || false
                                        }))
                                    });
                                }
                            }
                            if (sidecarTools.length > 0) {
                                allMcpTools = sidecarTools;
                            }
                        }
                    } catch (e) {
                        this.outputChannel.appendLine(`[AI Chat] Sidecar schema query failed: ${e}`);
                    }
                }

                // Interactive server/tool selection if no scope is pre-selected
                if (allMcpTools && allMcpTools.length > 0) {
                    if (!this._selectedMcpServer) {
                        // First message in MCP mode — guide user through selection
                        const filtered = await this._selectMcpScope(allMcpTools);
                        if (!filtered) {
                            // User cancelled — abort the message
                            this._messages.pop(); // Remove the user message we already pushed
                            return;
                        }
                        mcpTools = filtered;
                    } else {
                        // Server already selected — apply filter
                        let filtered = allMcpTools.filter(t => t.serverName === this._selectedMcpServer);
                        if (this._selectedMcpTool) {
                            filtered = filtered.filter(t => t.toolName === this._selectedMcpTool);
                        }
                        mcpTools = filtered.length > 0 ? filtered : allMcpTools;
                    }
                }

                // Log diagnostic info
                const mcpToolCount = mcpTools?.length || 0;
                const allToolCount = allMcpTools?.length || 0;
                const lmToolCount = vscode.lm?.tools?.length ?? 0;
                const mcpPrefixedCount = vscode.lm?.tools?.filter((t: any) => t.name.startsWith('mcp_')).length ?? 0;
                this.outputChannel.appendLine(`[AI Chat] MCP tools: ${mcpToolCount} selected (of ${allToolCount} total) | Server: ${this._selectedMcpServer || 'All'} | Tool: ${this._selectedMcpTool || 'All'} | vscode.lm.tools: ${lmToolCount} total, ${mcpPrefixedCount} mcp_`);

                if (mcpTools && mcpTools.length > 0) {
                    const servers = [...new Set(mcpTools.map(t => t.serverName))];
                    this.outputChannel.appendLine(`[AI Chat] Sending tools from servers: ${servers.join(', ')}`);
                } else {
                    this.outputChannel.appendLine(`[AI Chat] WARNING: No MCP tools to send`);
                }
            }

            const personaPrompt = this._getPersonaPrompt();
            let response = await this.client.aiChat({
                message: text,
                mode: this._currentMode,
                sessionId: this._sessionId,
                context: {
                    currentQuery,
                    availableTables: availableTables,
                    favorites: favorites.length > 0 ? favorites : undefined,
                    recentQueries: recentQueries.length > 0 ? recentQueries : undefined,
                    personaInstructions: personaPrompt,
                    systemPromptOverride: this._customSystemPrompt,
                    adoContext,
                    mcpTools
                }
            });

            // If auth required, prompt VS Code sign-in and retry once
            if (response.authRequired) {
                this.outputChannel.appendLine('[AI Chat] Auth required, prompting VS Code GitHub sign-in');
                const token = await this.ensureGithubToken(true);
                if (token) {
                    await this.client.setAiToken(token);
                    response = await this.client.aiChat({
                        message: text,
                        mode: this._currentMode,
                        sessionId: this._sessionId,
                        context: {
                            currentQuery,
                            availableTables: availableTables,
                            favorites: favorites.length > 0 ? favorites : undefined,
                            recentQueries: recentQueries.length > 0 ? recentQueries : undefined,
                            personaInstructions: personaPrompt,
                            systemPromptOverride: this._customSystemPrompt,
                            adoContext,
                            mcpTools
                        }
                    });
                } else {
                    throw new Error('GitHub sign-in is required for AI chat. Please sign in to GitHub in VS Code.');
                }
            }

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
        const codeBlockRegex = /```(?:kql|kusto|wiql|oql|outlook|mcpql|mcp)?\s*([\s\S]*?)```/gi;
        const matches = [...text.matchAll(codeBlockRegex)];

        if (matches.length > 0) {
            return matches[matches.length - 1][1].trim();
        }

        return undefined;
    }

    private _updateView() {
        if (!this._view) return;
        const personaInfo = this._getPersonaInfo();
        this._view.webview.postMessage({
            command: 'updateMessages',
            messages: this._messages,
            modeDisplayName: this._getModeDisplayName(),
            modeIcon: this._getModeIcon(),
            suggestions: this._suggestions,
            persona: personaInfo
        });
        this._updateContextBar();
        this._updateMcpContextChips();
    }

    private async _updateContextBar() {
        if (!this._view) return;
        try {
            const editor = vscode.window.activeTextEditor;
            const queryLanguages = ['kql', 'wiql', 'oql', 'mcpql'];
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
        .persona-selector {
            display: flex;
            align-items: center;
            gap: 2px;
        }
        .persona-btn {
            background: var(--vscode-editor-inactiveSelectionBackground);
            color: var(--vscode-foreground);
            border: 1px solid var(--vscode-panel-border);
            padding: 3px 10px;
            border-radius: 12px 0 0 12px;
            cursor: pointer;
            font-size: 10px;
            font-weight: 500;
            transition: background 0.1s;
            display: flex;
            align-items: center;
            gap: 5px;
        }
        .persona-btn:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        .persona-btn.active {
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            border-color: var(--vscode-badge-background);
        }
        .persona-icon {
            font-size: 12px;
        }
        .persona-name {
            max-width: 80px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .persona-settings-btn {
            background: var(--vscode-editor-inactiveSelectionBackground);
            color: var(--vscode-foreground);
            border: 1px solid var(--vscode-panel-border);
            border-left: none;
            padding: 3px 6px;
            border-radius: 0 12px 12px 0;
            cursor: pointer;
            font-size: 10px;
            transition: background 0.1s;
        }
        .persona-settings-btn:hover {
            background: var(--vscode-button-secondaryHoverBackground);
            color: var(--vscode-textLink-foreground);
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
        .mcp-chip {
            background: var(--vscode-textLink-foreground, #3794ff);
            color: #fff;
            font-weight: 500;
        }
        .mcp-chip:hover {
            opacity: 0.85;
        }
        .mcp-chip.has-selection {
            background: var(--vscode-testing-iconPassed, #4caf50);
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
        .system-prompt-chip {
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
            margin-left: auto;
        }
        .system-prompt-chip:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        .system-prompt-chip.custom {
            background: var(--vscode-testing-iconPassed, #4caf50);
        }
        .system-prompt-panel {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: var(--vscode-dropdown-background);
            border: none;
            z-index: 100;
            flex-direction: column;
        }
        .system-prompt-panel.visible {
            display: flex;
        }
        .system-prompt-panel-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 6px 10px;
            font-size: 10px;
            font-weight: 600;
            color: var(--vscode-foreground);
            border-bottom: 1px solid var(--vscode-panel-border);
            background: var(--vscode-sideBarSectionHeader-background);
        }
        .system-prompt-panel-header .sp-actions {
            display: flex;
            gap: 4px;
        }
        .system-prompt-panel-header button {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: none;
            padding: 2px 8px;
            border-radius: 2px;
            font-size: 10px;
            cursor: pointer;
        }
        .system-prompt-panel-header button:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        .system-prompt-panel-header button.primary {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        .system-prompt-textarea {
            flex: 1;
            padding: 8px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: none;
            font-family: var(--vscode-editor-font-family);
            font-size: 11px;
            line-height: 1.4;
            resize: none;
            outline: none;
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
            <div class="persona-selector">
                <button class="persona-btn" id="personaBtn" onclick="selectPersona()" title="Click to change AI persona">
                    <span class="persona-icon">🤖</span>
                    <span class="persona-name">Default</span>
                </button>
                <button class="persona-settings-btn" onclick="managePersonas()" title="Create or manage AI personas">⚙</button>
            </div>
            <button class="new-chat-btn" onclick="clearChat()" title="Start a new chat conversation">+ New</button>
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
        <div class="context-chip-wrapper mcp-chip-wrapper" id="mcpServerChipWrapper" style="display:none">
            <span class="context-chip mcp-chip" id="mcpServerChip" onclick="changeMcpServer()" title="Click to change MCP server">Server: All</span>
        </div>
        <div class="context-chip-wrapper mcp-chip-wrapper" id="mcpToolChipWrapper" style="display:none">
            <span class="context-chip mcp-chip" id="mcpToolChip" onclick="changeMcpTool()" title="Click to change MCP tool">Tool: All</span>
        </div>
        <div class="context-chip-wrapper" style="margin-left:auto">
            <span class="system-prompt-chip" id="systemPromptChip" onclick="toggleSystemPrompt()" title="View or customize the AI system prompt">System Prompt</span>
            <div class="system-prompt-panel" id="systemPromptPanel">
                <div class="system-prompt-panel-header">
                    <span>System Prompt</span>
                    <div class="sp-actions">
                        <button onclick="resetSystemPrompt()" title="Reset to default">Reset</button>
                        <button class="primary" onclick="saveSystemPrompt()">Save</button>
                    </div>
                </div>
                <textarea class="system-prompt-textarea" id="systemPromptTextarea" placeholder="Loading..."></textarea>
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
            Send Feedback (Ctrl+Shift+B)
        </span>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let messages = [];
        let isTyping = false;
        let modeDisplayName = 'KQL (Kusto Query Language)';
        let modeIcon = 'K';
        let suggestions = [];
        let currentPersona = null;
        let systemPromptDefault = '';

        window.addEventListener('message', event => {
            const msg = event.data;
            switch (msg.command) {
                case 'updateMessages':
                    messages = msg.messages;
                    if (msg.modeDisplayName) modeDisplayName = msg.modeDisplayName;
                    if (msg.modeIcon) modeIcon = msg.modeIcon;
                    if (msg.suggestions) suggestions = msg.suggestions;
                    currentPersona = msg.persona || null;
                    updatePersonaButton();
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
                case 'systemPrompt':
                    systemPromptDefault = msg.defaultPrompt || '';
                    document.getElementById('systemPromptTextarea').value = msg.prompt || '';
                    updateSystemPromptChip(msg.isCustom);
                    break;
                case 'systemPromptSaved':
                    updateSystemPromptChip(msg.isCustom);
                    break;
                case 'updateMcpContext':
                    updateMcpChips(msg.isMcpMode, msg.server, msg.tool);
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

            document.getElementById('systemPromptPanel').classList.remove('visible');
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
            document.getElementById('systemPromptPanel').classList.remove('visible');
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

        function selectPersona() {
            vscode.postMessage({ command: 'selectPersona' });
        }

        function updatePersonaButton() {
            const btn = document.getElementById('personaBtn');
            if (!btn) return;
            const iconSpan = btn.querySelector('.persona-icon');
            const nameSpan = btn.querySelector('.persona-name');
            if (currentPersona && currentPersona.name) {
                if (nameSpan) nameSpan.textContent = currentPersona.name;
                if (iconSpan) iconSpan.textContent = '✨';
                btn.classList.add('active');
                btn.title = 'Current persona: ' + currentPersona.name + '. Click to change.';
            } else {
                if (nameSpan) nameSpan.textContent = 'Default';
                if (iconSpan) iconSpan.textContent = '🤖';
                btn.classList.remove('active');
                btn.title = 'Click to select an AI persona';
            }
        }

        function managePersonas() {
            vscode.postMessage({ command: 'managePersonas' });
        }

        function toggleSystemPrompt() {
            const panel = document.getElementById('systemPromptPanel');
            closeAllDropdowns();
            if (panel.classList.contains('visible')) {
                panel.classList.remove('visible');
            } else {
                vscode.postMessage({ command: 'getSystemPrompt' });
                panel.classList.add('visible');
            }
        }

        function saveSystemPrompt() {
            const text = document.getElementById('systemPromptTextarea').value.trim();
            const isDefault = text === systemPromptDefault.trim();
            vscode.postMessage({ command: 'updateSystemPrompt', prompt: isDefault ? '' : text });
            document.getElementById('systemPromptPanel').classList.remove('visible');
        }

        function resetSystemPrompt() {
            document.getElementById('systemPromptTextarea').value = systemPromptDefault;
            vscode.postMessage({ command: 'updateSystemPrompt', prompt: '' });
        }

        function updateSystemPromptChip(isCustom) {
            const chip = document.getElementById('systemPromptChip');
            chip.classList.toggle('custom', isCustom);
            chip.title = isCustom ? 'System prompt customized - click to edit' : 'View or customize the AI system prompt';
        }

        function updateMcpChips(isMcpMode, server, tool) {
            const serverWrapper = document.getElementById('mcpServerChipWrapper');
            const toolWrapper = document.getElementById('mcpToolChipWrapper');
            const serverChip = document.getElementById('mcpServerChip');
            const toolChip = document.getElementById('mcpToolChip');

            if (!isMcpMode) {
                serverWrapper.style.display = 'none';
                toolWrapper.style.display = 'none';
                return;
            }

            serverWrapper.style.display = '';
            toolWrapper.style.display = '';

            if (server) {
                serverChip.textContent = 'Server: ' + server;
                serverChip.classList.add('has-selection');
                serverChip.title = 'MCP Server: ' + server + ' (click to change)';
            } else {
                serverChip.textContent = 'Server: All';
                serverChip.classList.remove('has-selection');
                serverChip.title = 'Click to select an MCP server';
            }

            if (tool) {
                toolChip.textContent = 'Tool: ' + tool;
                toolChip.classList.add('has-selection');
                toolChip.title = 'MCP Tool: ' + tool + ' (click to change)';
            } else {
                toolChip.textContent = 'Tool: All';
                toolChip.classList.remove('has-selection');
                toolChip.title = 'Click to select a specific MCP tool';
            }
        }

        function changeMcpServer() {
            vscode.postMessage({ command: 'changeMcpServer' });
        }

        function changeMcpTool() {
            vscode.postMessage({ command: 'changeMcpTool' });
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
                    <button class="primary query-btn" data-action="run" data-query="\${encodedQuery}" data-cluster="\${encodedCluster}" data-database="\${encodedDb}">▶ Run</button>
                    <button class="query-btn" data-action="apply" data-query="\${encodedQuery}" data-cluster="\${encodedCluster}" data-database="\${encodedDb}">Use</button>
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
                case 'run':
                    vscode.postMessage({ command: 'runQuery', query: query, cluster: clusterUrl, database: database });
                    break;
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
