import * as vscode from 'vscode';

/**
 * Captures images from the clipboard using a webview.
 * VS Code's native clipboard API only supports text, so we use a webview
 * to access the browser's clipboard API for image support.
 */
export class ClipboardImageCapture {
    static async captureFromClipboard(): Promise<{ base64: string; mimeType: string } | undefined> {
        return new Promise((resolve) => {
            const panel = vscode.window.createWebviewPanel(
                'clipboardCapture',
                'Paste Screenshot',
                vscode.ViewColumn.Active,
                { enableScripts: true }
            );

            panel.webview.html = this.getWebviewContent();

            let resolved = false;
            const disposable = panel.webview.onDidReceiveMessage(
                message => {
                    console.log('[Quest] ClipboardCapture received message:', message.type);
                    if (message.type === 'imageData') {
                        resolved = true;
                        panel.dispose();
                        // Remove data:image/...;base64, prefix
                        const base64Match = message.data.match(/^data:([^;]+);base64,(.+)$/);
                        if (base64Match) {
                            console.log('[Quest] Image captured successfully, mimeType:', base64Match[1]);
                            resolve({
                                base64: base64Match[2],
                                mimeType: base64Match[1]
                            });
                        } else {
                            console.log('[Quest] Failed to parse image data');
                            resolve(undefined);
                        }
                    } else if (message.type === 'cancel' || message.type === 'noImage') {
                        resolved = true;
                        panel.dispose();
                        if (message.type === 'noImage') {
                            vscode.window.showWarningMessage('No image found in clipboard. Please copy a screenshot first.');
                        }
                        resolve(undefined);
                    } else if (message.type === 'error') {
                        console.log('[Quest] ClipboardCapture error:', message.error);
                        vscode.window.showErrorMessage(`Clipboard error: ${message.error}`);
                    } else if (message.type === 'log') {
                        console.log('[Quest] Webview:', message.text);
                    }
                }
            );

            panel.onDidDispose(() => {
                disposable.dispose();
                if (!resolved) {
                    resolve(undefined);
                }
            });
        });
    }

