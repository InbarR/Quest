import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SidecarClient, QueryRequest, ClusterInfo, ResultHistoryItem } from '../sidecar/SidecarClient';
import { ResultsWebViewProvider } from '../providers/ResultsWebViewProvider';
import { ResultsHistoryWebViewProvider } from '../providers/ResultsHistoryWebViewProvider';
import { ClusterTreeProvider } from '../providers/ClusterTreeProvider';
import { EmailPreviewPanel } from '../providers/EmailPreviewPanel';
import { getCurrentMode } from '../extension';

/**
 * Find the query block at the cursor position.
 * Query blocks are separated by one or more empty lines.
 * Returns the range of the query block containing the cursor.
 */
function findQueryBlockAtCursor(editor: vscode.TextEditor): vscode.Range | undefined {
    const document = editor.document;
    const cursorPosition = editor.selection.active;
    const cursorLine = cursorPosition.line;
    const totalLines = document.lineCount;

    // Find the start of the query block (first non-empty line going backwards)
    let startLine = cursorLine;

    // First, go back to find the start of the current block
    // A block boundary is an empty line (or start of document)
    while (startLine > 0) {
        const prevLine = document.lineAt(startLine - 1);
        if (prevLine.isEmptyOrWhitespace) {
            // Check if we're currently on an empty line - if so, keep going
            const currentLine = document.lineAt(startLine);
            if (currentLine.isEmptyOrWhitespace) {
                startLine--;
                continue;
            }
            break;
        }
        startLine--;
    }

    // If we landed on an empty line, move forward to find the start of content
    while (startLine < totalLines && document.lineAt(startLine).isEmptyOrWhitespace) {
        startLine++;
    }

    // If no content found, return undefined
    if (startLine >= totalLines) {
        return undefined;
    }

    // Find the end of the query block (last non-empty line going forwards)
    let endLine = cursorLine;

    // Go forward to find the end of the current block
    while (endLine < totalLines - 1) {
        const nextLine = document.lineAt(endLine + 1);
        if (nextLine.isEmptyOrWhitespace) {
            break;
        }
        endLine++;
    }

    // If cursor is on an empty line between blocks, find the next block
    if (document.lineAt(cursorLine).isEmptyOrWhitespace) {
        // Find next non-empty line
        let nextStart = cursorLine;
        while (nextStart < totalLines && document.lineAt(nextStart).isEmptyOrWhitespace) {
            nextStart++;
        }
        if (nextStart < totalLines) {
            startLine = nextStart;
            endLine = nextStart;
            while (endLine < totalLines - 1 && !document.lineAt(endLine + 1).isEmptyOrWhitespace) {
                endLine++;
            }
        } else {
            return undefined;
        }
    }

    // Create the range from start of startLine to end of endLine
    const startPos = new vscode.Position(startLine, 0);
    const endLineObj = document.lineAt(endLine);
    const endPos = new vscode.Position(endLine, endLineObj.text.length);

    return new vscode.Range(startPos, endPos);
}

/**
 * Save query results to a CSV file
 */
function saveResultsToCsv(columns: string[], rows: any[][], title: string): string | undefined {
    try {
        // Create Results folder in Quest app data
        const appDataPath = path.join(os.homedir(), 'AppData', 'Local', 'Quest', 'Results');
        if (!fs.existsSync(appDataPath)) {
            fs.mkdirSync(appDataPath, { recursive: true });
        }

        // Generate filename with timestamp
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
        const safeTitle = title.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 30);
        const filename = `${timestamp}_${safeTitle}.csv`;
        const filePath = path.join(appDataPath, filename);

        // Build CSV content
        const escapeCsvField = (field: any): string => {
            const str = field === null || field === undefined ? '' : String(field);
            if (str.includes(',') || str.includes('"') || str.includes('\n')) {
                return '"' + str.replace(/"/g, '""') + '"';
            }
            return str;
        };

        const csvLines: string[] = [];
        csvLines.push(columns.map(escapeCsvField).join(','));
        for (const row of rows) {
            csvLines.push(row.map(escapeCsvField).join(','));
        }

        fs.writeFileSync(filePath, csvLines.join('\n'), 'utf8');
        return filePath;
    } catch (error) {
        console.error('Failed to save CSV:', error);
        return undefined;
    }
}

let activeClusterUrl: string | undefined;
let activeDatabase: string | undefined;
let activeQueryType: 'kusto' | 'ado' | 'outlook' = 'kusto';
let statusBarItem: vscode.StatusBarItem | undefined;

interface ConnectionProfile {
    name: string;
    clusterUrl: string;
    database: string;
    type: 'kusto' | 'ado' | 'outlook';
}

let connectionProfiles: ConnectionProfile[] = [];
let extensionContext: vscode.ExtensionContext | undefined;

function loadConnectionProfiles() {
    if (extensionContext) {
        connectionProfiles = extensionContext.globalState.get<ConnectionProfile[]>('connectionProfiles', []);
    }
}

async function saveConnectionProfiles() {
    if (extensionContext) {
        await extensionContext.globalState.update('connectionProfiles', connectionProfiles);
    }
}

export function setActiveConnection(clusterUrl: string, database: string, type: 'kusto' | 'ado' | 'outlook') {
    activeClusterUrl = clusterUrl;
    activeDatabase = database;
    activeQueryType = type;
    updateStatusBar();
}

