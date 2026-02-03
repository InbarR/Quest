import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Quest Extension Test Suite', () => {
    vscode.window.showInformationMessage('Start all tests.');

    test('Extension should be present', () => {
        const extension = vscode.extensions.getExtension('inbar-rotem.query-studio');
        assert.ok(extension, 'Extension should be installed');
    });

    test('Extension should activate', async () => {
        const extension = vscode.extensions.getExtension('inbar-rotem.query-studio');
        assert.ok(extension, 'Extension should be installed');

        // Activate the extension
        await extension?.activate();
        assert.ok(extension?.isActive, 'Extension should be active');
    });

    test('KQL language should be registered', async () => {
        // Create a new KQL document
        const doc = await vscode.workspace.openTextDocument({
            language: 'kql',
            content: 'StormEvents | take 10'
        });

        assert.strictEqual(doc.languageId, 'kql', 'Document should be KQL');
    });

    test('WIQL language should be registered', async () => {
        const doc = await vscode.workspace.openTextDocument({
            language: 'wiql',
            content: 'SELECT [System.Id] FROM WorkItems'
        });

        assert.strictEqual(doc.languageId, 'wiql', 'Document should be WIQL');
    });

    test('OQL language should be registered', async () => {
        const doc = await vscode.workspace.openTextDocument({
            language: 'oql',
            content: 'FROM:sender@example.com'
        });

        assert.strictEqual(doc.languageId, 'oql', 'Document should be OQL');
    });

    test('Core commands should be registered', async () => {
        const commands = await vscode.commands.getCommands(true);

        const expectedCommands = [
            'queryStudio.runQuery',
            'queryStudio.addDataSource',
            'queryStudio.refreshClusters',
            'queryStudio.aiChat',
            'queryStudio.newKqlFile',
            'queryStudio.newWiqlFile',
            'queryStudio.newOqlFile'
        ];

        for (const cmd of expectedCommands) {
            assert.ok(
                commands.includes(cmd),
                `Command ${cmd} should be registered`
            );
        }
    });

    test('All extension commands should be registered', async () => {
        const commands = await vscode.commands.getCommands(true);

        const allExpectedCommands = [
            'queryStudio.runQuery',
            'queryStudio.cancelQuery',
            'queryStudio.addDataSource',
            'queryStudio.refreshClusters',
            'queryStudio.aiChat',
            'queryStudio.aiExplain',
            'queryStudio.aiGenerate',
            'queryStudio.newKqlFile',
            'queryStudio.newWiqlFile',
            'queryStudio.newOqlFile',
            'queryStudio.saveAsPreset',
            'queryStudio.showExample',
            'queryStudio.setActiveCluster',
            'queryStudio.removeCluster',
            'queryStudio.renameCluster',
            'queryStudio.toggleFavorite',
            'queryStudio.loadPreset',
            'queryStudio.deletePreset',
            'queryStudio.exportResults',
            'queryStudio.refreshFavorites',
            'queryStudio.refreshHistory',
            'queryStudio.clearHistory',
            'queryStudio.toggleMode',
            'queryStudio.setMode',
            'queryStudio.fetchSchema',
            'queryStudio.refreshSchema',
            'queryStudio.showKeyboardShortcuts',
            'queryStudio.insertSnippet',
            'queryStudio.saveSnippet',
            'queryStudio.refreshSnippets'
        ];

        for (const cmd of allExpectedCommands) {
            assert.ok(
                commands.includes(cmd),
                `Command ${cmd} should be registered`
            );
        }
    });

    test('Views should be registered', () => {
        // Check that the Quest view container exists
        // This is a basic check - view registration is handled by VS Code
        const extension = vscode.extensions.getExtension('inbar-rotem.query-studio');
        const packageJson = extension?.packageJSON;

        assert.ok(
            packageJson?.contributes?.views?.queryStudio,
            'queryStudio views should be defined'
        );

        assert.ok(
            packageJson?.contributes?.viewsContainers?.activitybar?.some(
                (c: any) => c.id === 'queryStudio'
            ),
            'queryStudio activity bar container should be defined'
        );
    });

    test('All views should be defined', () => {
        const extension = vscode.extensions.getExtension('inbar-rotem.query-studio');
        const packageJson = extension?.packageJSON;
        const views = packageJson?.contributes?.views?.queryStudio;

        const expectedViews = [
            'querystudio.clusters',
            'querystudio.presets',
            'querystudio.history',
            'querystudio.resultsHistory',
            'querystudio.snippets',
            'querystudio.aiChat'
        ];

        for (const viewId of expectedViews) {
            assert.ok(
                views?.some((v: any) => v.id === viewId),
                `View ${viewId} should be defined`
            );
        }
    });

    test('AI Chat view should be a webview in the sidebar', () => {
        const extension = vscode.extensions.getExtension('inbar-rotem.query-studio');
        const packageJson = extension?.packageJSON;
        const views = packageJson?.contributes?.views?.queryStudio;

        const aiChatView = views?.find((v: any) => v.id === 'querystudio.aiChat');
        assert.ok(aiChatView, 'AI Chat view should be defined');
        assert.strictEqual(aiChatView?.type, 'webview', 'AI Chat should be a webview type');
        assert.ok(aiChatView?.name?.includes('AI'), 'AI Chat view should have AI in the name');
    });

    test('Keybindings should be defined', () => {
        const extension = vscode.extensions.getExtension('inbar-rotem.query-studio');
        const packageJson = extension?.packageJSON;
        const keybindings = packageJson?.contributes?.keybindings;

        assert.ok(keybindings && keybindings.length > 0, 'Keybindings should be defined');

        // Check F5 is bound to runQuery
        const f5Binding = keybindings?.find((kb: any) => kb.key === 'F5');
        assert.ok(f5Binding, 'F5 keybinding should exist');
        assert.strictEqual(f5Binding?.command, 'queryStudio.runQuery', 'F5 should run query');
    });
});

