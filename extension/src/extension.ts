import * as vscode from 'vscode';
import { SidecarManager } from './sidecar/SidecarManager';
import { ClusterTreeProvider } from './providers/ClusterTreeProvider';
import { FavoritesWebViewProvider } from './providers/FavoritesWebViewProvider';
import { HistoryWebViewProvider } from './providers/HistoryWebViewProvider';
import { ResultsWebViewProvider } from './providers/ResultsWebViewProvider';
import { ResultsHistoryWebViewProvider } from './providers/ResultsHistoryWebViewProvider';
import { SnippetsWebViewProvider } from './providers/SnippetsWebViewProvider';
import { AIChatViewProvider } from './providers/AIChatViewProvider';
import { FeedbackPanel } from './providers/FeedbackPanel';
import { registerQueryCommands, resetActiveConnection, setActiveQueryType } from './commands/queryCommands';
import { registerClusterCommands } from './commands/clusterCommands';
import { registerAiCommands } from './commands/aiCommands';
import { registerKqlLanguage } from './languages/kql/kqlLanguage';
import { registerWiqlLanguage } from './languages/wiql/wiqlLanguage';
import { registerOqlLanguage } from './languages/oql/oqlLanguage';
import { parseData, isValidTableData } from './utils/dataParser';
import * as fs from 'fs';
import * as path from 'path';

let sidecar: SidecarManager;
let outputChannel: vscode.OutputChannel;
let modeStatusBarItem: vscode.StatusBarItem;
let connectionStatusBarItem: vscode.StatusBarItem;
let shortcutsStatusBarItem: vscode.StatusBarItem;
let logStatusBarItem: vscode.StatusBarItem;
let currentMode: 'kusto' | 'ado' | 'outlook' = 'kusto';
let queryCounter = 0;
let resultsProviderInstance: ResultsWebViewProvider;

// Export for use by other modules
export function getCurrentMode(): 'kusto' | 'ado' | 'outlook' {
    return currentMode;
}

export function setCurrentMode(mode: 'kusto' | 'ado' | 'outlook') {
    currentMode = mode;
    // Set context for when clauses in package.json
    vscode.commands.executeCommand('setContext', 'queryStudio.mode', mode);
    vscode.commands.executeCommand('setContext', 'queryStudio.isOutlookMode', mode === 'outlook');
}

export function updateConnectionStatus(connected: boolean) {
    if (!connectionStatusBarItem) return;

    if (connected) {
        connectionStatusBarItem.text = '$(plug) Connected';
        connectionStatusBarItem.backgroundColor = undefined;
        connectionStatusBarItem.tooltip = 'Quest server is running';
    } else {
        connectionStatusBarItem.text = '$(debug-disconnect) Disconnected';
        connectionStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        connectionStatusBarItem.tooltip = 'Quest server is not running. Click to restart.';
    }
}

export function updateSchemaStatus(_tableCount: number, _database?: string) {
    // Schema status moved to Data Sources view - this is now a no-op
    // Kept for backwards compatibility with clusterCommands.ts calls
}

/**
 * Find a visible KQL, WIQL, or OQL editor, prioritizing the active editor
 */
function findQueryEditor(): vscode.TextEditor | undefined {
    const queryLanguages = ['kql', 'wiql', 'oql'];

    // First try the active editor
    const active = vscode.window.activeTextEditor;
    if (active && queryLanguages.includes(active.document.languageId)) {
        return active;
    }

    // Then look for any visible query editor
    for (const editor of vscode.window.visibleTextEditors) {
        if (queryLanguages.includes(editor.document.languageId)) {
            return editor;
        }
    }

    // Finally try any untitled document
    for (const editor of vscode.window.visibleTextEditors) {
        if (editor.document.isUntitled) {
            return editor;
        }
    }

    return undefined;
}

