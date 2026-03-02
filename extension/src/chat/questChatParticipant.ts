import * as vscode from 'vscode';
import { SidecarManager } from '../sidecar/SidecarManager';
import { PresetInfo, QueryRequest, QueryResult, SchemaInfo, TableInfo } from '../sidecar/SidecarClient';
import { ResultsWebViewProvider } from '../providers/ResultsWebViewProvider';
import { getActiveConnection } from '../commands/queryCommands';
import { getCurrentMode } from '../extension';

/**
 * Resolve the active connection, falling back to VS Code settings if no
 * cluster/database has been explicitly selected this session.
 */
function resolveConnection(): { clusterUrl?: string; database?: string; type: 'kusto' | 'ado' | 'outlook' | 'mcp' } {
    const conn = getActiveConnection();
    if (!conn.clusterUrl || !conn.database) {
        const config = vscode.workspace.getConfiguration('queryStudio');
        conn.clusterUrl = conn.clusterUrl || config.get<string>('defaultCluster') || '';
        conn.database = conn.database || config.get<string>('defaultDatabase') || '';
    }
    return conn;
}

export function registerChatParticipant(
    context: vscode.ExtensionContext,
    sidecar: SidecarManager,
    resultsProvider: ResultsWebViewProvider,
    outputChannel: vscode.OutputChannel
): void {
    const participant = vscode.chat.createChatParticipant('quest.chat', async (request, chatContext, stream, token) => {
        outputChannel.appendLine(`[Chat] @quest command="${request.command || '(none)'}" prompt="${request.prompt.substring(0, 80)}"`);

        try {
            await sidecar.ensureRunning();
        } catch {
            stream.markdown('**Quest server is not running.** Please check the connection status in the status bar and try reconnecting.');
            return;
        }

        switch (request.command) {
            case 'schema':
                await handleSchema(request, stream, token, sidecar, outputChannel);
                break;
            case 'status':
                await handleStatus(stream, sidecar, outputChannel);
                break;
            case 'query':
                await handleQuery(request, stream, token, sidecar, resultsProvider, outputChannel);
                break;
            case 'ask':
            default:
                await handleAsk(request, stream, token, sidecar, resultsProvider, outputChannel);
                break;
        }
    });

    participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'resources', 'icon.png');
    context.subscriptions.push(participant);
    outputChannel.appendLine('[Chat] @quest chat participant registered');
}