export function getActiveConnection(): { clusterUrl?: string; database?: string; type: 'kusto' | 'ado' | 'outlook' } {
    return { clusterUrl: activeClusterUrl, database: activeDatabase, type: activeQueryType };
}

/**
 * Reset active connection when mode changes
 */
export function resetActiveConnection() {
    activeClusterUrl = undefined;
    activeDatabase = undefined;
    updateStatusBar();
}

/**
 * Set just the query type (used when mode changes)
 */
export function setActiveQueryType(type: 'kusto' | 'ado' | 'outlook') {
    console.log(`[Quest] setActiveQueryType called with: ${type}`);
    activeQueryType = type;
    updateStatusBar();
}

function updateStatusBar() {
    if (!statusBarItem) {
        statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        statusBarItem.command = 'queryStudio.showConnectionInfo';
    }

    if (activeQueryType === 'outlook') {
        // Outlook doesn't need cluster/database - it's always local
        statusBarItem.text = '📧 Outlook';
        statusBarItem.tooltip = 'Mode: Outlook (OQL)\nConnects to local Outlook via COM';
        statusBarItem.show();
    } else if (activeClusterUrl && activeDatabase) {
        // Extract short name from URL
        let shortName = activeClusterUrl;
        const match = activeClusterUrl.match(/https?:\/\/([^./]+)/);
        if (match) {
            shortName = match[1];
        }
        const icon = activeQueryType === 'ado' ? '$(organization)' : '$(database)';
        statusBarItem.text = `${icon} ${shortName}/${activeDatabase}`;
        statusBarItem.tooltip = `Active: ${activeClusterUrl}\nDatabase: ${activeDatabase}\nType: ${activeQueryType.toUpperCase()}`;
        statusBarItem.show();
    } else {
        statusBarItem.text = '$(database) No connection';
        statusBarItem.tooltip = 'Click to select a data source';
        statusBarItem.show();
    }
}

