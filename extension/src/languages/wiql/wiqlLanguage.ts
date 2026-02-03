import * as vscode from 'vscode';
import { SidecarClient } from '../../sidecar/SidecarClient';
import { WiqlCompletionProvider } from './wiqlCompletionProvider';

export function registerWiqlLanguage(context: vscode.ExtensionContext, client: SidecarClient) {
    // Register completion provider
    const completionProvider = new WiqlCompletionProvider();
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            { language: 'wiql', scheme: 'file' },
            completionProvider,
            '[', '.', ' '
        ),
        vscode.languages.registerCompletionItemProvider(
            { language: 'wiql', scheme: 'untitled' },
            completionProvider,
            '[', '.', ' '
        )
    );

    // Register document formatting
    context.subscriptions.push(
        vscode.languages.registerDocumentFormattingEditProvider(
            { language: 'wiql' },
            {
                provideDocumentFormattingEdits(document: vscode.TextDocument): vscode.TextEdit[] {
                    return formatWiqlDocument(document);
                }
            }
        )
    );
}

function formatWiqlDocument(document: vscode.TextDocument): vscode.TextEdit[] {
    const edits: vscode.TextEdit[] = [];
    const text = document.getText();

    // Simple formatting rules for WIQL
    let formatted = text
        // Uppercase keywords
        .replace(/\b(select|from|where|order by|group by|asof|mode|and|or|not|in|ever|under|contains|asc|desc)\b/gi,
            match => match.toUpperCase())
        // Clean up multiple spaces
        .replace(/  +/g, ' ')
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