suite('KQL Completions Test Suite', () => {
    test('KQL completions should include keywords', async () => {
        const doc = await vscode.workspace.openTextDocument({
            language: 'kql',
            content: 'wh'
        });

        await vscode.window.showTextDocument(doc);

        // Move cursor to end of document
        const position = new vscode.Position(0, 2);

        // Trigger completion
        const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
            'vscode.executeCompletionItemProvider',
            doc.uri,
            position
        );

        // Check that 'where' is in the completions
        const hasWhere = completions?.items.some(item =>
            item.label === 'where' ||
            (typeof item.label === 'object' && item.label.label === 'where')
        );

        assert.ok(hasWhere, 'KQL completions should include "where" keyword');
    });

    test('KQL completions should include functions', async () => {
        const doc = await vscode.workspace.openTextDocument({
            language: 'kql',
            content: 'cou'
        });

        await vscode.window.showTextDocument(doc);

        const position = new vscode.Position(0, 3);

        const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
            'vscode.executeCompletionItemProvider',
            doc.uri,
            position
        );

        // Check that 'count' function is in completions
        const hasCount = completions?.items.some(item =>
            item.label === 'count' ||
            (typeof item.label === 'object' && item.label.label === 'count')
        );

        assert.ok(hasCount, 'KQL completions should include "count" function');
    });

    test('KQL pipe operator completions', async () => {
        const doc = await vscode.workspace.openTextDocument({
            language: 'kql',
            content: 'StormEvents | '
        });

        await vscode.window.showTextDocument(doc);

        // Position after pipe
        const position = new vscode.Position(0, 14);

        const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
            'vscode.executeCompletionItemProvider',
            doc.uri,
            position
        );

        // Should have operator completions like 'where', 'project', 'summarize'
        const labels = completions?.items.map(item =>
            typeof item.label === 'string' ? item.label : item.label.label
        ) || [];

        assert.ok(labels.includes('where'), 'Should suggest "where" after pipe');
        assert.ok(labels.includes('project'), 'Should suggest "project" after pipe');
    });

    test('KQL completions should include summarize', async () => {
        const doc = await vscode.workspace.openTextDocument({
            language: 'kql',
            content: 'sum'
        });

        await vscode.window.showTextDocument(doc);
        const position = new vscode.Position(0, 3);

        const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
            'vscode.executeCompletionItemProvider',
            doc.uri,
            position
        );

        const labels = completions?.items.map(item =>
            typeof item.label === 'string' ? item.label : item.label.label
        ) || [];

        assert.ok(labels.includes('summarize'), 'Should suggest "summarize"');
        assert.ok(labels.includes('sum'), 'Should suggest "sum" function');
    });

    test('KQL completions should include aggregation functions', async () => {
        const doc = await vscode.workspace.openTextDocument({
            language: 'kql',
            content: 'T | summarize '
        });

        await vscode.window.showTextDocument(doc);
        const position = new vscode.Position(0, 14);

        const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
            'vscode.executeCompletionItemProvider',
            doc.uri,
            position
        );

        const labels = completions?.items.map(item =>
            typeof item.label === 'string' ? item.label : item.label.label
        ) || [];

        assert.ok(labels.includes('count'), 'Should suggest "count" function');
        assert.ok(labels.includes('sum'), 'Should suggest "sum" function');
        assert.ok(labels.includes('avg'), 'Should suggest "avg" function');
    });
});

