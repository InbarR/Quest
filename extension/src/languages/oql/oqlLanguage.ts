import * as vscode from 'vscode';
import { SidecarClient } from '../../sidecar/SidecarClient';
import { OqlCompletionProvider } from './oqlCompletionProvider';

export function registerOqlLanguage(context: vscode.ExtensionContext, client: SidecarClient) {
    // Register completion provider for all schemes
    // Note: Not specifying trigger characters allows VS Code to show completions as user types
    // We register with specific triggers for pipe/space context, plus a general provider for typing
    const completionProvider = new OqlCompletionProvider();

    // Register for file scheme (regular files)
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            { language: 'oql', scheme: 'file' },
            completionProvider
        )
    );

    // Register for untitled scheme (new unsaved files)
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            { language: 'oql', scheme: 'untitled' },
            completionProvider
        )
    );

    // Register for vscode-userdata scheme (globalStorage files)
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            { language: 'oql', scheme: 'vscode-userdata' },
            completionProvider
        )
    );

    // Also register with specific triggers for immediate popup on pipe and space
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            { language: 'oql' },
            completionProvider,
            '|', ' '
        )
    );

    // Register document formatting
    context.subscriptions.push(
        vscode.languages.registerDocumentFormattingEditProvider(
            { language: 'oql' },
            {
                provideDocumentFormattingEdits(document: vscode.TextDocument): vscode.TextEdit[] {
                    return formatOqlDocument(document);
                }
            }
        )
    );
}

function formatOqlDocument(document: vscode.TextDocument): vscode.TextEdit[] {
    const edits: vscode.TextEdit[] = [];
    const text = document.getText();

    // Simple formatting rules for OQL (KQL-like)
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
