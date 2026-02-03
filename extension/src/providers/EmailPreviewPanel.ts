import * as vscode from 'vscode';

export interface MailPreviewData {
    subject?: string;
    from?: string;
    fromEmail?: string;
    to?: string;
    cc?: string;
    receivedTime?: string;
    body?: string;
    htmlBody?: string;
    hasAttachments?: boolean;
    attachmentCount?: number;
    importance?: string;
    isRead?: boolean;
    error?: string;
}

/**
 * Email Preview Panel - Shows email content in a webview panel
 */
export class EmailPreviewPanel {
    public static currentPanel: EmailPreviewPanel | undefined;
    public static readonly viewType = 'querystudio.emailPreviewPanel';

    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private _onOpenInOutlook?: (entryId: string) => void;
    private _onMarkAsRead?: (entryId: string, markAsRead: boolean) => Promise<boolean>;
    private _currentEntryId?: string;
    private _currentIsRead?: boolean;

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri
    ) {
        this._panel = panel;
        this._extensionUri = extensionUri;

        this._panel.webview.html = this._getLoadingHtml();

        // Listen for when the panel is disposed
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        // Handle messages from the webview
        this._panel.webview.onDidReceiveMessage(
            message => this._handleMessage(message),
            null,
            this._disposables
        );
    }

    public static createOrShow(extensionUri: vscode.Uri): EmailPreviewPanel {
        const column = vscode.ViewColumn.Beside;

        // If we already have a panel, show it
        if (EmailPreviewPanel.currentPanel) {
            EmailPreviewPanel.currentPanel._panel.reveal(column);
            return EmailPreviewPanel.currentPanel;
        }

        // Create a new panel
        const panel = vscode.window.createWebviewPanel(
            EmailPreviewPanel.viewType,
            'Email Preview',
            {
                viewColumn: column,
                preserveFocus: true
            },
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri]
            }
        );

        EmailPreviewPanel.currentPanel = new EmailPreviewPanel(panel, extensionUri);
        return EmailPreviewPanel.currentPanel;
    }

    public setOnOpenInOutlook(callback: (entryId: string) => void) {
        this._onOpenInOutlook = callback;
    }

    public setOnMarkAsRead(callback: (entryId: string, markAsRead: boolean) => Promise<boolean>) {
        this._onMarkAsRead = callback;
    }

    public showPreview(data: MailPreviewData, entryId: string) {
        this._currentEntryId = entryId;
        this._currentIsRead = data.isRead;
        this._panel.title = data.subject || 'Email Preview';
        this._panel.webview.html = this._getHtmlForEmail(data);
    }

    public updateReadStatus(isRead: boolean) {
        this._currentIsRead = isRead;
        this._panel.webview.postMessage({ command: 'updateReadStatus', isRead });
    }

    public showLoading() {
        this._panel.webview.html = this._getLoadingHtml();
    }

    public showError(error: string) {
        this._panel.webview.html = this._getErrorHtml(error);
    }

    private async _handleMessage(message: any) {
        switch (message.command) {
            case 'openInOutlook':
                if (this._onOpenInOutlook && this._currentEntryId) {
                    this._onOpenInOutlook(this._currentEntryId);
                }
                break;
            case 'copyText':
                vscode.env.clipboard.writeText(message.text);
                vscode.window.showInformationMessage('Copied to clipboard');
                break;
            case 'markAsRead':
                if (this._onMarkAsRead && this._currentEntryId) {
                    const success = await this._onMarkAsRead(this._currentEntryId, message.markAsRead);
                    if (success) {
                        this.updateReadStatus(message.markAsRead);
                        vscode.window.showInformationMessage(
                            message.markAsRead ? 'Marked as read' : 'Marked as unread'
                        );
                    }
                }
                break;
        }
    }

    private _getLoadingHtml(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body {
            font-family: var(--vscode-font-family);
            padding: 20px;
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            margin: 0;
        }
        .loading {
            text-align: center;
        }
        .spinner {
            width: 40px;
            height: 40px;
            border: 4px solid var(--vscode-input-border);
            border-top-color: var(--vscode-focusBorder);
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin: 0 auto 16px;
        }
        @keyframes spin {
            to { transform: rotate(360deg); }
        }
    </style>
</head>
<body>
    <div class="loading">
        <div class="spinner"></div>
        <div>Loading email...</div>
    </div>
</body>
</html>`;
    }

    private _getErrorHtml(error: string): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body {
            font-family: var(--vscode-font-family);
            padding: 20px;
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
        }
        .error {
            background-color: var(--vscode-inputValidation-errorBackground);
            border: 1px solid var(--vscode-inputValidation-errorBorder);
            padding: 16px;
            border-radius: 4px;
        }
    </style>
</head>
<body>
    <div class="error">
        <strong>Error loading email:</strong><br>
        ${this._escapeHtml(error)}
    </div>
</body>
</html>`;
    }

    private _getHtmlForEmail(data: MailPreviewData): string {
        const importance = data.importance === 'High' ? '🔴 High' :
                          data.importance === 'Low' ? '🔵 Low' : '';

        const attachmentBadge = data.hasAttachments
            ? `<span class="badge attachment">📎 ${data.attachmentCount} attachment${data.attachmentCount !== 1 ? 's' : ''}</span>`
            : '';

        // Prefer HTML body if available, otherwise use plain text
        const bodyContent = data.htmlBody
            ? `<iframe id="emailBody" sandbox="allow-same-origin" srcdoc="${this._escapeHtml(data.htmlBody)}"></iframe>`
            : `<pre class="plain-body">${this._escapeHtml(data.body || '')}</pre>`;

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        * {
            box-sizing: border-box;
        }
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            padding: 0;
            margin: 0;
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            height: 100vh;
            display: flex;
            flex-direction: column;
        }
        .toolbar {
            display: flex;
            gap: 8px;
            padding: 8px 16px;
            background-color: var(--vscode-sideBar-background);
            border-bottom: 1px solid var(--vscode-panel-border);
            flex-shrink: 0;
        }
        .toolbar button {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: none;
            padding: 6px 12px;
            cursor: pointer;
            border-radius: 4px;
            font-size: 12px;
        }
        .toolbar button:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }
        .toolbar button.primary {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        .toolbar button.primary:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        .header {
            padding: 16px;
            background-color: var(--vscode-sideBar-background);
            border-bottom: 1px solid var(--vscode-panel-border);
            flex-shrink: 0;
        }
        .subject {
            font-size: 18px;
            font-weight: 600;
            margin-bottom: 12px;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .meta {
            display: grid;
            grid-template-columns: auto 1fr;
            gap: 4px 12px;
            font-size: 13px;
        }
        .meta-label {
            color: var(--vscode-descriptionForeground);
            font-weight: 500;
        }
        .meta-value {
            word-break: break-word;
        }
        .badge {
            display: inline-block;
            padding: 2px 8px;
            border-radius: 12px;
            font-size: 11px;
            font-weight: 500;
        }
        .badge.attachment {
            background-color: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
        }
        .badge.importance {
            background-color: var(--vscode-inputValidation-warningBackground);
        }
        .badge.read {
            background-color: var(--vscode-testing-iconPassed, #4caf50);
            color: white;
            margin-left: auto;
        }
        .badge.unread {
            background-color: var(--vscode-inputValidation-infoBorder, #2196f3);
            color: white;
            margin-left: auto;
        }
        .body-container {
            flex: 1;
            overflow: auto;
            padding: 0;
        }
        #emailBody {
            width: 100%;
            height: 100%;
            border: none;
            background-color: white;
        }
        #emailBody.dark-mode {
            filter: invert(1) hue-rotate(180deg);
        }
        .theme-toggle {
            margin-left: auto;
        }
        .plain-body {
            padding: 16px;
            margin: 0;
            white-space: pre-wrap;
            word-wrap: break-word;
            font-family: var(--vscode-editor-font-family);
            font-size: var(--vscode-editor-font-size);
            line-height: 1.5;
        }
    </style>
</head>
<body>
    <div class="toolbar">
        <button class="primary" onclick="openInOutlook()">📧 Open in Outlook</button>
        <button id="readStatusBtn" onclick="toggleReadStatus()">${data.isRead ? '📭 Mark Unread' : '📬 Mark Read'}</button>
        <button onclick="copySubject()">📋 Copy Subject</button>
        <button onclick="toggleView()">🔄 Toggle HTML/Text</button>
        <button class="theme-toggle" onclick="toggleDarkMode()" id="darkModeBtn">☀️ Light</button>
        <span id="readBadge" class="badge ${data.isRead ? 'read' : 'unread'}">${data.isRead ? '✓ Read' : '● Unread'}</span>
    </div>
    <div class="header">
        <div class="subject">
            ${this._escapeHtml(data.subject || '(No Subject)')}
            ${importance ? `<span class="badge importance">${importance}</span>` : ''}
            ${attachmentBadge}
        </div>
        <div class="meta">
            <span class="meta-label">From:</span>
            <span class="meta-value">${this._escapeHtml(data.from || '')} ${data.fromEmail ? `&lt;${this._escapeHtml(data.fromEmail)}&gt;` : ''}</span>

            <span class="meta-label">To:</span>
            <span class="meta-value">${this._escapeHtml(data.to || '')}</span>

            ${data.cc ? `
            <span class="meta-label">CC:</span>
            <span class="meta-value">${this._escapeHtml(data.cc)}</span>
            ` : ''}

            <span class="meta-label">Date:</span>
            <span class="meta-value">${this._escapeHtml(data.receivedTime || '')}</span>
        </div>
    </div>
    <div class="body-container">
        ${bodyContent}
    </div>
    <script>
        const vscode = acquireVsCodeApi();
        let showingHtml = ${data.htmlBody ? 'true' : 'false'};
        const htmlBody = ${JSON.stringify(data.htmlBody || '')};
        const textBody = ${JSON.stringify(data.body || '')};

        function openInOutlook() {
            vscode.postMessage({ command: 'openInOutlook' });
        }

        function copySubject() {
            vscode.postMessage({ command: 'copyText', text: ${JSON.stringify(data.subject || '')} });
        }

        function toggleView() {
            showingHtml = !showingHtml;
            const container = document.querySelector('.body-container');
            if (showingHtml && htmlBody) {
                container.innerHTML = '<iframe id="emailBody" sandbox="allow-same-origin" srcdoc="' + htmlBody.replace(/"/g, '&quot;') + '"></iframe>';
                // Re-apply dark mode if enabled
                if (isDarkMode) {
                    const iframe = document.getElementById('emailBody');
                    if (iframe) iframe.classList.add('dark-mode');
                }
            } else {
                container.innerHTML = '<pre class="plain-body">' + escapeHtml(textBody) + '</pre>';
            }
        }

        let isDarkMode = true;  // Default to dark mode
        function toggleDarkMode() {
            isDarkMode = !isDarkMode;
            const iframe = document.getElementById('emailBody');
            const btn = document.getElementById('darkModeBtn');
            if (iframe) {
                if (isDarkMode) {
                    iframe.classList.add('dark-mode');
                } else {
                    iframe.classList.remove('dark-mode');
                }
            }
            if (btn) {
                btn.textContent = isDarkMode ? '☀️ Light' : '🌙 Dark';
            }
        }
        // Apply dark mode on initial load
        setTimeout(() => {
            const iframe = document.getElementById('emailBody');
            if (iframe && isDarkMode) {
                iframe.classList.add('dark-mode');
            }
        }, 100);

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        let isRead = ${data.isRead ? 'true' : 'false'};

        function toggleReadStatus() {
            vscode.postMessage({ command: 'markAsRead', markAsRead: !isRead });
        }

        // Listen for messages from the extension
        window.addEventListener('message', event => {
            const message = event.data;
            if (message.command === 'updateReadStatus') {
                isRead = message.isRead;
                const btn = document.getElementById('readStatusBtn');
                const badge = document.getElementById('readBadge');
                if (btn) {
                    btn.textContent = isRead ? '📭 Mark Unread' : '📬 Mark Read';
                }
                if (badge) {
                    badge.textContent = isRead ? '✓ Read' : '● Unread';
                    badge.className = 'badge ' + (isRead ? 'read' : 'unread');
                }
            }
        });
    </script>
</body>
</html>`;
    }

    private _escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    public dispose() {
        EmailPreviewPanel.currentPanel = undefined;

        this._panel.dispose();

        while (this._disposables.length) {
            const disposable = this._disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }
}