suite('WIQL Completions Test Suite', () => {
    test('WIQL completions should include keywords', async () => {
        const doc = await vscode.workspace.openTextDocument({
            language: 'wiql',
            content: 'SEL'
        });

        await vscode.window.showTextDocument(doc);
        const position = new vscode.Position(0, 3);

        const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
            'vscode.executeCompletionItemProvider',
            doc.uri,
            position
        );

        const labels = completions?.items.map(item =>
            typeof item.label === 'string' ? item.label : item.label.label
        ) || [];

        assert.ok(labels.includes('SELECT'), 'Should suggest "SELECT" keyword');
    });

    test('WIQL completions should include FROM keyword', async () => {
        const doc = await vscode.workspace.openTextDocument({
            language: 'wiql',
            content: 'SELECT [System.Id] FR'
        });

        await vscode.window.showTextDocument(doc);
        const position = new vscode.Position(0, 21);

        const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
            'vscode.executeCompletionItemProvider',
            doc.uri,
            position
        );

        const labels = completions?.items.map(item =>
            typeof item.label === 'string' ? item.label : item.label.label
        ) || [];

        assert.ok(labels.includes('FROM'), 'Should suggest "FROM" keyword');
    });

    test('WIQL completions should include fields after bracket', async () => {
        const doc = await vscode.workspace.openTextDocument({
            language: 'wiql',
            content: 'SELECT ['
        });

        await vscode.window.showTextDocument(doc);
        const position = new vscode.Position(0, 8);

        const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
            'vscode.executeCompletionItemProvider',
            doc.uri,
            position
        );

        const labels = completions?.items.map(item =>
            typeof item.label === 'string' ? item.label : item.label.label
        ) || [];

        assert.ok(labels.includes('System.Id'), 'Should suggest "System.Id" field');
        assert.ok(labels.includes('System.Title'), 'Should suggest "System.Title" field');
        assert.ok(labels.includes('System.State'), 'Should suggest "System.State" field');
    });

    test('WIQL completions should include macros after @', async () => {
        const doc = await vscode.workspace.openTextDocument({
            language: 'wiql',
            content: 'WHERE [System.AssignedTo] = @'
        });

        await vscode.window.showTextDocument(doc);
        const position = new vscode.Position(0, 29);

        const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
            'vscode.executeCompletionItemProvider',
            doc.uri,
            position
        );

        const labels = completions?.items.map(item =>
            typeof item.label === 'string' ? item.label : item.label.label
        ) || [];

        assert.ok(labels.includes('@Me'), 'Should suggest "@Me" macro');
        assert.ok(labels.includes('@Today'), 'Should suggest "@Today" macro');
        assert.ok(labels.includes('@Project'), 'Should suggest "@Project" macro');
    });

    test('WIQL completions should include logical operators', async () => {
        const doc = await vscode.workspace.openTextDocument({
            language: 'wiql',
            content: 'WHERE [System.State] = "Active" AN'
        });

        await vscode.window.showTextDocument(doc);
        const position = new vscode.Position(0, 35);

        const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
            'vscode.executeCompletionItemProvider',
            doc.uri,
            position
        );

        const labels = completions?.items.map(item =>
            typeof item.label === 'string' ? item.label : item.label.label
        ) || [];

        assert.ok(labels.includes('AND'), 'Should suggest "AND" operator');
    });
});

