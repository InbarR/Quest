import * as vscode from 'vscode';
import { SidecarClient, AiChatRequest } from '../sidecar/SidecarClient';

let chatSessionId: string | undefined;

export function registerAiCommands(
    context: vscode.ExtensionContext,
    client: SidecarClient,
    outputChannel: vscode.OutputChannel
) {
    // Note: queryStudio.aiChat is registered in extension.ts (opens panel in right sidebar)

    // AI Explain Query
    context.subscriptions.push(
        vscode.commands.registerCommand('queryStudio.aiExplain', async () => {
            const config = vscode.workspace.getConfiguration('queryStudio');
            if (!config.get('ai.enabled')) {
                vscode.window.showWarningMessage('AI features are disabled. Enable them in settings.');
                return;
            }

            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('No active editor');
                return;
            }

            const selection = editor.selection;
            const query = selection.isEmpty
                ? editor.document.getText()
                : editor.document.getText(selection);

            if (!query.trim()) {
                vscode.window.showWarningMessage('No query to explain');
                return;
            }

            try {
                outputChannel.appendLine('Asking AI to explain query...');

                const request: AiChatRequest = {
                    message: `Please explain this query in detail. What does it do? What are the key operations?\n\n${query}`,
                    sessionId: chatSessionId
                };

                const response = await client.aiChat(request);
                chatSessionId = response.sessionId;

                // Show explanation in output channel
                outputChannel.appendLine('--- Query Explanation ---');
                outputChannel.appendLine(response.message);
                outputChannel.appendLine('-------------------------');
                outputChannel.show();

                vscode.window.showInformationMessage('Query explanation shown in Output panel');
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Unknown error';
                outputChannel.appendLine(`AI Error: ${message}`);
                vscode.window.showErrorMessage(`Failed to explain query: ${message}`);
            }
        })
    );

    // AI Generate Query
    context.subscriptions.push(
        vscode.commands.registerCommand('queryStudio.aiGenerate', async () => {
            const config = vscode.workspace.getConfiguration('queryStudio');
            if (!config.get('ai.enabled')) {
                vscode.window.showWarningMessage('AI features are disabled. Enable them in settings.');
                return;
            }

            const description = await vscode.window.showInputBox({
                prompt: 'Describe the query you want to generate',
                placeHolder: 'e.g., "Count errors by error code in the last 24 hours"'
            });

            if (!description) {
                return;
            }

            // Ask for query type
            const queryType = await vscode.window.showQuickPick(
                [
                    { label: 'KQL (Kusto)', value: 'kql' },
                    { label: 'WIQL (Azure DevOps)', value: 'wiql' }
                ],
                { placeHolder: 'Select query language' }
            );

            if (!queryType) {
                return;
            }

            try {
                outputChannel.appendLine(`Generating ${queryType.value} query: ${description}`);

                const languageContext = queryType.value === 'kql'
                    ? 'Generate a KQL (Kusto Query Language) query.'
                    : 'Generate a WIQL (Work Item Query Language) query for Azure DevOps.';

                const request: AiChatRequest = {
                    message: `${languageContext}\n\nRequirement: ${description}\n\nProvide only the query code, no explanation.`,
                    sessionId: chatSessionId
                };

                const response = await client.aiChat(request);
                chatSessionId = response.sessionId;

                // Extract query from response (it might be in a code block)
                let generatedQuery = response.suggestedQuery || response.message;

                // Clean up markdown code blocks if present
                generatedQuery = generatedQuery
                    .replace(/```(?:kql|kusto|wiql|sql)?\n?/g, '')
                    .replace(/```/g, '')
                    .trim();

                // Insert into new document
                await insertQuery(generatedQuery, queryType.value as 'kql' | 'wiql');

                outputChannel.appendLine('Query generated successfully');
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Unknown error';
                outputChannel.appendLine(`AI Error: ${message}`);
                vscode.window.showErrorMessage(`Failed to generate query: ${message}`);
            }
        })
    );
}

async function insertQuery(query: string, language: 'kql' | 'wiql' = 'kql') {
    const editor = vscode.window.activeTextEditor;

    if (editor && (editor.document.languageId === 'kql' || editor.document.languageId === 'wiql')) {
        // Insert at cursor position in existing document
        await editor.edit(editBuilder => {
            if (editor.selection.isEmpty) {
                editBuilder.insert(editor.selection.active, query);
            } else {
                editBuilder.replace(editor.selection, query);
            }
        });
    } else {
        // Create new document
        const doc = await vscode.workspace.openTextDocument({
            language: language,
            content: query
        });
        await vscode.window.showTextDocument(doc);
    }
}
