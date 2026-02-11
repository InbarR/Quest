import * as vscode from 'vscode';

/**
 * Feedback Panel - Allows users to send feedback, bug reports, and feature requests
 */
export class FeedbackPanel {
    public static currentPanel: FeedbackPanel | undefined;
    public static readonly viewType = 'querystudio.feedbackPanel';

    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri
    ) {
        this._panel = panel;
        this._extensionUri = extensionUri;

        this._panel.webview.html = this._getHtml();

        // Listen for when the panel is disposed
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        // Handle messages from the webview
        this._panel.webview.onDidReceiveMessage(
            message => this._handleMessage(message),
            null,
            this._disposables
        );
    }

    public static createOrShow(extensionUri: vscode.Uri): FeedbackPanel {
        const column = vscode.ViewColumn.Active;

        // If we already have a panel, show it
        if (FeedbackPanel.currentPanel) {
            FeedbackPanel.currentPanel._panel.reveal(column);
            return FeedbackPanel.currentPanel;
        }

        // Create a new panel
        const panel = vscode.window.createWebviewPanel(
            FeedbackPanel.viewType,
            'Send Feedback - Quest',
            column,
            {
                enableScripts: true,
                retainContextWhenHidden: false,
                localResourceRoots: [extensionUri]
            }
        );

        FeedbackPanel.currentPanel = new FeedbackPanel(panel, extensionUri);
        return FeedbackPanel.currentPanel;
    }

    private async _handleMessage(message: any) {
        switch (message.command) {
            case 'submit':
                await this._submitFeedback(message.data);
                break;
            case 'cancel':
                this._panel.dispose();
                break;
            case 'openGitHub':
                vscode.env.openExternal(vscode.Uri.parse('https://github.com/InbarR/Quest/issues/new'));
                break;
        }
    }

    private async _submitFeedback(data: { type: string; title: string; description: string; email: string }) {
        const config = vscode.workspace.getConfiguration('queryStudio');
        const formspreeId = config.get<string>('feedbackFormId');

        // If no form ID configured, use email fallback
        if (!formspreeId) {
            const subject = encodeURIComponent(`[Quest ${data.type}] ${data.title}`);
            const systemInfo = `VS Code: ${vscode.version}, Platform: ${process.platform}`;
            const body = encodeURIComponent(`${data.description}\n\n---\nType: ${data.type}\nFrom: ${data.email || 'not provided'}\n${systemInfo}`);
            await vscode.env.openExternal(vscode.Uri.parse(`mailto:inbar.rose@gmail.com?subject=${subject}&body=${body}`));
            this._panel.webview.postMessage({ command: 'success' });
            vscode.window.showInformationMessage('Opening email client to send feedback...');
            setTimeout(() => this._panel.dispose(), 1500);
            return;
        }

        try {
            // Show progress
            this._panel.webview.postMessage({ command: 'submitting' });

            // Get system info
            const systemInfo = {
                vscodeVersion: vscode.version,
                platform: process.platform,
                extensionVersion: vscode.extensions.getExtension('inbarr.query-studio')?.packageJSON?.version || 'unknown'
            };

            const payload = {
                type: data.type,
                title: data.title,
                description: data.description,
                email: data.email || 'not provided',
                ...systemInfo,
                _subject: `[Quest ${data.type}] ${data.title}`
            };

            // Submit to Formspree
            const response = await fetch(`https://formspree.io/f/${formspreeId}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify(payload)
            });

            if (response.ok) {
                this._panel.webview.postMessage({ command: 'success' });
                vscode.window.showInformationMessage('Thank you for your feedback!');

                // Close panel after a short delay
                setTimeout(() => {
                    this._panel.dispose();
                }, 2000);
            } else {
                const errorText = await response.text();
                throw new Error(`Server responded with ${response.status}: ${errorText}`);
            }
        } catch (error: any) {
            console.error('Feedback submission error:', error);
            this._panel.webview.postMessage({
                command: 'error',
                message: error.message || 'Failed to submit feedback'
            });

            // Offer email fallback
            const action = await vscode.window.showErrorMessage(
                'Failed to submit feedback. Would you like to send via email instead?',
                'Send Email',
                'Cancel'
            );

            if (action === 'Send Email') {
                const subject = encodeURIComponent(`[Quest ${data.type}] ${data.title}`);
                const body = encodeURIComponent(`${data.description}\n\n---\nType: ${data.type}\nEmail: ${data.email || 'not provided'}`);
                vscode.env.openExternal(vscode.Uri.parse(`mailto:quest.feedback@outlook.com?subject=${subject}&body=${body}`));
            }
        }
    }

    private _getHtml(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Send Feedback</title>
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
            min-height: 100vh;
            display: flex;
            justify-content: center;
            align-items: flex-start;
            padding: 40px 20px;
        }
        .container {
            max-width: 600px;
            width: 100%;
        }
        h1 {
            font-size: 24px;
            margin: 0 0 8px 0;
            display: flex;
            align-items: center;
            gap: 12px;
        }
        .subtitle {
            color: var(--vscode-descriptionForeground);
            margin-bottom: 24px;
        }
        .form-group {
            margin-bottom: 20px;
        }
        label {
            display: block;
            margin-bottom: 6px;
            font-weight: 500;
        }
        .required::after {
            content: ' *';
            color: var(--vscode-errorForeground);
        }
        input[type="text"],
        input[type="email"],
        textarea,
        select {
            width: 100%;
            padding: 10px 12px;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            font-family: inherit;
            font-size: inherit;
        }
        input:focus,
        textarea:focus,
        select:focus {
            outline: none;
            border-color: var(--vscode-focusBorder);
        }
        textarea {
            min-height: 150px;
            resize: vertical;
        }
        select {
            cursor: pointer;
        }
        .type-buttons {
            display: flex;
            gap: 8px;
            flex-wrap: wrap;
        }
        .type-btn {
            flex: 1;
            min-width: 120px;
            padding: 12px 16px;
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: 2px solid transparent;
            border-radius: 6px;
            cursor: pointer;
            text-align: center;
            transition: all 0.2s;
        }
        .type-btn:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }
        .type-btn.selected {
            border-color: var(--vscode-focusBorder);
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        .type-btn .icon {
            font-size: 24px;
            display: block;
            margin-bottom: 4px;
        }
        .buttons {
            display: flex;
            gap: 12px;
            margin-top: 24px;
        }
        button {
            padding: 10px 20px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: inherit;
            font-family: inherit;
        }
        .btn-primary {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            flex: 1;
        }
        .btn-primary:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        .btn-primary:disabled {
            opacity: 0.6;
            cursor: not-allowed;
        }
        .btn-secondary {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        .btn-secondary:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }
        .github-link {
            margin-top: 20px;
            padding-top: 20px;
            border-top: 1px solid var(--vscode-panel-border);
            text-align: center;
            color: var(--vscode-descriptionForeground);
        }
        .github-link a {
            color: var(--vscode-textLink-foreground);
            cursor: pointer;
        }
        .github-link a:hover {
            color: var(--vscode-textLink-activeForeground);
        }
        .status {
            padding: 12px 16px;
            border-radius: 4px;
            margin-top: 16px;
            display: none;
        }
        .status.show {
            display: block;
        }
        .status.success {
            background-color: var(--vscode-testing-iconPassed, #4caf50);
            color: white;
        }
        .status.error {
            background-color: var(--vscode-inputValidation-errorBackground);
            border: 1px solid var(--vscode-inputValidation-errorBorder);
        }
        .status.submitting {
            background-color: var(--vscode-inputValidation-infoBackground);
            border: 1px solid var(--vscode-inputValidation-infoBorder);
        }
        .spinner {
            display: inline-block;
            width: 14px;
            height: 14px;
            border: 2px solid currentColor;
            border-top-color: transparent;
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
            margin-right: 8px;
            vertical-align: middle;
        }
        @keyframes spin {
            to { transform: rotate(360deg); }
        }
        .helper-text {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            margin-top: 4px;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>
            <span>📬</span>
            Send Feedback
        </h1>
        <p class="subtitle">Help improve Quest by sharing your thoughts, reporting bugs, or suggesting features.</p>

        <form id="feedbackForm">
            <div class="form-group">
                <label class="required">What type of feedback is this?</label>
                <div class="type-buttons">
                    <button type="button" class="type-btn selected" data-type="Bug">
                        <span class="icon">🐛</span>
                        Bug Report
                    </button>
                    <button type="button" class="type-btn" data-type="Feature">
                        <span class="icon">💡</span>
                        Feature Request
                    </button>
                    <button type="button" class="type-btn" data-type="Question">
                        <span class="icon">❓</span>
                        Question
                    </button>
                    <button type="button" class="type-btn" data-type="Feedback">
                        <span class="icon">💬</span>
                        General Feedback
                    </button>
                </div>
            </div>

            <div class="form-group">
                <label for="title" class="required">Title</label>
                <input type="text" id="title" placeholder="Brief summary of your feedback" required>
            </div>

            <div class="form-group">
                <label for="description" class="required">Description</label>
                <textarea id="description" placeholder="Please provide details. For bugs, include steps to reproduce." required></textarea>
            </div>

            <div class="form-group">
                <label for="email">Email (optional)</label>
                <input type="email" id="email" placeholder="your@email.com">
                <div class="helper-text">If you'd like a response, please provide your email address.</div>
            </div>

            <div id="status" class="status"></div>

            <div class="buttons">
                <button type="button" class="btn-secondary" onclick="cancel()">Cancel</button>
                <button type="submit" class="btn-primary" id="submitBtn">Send Feedback</button>
            </div>
        </form>

        <div class="github-link">
            Or <a onclick="openGitHub()">create an issue on GitHub</a> if you have access
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let selectedType = 'Bug';

        // Type button selection
        document.querySelectorAll('.type-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.type-btn').forEach(b => b.classList.remove('selected'));
                btn.classList.add('selected');
                selectedType = btn.dataset.type;
            });
        });

        // Form submission
        document.getElementById('feedbackForm').addEventListener('submit', (e) => {
            e.preventDefault();

            const title = document.getElementById('title').value.trim();
            const description = document.getElementById('description').value.trim();
            const email = document.getElementById('email').value.trim();

            if (!title || !description) {
                showStatus('Please fill in all required fields.', 'error');
                return;
            }

            vscode.postMessage({
                command: 'submit',
                data: {
                    type: selectedType,
                    title,
                    description,
                    email
                }
            });
        });

        function cancel() {
            vscode.postMessage({ command: 'cancel' });
        }

        function openGitHub() {
            vscode.postMessage({ command: 'openGitHub' });
        }

        function showStatus(message, type) {
            const status = document.getElementById('status');
            status.className = 'status show ' + type;
            status.innerHTML = type === 'submitting'
                ? '<span class="spinner"></span>' + message
                : message;
        }

        function setSubmitEnabled(enabled) {
            document.getElementById('submitBtn').disabled = !enabled;
        }

        // Listen for messages from the extension
        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.command) {
                case 'submitting':
                    showStatus('Sending feedback...', 'submitting');
                    setSubmitEnabled(false);
                    break;
                case 'success':
                    showStatus('Thank you! Your feedback has been sent.', 'success');
                    break;
                case 'error':
                    showStatus('Error: ' + message.message, 'error');
                    setSubmitEnabled(true);
                    break;
            }
        });
    </script>
</body>
</html>`;
    }

    public dispose() {
        FeedbackPanel.currentPanel = undefined;

        this._panel.dispose();

        while (this._disposables.length) {
            const disposable = this._disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }
}