suite('OQL Completions Test Suite', () => {
    test('OQL completions should include folders', async () => {
        const doc = await vscode.workspace.openTextDocument({
            language: 'oql',
            content: ''
        });

        await vscode.window.showTextDocument(doc);
        const position = new vscode.Position(0, 0);

        const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
            'vscode.executeCompletionItemProvider',
            doc.uri,
            position
        );

        const labels = completions?.items.map(item =>
            typeof item.label === 'string' ? item.label : item.label.label
        ) || [];

        assert.ok(labels.includes('Inbox'), 'Should suggest "Inbox" folder');
        assert.ok(labels.includes('SentMail'), 'Should suggest "SentMail" folder');
        assert.ok(labels.includes('Calendar'), 'Should suggest "Calendar" folder');
    });

    test('OQL completions should include operators after pipe', async () => {
        const doc = await vscode.workspace.openTextDocument({
            language: 'oql',
            content: 'Inbox | '
        });

        await vscode.window.showTextDocument(doc);
        const position = new vscode.Position(0, 8);

        const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
            'vscode.executeCompletionItemProvider',
            doc.uri,
            position
        );

        const labels = completions?.items.map(item =>
            typeof item.label === 'string' ? item.label : item.label.label
        ) || [];

        assert.ok(labels.includes('where'), 'Should suggest "where" operator');
        assert.ok(labels.includes('take'), 'Should suggest "take" operator');
        assert.ok(labels.includes('project'), 'Should suggest "project" operator');
    });

    test('OQL completions should include mail fields after where', async () => {
        const doc = await vscode.workspace.openTextDocument({
            language: 'oql',
            content: 'Inbox | where '
        });

        await vscode.window.showTextDocument(doc);
        const position = new vscode.Position(0, 14);

        const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
            'vscode.executeCompletionItemProvider',
            doc.uri,
            position
        );

        const labels = completions?.items.map(item =>
            typeof item.label === 'string' ? item.label : item.label.label
        ) || [];

        assert.ok(labels.includes('Subject'), 'Should suggest "Subject" field');
        assert.ok(labels.includes('From'), 'Should suggest "From" field');
        assert.ok(labels.includes('ReceivedTime'), 'Should suggest "ReceivedTime" field');
    });

    test('OQL completions should include snippets', async () => {
        // Snippets are available when typing in the middle of a query (not at start)
        const doc = await vscode.workspace.openTextDocument({
            language: 'oql',
            content: 'Inbox\nRec'
        });

        await vscode.window.showTextDocument(doc);
        const position = new vscode.Position(1, 3);

        const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
            'vscode.executeCompletionItemProvider',
            doc.uri,
            position
        );

        const snippetItems = completions?.items.filter(item =>
            item.kind === vscode.CompletionItemKind.Snippet
        ) || [];

        assert.ok(snippetItems.length > 0, 'Should have snippet completions');
    });

    test('OQL completions should include Drafts folder', async () => {
        const doc = await vscode.workspace.openTextDocument({
            language: 'oql',
            content: 'Dr'
        });

        await vscode.window.showTextDocument(doc);
        const position = new vscode.Position(0, 2);

        const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
            'vscode.executeCompletionItemProvider',
            doc.uri,
            position
        );

        const labels = completions?.items.map(item =>
            typeof item.label === 'string' ? item.label : item.label.label
        ) || [];

        assert.ok(labels.includes('Drafts'), 'Should suggest "Drafts" folder');
    });

    test('OQL completions should include new mail fields', async () => {
        const doc = await vscode.workspace.openTextDocument({
            language: 'oql',
            content: 'Inbox | where '
        });

        await vscode.window.showTextDocument(doc);
        const position = new vscode.Position(0, 14);

        const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
            'vscode.executeCompletionItemProvider',
            doc.uri,
            position
        );

        const labels = completions?.items.map(item =>
            typeof item.label === 'string' ? item.label : item.label.label
        ) || [];

        // New fields added in TASK-24
        assert.ok(labels.includes('CC'), 'Should suggest "CC" field');
        assert.ok(labels.includes('SenderEmail'), 'Should suggest "SenderEmail" field');
        assert.ok(labels.includes('Categories'), 'Should suggest "Categories" field');
        assert.ok(labels.includes('BodyPreview'), 'Should suggest "BodyPreview" field');
    });

    test('OQL completions should include Calendar folder', async () => {
        const doc = await vscode.workspace.openTextDocument({
            language: 'oql',
            content: 'Cal'
        });

        await vscode.window.showTextDocument(doc);
        const position = new vscode.Position(0, 3);

        const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
            'vscode.executeCompletionItemProvider',
            doc.uri,
            position
        );

        const labels = completions?.items.map(item =>
            typeof item.label === 'string' ? item.label : item.label.label
        ) || [];

        assert.ok(labels.includes('Calendar'), 'Should suggest "Calendar" folder');
    });
});