export async function activate(context: vscode.ExtensionContext) {
    outputChannel = vscode.window.createOutputChannel('Quest');
    outputChannel.appendLine('Quest is starting...');

    // Set initial context for when clauses
    setCurrentMode(currentMode);

    // Start sidecar initialization (don't await yet - let it run in parallel)
    sidecar = new SidecarManager(context, outputChannel);
    const sidecarPromise = sidecar.start().then(() => {
        outputChannel.appendLine('Sidecar started successfully');
    });

    // Register providers immediately (they handle missing client gracefully)
    const clusterProvider = new ClusterTreeProvider(sidecar.client);
    const favoritesProvider = new FavoritesWebViewProvider(context.extensionUri, sidecar.client);
    const historyProvider = new HistoryWebViewProvider(context.extensionUri, sidecar.client);
    const resultsHistoryProvider = new ResultsHistoryWebViewProvider(context.extensionUri, sidecar.client);
    const snippetsProvider = new SnippetsWebViewProvider(context.extensionUri, context);
    const aiChatProvider = new AIChatViewProvider(context.extensionUri, sidecar.client, outputChannel, context);
    const resultsProvider = new ResultsWebViewProvider(context.extensionUri, context);
    resultsProviderInstance = resultsProvider;

    // Register all view providers synchronously (fast, no I/O)
    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('querystudio.clusters', clusterProvider),
        vscode.window.registerWebviewViewProvider(FavoritesWebViewProvider.viewType, favoritesProvider),
        vscode.window.registerWebviewViewProvider(HistoryWebViewProvider.viewType, historyProvider),
        vscode.window.registerWebviewViewProvider(ResultsHistoryWebViewProvider.viewType, resultsHistoryProvider),
        vscode.window.registerWebviewViewProvider(SnippetsWebViewProvider.viewType, snippetsProvider),
        vscode.window.registerWebviewViewProvider(AIChatViewProvider.viewType, aiChatProvider, { webviewOptions: { retainContextWhenHidden: true } }),
        vscode.window.registerWebviewViewProvider(ResultsWebViewProvider.viewType, resultsProvider, { webviewOptions: { retainContextWhenHidden: true } })
    );

    // Set up callbacks (fast, no I/O)
    resultsHistoryProvider.setOnViewResult((item) => {
        const result = {
            success: item.success,
            columns: item.columns || [],
            rows: item.sampleRows || [],
            rowCount: item.rowCount,
            executionTimeMs: item.executionTimeMs,
            error: item.error
        };
        resultsProvider.showResults(result, item.title, item.query, item.clusterUrl, item.database, item.type as 'kusto' | 'ado' | 'outlook');
    });

    aiChatProvider.setOnInsertQuery(async (query) => {
        const editor = findQueryEditor();
        if (editor) {
            await editor.edit(editBuilder => {
                editBuilder.insert(editor.selection.active, query);
            });
        } else {
            const doc = await vscode.workspace.openTextDocument({ content: query, language: 'kql' });
            await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
        }
    });

    aiChatProvider.setOnApplyQuery(async (query, cluster, database) => {
        const editor = findQueryEditor();
        if (editor) {
            const fullRange = new vscode.Range(
                editor.document.positionAt(0),
                editor.document.positionAt(editor.document.getText().length)
            );
            await editor.edit(editBuilder => {
                editBuilder.replace(fullRange, query);
            });
        } else {
            const doc = await vscode.workspace.openTextDocument({ content: query, language: 'kql' });
            await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
        }

        // Also select the cluster if provided
        if (cluster && database) {
            const clusters = await sidecar.client.getClusters();
            const matchingCluster = clusters.find(c =>
                c.url.toLowerCase() === cluster.toLowerCase() &&
                c.database.toLowerCase() === database.toLowerCase()
            );
            if (matchingCluster) {
                await vscode.commands.executeCommand('queryStudio.setActiveCluster', matchingCluster);
            }
        }
    });

    // Handle cluster selection from AI chat
    aiChatProvider.setOnSelectCluster(async (clusterUrl, database) => {
        // Check if this cluster exists in our data sources
        const clusters = await sidecar.client.getClusters();
        const matchingCluster = clusters.find(c =>
            c.url.toLowerCase() === clusterUrl.toLowerCase() &&
            c.database.toLowerCase() === database.toLowerCase()
        );

        if (matchingCluster) {
            // Select the existing cluster
            await vscode.commands.executeCommand('queryStudio.setActiveCluster', matchingCluster);
            vscode.window.showInformationMessage(`Selected ${matchingCluster.name} / ${matchingCluster.database}`);
        } else {
            // Cluster doesn't exist - offer options
            const choice = await vscode.window.showQuickPick([
                { label: '$(add) Add to Data Sources', value: 'add', description: 'Save this cluster for future use' },
                { label: '$(code) Add cluster() to Query', value: 'prefix', description: 'Prefix query with cluster().database()' }
            ], { placeHolder: `Cluster "${clusterUrl}" not found in data sources` });

            if (choice?.value === 'add') {
                // Extract cluster name from URL
                let clusterName = clusterUrl;
                try {
                    const uri = new URL(clusterUrl);
                    clusterName = uri.hostname.split('.')[0];
                } catch { }

                const newCluster = {
                    id: Date.now().toString(),
                    name: clusterName,
                    url: clusterUrl,
                    database: database,
                    type: 'kusto' as const,
                    isFavorite: false
                };
                await sidecar.client.addCluster(newCluster);
                clusterProvider.refresh();
                await vscode.commands.executeCommand('queryStudio.setActiveCluster', newCluster);
                vscode.window.showInformationMessage(`Added and selected ${clusterName} / ${database}`);
            } else if (choice?.value === 'prefix') {
                // Add cluster().database() prefix to the current query
                const editor = findQueryEditor();
                if (editor) {
                    const currentText = editor.document.getText();
                    const prefix = `cluster('${clusterUrl}').database('${database}')\n`;
                    await editor.edit(editBuilder => {
                        editBuilder.insert(new vscode.Position(0, 0), prefix);
                    });
                }
            }
        }
    });

    // Register AI Chat command
    context.subscriptions.push(
        vscode.commands.registerCommand('queryStudio.aiChat', async () => {
            aiChatProvider.setMode(currentMode);
            await vscode.commands.executeCommand('workbench.view.extension.queryStudio');
            try {
                await vscode.commands.executeCommand('querystudio.aiChat.focus');
            } catch {
                // View might already be focused
            }
            aiChatProvider.reveal();
        })
    );

    // Register URI handler for external data viewing
    // Usage: code --open-url "vscode://inbar-rotem.quest/view?file=/path/to/data.json"
    // Usage: code --open-url "vscode://inbar-rotem.quest/view?data=base64encodeddata"
    context.subscriptions.push(
        vscode.window.registerUriHandler({
            handleUri(uri: vscode.Uri): vscode.ProviderResult<void> {
                outputChannel.appendLine(`[URI Handler] Received: ${uri.toString()}`);

                if (uri.path === '/view') {
                    const params = new URLSearchParams(uri.query);
                    const filePath = params.get('file');
                    const base64Data = params.get('data');
                    const title = params.get('title') || 'External Data';

                    if (filePath) {
                        // Load from file
                        vscode.commands.executeCommand('queryStudio.openTableFromFile', filePath, title);
                    } else if (base64Data) {
                        // Decode base64 data
                        try {
                            const data = Buffer.from(base64Data, 'base64').toString('utf-8');
                            showExternalData(data, title);
                        } catch (error) {
                            vscode.window.showErrorMessage('Failed to decode data from URL');
                            outputChannel.appendLine(`[URI Handler] Failed to decode base64: ${error}`);
                        }
                    } else {
                        vscode.window.showWarningMessage('No data provided in URL. Use ?file= or ?data=');
                    }
                }
            }
        })
    );

    // Register paste as table command
    context.subscriptions.push(
        vscode.commands.registerCommand('queryStudio.pasteAsTable', async () => {
            const clipboardText = await vscode.env.clipboard.readText();

            if (!clipboardText.trim()) {
                vscode.window.showWarningMessage('Clipboard is empty');
                return;
            }

            if (!isValidTableData(clipboardText)) {
                const proceed = await vscode.window.showWarningMessage(
                    'Clipboard content may not be valid table data (JSON array or CSV). Try anyway?',
                    'Try Anyway', 'Cancel'
                );
                if (proceed !== 'Try Anyway') {
                    return;
                }
            }

            showExternalData(clipboardText, 'Pasted Data');
        })
    );

    // Register open file as table command
    context.subscriptions.push(
        vscode.commands.registerCommand('queryStudio.openTableFromFile', async (filePath?: string, title?: string) => {
            let targetPath = filePath;

            if (!targetPath) {
                // Show file picker
                const fileUri = await vscode.window.showOpenDialog({
                    canSelectFiles: true,
                    canSelectFolders: false,
                    canSelectMany: false,
                    filters: {
                        'Data Files': ['json', 'csv', 'tsv', 'txt'],
                        'All Files': ['*']
                    },
                    title: 'Select a data file to view as table'
                });

                if (!fileUri || fileUri.length === 0) {
                    return;
                }

                targetPath = fileUri[0].fsPath;
            }

            try {
                const data = fs.readFileSync(targetPath, 'utf-8');
                const fileName = title || path.basename(targetPath);
                showExternalData(data, fileName);
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Unknown error';
                vscode.window.showErrorMessage(`Failed to read file: ${message}`);
                outputChannel.appendLine(`[Open File] Error: ${message}`);
            }
        })
    );

    // Helper function to show external data in results panel
    function showExternalData(data: string, title: string) {
        try {
            const parsed = parseData(data);

            if (parsed.columns.length === 0) {
                vscode.window.showWarningMessage('No data to display');
                return;
            }

            const result = {
                success: true,
                columns: parsed.columns,
                rows: parsed.rows,
                rowCount: parsed.rowCount,
                executionTimeMs: 0
            };

            resultsProvider.showResults(result, title, undefined, undefined, undefined, 'kusto');
            outputChannel.appendLine(`[External Data] Displayed ${parsed.rowCount} rows with ${parsed.columns.length} columns`);
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            vscode.window.showErrorMessage(`Failed to parse data: ${message}`);
            outputChannel.appendLine(`[External Data] Parse error: ${message}`);
        }
    }

    // Set up save as preset callback
    resultsProvider.setOnSaveAsPreset(async (query, title) => {
        const name = await vscode.window.showInputBox({
            prompt: 'Enter a name for this favorite',
            value: title.replace(/\s*\[\d+\]$/, ''),
            placeHolder: 'My Query'
        });
        if (name) {
            try {
                await sidecar.client.savePreset({
                    id: Date.now().toString(),
                    name: name,
                    query: query,
                    type: 'kusto',
                    createdAt: new Date().toISOString(),
                    isAutoSaved: false
                });
                vscode.window.showInformationMessage(`Query saved as "${name}"`);
                favoritesProvider.refresh();
            } catch (error) {
                vscode.window.showErrorMessage('Failed to save favorite');
            }
        }
    });

    // Register commands (fast, no I/O)
    registerQueryCommands(context, sidecar.client, resultsProvider, outputChannel, clusterProvider, resultsHistoryProvider);
    registerClusterCommands(context, sidecar.client, clusterProvider, (cluster) => {
        // Update AI chat with the new active cluster
        aiChatProvider.setActiveCluster(cluster.url, cluster.database, cluster.name, cluster.type);
    });
    registerAiCommands(context, sidecar.client, outputChannel, aiChatProvider);

    // Register language features (fast, no I/O)
    registerKqlLanguage(context, sidecar.client);
    registerWiqlLanguage(context, sidecar.client);
    registerOqlLanguage(context, sidecar.client);

    // Register all commands immediately (don't block on sidecar)
    // Commands will handle not-ready state gracefully

    // Register refresh commands
    context.subscriptions.push(
        vscode.commands.registerCommand('queryStudio.refreshFavorites', () => {
            favoritesProvider.refresh();
        }),
        vscode.commands.registerCommand('queryStudio.refreshHistory', () => {
            historyProvider.refresh();
        }),
        vscode.commands.registerCommand('queryStudio.refreshResultsHistory', () => {
            resultsHistoryProvider.refresh();
        }),
        vscode.commands.registerCommand('queryStudio.clearHistory', async () => {
            const confirm = await vscode.window.showWarningMessage(
                'Clear all query history?',
                { modal: true },
                'Clear'
            );
            if (confirm === 'Clear') {
                try {
                    const result = await sidecar.client.clearHistory();
                    vscode.window.showInformationMessage(`Cleared ${result.cleared} history items`);
                    historyProvider.refresh();
                } catch (error) {
                    const message = error instanceof Error ? error.message : 'Unknown error';
                    vscode.window.showErrorMessage(`Failed to clear history: ${message}`);
                }
            }
        }),
        vscode.commands.registerCommand('queryStudio.refreshSnippets', () => {
            snippetsProvider.setMode(currentMode); // Triggers refresh
        }),
        vscode.commands.registerCommand('queryStudio.insertSnippet', async () => {
            const snippets = snippetsProvider.getSnippetsForMode(currentMode);
            const items = snippets.map(s => ({
                label: s.name,
                description: s.category,
                detail: s.description,
                snippet: s
            }));

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select a snippet to insert',
                matchOnDescription: true,
                matchOnDetail: true
            });

            if (selected) {
                const editor = vscode.window.activeTextEditor;
                if (editor) {
                    const snippetString = new vscode.SnippetString(selected.snippet.code);
                    await editor.insertSnippet(snippetString);
                }
            }
        }),
        vscode.commands.registerCommand('queryStudio.saveSnippet', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('No active editor');
                return;
            }

            const selection = editor.selection;
            const selectedText = !selection.isEmpty
                ? editor.document.getText(selection)
                : '';

            const name = await vscode.window.showInputBox({
                prompt: 'Snippet name',
                placeHolder: 'e.g., My Custom Query'
            });
            if (!name) return;

            const description = await vscode.window.showInputBox({
                prompt: 'Snippet description',
                placeHolder: 'e.g., Filters active items by date'
            });
            if (!description) return;

            const code = await vscode.window.showInputBox({
                prompt: 'Snippet code (use ${1:placeholder} for placeholders)',
                value: selectedText,
                placeHolder: '| where Column == "${1:value}"'
            });
            if (!code) return;

            const lang = currentMode === 'kusto' ? 'kql' : currentMode === 'ado' ? 'wiql' : 'oql';
            await snippetsProvider.addCustomSnippet({
                name,
                description,
                code,
                category: 'Custom',
                language: lang
            });

            vscode.window.showInformationMessage(`Snippet "${name}" saved!`);
        })
    );

    // Check if Outlook mode is supported (Windows only - requires COM interop)
    const isOutlookSupported = process.platform === 'win32';

    // Register mode toggle command - shows quick pick to select mode
    context.subscriptions.push(
        vscode.commands.registerCommand('queryStudio.toggleMode', async () => {
            const modes: { label: string; description: string; mode: 'kusto' | 'ado' | 'outlook' }[] = [
                { label: 'Ⓚ Kusto (KQL)', description: 'Query KQL', mode: 'kusto' },
                { label: 'Ⓐ Azure DevOps (WIQL)', description: 'Query work items', mode: 'ado' },
            ];

            // Only add Outlook option on Windows
            if (isOutlookSupported) {
                modes.push({ label: '📧 Outlook (OQL)', description: 'Query mails', mode: 'outlook' });
            } else {
                modes.push({ label: '📧 Outlook (OQL)', description: '⚠️ Windows only', mode: 'outlook' });
            }

            // Mark current mode
            const items = modes.map(m => ({
                ...m,
                description: m.mode === currentMode ? `${m.description} (current)` : m.description
            }));

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select query mode',
                title: 'Quest Mode'
            });

            if (!selected || selected.mode === currentMode) {
                return;
            }

            // Check if trying to use Outlook on non-Windows
            if (selected.mode === 'outlook' && !isOutlookSupported) {
                vscode.window.showWarningMessage(
                    'Outlook mode requires Windows with Microsoft Outlook installed. It uses COM interop which is not available on macOS/Linux.',
                    'OK'
                );
                return;
            }

            const newMode = selected.mode;
            setCurrentMode(newMode);
            updateModeStatusBar(newMode);

            // Reset active connection and set new query type
            resetActiveConnection();
            setActiveQueryType(newMode);

            // Create a new empty file with the correct language for the mode
            const newLang = newMode === 'kusto' ? 'kql' : newMode === 'ado' ? 'wiql' : 'oql';
            const ext = newMode === 'kusto' ? '.kql' : newMode === 'ado' ? '.wiql' : '.oql';

            // Generate a simple query name
            const queryNumber = ++queryCounter;
            const fileName = `Query ${queryNumber}${ext}`;

            // Create file in scratch directory
            const scratchDir = context.globalStorageUri;
            await vscode.workspace.fs.createDirectory(scratchDir);
            const fileUri = vscode.Uri.joinPath(scratchDir, fileName);

            // Write empty content
            await vscode.workspace.fs.writeFile(fileUri, Buffer.from('', 'utf-8'));

            const doc = await vscode.workspace.openTextDocument(fileUri);
            await vscode.languages.setTextDocumentLanguage(doc, newLang);
            await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);

            // Ensure sidecar is running before refreshing providers
            try {
                await sidecar.ensureRunning();
            } catch (error) {
                outputChannel.appendLine(`Warning: Sidecar not available: ${error}`);
            }

            clusterProvider.setMode(newMode);
            favoritesProvider.setMode(newMode);
            historyProvider.setMode(newMode);
            resultsHistoryProvider.setMode(newMode);
            snippetsProvider.setMode(newMode);

            // Update AI chat view provider
            aiChatProvider.setMode(newMode);
            outputChannel.appendLine(`Switched to ${newMode.toUpperCase()} mode`);
        }),
        vscode.commands.registerCommand('queryStudio.setMode', async (mode: 'kusto' | 'ado' | 'outlook') => {
            // Check if trying to use Outlook on non-Windows
            if (mode === 'outlook' && !isOutlookSupported) {
                vscode.window.showWarningMessage(
                    'Outlook mode requires Windows with Microsoft Outlook installed.',
                    'OK'
                );
                return;
            }

            setCurrentMode(mode);
            updateModeStatusBar(mode);

            // Reset active connection and set new query type
            resetActiveConnection();
            setActiveQueryType(mode);

            // Change the language of the active editor to match the mode
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                const currentLang = editor.document.languageId;
                const queryLanguages = ['kql', 'wiql', 'oql', 'plaintext'];
                if (queryLanguages.includes(currentLang) || editor.document.isUntitled) {
                    const newLang = mode === 'kusto' ? 'kql' : mode === 'ado' ? 'wiql' : 'oql';
                    await vscode.languages.setTextDocumentLanguage(editor.document, newLang);
                }
            }

            // Ensure sidecar is running before refreshing providers
            try {
                await sidecar.ensureRunning();
            } catch (error) {
                outputChannel.appendLine(`Warning: Sidecar not available: ${error}`);
            }

            clusterProvider.setMode(mode);
            favoritesProvider.setMode(mode);
            historyProvider.setMode(mode);
            resultsHistoryProvider.setMode(mode);
            snippetsProvider.setMode(mode);

            // Update AI chat view provider
            aiChatProvider.setMode(mode);
            outputChannel.appendLine(`Set to ${mode.toUpperCase()} mode`);
        }),
        vscode.commands.registerCommand('queryStudio.newOqlFile', async () => {
            // Check if Outlook is supported on this platform
            if (!isOutlookSupported) {
                vscode.window.showWarningMessage(
                    'Outlook queries require Windows with Microsoft Outlook installed.',
                    'OK'
                );
                return;
            }

            const doc = await vscode.workspace.openTextDocument({
                content: 'Inbox\n| take 100\n',
                language: 'oql'
            });
            await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
        }),
        // Quest indicator button - focuses the sidebar
        vscode.commands.registerCommand('queryStudio.showPanel', async () => {
            await vscode.commands.executeCommand('workbench.view.extension.queryStudio');
        }),
        // Welcome walkthrough command
        vscode.commands.registerCommand('queryStudio.welcome', async () => {
            // Try full qualified ID first, then fallback
            try {
                await vscode.commands.executeCommand('workbench.action.openWalkthrough', 'inbar-rotem.query-studio#queryStudio.welcome', false);
            } catch {
                // Fallback to just the walkthrough ID
                await vscode.commands.executeCommand('workbench.action.openWalkthrough', 'queryStudio.welcome', false);
            }
        }),
        vscode.commands.registerCommand('queryStudio.showExample', async () => {
            const examples: Record<string, { label: string; query: string }[]> = {
                kusto: [
                    { label: 'Basic query with filter', query: '// Basic query - filter and project\nTableName\n| where TimeGenerated > ago(1h)\n| project Column1, Column2, Column3\n| take 100' },
                    { label: 'Aggregation with count', query: '// Count by category\nTableName\n| where TimeGenerated > ago(24h)\n| summarize Count = count() by Category\n| order by Count desc' },
                    { label: 'Time chart', query: '// Time series chart\nTableName\n| where TimeGenerated > ago(7d)\n| summarize Count = count() by bin(TimeGenerated, 1h)\n| render timechart' },
                    { label: 'Join two tables', query: '// Join example\nTable1\n| join kind=inner (Table2) on CommonColumn\n| project Table1.Column1, Table2.Column2' },
                    { label: 'Parse JSON', query: '// Parse JSON column\nTableName\n| extend ParsedJson = parse_json(JsonColumn)\n| project Name = ParsedJson.name, Value = ParsedJson.value' },
                ],
                ado: [
                    { label: 'Active bugs (WIQL)', query: '// Active bugs assigned to me (WIQL syntax)\nSELECT [System.Id], [System.Title], [System.State], [System.AssignedTo]\nFROM WorkItems\nWHERE [System.WorkItemType] = \'Bug\'\n  AND [System.State] <> \'Closed\'\n  AND [System.AssignedTo] = @Me\nORDER BY [System.CreatedDate] DESC' },
                    { label: 'Active bugs (KQL-style)', query: '// Active bugs assigned to me (KQL-style syntax)\nWorkItems\n| where WorkItemType == "Bug"\n| where State != "Closed"\n| where AssignedTo == @Me\n| project Id, Title, State, AssignedTo\n| order by CreatedDate desc' },
                    { label: 'Sprint work items (WIQL)', query: '// Current sprint items (WIQL syntax)\nSELECT [System.Id], [System.Title], [System.State], [System.WorkItemType]\nFROM WorkItems\nWHERE [System.IterationPath] = @CurrentIteration\nORDER BY [System.WorkItemType]' },
                    { label: 'Sprint work items (KQL-style)', query: '// Current sprint items (KQL-style syntax)\nWorkItems\n| where IterationPath == @CurrentIteration\n| project Id, Title, State, WorkItemType\n| order by WorkItemType' },
                    { label: 'Recently changed (WIQL)', query: '// Recently changed items (WIQL syntax)\nSELECT [System.Id], [System.Title], [System.ChangedDate], [System.ChangedBy]\nFROM WorkItems\nWHERE [System.ChangedDate] > @Today - 7\nORDER BY [System.ChangedDate] DESC' },
                    { label: 'Recently changed (KQL-style)', query: '// Recently changed items (KQL-style syntax)\nWorkItems\n| where ChangedDate > ago(7d)\n| project Id, Title, ChangedDate, ChangedBy\n| order by ChangedDate desc' },
                    { label: 'Unassigned tasks (WIQL)', query: '// Unassigned tasks (WIQL syntax)\nSELECT [System.Id], [System.Title], [System.State]\nFROM WorkItems\nWHERE [System.WorkItemType] = \'Task\'\n  AND [System.AssignedTo] = \'\'\n  AND [System.State] <> \'Closed\'' },
                    { label: 'Unassigned tasks (KQL-style)', query: '// Unassigned tasks (KQL-style syntax)\nWorkItems\n| where WorkItemType == "Task"\n| where AssignedTo == ""\n| where State != "Closed"\n| project Id, Title, State' },
                    { label: 'Bugs by priority (KQL-style)', query: '// Bugs grouped by priority (KQL-style syntax)\nWorkItems\n| where WorkItemType == "Bug"\n| where State != "Closed"\n| summarize Count = count() by Priority\n| order by Priority' },
                ],
                outlook: [
                    { label: 'Recent emails', query: '// Recent emails from Inbox\nInbox\n| take 100' },
                    { label: 'Emails from last week', query: '// Emails from the past 7 days\nInbox\n| where ReceivedTime > ago(7d)\n| take 100' },
                    { label: 'Search by subject', query: '// Search emails by subject\nInbox\n| where Subject contains "meeting"\n| take 100' },
                    { label: 'From specific sender', query: '// Emails from a specific sender\nInbox\n| where From contains "john"\n| take 100' },
                    { label: 'Unread emails', query: '// Unread emails\nInbox\n| where UnRead == true\n| take 50' },
                    { label: 'Combined filters', query: '// Recent emails with keyword\nInbox\n| where Subject contains "report"\n| where ReceivedTime > ago(30d)\n| take 50' },
                    { label: 'Calendar events', query: '// Calendar events\nCalendar\n| take 50' },
                    { label: 'Sent emails', query: '// Recently sent emails\nSentMail\n| take 100' },
                    { label: 'Contacts', query: '// All contacts\nContacts\n| take 100' },
                    { label: 'Tasks', query: '// All tasks\nTasks\n| take 50' },
                ]
            };

            const modeExamples = examples[currentMode] || examples.kusto;
            const selected = await vscode.window.showQuickPick(
                modeExamples.map(e => ({ label: e.label, query: e.query })),
                { placeHolder: 'Select an example query' }
            );

            if (!selected) return;

            const editor = vscode.window.activeTextEditor;
            const lang = currentMode === 'kusto' ? 'kql' : currentMode === 'ado' ? 'wiql' : 'oql';

            if (editor && ['kql', 'wiql', 'oql', 'plaintext'].includes(editor.document.languageId)) {
                // Insert at cursor position
                await editor.edit(editBuilder => {
                    editBuilder.insert(editor.selection.active, selected.query);
                });
            } else {
                // Create new document
                const doc = await vscode.workspace.openTextDocument({
                    content: selected.query,
                    language: lang
                });
                await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
            }
        })
    );

    // Register keyboard shortcuts command
    context.subscriptions.push(
        vscode.commands.registerCommand('queryStudio.showKeyboardShortcuts', () => {
            const shortcuts = [
                { key: 'F5', description: 'Run Query (new tab)' },
                { key: 'Ctrl+Shift+Enter', description: 'Run Query (same tab)' },
                { key: 'Shift+F5', description: 'Cancel Query' },
                { key: 'Ctrl+Shift+S', description: 'Save as Favorite' },
                { key: 'Ctrl+Shift+A', description: 'Open AI Chat' },
                { key: 'Ctrl+Alt+M', description: 'Toggle Mode (KQL/WIQL/OQL)' },
                { key: 'Ctrl+Alt+P', description: 'Switch Connection Profile' },
                { key: 'Ctrl+Alt+V', description: 'Paste Data as Table' },
                { key: 'Ctrl+Shift+/', description: 'Show Keyboard Shortcuts' },
                { key: 'Ctrl+Shift+B', description: 'Report Issue' },
                { key: 'Ctrl+Space', description: 'Trigger Autocomplete' },
            ];

            const panel = vscode.window.createWebviewPanel(
                'queryStudioShortcuts',
                'Quest Keyboard Shortcuts',
                vscode.ViewColumn.One,
                { enableScripts: false }
            );

            const shortcutRows = shortcuts.map(s =>
                `<tr><td><kbd>${s.key}</kbd></td><td>${s.description}</td></tr>`
            ).join('\n');

            panel.webview.html = `<!DOCTYPE html>
<html>
<head>
    <style>
        body { font-family: var(--vscode-font-family); padding: 20px; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
        h1 { font-size: 1.5em; margin-bottom: 20px; }
        table { width: 100%; border-collapse: collapse; }
        th, td { text-align: left; padding: 10px; border-bottom: 1px solid var(--vscode-panel-border); }
        th { background: var(--vscode-sideBar-background); font-weight: 600; }
        kbd { background: var(--vscode-button-secondaryBackground); padding: 4px 8px; border-radius: 4px; font-family: monospace; font-size: 0.9em; }
        tr:hover { background: var(--vscode-list-hoverBackground); }
        .note { margin-top: 20px; padding: 10px; background: var(--vscode-textBlockQuote-background); border-radius: 4px; font-size: 0.9em; }
    </style>
</head>
<body>
    <h1>⌨️ Quest Keyboard Shortcuts</h1>
    <table>
        <thead><tr><th>Shortcut</th><th>Action</th></tr></thead>
        <tbody>${shortcutRows}</tbody>
    </table>
    <div class="note">
        <strong>Tip:</strong> You can customize these shortcuts in VS Code's Keyboard Shortcuts settings (Ctrl+K Ctrl+S).
    </div>
</body>
</html>`;
        })
    );

    // Create Quest status bar items - all grouped on the right with "Quest:" label
    // Priority determines order (higher = more left): label(110) mode(109) limit(108) schema(107) data(106) | connection(105) keyboard(104) log(103)

    // Quest label
    const questLabelStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 110);
    questLabelStatusBarItem.text = 'Quest:';
    questLabelStatusBarItem.tooltip = 'Quest - Query Studio';
    questLabelStatusBarItem.command = 'queryStudio.showPanel';
    questLabelStatusBarItem.show();
    context.subscriptions.push(questLabelStatusBarItem);

    // Mode indicator (KQL/WIQL/OQL)
    modeStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 109);
    modeStatusBarItem.command = 'queryStudio.toggleMode';
    modeStatusBarItem.tooltip = 'Click to switch mode';
    updateModeStatusBar('kusto');
    modeStatusBarItem.show();
    context.subscriptions.push(modeStatusBarItem);

    // Results limit
    const resultsLimitStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 108);
    resultsLimitStatusBarItem.command = 'queryStudio.setResultsLimit';
    resultsLimitStatusBarItem.text = '$(list-ordered) 1000';
    resultsLimitStatusBarItem.tooltip = 'Results Limit\nClick to change';
    resultsLimitStatusBarItem.show();
    context.subscriptions.push(resultsLimitStatusBarItem);

    // Export a function to update the results limit display
    (globalThis as any).questUpdateResultsLimit = (limit: number) => {
        if (limit === 0) {
            resultsLimitStatusBarItem.text = '$(list-ordered) All';
            resultsLimitStatusBarItem.tooltip = 'Results Limit: No limit\nClick to change';
        } else {
            resultsLimitStatusBarItem.text = `$(list-ordered) ${limit}`;
            resultsLimitStatusBarItem.tooltip = `Results Limit: ${limit}\nClick to change`;
        }
    };

    // View external data
    const pasteTableStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 106);
    pasteTableStatusBarItem.text = '$(table)';
    pasteTableStatusBarItem.command = 'queryStudio.viewExternalData';
    pasteTableStatusBarItem.tooltip = 'View JSON/CSV data as table';
    pasteTableStatusBarItem.show();
    context.subscriptions.push(pasteTableStatusBarItem);

    // Connection status
    connectionStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 105);
    connectionStatusBarItem.command = 'queryStudio.showServerInfo';
    updateConnectionStatus(true);
    connectionStatusBarItem.show();
    context.subscriptions.push(connectionStatusBarItem);

    // Keyboard shortcuts
    shortcutsStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 104);
    shortcutsStatusBarItem.text = '$(keyboard)';
    shortcutsStatusBarItem.command = 'queryStudio.showKeyboardShortcuts';
    shortcutsStatusBarItem.tooltip = 'Show Keyboard Shortcuts (Ctrl+Shift+/)';
    shortcutsStatusBarItem.show();
    context.subscriptions.push(shortcutsStatusBarItem);

    // Log output
    logStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 103);
    logStatusBarItem.text = '$(output)';
    logStatusBarItem.command = 'queryStudio.showLog';
    logStatusBarItem.tooltip = 'Show Quest Log';
    logStatusBarItem.show();
    context.subscriptions.push(logStatusBarItem);

    // Register the menu command for viewing external data
    context.subscriptions.push(
        vscode.commands.registerCommand('queryStudio.viewExternalData', async () => {
            const choice = await vscode.window.showQuickPick([
                { label: '$(clippy) From Clipboard', description: 'Paste JSON/CSV from clipboard', value: 'clipboard' },
                { label: '$(folder-opened) From File', description: 'Open a JSON/CSV file', value: 'file' }
            ], {
                placeHolder: 'How would you like to load the data?',
                title: 'View Data as Table'
            });

            if (choice?.value === 'clipboard') {
                vscode.commands.executeCommand('queryStudio.pasteAsTable');
            } else if (choice?.value === 'file') {
                vscode.commands.executeCommand('queryStudio.openTableFromFile');
            }
        })
    );

    // Register show log command
    context.subscriptions.push(
        vscode.commands.registerCommand('queryStudio.showLog', () => {
            outputChannel.show();
        })
    );

    // Register server info command (shows when clicking connected status)
    let serverStartTime = Date.now();
    context.subscriptions.push(
        vscode.commands.registerCommand('queryStudio.showServerInfo', async () => {
            if (!sidecar.isRunning) {
                // If not running, offer to reconnect
                const action = await vscode.window.showWarningMessage(
                    'Quest server is not running',
                    'Reconnect'
                );
                if (action === 'Reconnect') {
                    await vscode.commands.executeCommand('queryStudio.reconnect');
                }
                return;
            }

            try {
                const health = await sidecar.client.healthCheck();
                const uptimeMs = Date.now() - serverStartTime;
                const uptimeMin = Math.floor(uptimeMs / 60000);
                const uptimeSec = Math.floor((uptimeMs % 60000) / 1000);
                const pid = sidecar.pid;

                vscode.window.showInformationMessage(
                    `Server: ${health.status} | Version: ${health.version} | PID: ${pid ?? 'N/A'} | Uptime: ${uptimeMin}m ${uptimeSec}s`,
                    'Reconnect', 'Show Log'
                ).then(action => {
                    if (action === 'Reconnect') {
                        vscode.commands.executeCommand('queryStudio.reconnect');
                    } else if (action === 'Show Log') {
                        outputChannel.show();
                    }
                });
            } catch (error) {
                vscode.window.showErrorMessage('Failed to get server info');
            }
        })
    );

    // Register reconnect command
    context.subscriptions.push(
        vscode.commands.registerCommand('queryStudio.reconnect', async () => {
            outputChannel.appendLine('Manual reconnect requested...');
            updateConnectionStatus(false);
            serverStartTime = Date.now(); // Reset uptime on reconnect
            try {
                await sidecar.reconnect();
                updateConnectionStatus(true);
                vscode.window.showInformationMessage('Quest server reconnected');
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Unknown error';
                vscode.window.showErrorMessage(`Failed to reconnect: ${message}`);
            }
        })
    );

    // Register report issue / feedback command
    context.subscriptions.push(
        vscode.commands.registerCommand('queryStudio.reportIssue', async () => {
            FeedbackPanel.createOrShow(context.extensionUri);
        })
    );

    // Register AI persona commands
    context.subscriptions.push(
        vscode.commands.registerCommand('queryStudio.selectAiPersona', async () => {
            const config = vscode.workspace.getConfiguration('queryStudio.ai');
            const personas: { name: string; prompt: string; description?: string; icon?: string }[] = config.get('personas') || [];
            const currentPersona = config.get<string>('defaultPersona') || '';

            const items: vscode.QuickPickItem[] = [
                {
                    label: '$(sparkle) Default Assistant',
                    description: currentPersona === '' ? '(active)' : '',
                    detail: 'Standard query assistant without custom instructions'
                },
                ...personas.map(p => ({
                    label: `${p.icon || '$(account)'} ${p.name}`,
                    description: p.name === currentPersona ? '(active)' : '',
                    detail: p.description || p.prompt.substring(0, 80) + (p.prompt.length > 80 ? '...' : '')
                }))
            ];

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select an AI persona',
                title: 'Quest AI Personas'
            });

            if (selected) {
                const selectedName = selected.label.includes('Default Assistant') ? '' :
                    personas.find(p => selected.label.includes(p.name))?.name || '';
                await config.update('defaultPersona', selectedName, vscode.ConfigurationTarget.Global);
                aiChatProvider.setPersona(selectedName);
                vscode.window.showInformationMessage(`AI persona set to: ${selectedName || 'Default Assistant'}`);
            }
        }),
        vscode.commands.registerCommand('queryStudio.manageAiPersonas', async () => {
            const config = vscode.workspace.getConfiguration('queryStudio.ai');
            const personas: { name: string; prompt: string; description?: string; icon?: string }[] = config.get('personas') || [];

            const actions = [
                { label: '$(add) Create New Persona', value: 'create' },
                ...(personas.length > 0 ? [
                    { label: '$(edit) Edit Persona', value: 'edit' },
                    { label: '$(trash) Delete Persona', value: 'delete' }
                ] : [])
            ];

            const action = await vscode.window.showQuickPick(actions, {
                placeHolder: 'What would you like to do?',
                title: 'Manage AI Personas'
            });

            if (!action) return;

            if (action.value === 'create') {
                const name = await vscode.window.showInputBox({
                    prompt: 'Enter a name for the persona',
                    placeHolder: 'e.g., Expert Analyst, Concise Helper',
                    ignoreFocusOut: true
                });
                if (!name) return;

                if (personas.some(p => p.name.toLowerCase() === name.toLowerCase())) {
                    vscode.window.showErrorMessage(`A persona named "${name}" already exists`);
                    return;
                }

                const prompt = await vscode.window.showInputBox({
                    prompt: 'Enter the system prompt for this persona',
                    placeHolder: 'e.g., You are an expert data analyst who provides detailed explanations...',
                    validateInput: (value) => value.length < 10 ? 'Prompt should be at least 10 characters' : null,
                    ignoreFocusOut: true
                });
                if (!prompt) return;

                const description = await vscode.window.showInputBox({
                    prompt: 'Enter a short description (optional)',
                    placeHolder: 'e.g., Provides detailed technical explanations',
                    ignoreFocusOut: true
                });

                const iconOptions = [
                    { label: '$(account) Person', value: '$(account)' },
                    { label: '$(beaker) Scientist', value: '$(beaker)' },
                    { label: '$(book) Scholar', value: '$(book)' },
                    { label: '$(lightbulb) Idea', value: '$(lightbulb)' },
                    { label: '$(rocket) Fast', value: '$(rocket)' },
                    { label: '$(tools) Expert', value: '$(tools)' },
                    { label: '$(zap) Quick', value: '$(zap)' }
                ];

                const icon = await vscode.window.showQuickPick(iconOptions, {
                    placeHolder: 'Choose an icon for the persona'
                });

                personas.push({
                    name,
                    prompt,
                    description: description || undefined,
                    icon: icon?.value || '$(account)'
                });

                await config.update('personas', personas, vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage(`Persona "${name}" created`);

            } else if (action.value === 'edit') {
                const personaItems = personas.map(p => ({
                    label: `${p.icon || '$(account)'} ${p.name}`,
                    description: p.description,
                    persona: p
                }));

                const selected = await vscode.window.showQuickPick(personaItems, {
                    placeHolder: 'Select a persona to edit'
                });
                if (!selected) return;

                const newPrompt = await vscode.window.showInputBox({
                    prompt: 'Edit the system prompt',
                    value: selected.persona.prompt,
                    validateInput: (value) => value.length < 10 ? 'Prompt should be at least 10 characters' : null,
                    ignoreFocusOut: true
                });
                if (!newPrompt) return;

                const newDescription = await vscode.window.showInputBox({
                    prompt: 'Edit the description (optional)',
                    value: selected.persona.description || '',
                    ignoreFocusOut: true
                });

                const idx = personas.findIndex(p => p.name === selected.persona.name);
                if (idx >= 0) {
                    personas[idx].prompt = newPrompt;
                    personas[idx].description = newDescription || undefined;
                    await config.update('personas', personas, vscode.ConfigurationTarget.Global);
                    vscode.window.showInformationMessage(`Persona "${selected.persona.name}" updated`);
                }

            } else if (action.value === 'delete') {
                const personaItems = personas.map(p => ({
                    label: `${p.icon || '$(account)'} ${p.name}`,
                    description: p.description,
                    persona: p
                }));

                const selected = await vscode.window.showQuickPick(personaItems, {
                    placeHolder: 'Select a persona to delete'
                });
                if (!selected) return;

                const confirm = await vscode.window.showWarningMessage(
                    `Delete persona "${selected.persona.name}"?`,
                    { modal: true },
                    'Delete'
                );
                if (confirm !== 'Delete') return;

                const filtered = personas.filter(p => p.name !== selected.persona.name);
                await config.update('personas', filtered, vscode.ConfigurationTarget.Global);

                // Clear default if deleted
                if (config.get<string>('defaultPersona') === selected.persona.name) {
                    await config.update('defaultPersona', '', vscode.ConfigurationTarget.Global);
                    aiChatProvider.setPersona('');
                }

                vscode.window.showInformationMessage(`Persona "${selected.persona.name}" deleted`);
            }
        })
    );

    // Register reset AI token command
    context.subscriptions.push(
        vscode.commands.registerCommand('queryStudio.resetAiToken', async () => {
            const confirm = await vscode.window.showWarningMessage(
                'This will clear your saved AI authentication token. You will need to re-authenticate with GitHub on your next AI request.',
                { modal: true },
                'Reset Token'
            );

            if (confirm === 'Reset Token') {
                try {
                    const result = await sidecar.client.clearAiToken();
                    if (result.success) {
                        vscode.window.showInformationMessage('AI token cleared. You will be prompted to authenticate on your next AI request.');
                        outputChannel.appendLine('[AI] Token cleared successfully');
                    } else {
                        vscode.window.showErrorMessage(`Failed to clear AI token: ${result.error}`);
                        outputChannel.appendLine(`[AI] Failed to clear token: ${result.error}`);
                    }
                } catch (error) {
                    const message = error instanceof Error ? error.message : 'Unknown error';
                    vscode.window.showErrorMessage(`Failed to clear AI token: ${message}`);
                    outputChannel.appendLine(`[AI] Error clearing token: ${message}`);
                }
            }
        })
    );

    // Periodic health check to update connection status
    const healthCheckInterval = setInterval(async () => {
        try {
            if (sidecar.isRunning) {
                await sidecar.client.healthCheck();
                updateConnectionStatus(true);
            } else {
                updateConnectionStatus(false);
            }
        } catch {
            updateConnectionStatus(false);
        }
    }, 30000);
    context.subscriptions.push({ dispose: () => clearInterval(healthCheckInterval) });

    // Note: Query toolbar buttons (Run, Cancel, Save, AI) are defined in package.json
    // and appear in the editor title bar when a KQL/WIQL file is open

    // Refresh views
    clusterProvider.refresh();

    // Focus the Quest sidebar (AI Chat is part of it)
    setTimeout(() => {
        vscode.commands.executeCommand('workbench.view.extension.queryStudio');
    }, 500);

    // Handle sidecar startup completion in the background (non-blocking)
    sidecarPromise.then(async () => {
        outputChannel.appendLine('Quest fully ready (sidecar connected)');
        updateConnectionStatus(true);

        // Send GitHub token from VS Code's built-in auth to sidecar (non-interactive)
        try {
            const token = await aiChatProvider.ensureGithubToken(false);
            if (token) {
                await sidecar.client.setAiToken(token);
                outputChannel.appendLine('[AI] GitHub token sent to server');
            }
        } catch (error) {
            outputChannel.appendLine(`[AI] Token not available at startup (will prompt on first chat): ${error}`);
        }
    }).catch((error) => {
        const message = error instanceof Error ? error.message : 'Unknown error';
        outputChannel.appendLine(`Sidecar startup failed: ${message}`);
        updateConnectionStatus(false);
        // Don't show error message immediately - user may not need sidecar yet
    });

    outputChannel.appendLine('Quest activated successfully (sidecar starting in background)');
}