    private static getWebviewContent(): string {
        return `<!DOCTYPE html>
<html>
<head>
    <style>
        body {
            font-family: var(--vscode-font-family);
            padding: 20px;
            text-align: center;
            background: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
        }
        .paste-area {
            border: 2px dashed var(--vscode-input-border);
            border-radius: 8px;
            padding: 40px;
            margin: 20px 0;
            cursor: pointer;
            transition: border-color 0.2s, background-color 0.2s;
        }
        .paste-area:hover, .paste-area:focus {
            border-color: var(--vscode-focusBorder);
            outline: none;
        }
        .paste-area.has-image {
            border-color: var(--vscode-terminal-ansiGreen);
            border-style: solid;
        }
        .paste-area.drag-over {
            border-color: var(--vscode-focusBorder);
            background: var(--vscode-editor-selectionBackground);
        }
        img {
            max-width: 100%;
            max-height: 300px;
            margin: 10px 0;
            border-radius: 4px;
        }
        button {
            padding: 8px 20px;
            margin: 5px;
            cursor: pointer;
            border: none;
            border-radius: 4px;
            font-size: 14px;
        }
        .primary {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        .primary:hover {
            background: var(--vscode-button-hoverBackground);
        }
        .secondary {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        .secondary:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        #buttons {
            display: none;
            margin-top: 20px;
        }
        .hint {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            margin-top: 10px;
        }
        h2 {
            margin-bottom: 5px;
        }
        .status {
            margin-top: 10px;
            padding: 8px;
            border-radius: 4px;
            display: none;
        }
        .status.processing {
            display: block;
            background: var(--vscode-inputValidation-infoBackground);
            border: 1px solid var(--vscode-inputValidation-infoBorder);
        }
        .status.error {
            display: block;
            background: var(--vscode-inputValidation-errorBackground);
            border: 1px solid var(--vscode-inputValidation-errorBorder);
        }
    </style>
</head>
<body>
    <h2>Paste Screenshot</h2>
    <p>Click below and press <strong>Ctrl+V</strong> to paste, or drag & drop an image file</p>
    <div class="paste-area" id="pasteArea" tabindex="0">
        <div id="placeholder">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
            <p>Click here and paste (Ctrl+V)<br>or drag & drop an image</p>
        </div>
        <div id="preview"></div>
    </div>
    <div id="status" class="status"></div>
    <div id="buttons">
        <button class="primary" onclick="submit()">Use This Image</button>
        <button class="secondary" onclick="cancel()">Cancel</button>
    </div>
    <p class="hint">Tip: Take a screenshot with Win+Shift+S, then paste here</p>

    <script>
        const vscode = acquireVsCodeApi();
        let currentImageData = null;
        let currentMimeType = null;
        let autoSubmitTimeout = null;

        function log(text) {
            vscode.postMessage({ type: 'log', text: text });
        }

        function setStatus(text, type) {
            const status = document.getElementById('status');
            status.textContent = text;
            status.className = 'status ' + (type || '');
        }

        // Focus paste area on load
        document.getElementById('pasteArea').focus();
        log('Webview loaded, paste area focused');

        function processImage(blob, mimeType) {
            log('Processing image: ' + mimeType + ', size: ' + blob.size);
            setStatus('Processing image...', 'processing');

            const reader = new FileReader();
            reader.onload = () => {
                log('FileReader loaded successfully');
                currentImageData = reader.result;
                currentMimeType = mimeType;
                document.getElementById('placeholder').style.display = 'none';
                document.getElementById('preview').innerHTML = '<img src="' + currentImageData + '">';
                document.getElementById('buttons').style.display = 'block';
                document.querySelector('.paste-area').classList.add('has-image');
                setStatus('Image ready! Click "Use This Image" or press Enter', '');

                // Auto-submit after a short delay (gives user time to see preview)
                if (autoSubmitTimeout) clearTimeout(autoSubmitTimeout);
                autoSubmitTimeout = setTimeout(() => {
                    log('Auto-submitting image');
                    submit();
                }, 1500);
            };
            reader.onerror = (err) => {
                log('FileReader error: ' + err);
                setStatus('Error reading image', 'error');
                vscode.postMessage({ type: 'error', error: 'Failed to read image file' });
            };
            reader.readAsDataURL(blob);
        }

        // Handle paste
        document.addEventListener('paste', async (e) => {
            e.preventDefault();
            log('Paste event received');

            const items = e.clipboardData?.items;
            if (!items) {
                log('No clipboardData items');
                vscode.postMessage({ type: 'noImage' });
                return;
            }

            log('Clipboard items: ' + items.length);
            for (let i = 0; i < items.length; i++) {
                const item = items[i];
                log('Item ' + i + ': kind=' + item.kind + ', type=' + item.type);

                if (item.type.startsWith('image/')) {
                    const blob = item.getAsFile();
                    if (!blob) {
                        log('getAsFile returned null');
                        continue;
                    }
                    processImage(blob, item.type);
                    return;
                }
            }

            // No image found in clipboard
            log('No image found in clipboard items');
            setStatus('No image in clipboard. Copy a screenshot first.', 'error');
            vscode.postMessage({ type: 'noImage' });
        });

        // Handle drag & drop
        const pasteArea = document.getElementById('pasteArea');

        pasteArea.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            pasteArea.classList.add('drag-over');
        });

        pasteArea.addEventListener('dragleave', (e) => {
            e.preventDefault();
            e.stopPropagation();
            pasteArea.classList.remove('drag-over');
        });

        pasteArea.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            pasteArea.classList.remove('drag-over');
            log('Drop event received');

            const files = e.dataTransfer?.files;
            if (!files || files.length === 0) {
                log('No files in drop');
                return;
            }

            const file = files[0];
            log('Dropped file: ' + file.name + ', type: ' + file.type);

            if (file.type.startsWith('image/')) {
                processImage(file, file.type);
            } else {
                setStatus('Please drop an image file (PNG, JPG, etc.)', 'error');
            }
        });

        function submit() {
            if (autoSubmitTimeout) clearTimeout(autoSubmitTimeout);
            if (currentImageData) {
                log('Submitting image data');
                setStatus('Sending to AI...', 'processing');
                vscode.postMessage({ type: 'imageData', data: currentImageData, mimeType: currentMimeType });
            }
        }

        function cancel() {
            if (autoSubmitTimeout) clearTimeout(autoSubmitTimeout);
            log('User cancelled');
            vscode.postMessage({ type: 'cancel' });
        }

        // Allow Enter key to submit
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && currentImageData) {
                submit();
            } else if (e.key === 'Escape') {
                cancel();
            }
        });
    </script>
</body>
</html>`;
    }
}