export function registerQueryCommands(
    context: vscode.ExtensionContext,
    client: SidecarClient,
    resultsProvider: ResultsWebViewProvider,
    outputChannel: vscode.OutputChannel,
    clusterProvider?: ClusterTreeProvider,
    resultsHistoryProvider?: ResultsHistoryWebViewProvider
) {
    // Store context for profile management
    extensionContext = context;
    loadConnectionProfiles();

    // Show Connection Info (for status bar click)
    context.subscriptions.push(
        vscode.commands.registerCommand('queryStudio.showConnectionInfo', async () => {
            if (activeClusterUrl && activeDatabase) {
                const typeName = activeQueryType === 'ado' ? 'Azure DevOps' : 'Kusto';
                vscode.window.showInformationMessage(
                    `Active Connection: ${typeName}\nCluster: ${activeClusterUrl}\nDatabase: ${activeDatabase}`,
                    'Change'
                ).then(selection => {
                    if (selection === 'Change') {
                        vscode.commands.executeCommand('querystudio.clusters.focus');
                    }
                });
            } else {
                vscode.window.showInformationMessage(
                    'No active connection. Select a data source from the sidebar.',
                    'Open Data Sources'
                ).then(selection => {
                    if (selection === 'Open Data Sources') {
                        vscode.commands.executeCommand('querystudio.clusters.focus');
                    }
                });
            }
        })
    );

    // Initialize status bar
    updateStatusBar();

    // Save current connection as profile
    context.subscriptions.push(
        vscode.commands.registerCommand('queryStudio.saveConnectionProfile', async () => {
            if (!activeClusterUrl || !activeDatabase) {
                vscode.window.showWarningMessage('No active connection to save as profile');
                return;
            }

            const name = await vscode.window.showInputBox({
                prompt: 'Enter a name for this connection profile',
                placeHolder: 'e.g., Production DB, Dev Environment'
            });

            if (!name) return;

            // Check for duplicate name
            if (connectionProfiles.some(p => p.name === name)) {
                const overwrite = await vscode.window.showWarningMessage(
                    `Profile "${name}" already exists. Overwrite?`,
                    { modal: true },
                    'Overwrite'
                );
                if (overwrite !== 'Overwrite') return;

                connectionProfiles = connectionProfiles.filter(p => p.name !== name);
            }

            connectionProfiles.push({
                name,
                clusterUrl: activeClusterUrl,
                database: activeDatabase,
                type: activeQueryType
            });

            await saveConnectionProfiles();
            vscode.window.showInformationMessage(`Connection profile "${name}" saved`);
        })
    );

    // Switch to connection profile
    context.subscriptions.push(
        vscode.commands.registerCommand('queryStudio.switchConnectionProfile', async () => {
            if (connectionProfiles.length === 0) {
                vscode.window.showInformationMessage('No saved connection profiles. Save the current connection first.');
                return;
            }

            const items = connectionProfiles.map(p => ({
                label: p.name,
                description: `${p.type.toUpperCase()} - ${p.database}`,
                detail: p.clusterUrl,
                profile: p
            }));

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select a connection profile',
                matchOnDescription: true,
                matchOnDetail: true
            });

            if (selected) {
                setActiveConnection(selected.profile.clusterUrl, selected.profile.database, selected.profile.type);
                vscode.window.showInformationMessage(`Switched to "${selected.profile.name}"`);
            }
        })
    );

    // Delete connection profile
    context.subscriptions.push(
        vscode.commands.registerCommand('queryStudio.deleteConnectionProfile', async () => {
            if (connectionProfiles.length === 0) {
                vscode.window.showInformationMessage('No saved connection profiles');
                return;
            }

            const items = connectionProfiles.map(p => ({
                label: p.name,
                description: `${p.type.toUpperCase()} - ${p.database}`,
                detail: p.clusterUrl,
                profile: p
            }));

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select a connection profile to delete'
            });

            if (selected) {
                const confirm = await vscode.window.showWarningMessage(
                    `Delete profile "${selected.profile.name}"?`,
                    { modal: true },
                    'Delete'
                );

                if (confirm === 'Delete') {
                    connectionProfiles = connectionProfiles.filter(p => p.name !== selected.profile.name);
                    await saveConnectionProfiles();
                    vscode.window.showInformationMessage(`Profile "${selected.profile.name}" deleted`);
                }
            }
        })
    );

    // Run Query
    context.subscriptions.push(
        vscode.commands.registerCommand('queryStudio.runQuery', async () => {
            outputChannel.appendLine('--- Run Query command triggered ---');

            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                outputChannel.appendLine('No active editor');
                vscode.window.showWarningMessage('No active editor');
                return;
            }

            // Get selected text, query block at cursor, or entire document
            let query: string;
            const selection = editor.selection;

            if (!selection.isEmpty) {
                // User has explicitly selected text - use that
                query = editor.document.getText(selection);
            } else {
                // No explicit selection - find the query block at cursor position
                const queryBlockRange = findQueryBlockAtCursor(editor);
                if (queryBlockRange) {
                    query = editor.document.getText(queryBlockRange);
                    // Highlight the query block so user sees what will be executed
                    editor.selection = new vscode.Selection(queryBlockRange.start, queryBlockRange.end);
                    outputChannel.appendLine(`Query block detected: lines ${queryBlockRange.start.line + 1}-${queryBlockRange.end.line + 1}`);
                } else {
                    // Fallback to entire document if no block found
                    query = editor.document.getText();
                }
            }

            if (!query.trim()) {
                vscode.window.showWarningMessage('No query to execute');
                return;
            }

            // Determine query type from current mode (from extension.ts) or language
            const langId = editor.document.languageId;
            const currentMode = getCurrentMode();
            outputChannel.appendLine(`DEBUG: currentMode=${currentMode}, activeQueryType=${activeQueryType}, langId=${langId}`);
            let queryType: 'kusto' | 'ado' | 'outlook';
            if (currentMode === 'outlook' || langId === 'oql') {
                queryType = 'outlook';
            } else if (currentMode === 'ado' || langId === 'wiql') {
                queryType = 'ado';
            } else {
                queryType = 'kusto';
            }
            outputChannel.appendLine(`Language: ${langId}, Current mode: ${currentMode}, Using: ${queryType}`);

            // Check for active connection (not needed for Outlook)
            if (queryType !== 'outlook') {
                outputChannel.appendLine(`Active cluster: ${activeClusterUrl || '(none)'}, database: ${activeDatabase || '(none)'}`);
                if (!activeClusterUrl || !activeDatabase) {
                    const config = vscode.workspace.getConfiguration('queryStudio');
                    activeClusterUrl = config.get('defaultCluster') || '';
                    activeDatabase = config.get('defaultDatabase') || '';
                    outputChannel.appendLine(`From config - cluster: ${activeClusterUrl || '(none)'}, database: ${activeDatabase || '(none)'}`);

                    if (!activeClusterUrl) {
                        outputChannel.appendLine('ERROR: No active cluster configured');
                        vscode.window.showWarningMessage('No active cluster. Select a cluster from the Data Sources panel or set queryStudio.defaultCluster in settings.');
                        return;
                    }
                }
            } else {
                outputChannel.appendLine('Outlook mode - no cluster/database needed');
            }

            let loadingTabId: string | undefined;
            try {
                outputChannel.appendLine(`Executing ${queryType} query...`);

                // Check if server is running before executing
                try {
                    await client.healthCheck();
                } catch (healthError) {
                    outputChannel.appendLine('ERROR: Server is not running or disconnected');
                    vscode.window.showErrorMessage('Quest server is not running. Click the connection status in the status bar to reconnect.');
                    return;
                }

                // Check setting for new tab vs replace current
                const tabConfig = vscode.workspace.getConfiguration('queryStudio');
                const openInNewTab = tabConfig.get<boolean>('results.openInNewTab', true);
                const replaceCurrentTab = !openInNewTab;

                loadingTabId = resultsProvider.showLoading(query, activeClusterUrl, activeDatabase, queryType, replaceCurrentTab);

                // Set running context for Stop button visibility
                vscode.commands.executeCommand('setContext', 'queryStudio.isRunning', true);

                const config = vscode.workspace.getConfiguration('queryStudio');
                const request: QueryRequest = {
                    query: query,
                    clusterUrl: queryType === 'outlook' ? '' : (activeClusterUrl || ''),
                    database: queryType === 'outlook' ? '' : (activeDatabase || ''),
                    type: queryType,
                    timeout: config.get('queryTimeout') || 300,
                    maxResults: config.get('maxResults') || 10000
                };

                // Execute query asynchronously (don't await) to allow concurrent queries
                const currentTabId = loadingTabId;
                const currentClusterUrl = activeClusterUrl;
                const currentDatabase = activeDatabase;
                const currentQueryType = queryType;
                const currentQuery = query;

                (async () => {
                    try {
                        const result = await client.executeQuery(request);

                        if (result.success) {
                            outputChannel.appendLine(`Query completed: ${result.rowCount} rows in ${result.executionTimeMs}ms`);

                            // Generate title for results
                            let title = 'Query Results';
                            try {
                                title = await client.aiGenerateTitle(currentQuery);
                            } catch {
                                // Use default title if AI fails
                            }

                            resultsProvider.showResults(result, title, currentQuery, currentClusterUrl, currentDatabase, currentQueryType, currentTabId);

                            // Auto-save to history
                            if (config.get('autoSaveHistory', true)) {
                                try {
                                    await client.savePreset({
                                        id: Date.now().toString(),
                                        name: title,
                                        query: currentQuery,
                                        clusterUrl: currentClusterUrl,
                                        database: currentDatabase,
                                        type: currentQueryType,
                                        createdAt: new Date().toISOString(),
                                        isAutoSaved: true
                                    });
                                    outputChannel.appendLine('Query saved to history');
                                    vscode.commands.executeCommand('queryStudio.refreshHistory');
                                } catch (e) {
                                    outputChannel.appendLine('Failed to save to history');
                                }
                            }

                            // Save to results history
                            if (resultsHistoryProvider) {
                                try {
                                    const maxSampleRows = config.get<number>('resultsHistory.maxSampleRows', 10);
                                    const sampleRows = result.rows.slice(0, maxSampleRows).map(row =>
                                        row.map(cell => cell === null || cell === undefined ? '' : String(cell))
                                    );

                                    const filePath = saveResultsToCsv(result.columns, result.rows, title);
                                    if (filePath) {
                                        outputChannel.appendLine(`Results saved to: ${filePath}`);
                                    }

                                    const resultHistoryItem: ResultHistoryItem = {
                                        id: Date.now().toString(),
                                        query: currentQuery,
                                        title: title,
                                        clusterUrl: currentClusterUrl,
                                        database: currentDatabase,
                                        rowCount: result.rowCount,
                                        executionTimeMs: result.executionTimeMs,
                                        success: true,
                                        createdAt: new Date().toISOString(),
                                        type: currentQueryType,
                                        columns: result.columns,
                                        sampleRows: sampleRows,
                                        filePath: filePath
                                    };
                                    outputChannel.appendLine(`Saving result to history: ${title}, ${result.rowCount} rows, type=${currentQueryType}`);
                                    await client.saveResultHistory(resultHistoryItem);
                                    outputChannel.appendLine('Result saved to results history successfully');
                                    resultsHistoryProvider.refresh();
                                } catch (e) {
                                    const errMsg = e instanceof Error ? e.message : String(e);
                                    outputChannel.appendLine(`Failed to save to results history: ${errMsg}`);
                                }
                            }
                        } else {
                            outputChannel.appendLine(`Query failed: ${result.error}`);
                            resultsProvider.showError(result.error || 'Query failed', currentTabId);
                        }
                    } catch (error) {
                        const message = error instanceof Error ? error.message : 'Unknown error';
                        outputChannel.appendLine(`Query error: ${message}`);
                        resultsProvider.showError(message, currentTabId);
                        vscode.window.showErrorMessage(`Query failed: ${message}`);
                    } finally {
                        vscode.commands.executeCommand('setContext', 'queryStudio.isRunning', false);
                    }
                })();

                // Return immediately to allow concurrent queries
                return;
            } catch (error) {
                // Handle errors before query execution (health check, etc.)
                const message = error instanceof Error ? error.message : 'Unknown error';
                outputChannel.appendLine(`Pre-query error: ${message}`);
                vscode.window.showErrorMessage(`Failed to start query: ${message}`);
            }
        })
    );

    // Run Query (Alternate Tab Mode) - uses opposite of the default setting
    context.subscriptions.push(
        vscode.commands.registerCommand('queryStudio.runQueryAlternate', async () => {
            outputChannel.appendLine('--- Run Query (Alternate Mode) command triggered ---');

            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('No active editor');
                return;
            }

            let query: string;
            const selection = editor.selection;

            if (!selection.isEmpty) {
                query = editor.document.getText(selection);
            } else {
                const queryBlockRange = findQueryBlockAtCursor(editor);
                if (queryBlockRange) {
                    query = editor.document.getText(queryBlockRange);
                    editor.selection = new vscode.Selection(queryBlockRange.start, queryBlockRange.end);
                } else {
                    query = editor.document.getText();
                }
            }

            if (!query.trim()) {
                vscode.window.showWarningMessage('No query to execute');
                return;
            }

            const langId = editor.document.languageId;
            const currentMode = getCurrentMode();
            let queryType: 'kusto' | 'ado' | 'outlook';
            if (currentMode === 'outlook' || langId === 'oql') {
                queryType = 'outlook';
            } else if (currentMode === 'ado' || langId === 'wiql') {
                queryType = 'ado';
            } else {
                queryType = 'kusto';
            }

            if (queryType !== 'outlook') {
                if (!activeClusterUrl || !activeDatabase) {
                    const config = vscode.workspace.getConfiguration('queryStudio');
                    activeClusterUrl = config.get('defaultCluster') || '';
                    activeDatabase = config.get('defaultDatabase') || '';
                    if (!activeClusterUrl) {
                        vscode.window.showWarningMessage('No active cluster. Select a cluster from the Data Sources panel.');
                        return;
                    }
                }
            }

            let loadingTabId: string | undefined;
            try {
                await client.healthCheck();

                // Use OPPOSITE of the setting (alternate mode)
                const config = vscode.workspace.getConfiguration('queryStudio');
                const openInNewTab = config.get<boolean>('results.openInNewTab', true);
                const replaceCurrentTab = openInNewTab; // Flipped!

                loadingTabId = resultsProvider.showLoading(query, activeClusterUrl, activeDatabase, queryType, replaceCurrentTab);
                vscode.commands.executeCommand('setContext', 'queryStudio.isRunning', true);

                const request: QueryRequest = {
                    query: query,
                    clusterUrl: queryType === 'outlook' ? '' : (activeClusterUrl || ''),
                    database: queryType === 'outlook' ? '' : (activeDatabase || ''),
                    type: queryType,
                    timeout: config.get('queryTimeout') || 300,
                    maxResults: config.get('maxResults') || 10000
                };

                const currentTabId = loadingTabId;
                const currentClusterUrl = activeClusterUrl;
                const currentDatabase = activeDatabase;
                const currentQueryType = queryType;
                const currentQuery = query;

                (async () => {
                    try {
                        const result = await client.executeQuery(request);

                        if (result.success) {
                            let title = 'Query Results';
                            try {
                                title = await client.aiGenerateTitle(currentQuery);
                            } catch { }

                            resultsProvider.showResults(result, title, currentQuery, currentClusterUrl, currentDatabase, currentQueryType, currentTabId);
                        } else {
                            resultsProvider.showError(result.error || 'Query failed', currentTabId);
                        }
                    } catch (error) {
                        const message = error instanceof Error ? error.message : 'Unknown error';
                        resultsProvider.showError(message, currentTabId);
                    } finally {
                        vscode.commands.executeCommand('setContext', 'queryStudio.isRunning', false);
                    }
                })();

                return;
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Unknown error';
                vscode.window.showErrorMessage(`Failed to start query: ${message}`);
            }
        })
    );

    // Cancel Query
    context.subscriptions.push(
        vscode.commands.registerCommand('queryStudio.cancelQuery', async () => {
            outputChannel.appendLine('[Cancel] Cancel command invoked');
            try {
                vscode.window.setStatusBarMessage('Cancelling query...', 2000);
                outputChannel.appendLine('[Cancel] Sending cancel request to server...');
                await client.cancelQuery();
                outputChannel.appendLine('[Cancel] Server acknowledged cancel');
                resultsProvider.showError('Query cancelled by user');
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Unknown error';
                outputChannel.appendLine(`[Cancel] Error: ${message}`);
                vscode.window.showErrorMessage(`Failed to cancel query: ${message}`);
            }
        })
    );

    // Explain Query (KQL only - uses explain operator)
    context.subscriptions.push(
        vscode.commands.registerCommand('queryStudio.explainQuery', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('No active editor');
                return;
            }

            const langId = editor.document.languageId;
            if (langId !== 'kql') {
                vscode.window.showInformationMessage('Query explain is only available for KQL queries. For WIQL and OQL, the query is executed directly without an execution plan.');
                return;
            }

            // Check if we have an active connection
            if (!activeClusterUrl || !activeDatabase) {
                vscode.window.showWarningMessage('Please select a cluster and database first');
                return;
            }

            // Get query text
            const text = editor.document.getText();
            const query = text.trim();

            if (!query) {
                vscode.window.showWarningMessage('Query is empty');
                return;
            }

            // Prepend 'explain' to the query (no newline - explain expects query directly after)
            const explainQuery = `explain ${query}`;

            try {
                outputChannel.appendLine(`Running explain for query: ${query.substring(0, 100)}...`);

                const request: QueryRequest = {
                    query: explainQuery,
                    clusterUrl: activeClusterUrl,
                    database: activeDatabase,
                    type: 'kusto'
                };

                vscode.window.setStatusBarMessage('Analyzing query...', 5000);
                const result = await client.executeQuery(request);

                if (result.success && result.rows.length > 0) {
                    // The explain operator returns a table with execution plan info
                    // Format it nicely in a new document
                    let planText = '# Query Execution Plan\n\n';
                    planText += '## Original Query\n```kql\n' + query + '\n```\n\n';
                    planText += '## Execution Plan\n\n';

                    // Format the explain results
                    result.columns.forEach((col, i) => {
                        planText += `### ${col}\n`;
                        result.rows.forEach(row => {
                            const val = row[i];
                            if (val && String(val).length > 0) {
                                // Try to format JSON if it looks like JSON
                                let formatted = String(val);
                                if (formatted.startsWith('{') || formatted.startsWith('[')) {
                                    try {
                                        formatted = JSON.stringify(JSON.parse(formatted), null, 2);
                                        planText += '```json\n' + formatted + '\n```\n';
                                    } catch {
                                        planText += formatted + '\n';
                                    }
                                } else {
                                    planText += formatted + '\n';
                                }
                            }
                        });
                        planText += '\n';
                    });

                    // Open as a new markdown document
                    const doc = await vscode.workspace.openTextDocument({
                        language: 'markdown',
                        content: planText
                    });
                    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: true });

                    outputChannel.appendLine('Query explain completed');
                } else if (result.error) {
                    vscode.window.showErrorMessage(`Explain failed: ${result.error}`);
                } else {
                    vscode.window.showInformationMessage('No execution plan returned');
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Unknown error';
                outputChannel.appendLine(`Query explain error: ${message}`);
                vscode.window.showErrorMessage(`Failed to analyze query: ${message}`);
            }
        })
    );

    // New KQL File
    context.subscriptions.push(
        vscode.commands.registerCommand('queryStudio.newKqlFile', async () => {
            const scratchDir = context.globalStorageUri;
            await vscode.workspace.fs.createDirectory(scratchDir);

            const fileName = `query_${Date.now()}.kql`;
            const fileUri = vscode.Uri.joinPath(scratchDir, fileName);

            await vscode.workspace.fs.writeFile(fileUri, Buffer.from('', 'utf-8'));
            const doc = await vscode.workspace.openTextDocument(fileUri);
            await vscode.languages.setTextDocumentLanguage(doc, 'kql');
            await vscode.window.showTextDocument(doc);
        })
    );

    // New WIQL File
    context.subscriptions.push(
        vscode.commands.registerCommand('queryStudio.newWiqlFile', async () => {
            const scratchDir = context.globalStorageUri;
            await vscode.workspace.fs.createDirectory(scratchDir);

            const fileName = `query_${Date.now()}.wiql`;
            const fileUri = vscode.Uri.joinPath(scratchDir, fileName);

            const content = 'SELECT [System.Id], [System.Title], [System.State]\nFROM WorkItems\nWHERE [System.TeamProject] = @Project\n';
            await vscode.workspace.fs.writeFile(fileUri, Buffer.from(content, 'utf-8'));
            const doc = await vscode.workspace.openTextDocument(fileUri);
            await vscode.languages.setTextDocumentLanguage(doc, 'wiql');
            await vscode.window.showTextDocument(doc);
        })
    );

    // New Query (based on current mode)
    context.subscriptions.push(
        vscode.commands.registerCommand('queryStudio.newQuery', async () => {
            const scratchDir = context.globalStorageUri;
            await vscode.workspace.fs.createDirectory(scratchDir);

            // Get current mode and create appropriate file
            const mode = activeQueryType || 'kusto';
            const ext = mode === 'ado' ? 'wiql' : mode === 'outlook' ? 'oql' : 'kql';
            const langId = ext;

            const fileName = `query_${Date.now()}.${ext}`;
            const fileUri = vscode.Uri.joinPath(scratchDir, fileName);

            await vscode.workspace.fs.writeFile(fileUri, Buffer.from('', 'utf-8'));
            const doc = await vscode.workspace.openTextDocument(fileUri);
            await vscode.languages.setTextDocumentLanguage(doc, langId);
            await vscode.window.showTextDocument(doc);
        })
    );

    // Save as Preset
    context.subscriptions.push(
        vscode.commands.registerCommand('queryStudio.saveAsPreset', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('No active editor');
                return;
            }

            const query = editor.document.getText();
            if (!query.trim()) {
                vscode.window.showWarningMessage('No query to save');
                return;
            }

            const langId = editor.document.languageId;
            const queryType: 'kusto' | 'ado' | 'outlook' = langId === 'wiql' ? 'ado' : langId === 'oql' ? 'outlook' : 'kusto';

            const name = await vscode.window.showInputBox({
                prompt: 'Enter a name for this query',
                placeHolder: 'My Query'
            });

            if (!name) {
                return;
            }

            try {
                // Check if a preset with this name already exists
                const existingPresets = await client.getPresets();
                const existingPreset = existingPresets.find(p => p.name.toLowerCase() === name.toLowerCase());

                let presetId = Date.now().toString();

                if (existingPreset) {
                    const override = await vscode.window.showWarningMessage(
                        `A favorite named "${name}" already exists. Do you want to replace it?`,
                        { modal: true },
                        'Replace',
                        'Cancel'
                    );

                    if (override !== 'Replace') {
                        return;
                    }

                    // Use the existing preset's ID to replace it
                    presetId = existingPreset.id;
                }

                await client.savePreset({
                    id: presetId,
                    name: name,
                    query: query,
                    clusterUrl: activeClusterUrl,
                    database: activeDatabase,
                    type: queryType,
                    createdAt: new Date().toISOString(),
                    isAutoSaved: false
                });

                vscode.window.showInformationMessage(`Query saved as "${name}"`);
                vscode.commands.executeCommand('queryStudio.refreshFavorites');
                vscode.commands.executeCommand('querystudio.presets.focus');
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Unknown error';
                vscode.window.showErrorMessage(`Failed to save query: ${message}`);
            }
        })
    );

    // Load Preset
    context.subscriptions.push(
        vscode.commands.registerCommand('queryStudio.loadPreset', async (preset) => {
            if (!preset) {
                vscode.window.showWarningMessage('No preset selected');
                return;
            }

            outputChannel.appendLine(`Loading preset: ${preset.name}`);
            outputChannel.appendLine(`  clusterUrl: ${preset.clusterUrl || '(none)'}`);
            outputChannel.appendLine(`  database: ${preset.database || '(none)'}`);
            outputChannel.appendLine(`  type: ${preset.type}`);

            const language = preset.type === 'ado' ? 'wiql' : preset.type === 'outlook' ? 'oql' : 'kql';
            const ext = language === 'wiql' ? '.wiql' : language === 'oql' ? '.oql' : '.kql';

            // Check if there's an active editor with a compatible language
            const editor = vscode.window.activeTextEditor;
            const activeLanguage = editor?.document.languageId;
            const isCompatibleEditor = editor && (activeLanguage === 'kql' || activeLanguage === 'wiql' || activeLanguage === 'oql');

            if (isCompatibleEditor && editor) {
                // Replace content in current editor
                const fullRange = new vscode.Range(
                    editor.document.positionAt(0),
                    editor.document.positionAt(editor.document.getText().length)
                );
                await editor.edit(editBuilder => {
                    editBuilder.replace(fullRange, preset.query || '');
                });
                outputChannel.appendLine(`Replaced content in current editor`);
            } else {
                // No compatible editor open - create new file
                const scratchDir = context.globalStorageUri;
                await vscode.workspace.fs.createDirectory(scratchDir);

                const fileName = `${(preset.name || 'query').replace(/[^a-zA-Z0-9]/g, '_')}_${Date.now()}${ext}`;
                const fileUri = vscode.Uri.joinPath(scratchDir, fileName);

                await vscode.workspace.fs.writeFile(fileUri, Buffer.from(preset.query || '', 'utf-8'));
                const doc = await vscode.workspace.openTextDocument(fileUri);
                await vscode.languages.setTextDocumentLanguage(doc, language);
                await vscode.window.showTextDocument(doc);
                outputChannel.appendLine(`Created new file: ${fileName}`);
            }

            // Update active connection
            let clusterUrl = preset.clusterUrl;
            let database = preset.database;

            // If preset has cluster info, use it
            if (clusterUrl && database) {
                setActiveConnection(clusterUrl, database, preset.type || 'kusto');

                // Update the cluster tree view to show active cluster
                if (clusterProvider) {
                    try {
                        const clusters = await client.getClusters();
                        // Find matching cluster with same URL and database
                        const matchingCluster = clusters.find(c =>
                            c.database === database && (
                                c.url === clusterUrl ||
                                c.url.includes(clusterUrl!) ||
                                clusterUrl!.includes(c.url)
                            )
                        );
                        if (matchingCluster) {
                            // Use the setActiveCluster command which also fetches schema
                            await vscode.commands.executeCommand('queryStudio.setActiveCluster', matchingCluster);
                            outputChannel.appendLine(`Set active cluster: ${matchingCluster.name}/${matchingCluster.database}`);
                        } else {
                            // Create a virtual cluster info for display
                            const virtualCluster: ClusterInfo = {
                                id: `preset_${preset.id}`,
                                name: clusterUrl.split('/').pop() || clusterUrl,
                                url: clusterUrl,
                                database: database,
                                type: preset.type || 'kusto',
                                isFavorite: false
                            };
                            // Use the setActiveCluster command which also fetches schema
                            await vscode.commands.executeCommand('queryStudio.setActiveCluster', virtualCluster);
                            outputChannel.appendLine(`Created virtual cluster: ${virtualCluster.name}/${database}`);
                        }
                    } catch (e) {
                        outputChannel.appendLine(`Failed to update cluster tree: ${e}`);
                    }
                }

                outputChannel.appendLine(`Loaded: ${preset.name} (${preset.type}: ${database})`);
            } else if (preset.type === 'outlook') {
                // Outlook presets don't need cluster/database
                outputChannel.appendLine(`Loaded Outlook preset: ${preset.name}`);
                setActiveConnection('', '', 'outlook');
            } else {
                // No cluster info in preset - warn user (only for kusto/ado)
                outputChannel.appendLine(`Preset has no cluster/database info`);
                vscode.window.showWarningMessage(
                    `Query loaded but no cluster/database stored. Select a data source before running.`,
                    'Select Data Source'
                ).then(selection => {
                    if (selection === 'Select Data Source') {
                        vscode.commands.executeCommand('querystudio.clusters.focus');
                    }
                });
            }
        })
    );

    // Delete Preset
    context.subscriptions.push(
        vscode.commands.registerCommand('queryStudio.deletePreset', async (preset) => {
            if (!preset) {
                return;
            }

            const confirm = await vscode.window.showWarningMessage(
                `Delete preset "${preset.name}"?`,
                { modal: true },
                'Delete'
            );

            if (confirm === 'Delete') {
                try {
                    await client.deletePreset(preset.id);
                    vscode.window.showInformationMessage(`Preset "${preset.name}" deleted`);
                } catch (error) {
                    const message = error instanceof Error ? error.message : 'Unknown error';
                    vscode.window.showErrorMessage(`Failed to delete preset: ${message}`);
                }
            }
        })
    );

    // Export Results
    context.subscriptions.push(
        vscode.commands.registerCommand('queryStudio.exportResults', async () => {
            // This is handled by the WebView
            vscode.window.showInformationMessage('Use the Export buttons in the Results panel');
        })
    );

    // Set up callbacks for the results provider
    resultsProvider.setOnSetQuery(async (query: string, clusterUrl: string, database: string) => {
        // Open query in a new editor and set the connection
        // Handle all three query types: kusto, ado, outlook
        const language = activeQueryType === 'ado' ? 'wiql' : activeQueryType === 'outlook' ? 'oql' : 'kql';
        const ext = activeQueryType === 'ado' ? '.wiql' : activeQueryType === 'outlook' ? '.oql' : '.kql';

        // Create file in scratch directory to avoid save prompts
        const scratchDir = context.globalStorageUri;
        await vscode.workspace.fs.createDirectory(scratchDir);

        const fileName = `query_${Date.now()}${ext}`;
        const fileUri = vscode.Uri.joinPath(scratchDir, fileName);

        await vscode.workspace.fs.writeFile(fileUri, Buffer.from(query, 'utf-8'));
        const doc = await vscode.workspace.openTextDocument(fileUri);
        await vscode.languages.setTextDocumentLanguage(doc, language);
        await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);

        // Only set connection for non-Outlook modes (Outlook doesn't use cluster/database)
        if (activeQueryType !== 'outlook') {
            setActiveConnection(clusterUrl, database, activeQueryType);
        }
        outputChannel.appendLine(`Query loaded to editor. Type: ${activeQueryType}, Cluster: ${clusterUrl || '(none)'}, Database: ${database || '(none)'}`);
    });

    resultsProvider.setOnReRun(async (query: string, clusterUrl: string, database: string) => {
        // Set the connection and run the query (skip for Outlook mode)
        if (activeQueryType !== 'outlook') {
            setActiveConnection(clusterUrl, database, activeQueryType);
        }
        outputChannel.appendLine(`Re-running query. Type: ${activeQueryType}, Cluster: ${clusterUrl || '(none)'}, Database: ${database || '(none)'}`);

        let loadingTabId: string | undefined;
        try {
            loadingTabId = resultsProvider.showLoading(query, clusterUrl, database, activeQueryType);

            const config = vscode.workspace.getConfiguration('queryStudio');
            const request: QueryRequest = {
                query: query,
                clusterUrl: clusterUrl,
                database: database,
                type: activeQueryType,
                timeout: config.get('queryTimeout') || 300,
                maxResults: config.get('maxResults') || 10000
            };

            const result = await client.executeQuery(request);

            if (result.success) {
                outputChannel.appendLine(`Re-run completed: ${result.rowCount} rows in ${result.executionTimeMs}ms`);

                let title = 'Query Results';
                try {
                    title = await client.aiGenerateTitle(query);
                } catch {
                    // Use default title if AI fails
                }

                resultsProvider.showResults(result, title, query, clusterUrl, database, activeQueryType, loadingTabId);
            } else {
                outputChannel.appendLine(`Re-run failed: ${result.error}`);
                resultsProvider.showError(result.error || 'Query failed', loadingTabId);
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            outputChannel.appendLine(`Re-run error: ${message}`);
            resultsProvider.showError(message, loadingTabId);
        }
    });

    resultsProvider.setOnOpenOutlookItem(async (entryId: string) => {
        outputChannel.appendLine(`Previewing Outlook item: ${entryId.substring(0, 20)}...`);
        try {
            // Create or show the email preview panel
            const panel = EmailPreviewPanel.createOrShow(context.extensionUri);
            panel.showLoading();

            // Set up callback for "Open in Outlook" button
            panel.setOnOpenInOutlook(async (id: string) => {
                outputChannel.appendLine(`Opening in Outlook: ${id.substring(0, 20)}...`);
                try {
                    await client.openOutlookItem(id);
                    outputChannel.appendLine('Outlook item opened');
                } catch (err) {
                    const msg = err instanceof Error ? err.message : 'Unknown error';
                    outputChannel.appendLine(`Failed to open in Outlook: ${msg}`);
                    vscode.window.showErrorMessage(`Failed to open in Outlook: ${msg}`);
                }
            });

            // Set up callback for "Mark as Read/Unread" button
            panel.setOnMarkAsRead(async (id: string, markAsRead: boolean) => {
                outputChannel.appendLine(`Marking email as ${markAsRead ? 'read' : 'unread'}: ${id.substring(0, 20)}...`);
                try {
                    const result = await client.markEmailRead(id, markAsRead);
                    if (result.success) {
                        outputChannel.appendLine(`Email marked as ${markAsRead ? 'read' : 'unread'}`);
                        return true;
                    } else {
                        outputChannel.appendLine(`Failed to mark email: ${result.error}`);
                        vscode.window.showErrorMessage(`Failed to mark email: ${result.error}`);
                        return false;
                    }
                } catch (err) {
                    const msg = err instanceof Error ? err.message : 'Unknown error';
                    outputChannel.appendLine(`Failed to mark email: ${msg}`);
                    vscode.window.showErrorMessage(`Failed to mark email: ${msg}`);
                    return false;
                }
            });

            // Fetch the email preview
            const preview = await client.getMailPreview(entryId);

            if (preview.error) {
                panel.showError(preview.error);
                outputChannel.appendLine(`Preview error: ${preview.error}`);
            } else {
                panel.showPreview(preview, entryId);
                outputChannel.appendLine('Email preview loaded');
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            outputChannel.appendLine(`Failed to preview Outlook item: ${message}`);
            vscode.window.showErrorMessage(`Failed to preview email: ${message}`);
        }
    });

    // Set up callback for direct opening in Outlook (from context menu)
    resultsProvider.setOnDirectOpenOutlookItem(async (entryId: string) => {
        outputChannel.appendLine(`Opening directly in Outlook: ${entryId.substring(0, 20)}...`);
        try {
            await client.openOutlookItem(entryId);
            outputChannel.appendLine('Outlook item opened');
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            outputChannel.appendLine(`Failed to open in Outlook: ${message}`);
            vscode.window.showErrorMessage(`Failed to open in Outlook: ${message}`);
        }
    });
}
