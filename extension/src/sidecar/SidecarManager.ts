import * as vscode from 'vscode';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { SidecarClient } from './SidecarClient';

export class SidecarManager {
    private process: ChildProcess | null = null;
    private _client: SidecarClient | null = null;
    private readonly context: vscode.ExtensionContext;
    private readonly outputChannel: vscode.OutputChannel;
    private isRestarting = false;
    private restartCount = 0;
    private readonly maxRestarts = 5;

    constructor(context: vscode.ExtensionContext, outputChannel: vscode.OutputChannel) {
        this.context = context;
        this.outputChannel = outputChannel;
    }

    get client(): SidecarClient {
        if (!this._client) {
            throw new Error('Sidecar client not initialized. Server may have crashed.');
        }
        return this._client;
    }

    get isRunning(): boolean {
        return this._client !== null && this.process !== null;
    }

    get pid(): number | undefined {
        return this.process?.pid;
    }

    async ensureRunning(): Promise<void> {
        if (!this.isRunning && !this.isRestarting) {
            this.outputChannel.appendLine('Server not running, attempting restart...');
            await this.restart();
        }
    }

    async restart(): Promise<void> {
        if (this.isRestarting) {
            return;
        }

        if (this.restartCount >= this.maxRestarts) {
            this.outputChannel.appendLine(`Max restart attempts (${this.maxRestarts}) reached. Please reload VS Code.`);
            vscode.window.showErrorMessage('Quest server crashed repeatedly. Please reload VS Code.');
            return;
        }

        this.isRestarting = true;
        this.restartCount++;
        this.outputChannel.appendLine(`Restarting sidecar (attempt ${this.restartCount}/${this.maxRestarts})...`);

        try {
            await this.stop();
            // Wait a bit to ensure process is fully terminated
            await this.delay(500);
            await this.start();
            this.outputChannel.appendLine('Sidecar restarted successfully');
            // Reset restart count on successful restart
            this.restartCount = 0;
        } catch (error) {
            this.outputChannel.appendLine(`Failed to restart sidecar: ${error}`);
        } finally {
            this.isRestarting = false;
        }
    }

    // Manual reconnect - resets the restart counter
    async reconnect(): Promise<void> {
        this.restartCount = 0;
        await this.restart();
    }

    async start(): Promise<void> {
        const sidecarPath = this.getSidecarPath();
        this.outputChannel.appendLine(`=== SIDECAR STARTUP ===`);
        this.outputChannel.appendLine(`Starting sidecar from: ${sidecarPath}`);

        // Check if file exists and show modification time
        const fs = require('fs');
        if (fs.existsSync(sidecarPath)) {
            const stats = fs.statSync(sidecarPath);
            this.outputChannel.appendLine(`Server exe modified: ${stats.mtime.toISOString()}`);
        } else {
            this.outputChannel.appendLine(`WARNING: Server exe not found at path!`);
        }

        return new Promise((resolve, reject) => {
            try {
                this.process = spawn(sidecarPath, [], {
                    stdio: ['pipe', 'pipe', 'pipe'],
                    env: { ...process.env }
                });

                if (!this.process.stdin || !this.process.stdout) {
                    throw new Error('Failed to create stdio streams');
                }

                // Handle stderr for logging
                this.process.stderr?.on('data', (data: Buffer) => {
                    this.outputChannel.appendLine(`[Sidecar] ${data.toString().trim()}`);
                });

                // Handle process exit - auto-restart
                this.process.on('exit', (code, signal) => {
                    this.outputChannel.appendLine(`Sidecar exited with code ${code}, signal ${signal}`);
                    this._client = null;
                    this.process = null;

                    // Auto-restart if not intentionally stopped
                    if (code !== 0 && !this.isRestarting) {
                        this.outputChannel.appendLine('Server crashed, will attempt restart...');
                        setTimeout(() => this.restart(), 1000);
                    }
                });

                this.process.on('error', (err) => {
                    this.outputChannel.appendLine(`Sidecar error: ${err.message}`);
                    reject(err);
                });

                // Create JSON-RPC client
                this._client = new SidecarClient(
                    this.process.stdin,
                    this.process.stdout,
                    this.outputChannel
                );

                // Wait for sidecar to be ready
                this.waitForReady()
                    .then(resolve)
                    .catch(reject);

            } catch (error) {
                reject(error);
            }
        });
    }

