import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { SidecarClient } from '../sidecar/SidecarClient';
import { getLogContent } from '../extension';

const FEEDBACK_EMAIL = 'inrotem@microsoft.com';

/**
 * Feedback Panel - Allows users to send feedback, bug reports, and feature requests.
 * Sends email directly via Outlook COM (sidecar) with optional screenshot and Quest log attachment.
 */
export class FeedbackPanel {
    public static currentPanel: FeedbackPanel | undefined;
    public static readonly viewType = 'querystudio.feedbackPanel';

    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _sidecarClient?: SidecarClient;
    private _screenshotPath?: string;
    private _disposables: vscode.Disposable[] = [];

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        sidecarClient?: SidecarClient
    ) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._sidecarClient = sidecarClient;

        this._panel.webview.html = this._getHtml();

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(
            message => this._handleMessage(message),
            null,
            this._disposables
        );
    }

    public static createOrShow(extensionUri: vscode.Uri, sidecarClient?: SidecarClient): FeedbackPanel {
        const column = vscode.ViewColumn.Active;

        if (FeedbackPanel.currentPanel) {
            FeedbackPanel.currentPanel._sidecarClient = sidecarClient;
            FeedbackPanel.currentPanel._panel.reveal(column);
            return FeedbackPanel.currentPanel;
        }

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

        FeedbackPanel.currentPanel = new FeedbackPanel(panel, extensionUri, sidecarClient);
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
            case 'pickScreenshot':
                await this._pickScreenshot();
                break;
            case 'pasteScreenshot':
                await this._pasteScreenshot();
                break;
            case 'removeScreenshot':
                this._screenshotPath = undefined;
                this._panel.webview.postMessage({ command: 'screenshotRemoved' });
                break;
        }
    }

    private async _pickScreenshot() {
        const result = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectMany: false,
            filters: { 'Images': ['png', 'jpg', 'jpeg', 'gif', 'bmp'] },
            title: 'Select Screenshot'
        });

        if (result && result.length > 0) {
            this._screenshotPath = result[0].fsPath;
            const fileName = path.basename(this._screenshotPath);
            this._panel.webview.postMessage({ command: 'screenshotPicked', fileName });
        }
    }

    private async _pasteScreenshot() {
        if (process.platform !== 'win32') {
            vscode.window.showWarningMessage('Clipboard paste is only supported on Windows.');
            return;
        }

        try {
            const tempPath = path.join(os.tmpdir(), `quest-screenshot-${Date.now()}.png`);
            // Use PowerShell to grab image from clipboard and save as PNG
            const psScript = `Add-Type -AssemblyName System.Windows.Forms; $img = [System.Windows.Forms.Clipboard]::GetImage(); if ($img) { $img.Save('${tempPath.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png); Write-Output 'OK' } else { Write-Output 'NO_IMAGE' }`;
            const result = execSync(`powershell -NoProfile -Command "${psScript}"`, { encoding: 'utf8', timeout: 5000 }).trim();

            if (result === 'OK' && fs.existsSync(tempPath)) {
                this._screenshotPath = tempPath;
                this._panel.webview.postMessage({ command: 'screenshotPicked', fileName: 'clipboard-screenshot.png' });
            } else {
                vscode.window.showWarningMessage('No image found in clipboard. Copy an image first.');
            }
        } catch {
            vscode.window.showWarningMessage('Failed to read image from clipboard.');
        }
    }

    private async _submitFeedback(data: { type: string; title: string; description: string; email: string }) {
        this._panel.webview.postMessage({ command: 'submitting' });

        const subject = `[Quest ${data.type}] ${data.title}`;
        const extVersion = vscode.extensions.getExtension('inbar-rotem.quest')?.packageJSON?.version || 'unknown';
        const systemInfo = `VS Code: ${vscode.version}, Platform: ${process.platform}, Extension: ${extVersion}`;
        const body = `${data.description}\n\n---\nType: ${data.type}\n${systemInfo}`;

        // Collect attachment paths
        const attachments: string[] = [];

        // Screenshot
        if (this._screenshotPath && fs.existsSync(this._screenshotPath)) {
            attachments.push(this._screenshotPath);
        }

        // Quest log - write to temp file
        let logTempPath: string | undefined;
        try {
            const logContent = getLogContent();
            if (logContent && logContent.length > 0) {
                logTempPath = path.join(os.tmpdir(), `quest-log-${Date.now()}.txt`);
                fs.writeFileSync(logTempPath, logContent, 'utf8');
                attachments.push(logTempPath);
            }
        } catch {
            // Non-critical, skip log attachment
        }

        // Try sending via Outlook COM (sidecar)
        if (this._sidecarClient && process.platform === 'win32') {
            try {
                const result = await this._sidecarClient.sendMail(
                    FEEDBACK_EMAIL,
                    subject,
                    body,
                    attachments.length > 0 ? attachments : undefined
                );

                if (result.success) {
                    this._panel.webview.postMessage({ command: 'success' });
                    vscode.window.showInformationMessage('Thank you! Your feedback has been sent via Outlook.');
                    this._cleanup(logTempPath);
                    setTimeout(() => this._panel.dispose(), 2000);
                    return;
                }

                // Outlook send failed - fall through to mailto
                console.error('Outlook send failed:', result.error);
            } catch (error) {
                console.error('Outlook send error:', error);
            }
        }

        // Fallback: open mailto
        const mailtoSubject = encodeURIComponent(subject);
        const mailtoBody = encodeURIComponent(body);
        await vscode.env.openExternal(vscode.Uri.parse(`mailto:${FEEDBACK_EMAIL}?subject=${mailtoSubject}&body=${mailtoBody}`));

        if (attachments.length > 0) {
            vscode.window.showInformationMessage(
                'Email client opened. Please manually attach the screenshot/log files.',
                'OK'
            );
        }

        this._panel.webview.postMessage({ command: 'success' });
        vscode.window.showInformationMessage('Opening email client to send feedback...');
        this._cleanup(logTempPath);
        setTimeout(() => this._panel.dispose(), 1500);
    }

    private _cleanup(logTempPath?: string) {
        // Clean up temp log file
        if (logTempPath) {
            try { fs.unlinkSync(logTempPath); } catch { }
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
        * { box-sizing: border-box; }
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            padding: 0; margin: 0;
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            min-height: 100vh;
            display: flex;
            justify-content: center;
            align-items: flex-start;
            padding: 40px 20px;
        }
        .container { max-width: 600px; width: 100%; }
        h1 { font-size: 24px; margin: 0 0 8px 0; display: flex; align-items: center; gap: 12px; }
        .subtitle { color: var(--vscode-descriptionForeground); margin-bottom: 24px; }
        .form-group { margin-bottom: 20px; }
        label { display: block; margin-bottom: 6px; font-weight: 500; }
        .required::after { content: ' *'; color: var(--vscode-errorForeground); }
        input[type="text"], input[type="email"], textarea, select {
            width: 100%; padding: 10px 12px;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px; font-family: inherit; font-size: inherit;
        }
        input:focus, textarea:focus, select:focus {
            outline: none; border-color: var(--vscode-focusBorder);
        }
        textarea { min-height: 150px; resize: vertical; }
        .type-buttons { display: flex; gap: 8px; flex-wrap: wrap; }
        .type-btn {
            flex: 1; min-width: 120px; padding: 12px 16px;
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: 2px solid transparent; border-radius: 6px;
            cursor: pointer; text-align: center; transition: all 0.2s;
        }
        .type-btn:hover { background-color: var(--vscode-button-secondaryHoverBackground); }
        .type-btn.selected {
            border-color: var(--vscode-focusBorder);
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        .type-btn .icon { font-size: 24px; display: block; margin-bottom: 4px; }
        .buttons { display: flex; gap: 12px; margin-top: 24px; }
        button {
            padding: 10px 20px; border: none; border-radius: 4px;
            cursor: pointer; font-size: inherit; font-family: inherit;
        }
        .btn-primary {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground); flex: 1;
        }
        .btn-primary:hover { background-color: var(--vscode-button-hoverBackground); }
        .btn-primary:disabled { opacity: 0.6; cursor: not-allowed; }
        .btn-secondary {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        .btn-secondary:hover { background-color: var(--vscode-button-secondaryHoverBackground); }
        .github-link {
            margin-top: 20px; padding-top: 20px;
            border-top: 1px solid var(--vscode-panel-border);
            text-align: center; color: var(--vscode-descriptionForeground);
        }
        .github-link a { color: var(--vscode-textLink-foreground); cursor: pointer; }
        .github-link a:hover { color: var(--vscode-textLink-activeForeground); }
        .status { padding: 12px 16px; border-radius: 4px; margin-top: 16px; display: none; }
        .status.show { display: block; }
        .status.success { background-color: var(--vscode-testing-iconPassed, #4caf50); color: white; }
        .status.error { background-color: var(--vscode-inputValidation-errorBackground); border: 1px solid var(--vscode-inputValidation-errorBorder); }
        .status.submitting { background-color: var(--vscode-inputValidation-infoBackground); border: 1px solid var(--vscode-inputValidation-infoBorder); }
        .spinner {
            display: inline-block; width: 14px; height: 14px;
            border: 2px solid currentColor; border-top-color: transparent;
            border-radius: 50%; animation: spin 0.8s linear infinite;
            margin-right: 8px; vertical-align: middle;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
        .helper-text { font-size: 12px; color: var(--vscode-descriptionForeground); margin-top: 4px; }
        .screenshot-row { display: flex; align-items: center; gap: 8px; }
        .screenshot-name {
            flex: 1; padding: 8px 12px;
            background-color: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px; color: var(--vscode-descriptionForeground);
            overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .screenshot-name.has-file { color: var(--vscode-foreground); }
        .btn-small {
            padding: 8px 12px; font-size: 12px;
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: none; border-radius: 4px; cursor: pointer;
        }
        .btn-small:hover { background-color: var(--vscode-button-secondaryHoverBackground); }
        .btn-remove { color: var(--vscode-errorForeground); }
        .attachment-info {
            font-size: 12px; color: var(--vscode-descriptionForeground);
            margin-top: 8px; padding: 8px 12px;
            background-color: var(--vscode-input-background);
            border-radius: 4px;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>
            Send Feedback
        </h1>
        <p class="subtitle">Help improve Quest by sharing your thoughts, reporting bugs, or suggesting features.</p>

        <form id="feedbackForm">
            <div class="form-group">
                <label class="required">What type of feedback is this?</label>
                <div class="type-buttons">
                    <button type="button" class="type-btn selected" data-type="Bug">
                        <span class="icon">Bug</span>
                        Bug Report
                    </button>
                    <button type="button" class="type-btn" data-type="Feature">
                        <span class="icon">Idea</span>
                        Feature Request
                    </button>
                    <button type="button" class="type-btn" data-type="Question">
                        <span class="icon">?</span>
                        Question
                    </button>
                    <button type="button" class="type-btn" data-type="Feedback">
                        <span class="icon">Chat</span>
                        General
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
                <label>Screenshot (optional)</label>
                <div class="screenshot-row">
                    <div id="screenshotName" class="screenshot-name">No file selected</div>
                    <button type="button" class="btn-small" onclick="pickScreenshot()">Browse...</button>
                    <button type="button" class="btn-small" onclick="pasteScreenshot()">Paste</button>
                    <button type="button" class="btn-small btn-remove" id="removeScreenshotBtn" onclick="removeScreenshot()" style="display:none">X</button>
                </div>
            </div>

            <div class="attachment-info">
                Quest log will be automatically attached to help diagnose issues.
            </div>

            <div id="status" class="status"></div>

            <div class="buttons">
                <button type="button" class="btn-secondary" onclick="cancel()">Cancel</button>
                <button type="submit" class="btn-primary" id="submitBtn">Send Feedback</button>
            </div>
        </form>

        <div class="github-link">
            Or <a onclick="openGitHub()">create an issue on GitHub</a> using your personal GitHub account
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let selectedType = 'Bug';

        document.querySelectorAll('.type-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.type-btn').forEach(b => b.classList.remove('selected'));
                btn.classList.add('selected');
                selectedType = btn.dataset.type;
            });
        });

        document.getElementById('feedbackForm').addEventListener('submit', (e) => {
            e.preventDefault();
            const title = document.getElementById('title').value.trim();
            const description = document.getElementById('description').value.trim();
            const email = '';

            if (!title || !description) {
                showStatus('Please fill in all required fields.', 'error');
                return;
            }

            vscode.postMessage({
                command: 'submit',
                data: { type: selectedType, title, description, email }
            });
        });

        function cancel() { vscode.postMessage({ command: 'cancel' }); }
        function openGitHub() { vscode.postMessage({ command: 'openGitHub' }); }
        function pickScreenshot() { vscode.postMessage({ command: 'pickScreenshot' }); }
        function pasteScreenshot() { vscode.postMessage({ command: 'pasteScreenshot' }); }
        function removeScreenshot() { vscode.postMessage({ command: 'removeScreenshot' }); }

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
                case 'screenshotPicked':
                    document.getElementById('screenshotName').textContent = message.fileName;
                    document.getElementById('screenshotName').classList.add('has-file');
                    document.getElementById('removeScreenshotBtn').style.display = '';
                    break;
                case 'screenshotRemoved':
                    document.getElementById('screenshotName').textContent = 'No file selected';
                    document.getElementById('screenshotName').classList.remove('has-file');
                    document.getElementById('removeScreenshotBtn').style.display = 'none';
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