suite('KQL Hover Provider Test Suite', () => {
    test('KQL hover should show documentation for where', async () => {
        const doc = await vscode.workspace.openTextDocument({
            language: 'kql',
            content: 'StormEvents | where State == "FLORIDA"'
        });

        await vscode.window.showTextDocument(doc);
        const position = new vscode.Position(0, 16); // On 'where'

        const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
            'vscode.executeHoverProvider',
            doc.uri,
            position
        );

        assert.ok(hovers && hovers.length > 0, 'Should provide hover for "where"');

        const hoverContent = hovers[0].contents.map(c =>
            typeof c === 'string' ? c : c.value
        ).join('');

        assert.ok(hoverContent.toLowerCase().includes('filter'), 'Hover should explain filter functionality');
    });

    test('KQL hover should show documentation for summarize', async () => {
        const doc = await vscode.workspace.openTextDocument({
            language: 'kql',
            content: 'T | summarize count() by State'
        });

        await vscode.window.showTextDocument(doc);
        const position = new vscode.Position(0, 6); // On 'summarize'

        const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
            'vscode.executeHoverProvider',
            doc.uri,
            position
        );

        assert.ok(hovers && hovers.length > 0, 'Should provide hover for "summarize"');

        const hoverContent = hovers[0].contents.map(c =>
            typeof c === 'string' ? c : c.value
        ).join('');

        assert.ok(hoverContent.toLowerCase().includes('group'), 'Hover should mention grouping');
    });

    test('KQL hover should show documentation for count function', async () => {
        const doc = await vscode.workspace.openTextDocument({
            language: 'kql',
            content: 'T | summarize count()'
        });

        await vscode.window.showTextDocument(doc);
        const position = new vscode.Position(0, 16); // On 'count'

        const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
            'vscode.executeHoverProvider',
            doc.uri,
            position
        );

        assert.ok(hovers && hovers.length > 0, 'Should provide hover for "count"');
    });

    test('KQL hover should show documentation for ago function', async () => {
        const doc = await vscode.workspace.openTextDocument({
            language: 'kql',
            content: 'T | where Timestamp > ago(1h)'
        });

        await vscode.window.showTextDocument(doc);
        const position = new vscode.Position(0, 24); // On 'ago'

        const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
            'vscode.executeHoverProvider',
            doc.uri,
            position
        );

        assert.ok(hovers && hovers.length > 0, 'Should provide hover for "ago"');

        const hoverContent = hovers[0].contents.map(c =>
            typeof c === 'string' ? c : c.value
        ).join('');

        assert.ok(hoverContent.toLowerCase().includes('time'), 'Hover should mention time');
    });
});

suite('Configuration Test Suite', () => {
    test('Extension configuration should be accessible', () => {
        const config = vscode.workspace.getConfiguration('queryStudio');
        assert.ok(config, 'Configuration should be accessible');
    });

    test('Default query timeout should be 300', () => {
        const config = vscode.workspace.getConfiguration('queryStudio');
        const timeout = config.get<number>('queryTimeout');
        assert.strictEqual(timeout, 300, 'Default query timeout should be 300 seconds');
    });

    test('Default max results should be 10000', () => {
        const config = vscode.workspace.getConfiguration('queryStudio');
        const maxResults = config.get<number>('maxResults');
        assert.strictEqual(maxResults, 10000, 'Default max results should be 10000');
    });

    test('Auto save history should be enabled by default', () => {
        const config = vscode.workspace.getConfiguration('queryStudio');
        const autoSave = config.get<boolean>('autoSaveHistory');
        assert.strictEqual(autoSave, true, 'Auto save history should be enabled by default');
    });

    test('AI should be enabled by default', () => {
        const config = vscode.workspace.getConfiguration('queryStudio');
        const aiEnabled = config.get<boolean>('ai.enabled');
        assert.strictEqual(aiEnabled, true, 'AI should be enabled by default');
    });

    test('Default AI provider should be github', () => {
        const config = vscode.workspace.getConfiguration('queryStudio');
        const provider = config.get<string>('ai.provider');
        assert.strictEqual(provider, 'github', 'Default AI provider should be github');
    });

    test('History retention days should have valid default', () => {
        const config = vscode.workspace.getConfiguration('queryStudio');
        const retentionDays = config.get<number>('history.retentionDays');
        assert.strictEqual(retentionDays, 30, 'History retention should be 30 days by default');
    });
});