export function updateModeStatusBar(type: 'kusto' | 'ado' | 'outlook' | null, name?: string) {
    if (!modeStatusBarItem) return;

    if (type === 'kusto') {
        modeStatusBarItem.text = 'Ⓚ KQL';
        modeStatusBarItem.backgroundColor = undefined;
        modeStatusBarItem.tooltip = name ? `Mode: Kusto (KQL)\nActive: ${name}` : 'Mode: Kusto (KQL)';
    } else if (type === 'ado') {
        modeStatusBarItem.text = 'Ⓐ WIQL';
        modeStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        modeStatusBarItem.tooltip = name ? `Mode: Azure DevOps (WIQL)\nActive: ${name}` : 'Mode: Azure DevOps (WIQL)';
    } else if (type === 'outlook') {
        modeStatusBarItem.text = '📧 OQL';
        modeStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
        modeStatusBarItem.tooltip = name ? `Mode: Outlook (OQL)\nActive: ${name}` : 'Mode: Outlook (OQL)\nQueries local Outlook via COM';
    } else {
        modeStatusBarItem.text = '$(question) No Source';
        modeStatusBarItem.backgroundColor = undefined;
        modeStatusBarItem.tooltip = 'Click to select a data source';
    }
}

export async function deactivate() {
    outputChannel?.appendLine('Quest is deactivating...');
    await sidecar?.stop();
    outputChannel?.appendLine('Quest deactivated');
}