    private async waitForReady(): Promise<void> {
        const maxAttempts = 5;
        const delayMs = 200;

        for (let i = 0; i < maxAttempts; i++) {
            try {
                const result = await this._client!.healthCheck();
                if (result.status === 'ok') {
                    this.outputChannel.appendLine(`=== SIDECAR READY ===`);
                    this.outputChannel.appendLine(`Server version: ${result.version}`);
                    return;
                }
            } catch (error) {
                if (i < maxAttempts - 1) {
                    this.outputChannel.appendLine(`Waiting for sidecar... (attempt ${i + 1}/${maxAttempts})`);
                }
            }
            await this.delay(delayMs);
        }
        throw new Error('Sidecar failed to respond to health check');
    }

    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    private getSidecarPath(): string {
        // Check for user-configured path first
        const config = vscode.workspace.getConfiguration('queryStudio');
        const configuredPath = config.get<string>('sidecar.path');
        if (configuredPath) {
            return configuredPath;
        }

        // Use bundled sidecar
        const platform = process.platform;
        const arch = process.arch;
        const execName = platform === 'win32' ? 'QueryStudio.Server.exe' : 'QueryStudio.Server';

        // Determine runtime ID based on platform and architecture
        let runtimeId: string;
        if (platform === 'win32') {
            runtimeId = arch === 'arm64' ? 'win-arm64' : 'win-x64';
        } else if (platform === 'darwin') {
            runtimeId = arch === 'arm64' ? 'osx-arm64' : 'osx-x64';
        } else {
            runtimeId = arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
        }

        // Try platform-specific bundled path first, then generic
        const bundledPlatformPath = path.join(this.context.extensionPath, 'server', runtimeId, execName);
        const bundledPath = path.join(this.context.extensionPath, 'server', execName);

        // For development: debug build path (preferred for debugging)
        const devDebugPath = path.join(this.context.extensionPath, '..', 'server', 'bin', 'Debug', 'net8.0', runtimeId, execName);

        // For development: release build path (normal build)
        const devReleasePath = path.join(this.context.extensionPath, '..', 'server', 'bin', 'Release', 'net8.0', runtimeId, execName);

        // For development: check parent directory (published output)
        const devPublishPath = path.join(this.context.extensionPath, '..', 'server', 'bin', 'Release', 'net8.0', runtimeId, 'publish', execName);

        // For dev: prefer debug > release > published > bundled (platform-specific) > bundled (generic)
        const fs = require('fs');
        if (fs.existsSync(devDebugPath)) {
            this.outputChannel.appendLine(`Using debug build: ${devDebugPath}`);
            return devDebugPath;
        }
        if (fs.existsSync(devReleasePath)) {
            this.outputChannel.appendLine(`Using release build: ${devReleasePath}`);
            return devReleasePath;
        }
        if (fs.existsSync(devPublishPath)) {
            return devPublishPath;
        }
        if (fs.existsSync(bundledPlatformPath)) {
            this.outputChannel.appendLine(`Using platform-specific build (${runtimeId}): ${bundledPlatformPath}`);
            return bundledPlatformPath;
        }
        if (fs.existsSync(bundledPath)) {
            return bundledPath;
        }

        // Fallback - prefer platform-specific
        return bundledPlatformPath;
    }

    async stop(): Promise<void> {
        if (this.process) {
            this.outputChannel.appendLine('Stopping sidecar...');

            // Try graceful shutdown first
            try {
                await this._client?.shutdown();
            } catch {
                // Ignore errors during shutdown
            }

            // Force kill if still running
            if (this.process && !this.process.killed) {
                this.process.kill();
            }

            this.process = null;
            this._client = null;
        }
    }
}