async function handleQuery(
    request: vscode.ChatRequest,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    sidecar: SidecarManager,
    resultsProvider: ResultsWebViewProvider,
    outputChannel: vscode.OutputChannel
): Promise<void> {
    const queryText = request.prompt.trim();
    if (!queryText) {
        stream.markdown('Please provide a query to execute. For example:\n\n`@quest StormEvents | take 5`');
        return;
    }

    const conn = resolveConnection();
    const mode = getCurrentMode();

    if (mode !== 'outlook' && (!conn.clusterUrl || !conn.database)) {
        stream.markdown('**No active connection.** Please select a data source from the Quest sidebar before running queries.');
        return;
    }

    const queryRequest: QueryRequest = {
        query: queryText,
        clusterUrl: mode === 'outlook' ? '' : (conn.clusterUrl || ''),
        database: mode === 'outlook' ? '' : (conn.database || ''),
        type: mode === 'outlook' ? 'outlook' : mode === 'ado' ? 'ado' : 'kusto',
        timeout: 300
    };

    stream.progress('Executing query...');

    const cancelDisposable = token.onCancellationRequested(async () => {
        try {
            await sidecar.client.cancelQuery();
            outputChannel.appendLine('[Chat] Query cancelled by user');
        } catch { }
    });

    try {
        const result = await sidecar.client.executeQuery(queryRequest);

        if (result.success) {
            stream.markdown(formatResultAsMarkdown(result));
            const queryType = queryRequest.type;
            resultsProvider.showResults(
                result,
                `@quest: ${queryText.substring(0, 60)}`,
                queryText,
                queryType === 'outlook' ? undefined : conn.clusterUrl,
                queryType === 'outlook' ? undefined : conn.database,
                queryType
            );
        } else {
            stream.markdown(formatError(result.error || 'Query failed'));
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        stream.markdown(formatError(message));
    } finally {
        cancelDisposable.dispose();
    }
}

async function handleAsk(
    request: vscode.ChatRequest,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    sidecar: SidecarManager,
    resultsProvider: ResultsWebViewProvider,
    outputChannel: vscode.OutputChannel
): Promise<void> {
    const userPrompt = request.prompt.trim();
    if (!userPrompt) {
        stream.markdown('Please describe what you want to query. For example:\n\n`@quest show me the first 5 tenants`');
        return;
    }

    const conn = resolveConnection();
    const mode = getCurrentMode();
    const langLabel = mode === 'kusto' ? 'KQL' : mode === 'ado' ? 'WIQL' : 'OQL';

    // Load favorites for context (and possible connection inference)
    let favorites: PresetInfo[] = [];
    try {
        const allPresets = await sidecar.client.getPresets();
        favorites = allPresets.filter(p => !p.isAutoSaved && p.type === (mode === 'kusto' ? 'kusto' : mode === 'ado' ? 'ado' : 'outlook'));
        outputChannel.appendLine(`[Chat] Loaded ${favorites.length} favorites for context`);
    } catch (e) {
        outputChannel.appendLine(`[Chat] Failed to load favorites: ${e}`);
    }

    // Try to infer the best cluster from the user's prompt — even if there's already
    // an active connection. The user may mention a different cluster/favorite by name.
    if (mode !== 'outlook' && mode !== 'mcp') {
        const promptLower = userPrompt.toLowerCase();
        const promptWords = promptLower.split(/\s+/).filter(w => w.length > 2);
        let inferred = false;

        // Strategy 1: Match favorites by keyword relevance to the user's prompt
        if (favorites.length > 0) {
            const matchingFav = favorites.find(f =>
                f.clusterUrl && f.database &&
                promptWords.some(w =>
                    f.name.toLowerCase().includes(w) ||
                    (f.description && f.description.toLowerCase().includes(w)) ||
                    (f.database && f.database.toLowerCase().includes(w))
                )
            );
            if (matchingFav?.clusterUrl && matchingFav?.database) {
                conn.clusterUrl = matchingFav.clusterUrl;
                conn.database = matchingFav.database;
                outputChannel.appendLine(`[Chat] Matched connection from favorite "${matchingFav.name}": ${conn.clusterUrl} / ${conn.database}`);
                inferred = true;
            }
        }

        // Strategy 2: Match configured clusters by keyword (name, URL, database)
        if (!inferred) {
            try {
                const clusters = await sidecar.client.getClusters();
                const modeClusters = clusters.filter(c => c.type === mode);
                const matchingCluster = modeClusters.find(c =>
                    promptWords.some(w =>
                        c.name.toLowerCase().includes(w) ||
                        c.url.toLowerCase().includes(w) ||
                        c.database.toLowerCase().includes(w)
                    )
                );
                if (matchingCluster) {
                    conn.clusterUrl = matchingCluster.url;
                    conn.database = matchingCluster.database;
                    outputChannel.appendLine(`[Chat] Matched connection from cluster "${matchingCluster.name}/${matchingCluster.database}": ${conn.clusterUrl}`);
                    inferred = true;
                }
            } catch { /* sidecar not ready */ }
        }

        // If nothing matched and no active connection, fall back to first favorite
        if (!inferred && (!conn.clusterUrl || !conn.database)) {
            const fav = favorites.find(f => f.clusterUrl && f.database);
            if (fav?.clusterUrl && fav?.database) {
                conn.clusterUrl = fav.clusterUrl;
                conn.database = fav.database;
                outputChannel.appendLine(`[Chat] Fallback connection from favorite "${fav.name}": ${conn.clusterUrl} / ${conn.database}`);
            }
        }
    }

    if (mode !== 'outlook' && (!conn.clusterUrl || !conn.database)) {
        stream.markdown('**No active connection.** Please select a data source from the Quest sidebar before running queries.');
        return;
    }

    // Get active editor content for context
    const editor = vscode.window.activeTextEditor;
    let editorContext = '';
    if (editor && ['kql', 'wiql', 'oql'].includes(editor.document.languageId)) {
        editorContext = editor.document.getText().trim();
        if (editorContext.length > 2000) {
            editorContext = editorContext.substring(0, 2000);
        }
        outputChannel.appendLine(`[Chat] Active editor context: ${editorContext.length} chars (${editor.document.languageId})`);
    }

    // Build favorites context — example queries the user actually runs
    let favoritesSection = '';
    if (favorites.length > 0) {
        const exampleQueries = favorites.slice(0, 5).map(f =>
            `- "${f.name}": ${f.query.length > 200 ? f.query.substring(0, 200) + '...' : f.query}`
        );
        favoritesSection = `\nUSER'S SAVED QUERIES (use these as reference for correct table/column names and patterns):\n${exampleQueries.join('\n')}\n`;
    }

    // Fetch schema for context (best-effort)
    stream.progress('Fetching schema...');
    let schemaContext = '';
    if (mode !== 'outlook' && conn.clusterUrl && conn.database) {
        try {
            const schema = await sidecar.client.getSchema(conn.clusterUrl, conn.database);
            outputChannel.appendLine(`[Chat] Schema fetched: ${schema.tables.length} tables`);
            // Use user prompt, editor content, and favorites for matching relevant tables
            const favQueries = favorites.slice(0, 5).map(f => f.query).join(' ');
            const matchText = [userPrompt, editorContext, favQueries].filter(Boolean).join(' ');
            schemaContext = buildSchemaContext(schema, matchText);
            // Log matched tables for debugging
            const matchLine = schemaContext.match(/BEST MATCHING TABLES[^]*?(?=\nOther|\n$)/)?.[0] || '(no matches)';
            outputChannel.appendLine(`[Chat] ${matchLine.split('\n').slice(0, 6).join(' | ')}`);
            outputChannel.appendLine(`[Chat] Schema context: ${schemaContext.length} chars`);
        } catch (e) {
            outputChannel.appendLine(`[Chat] Schema fetch for NL context failed: ${e}`);
        }
    }

    // Select a language model
    stream.progress('Generating query...');
    let models: vscode.LanguageModelChat[];
    try {
        models = await vscode.lm.selectChatModels({ family: 'gpt-4o' });
        if (models.length === 0) {
            models = await vscode.lm.selectChatModels();
        }
    } catch {
        models = [];
    }

    if (models.length === 0) {
        outputChannel.appendLine('[Chat] No language models available, falling back to raw query');
        stream.markdown('_No language model available — treating your input as a raw query._\n\n');
        request = { ...request, command: 'query' } as any;
        await handleQuery(request, stream, token, sidecar, resultsProvider, outputChannel);
        return;
    }

    const model = models[0];
    const dbContext = mode === 'outlook' ? '' : ` for the "${conn.database}" database`;

    const syntaxHints = getSyntaxHints(mode);

    // Build the editor context section — placed prominently when available
    let editorSection = '';
    if (editorContext) {
        editorSection =
            `\nCURRENT QUERY IN EDITOR (this is the user's working context — use the EXACT table and column names from this query):\n` +
            `\`\`\`\n${editorContext}\n\`\`\`\n`;
    }

    let promptText: string;
    if (schemaContext) {
        promptText =
            `You are a ${langLabel} expert. The database "${conn.database}" has the following schema:\n\n` +
            `${schemaContext}\n\n` +
            `IMPORTANT: You MUST use ONLY the exact table and column names from the schema, the user's saved queries, or the user's current editor query. Do NOT guess or invent names.\n\n` +
            `${syntaxHints}\n` +
            `${favoritesSection}` +
            `${editorSection}\n` +
            `Translate the user's request into a ${langLabel} query. Return ONLY the raw query text — no explanation, no markdown fencing, no commentary.`;
    } else {
        promptText =
            `You are a ${langLabel} expert. ${syntaxHints}\n` +
            `${favoritesSection}` +
            `${editorSection}\n` +
            `Translate the user's request into a ${langLabel} query${dbContext}. ` +
            `Return ONLY the raw query text — no explanation, no markdown fencing, no commentary.`;
    }

    const systemMessage = vscode.LanguageModelChatMessage.User(promptText);
    const userMessage = vscode.LanguageModelChatMessage.User(userPrompt);
    outputChannel.appendLine(`[Chat] NL prompt (${promptText.length} chars), schema included: ${schemaContext.length > 0}`);

    let generatedQuery: string;
    try {
        const response = await model.sendRequest([systemMessage, userMessage], {}, token);
        const parts: string[] = [];
        for await (const fragment of response.text) {
            parts.push(fragment);
        }
        generatedQuery = parts.join('').trim();
        // Strip markdown fencing if the model wraps the query anyway
        generatedQuery = generatedQuery.replace(/^```(?:\w*)\n?/, '').replace(/\n?```$/, '').trim();
    } catch (error) {
        if (error instanceof vscode.LanguageModelError && error.code === 'NotAllowed') {
            stream.markdown('**Copilot access is required** to translate natural language to queries. Please ensure GitHub Copilot is active.\n\nYou can still use `@quest /query <raw query>` to run queries directly.');
            return;
        }
        const message = error instanceof Error ? error.message : 'Unknown error';
        outputChannel.appendLine(`[Chat] LM request failed: ${message}`);
        stream.markdown(`**Failed to generate query:** ${message}\n\nYou can try running a raw query with \`@quest /query <your query>\`.`);
        return;
    }

    if (!generatedQuery) {
        stream.markdown('The language model returned an empty response. Please try rephrasing your request.');
        return;
    }

    // Show the generated query
    stream.markdown(`**Generated ${langLabel} query:**\n\n\`\`\`${langLabel.toLowerCase()}\n${generatedQuery}\n\`\`\`\n\n`);

    // Execute the generated query
    const queryRequest: QueryRequest = {
        query: generatedQuery,
        clusterUrl: mode === 'outlook' ? '' : (conn.clusterUrl || ''),
        database: mode === 'outlook' ? '' : (conn.database || ''),
        type: mode === 'outlook' ? 'outlook' : mode === 'ado' ? 'ado' : 'kusto',
        timeout: 300
    };

    stream.progress('Executing query...');

    const cancelDisposable = token.onCancellationRequested(async () => {
        try {
            await sidecar.client.cancelQuery();
            outputChannel.appendLine('[Chat] Query cancelled by user');
        } catch { }
    });

    try {
        const result = await sidecar.client.executeQuery(queryRequest);

        if (result.success) {
            stream.markdown(formatResultAsMarkdown(result));
            const queryType = queryRequest.type;
            resultsProvider.showResults(
                result,
                `@quest: ${userPrompt.substring(0, 60)}`,
                generatedQuery,
                queryType === 'outlook' ? undefined : conn.clusterUrl,
                queryType === 'outlook' ? undefined : conn.database,
                queryType
            );
        } else {
            stream.markdown(`**Generated query failed to execute**\n\n\`\`\`\n${result.error || 'Unknown error'}\n\`\`\`\n\nTry rephrasing your request or use \`@quest /query\` to run a raw query.`);
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        stream.markdown(`**Generated query failed to execute**\n\n\`\`\`\n${message}\n\`\`\`\n\nTry rephrasing your request or use \`@quest /query\` to run a raw query.`);
    } finally {
        cancelDisposable.dispose();
    }
}

async function handleSchema(
    request: vscode.ChatRequest,
    stream: vscode.ChatResponseStream,
    _token: vscode.CancellationToken,
    sidecar: SidecarManager,
    outputChannel: vscode.OutputChannel
): Promise<void> {
    const conn = resolveConnection();
    const mode = getCurrentMode();

    if (mode === 'outlook') {
        stream.markdown('Schema browsing is not available in Outlook mode.');
        return;
    }

    if (!conn.clusterUrl || !conn.database) {
        stream.markdown('**No active connection.** Please select a data source from the Quest sidebar first.');
        return;
    }

    stream.progress('Fetching schema...');

    try {
        const schema = await sidecar.client.getSchema(conn.clusterUrl, conn.database);
        stream.markdown(formatSchemaAsMarkdown(schema, request.prompt.trim()));
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        outputChannel.appendLine(`[Chat] Schema error: ${message}`);
        stream.markdown(formatError(`Failed to fetch schema: ${message}`));
    }
}

async function handleStatus(
    stream: vscode.ChatResponseStream,
    sidecar: SidecarManager,
    outputChannel: vscode.OutputChannel
): Promise<void> {
    const conn = resolveConnection();
    const mode = getCurrentMode();

    let health: { status: string; version: string } | undefined;
    try {
        health = await sidecar.client.healthCheck();
    } catch (error) {
        outputChannel.appendLine(`[Chat] Health check failed: ${error}`);
    }

    const modeLabel = mode === 'kusto' ? 'Kusto (KQL)' : mode === 'ado' ? 'Azure DevOps (WIQL)' : 'Outlook (OQL)';

    let md = '### Quest Status\n\n';
    md += `| Property | Value |\n|---|---|\n`;
    md += `| Mode | ${modeLabel} |\n`;

    if (mode !== 'outlook') {
        md += `| Cluster | ${conn.clusterUrl || '_(not set)_'} |\n`;
        md += `| Database | ${conn.database || '_(not set)_'} |\n`;
    }

    md += `| Server | ${health ? `${health.status} (v${health.version})` : 'not reachable'} |\n`;

    stream.markdown(md);
}

// --- Formatting helpers ---

function formatResultAsMarkdown(result: QueryResult, maxRows: number = 50): string {
    if (result.columns.length === 0) {
        return `Query completed successfully. **${result.rowCount}** rows returned (no columns).`;
    }

    const displayRows = result.rows.slice(0, maxRows);
    const truncateCell = (val: any): string => {
        const s = val === null || val === undefined ? '' : String(val);
        return s.length > 100 ? s.substring(0, 97) + '...' : s;
    };

    // Header
    let md = `| ${result.columns.join(' | ')} |\n`;
    md += `| ${result.columns.map(() => '---').join(' | ')} |\n`;

    // Rows
    for (const row of displayRows) {
        const cells = row.map(cell => truncateCell(cell).replace(/\|/g, '\\|').replace(/\n/g, ' '));
        md += `| ${cells.join(' | ')} |\n`;
    }

    // Footer
    md += `\n_${result.rowCount} row(s) returned in ${result.executionTimeMs}ms_`;
    if (result.rowCount > maxRows) {
        md += ` _(showing first ${maxRows})_`;
    }

    return md;
}

function formatSchemaAsMarkdown(schema: SchemaInfo, filter?: string): string {
    let tables: TableInfo[] = schema.tables;

    if (filter) {
        const lowerFilter = filter.toLowerCase();
        tables = tables.filter(t => t.name.toLowerCase().includes(lowerFilter));
    }

    if (tables.length === 0) {
        return filter
            ? `No tables found matching "${filter}".`
            : 'No tables found in the current database.';
    }

    let md = `### Schema (${tables.length} table${tables.length !== 1 ? 's' : ''})\n\n`;

    if (tables.length <= 20) {
        for (const table of tables) {
            md += `#### ${table.name}\n\n`;
            if (table.columns.length > 0) {
                md += `| Column | Type |\n|---|---|\n`;
                for (const col of table.columns) {
                    md += `| ${col.name} | ${col.type} |\n`;
                }
                md += '\n';
            } else {
                md += '_(no columns)_\n\n';
            }
        }
    } else {
        md += `| Table | Columns |\n|---|---|\n`;
        for (const table of tables) {
            md += `| ${table.name} | ${table.columns.length} |\n`;
        }
        md += `\n_Use \`@quest /schema <table name>\` to see columns for a specific table._\n`;
    }

    return md;
}

/**
 * Build a focused schema context for the LM prompt.
 * Strategy: find tables relevant to the user's query by keyword matching,
 * present those prominently with columns.  Append remaining table names
 * in a compact secondary list so the model can fall back if needed.
 */
function buildSchemaContext(schema: SchemaInfo, userPrompt: string): string {
    // Find tables relevant to the user's prompt by keyword matching
    const keywords = userPrompt.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const relevantTables = schema.tables.filter(t => {
        const nameLower = t.name.toLowerCase();
        return keywords.some(kw => nameLower.includes(kw) || kw.includes(nameLower));
    });

    // Build the primary section: matched tables with full column details
    let context = '';
    if (relevantTables.length > 0) {
        context += 'BEST MATCHING TABLES (use one of these):\n';
        for (const t of relevantTables.slice(0, 15)) {
            const cols = t.columns.map(c => `${c.name} (${c.type})`).join(', ');
            context += `- ${t.name}: ${cols}\n`;
        }
    }

    // Secondary: all other table names (no columns) as a compact reference
    const matchedNames = new Set(relevantTables.map(t => t.name));
    const otherNames = schema.tables.filter(t => !matchedNames.has(t.name)).map(t => t.name);
    if (otherNames.length > 0) {
        context += `\nOther tables in this database (no column details): ${otherNames.join(', ')}\n`;
    }

    return context;
}

function getSyntaxHints(mode: string): string {
    if (mode === 'kusto') {
        return `KQL syntax reminders:
- Pipe operator: TableName | where ... | project ... | take N
- String operators are INFIX, not functions: ColName startswith "val", ColName contains "val", ColName == "val"
- Time: ago(2d), ago(1h), datetime(2024-01-01)
- Aggregation: | summarize count() by ColName
- Sorting: | order by ColName desc
- Limit rows: | take 10
- Do NOT use SQL syntax. Do NOT use function-call style like startswith(col, val).`;
    }
    if (mode === 'ado') {
        return `WIQL syntax reminders:
- SELECT [Field1], [Field2] FROM WorkItems WHERE [Condition]
- Fields use brackets: [System.Title], [System.State], [System.AssignedTo]
- Operators: =, <>, <, >, <=, >=, Contains, In, Not In, Under
- Date macros: @Today, @Today - 7
- Example: SELECT [System.Id], [System.Title] FROM WorkItems WHERE [System.State] = 'Active'`;
    }
    return `OQL syntax reminders:
- Pipe operator: FolderName | where ... | project ... | take N
- Available folders: Inbox, SentItems, Calendar, Contacts, Drafts, DeletedItems
- String operators are INFIX: ColName contains "val", ColName == "val"
- Date: ago(2d), ago(1h)`;
}

function formatError(error: string): string {
    return `**Query failed**\n\n\`\`\`\n${error}\n\`\`\``;
}
