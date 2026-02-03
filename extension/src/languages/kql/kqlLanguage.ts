import * as vscode from 'vscode';
import { SidecarClient } from '../../sidecar/SidecarClient';
import { KqlCompletionProvider } from './kqlCompletionProvider';
import { KqlHoverProvider } from './kqlHoverProvider';

export function registerKqlLanguage(context: vscode.ExtensionContext, client: SidecarClient) {
    // Register completion provider for all schemes
    const completionProvider = new KqlCompletionProvider(client);

    // Register without trigger characters to enable completions while typing
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            { language: 'kql' },
            completionProvider
        )
    );

    // Also register with specific triggers for immediate popup on these characters
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            { language: 'kql' },
            completionProvider,
            '.', '|', ' ', '('
        )
    );

    // Register hover provider
    const hoverProvider = new KqlHoverProvider();
    context.subscriptions.push(
        vscode.languages.registerHoverProvider(
            { language: 'kql' },
            hoverProvider
        )
    );

    // Register document formatting
    context.subscriptions.push(
        vscode.languages.registerDocumentFormattingEditProvider(
            { language: 'kql' },
            {
                provideDocumentFormattingEdits(document: vscode.TextDocument): vscode.TextEdit[] {
                    return formatKqlDocument(document);
                }
            }
        )
    );
}

function formatKqlDocument(document: vscode.TextDocument): vscode.TextEdit[] {
    const edits: vscode.TextEdit[] = [];
    const text = document.getText();

    // Simple formatting rules
    let formatted = text
        // Ensure pipes are on new lines
        .replace(/\s*\|\s*/g, '\n| ')
        // Clean up multiple spaces
        .replace(/  +/g, ' ')
        // Clean up multiple newlines
        .replace(/\n\n+/g, '\n\n')
        // Trim trailing whitespace
        .replace(/[ \t]+$/gm, '');

    if (formatted !== text) {
        const fullRange = new vscode.Range(
            document.positionAt(0),
            document.positionAt(text.length)
        );
        edits.push(vscode.TextEdit.replace(fullRange, formatted));
    }

    return edits;
}