suite('Document Creation Test Suite', () => {
    test('KQL document should have correct file extension association', async () => {
        const doc = await vscode.workspace.openTextDocument({
            language: 'kql',
            content: '// KQL query\nStormEvents | take 10'
        });

        assert.strictEqual(doc.languageId, 'kql', 'Language should be kql');
    });

    test('WIQL document should have correct file extension association', async () => {
        const doc = await vscode.workspace.openTextDocument({
            language: 'wiql',
            content: '-- WIQL query\nSELECT [System.Id] FROM WorkItems'
        });

        assert.strictEqual(doc.languageId, 'wiql', 'Language should be wiql');
    });

    test('OQL document should have correct file extension association', async () => {
        const doc = await vscode.workspace.openTextDocument({
            language: 'oql',
            content: '// OQL query\nInbox | take 10'
        });

        assert.strictEqual(doc.languageId, 'oql', 'Language should be oql');
    });

    test('Empty KQL document should be valid', async () => {
        const doc = await vscode.workspace.openTextDocument({
            language: 'kql',
            content: ''
        });

        assert.strictEqual(doc.languageId, 'kql', 'Empty KQL document should have correct language');
        assert.strictEqual(doc.getText(), '', 'Document should be empty');
    });

    test('Multi-line KQL query should be valid', async () => {
        const content = `StormEvents
| where StartTime > ago(7d)
| summarize count() by State
| top 10 by count_
| render barchart`;

        const doc = await vscode.workspace.openTextDocument({
            language: 'kql',
            content: content
        });

        assert.strictEqual(doc.languageId, 'kql', 'Multi-line KQL should be valid');
        assert.strictEqual(doc.lineCount, 5, 'Should have 5 lines');
    });
});

suite('Grammar Test Suite', () => {
    test('KQL grammar should be defined', () => {
        const extension = vscode.extensions.getExtension('inbar-rotem.query-studio');
        const packageJson = extension?.packageJSON;
        const grammars = packageJson?.contributes?.grammars;

        const kqlGrammar = grammars?.find((g: any) => g.language === 'kql');
        assert.ok(kqlGrammar, 'KQL grammar should be defined');
        assert.strictEqual(kqlGrammar?.scopeName, 'source.kql', 'KQL scope name should be source.kql');
    });

    test('WIQL grammar should be defined', () => {
        const extension = vscode.extensions.getExtension('inbar-rotem.query-studio');
        const packageJson = extension?.packageJSON;
        const grammars = packageJson?.contributes?.grammars;

        const wiqlGrammar = grammars?.find((g: any) => g.language === 'wiql');
        assert.ok(wiqlGrammar, 'WIQL grammar should be defined');
        assert.strictEqual(wiqlGrammar?.scopeName, 'source.wiql', 'WIQL scope name should be source.wiql');
    });

    test('OQL grammar should be defined', () => {
        const extension = vscode.extensions.getExtension('inbar-rotem.query-studio');
        const packageJson = extension?.packageJSON;
        const grammars = packageJson?.contributes?.grammars;

        const oqlGrammar = grammars?.find((g: any) => g.language === 'oql');
        assert.ok(oqlGrammar, 'OQL grammar should be defined');
        assert.strictEqual(oqlGrammar?.scopeName, 'source.oql', 'OQL scope name should be source.oql');
    });
});

suite('Menu Contributions Test Suite', () => {
    test('Editor title menu should have Quest commands', () => {
        const extension = vscode.extensions.getExtension('inbar-rotem.query-studio');
        const packageJson = extension?.packageJSON;
        const editorTitleMenus = packageJson?.contributes?.menus?.['editor/title'];

        assert.ok(editorTitleMenus && editorTitleMenus.length > 0, 'Editor title menus should exist');

        const runQueryMenu = editorTitleMenus?.find((m: any) => m.command === 'queryStudio.runQuery');
        assert.ok(runQueryMenu, 'Run query should be in editor title menu');
    });

    test('Editor context menu should have Quest commands', () => {
        const extension = vscode.extensions.getExtension('inbar-rotem.query-studio');
        const packageJson = extension?.packageJSON;
        const contextMenus = packageJson?.contributes?.menus?.['editor/context'];

        assert.ok(contextMenus && contextMenus.length > 0, 'Editor context menus should exist');

        const runQueryContext = contextMenus?.find((m: any) => m.command === 'queryStudio.runQuery');
        assert.ok(runQueryContext, 'Run query should be in context menu');
    });

    test('View title menu should have refresh commands', () => {
        const extension = vscode.extensions.getExtension('inbar-rotem.query-studio');
        const packageJson = extension?.packageJSON;
        const viewTitleMenus = packageJson?.contributes?.menus?.['view/title'];

        assert.ok(viewTitleMenus && viewTitleMenus.length > 0, 'View title menus should exist');

        const refreshClusters = viewTitleMenus?.find((m: any) => m.command === 'queryStudio.refreshClusters');
        assert.ok(refreshClusters, 'Refresh clusters should be in view title menu');
    });
});
