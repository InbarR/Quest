import * as vscode from 'vscode';
import { SidecarClient, ClusterInfo, ExtractedDataSourceInfo, ExtractedClusterItem, KustoExplorerConnection } from '../sidecar/SidecarClient';
import { ClusterTreeProvider } from '../providers/ClusterTreeProvider';
import { setActiveConnection } from './queryCommands';
import { updateModeStatusBar, getCurrentMode } from '../extension';
import { ClipboardImageCapture } from '../providers/ClipboardImageCapture';

export function registerClusterCommands(
    context: vscode.ExtensionContext,
    client: SidecarClient,
    clusterProvider: ClusterTreeProvider,
    onActiveClusterChanged?: (cluster: ClusterInfo) => void
) {
    // Unified Add Data Source command - works based on current mode
    context.subscriptions.push(
        vscode.commands.registerCommand('queryStudio.addDataSource', async () => {
            const currentMode = getCurrentMode();

            if (currentMode === 'outlook') {
                vscode.window.showInformationMessage('Outlook mode uses your local Outlook installation. No configuration needed.');
                return;
            }

            // Build options based on mode
            const options: { label: string; value: string; description: string }[] = [];

            if (currentMode === 'kusto') {
                options.push(
                    { label: '$(edit) Enter Manually', value: 'manual', description: 'Type cluster details' },
                    { label: '$(device-camera) From Screenshot', value: 'image', description: 'Extract from image using AI' },
                    { label: '$(file-symlink-directory) Import from Kusto Explorer', value: 'kustoExplorer', description: 'Import connections from Kusto Explorer' }
                );
            } else if (currentMode === 'ado') {
                options.push(
                    { label: '$(edit) Enter Manually', value: 'manual', description: 'Type organization details' },
                    { label: '$(link) From URL', value: 'url', description: 'Paste a work item or project URL' }
                );
            }

            const method = await vscode.window.showQuickPick(options, {
                placeHolder: 'How would you like to add the data source?'
            });

            if (!method) return;

            if (method.value === 'image') {
                await addDataSourceFromImage(client, clusterProvider, currentMode);
            } else if (method.value === 'kustoExplorer') {
                await importFromKustoExplorer(client, clusterProvider);
            } else if (method.value === 'url') {
                await addAdoFromUrl(client, clusterProvider);
            } else {
                if (currentMode === 'kusto') {
                    await addKustoCluster(client, clusterProvider);
                } else if (currentMode === 'ado') {
                    await addAdoOrganization(client, clusterProvider);
                }
            }
        })
    );

    // Refresh Clusters
    context.subscriptions.push(
        vscode.commands.registerCommand('queryStudio.refreshClusters', () => {
            clusterProvider.refresh();
        })
    );

    // Filter Data Sources
    context.subscriptions.push(
        vscode.commands.registerCommand('queryStudio.filterDataSources', async () => {
            const current = clusterProvider.getFilter();
            const value = await vscode.window.showInputBox({
                prompt: 'Filter data sources by name, database, or URL',
                placeHolder: 'Type to filter...',
                value: current
            });
            if (value === undefined) return; // cancelled
            clusterProvider.setFilter(value);
            vscode.commands.executeCommand('setContext', 'queryStudio.dataSourcesFiltered', !!value);
        })
    );

    // Clear Data Sources Filter
    context.subscriptions.push(
        vscode.commands.registerCommand('queryStudio.clearDataSourcesFilter', () => {
            clusterProvider.setFilter('');
            vscode.commands.executeCommand('setContext', 'queryStudio.dataSourcesFiltered', false);
        })
    );

    // Set Active Cluster
    context.subscriptions.push(
        vscode.commands.registerCommand('queryStudio.setActiveCluster', async (cluster: ClusterInfo) => {
            if (!cluster) {
                return;
            }

            setActiveConnection(cluster.url, cluster.database, cluster.type);
            clusterProvider.setActiveCluster(cluster);

            // Update status bar with current mode
            const displayName = `${cluster.name} / ${cluster.database}`;
            updateModeStatusBar(cluster.type, displayName);

            // Notify listeners (e.g., AI chat)
            if (onActiveClusterChanged) {
                onActiveClusterChanged(cluster);
            }

            // Fetch schema for Kusto clusters (for autocomplete)
            if (cluster.type === 'kusto') {
                try {
                    console.log(`[Quest] Fetching schema for ${cluster.url}/${cluster.database}...`);
                    const result = await client.fetchSchema(cluster.url, cluster.database);
                    if (result.success && result.tableCount > 0) {
                        console.log(`[Quest] Schema loaded: ${result.tableCount} tables`);
                        vscode.window.setStatusBarMessage(`Loaded ${result.tableCount} tables for autocomplete`, 3000);
                        clusterProvider.setTableCount(cluster.url, cluster.database, result.tableCount);
                    } else {
                        console.log(`[Quest] Schema fetch result: success=${result.success}, tableCount=${result.tableCount}, error=${result.error}`);
                    }
                } catch (err) {
                    console.log(`[Quest] Schema fetch error: ${err}`);
                    // Schema fetch failed silently - autocomplete will use cached data
                }
            }
        })
    );

    // Remove Cluster/Database (supports multi-select)
    context.subscriptions.push(
        vscode.commands.registerCommand('queryStudio.removeCluster', async (item, selectedItems?: any[]) => {
            // Collect all ClusterInfo IDs to remove from the selection
            const idsToRemove = new Set<string>();
            const labels: string[] = [];

            const collectFromItem = (it: any) => {
                if (it?.cluster) {
                    const cluster = it.cluster as ClusterInfo;
                    idsToRemove.add(cluster.id);
                    labels.push(`${cluster.name} / ${cluster.database}`);
                } else if (it?.databases && Array.isArray(it.databases)) {
                    const databases = it.databases as ClusterInfo[];
                    const clusterName = it.clusterName || databases[0]?.name || 'cluster';
                    for (const db of databases) {
                        idsToRemove.add(db.id);
                    }
                    labels.push(`${clusterName} (${databases.length} db)`);
                }
            };

            // If multi-select provided, use all selected items; otherwise just the single item
            const items = selectedItems && selectedItems.length > 1 ? selectedItems : [item];
            for (const it of items) {
                collectFromItem(it);
            }

            if (idsToRemove.size === 0) return;

            const message = labels.length === 1
                ? `Remove "${labels[0]}"?`
                : `Remove ${labels.length} data sources?\n${labels.join(', ')}`;

            const confirm = await vscode.window.showWarningMessage(
                message,
                { modal: true },
                'Remove'
            );

            if (confirm === 'Remove') {
                try {
                    for (const id of idsToRemove) {
                        await client.removeCluster(id);
                    }
                    clusterProvider.refresh();
                    const count = idsToRemove.size;
                    vscode.window.showInformationMessage(
                        count === 1 ? `Removed "${labels[0]}"` : `Removed ${count} data sources`
                    );
                } catch (error) {
                    const message = error instanceof Error ? error.message : 'Unknown error';
                    vscode.window.showErrorMessage(`Failed to remove: ${message}`);
                }
            }
        })
    );

    // Rename Cluster/Database
    context.subscriptions.push(
        vscode.commands.registerCommand('queryStudio.renameCluster', async (item) => {
            // Handle DatabaseTreeItem (has .cluster property)
            if (item?.cluster) {
                const cluster = item.cluster as ClusterInfo;
                const newName = await vscode.window.showInputBox({
                    prompt: 'Enter new display name',
                    value: cluster.name,
                    validateInput: (value) => {
                        if (!value || !value.trim()) {
                            return 'Name is required';
                        }
                        return undefined;
                    }
                });

                if (!newName || newName === cluster.name) {
                    return;
                }

                try {
                    await client.renameCluster(cluster.id, newName.trim());
                    clusterProvider.refresh();
                    vscode.window.showInformationMessage(`Renamed to "${newName}"`);
                } catch (error) {
                    const message = error instanceof Error ? error.message : 'Unknown error';
                    vscode.window.showErrorMessage(`Failed to rename: ${message}`);
                }
                return;
            }

            // Handle ClusterTreeItem (has .databases array) - rename all databases under this cluster
            if (item?.databases && Array.isArray(item.databases) && item.databases.length > 0) {
                const databases = item.databases as ClusterInfo[];
                const currentName = item.clusterName || databases[0].name;
                const newName = await vscode.window.showInputBox({
                    prompt: 'Enter new display name for this cluster',
                    value: currentName,
                    validateInput: (value) => {
                        if (!value || !value.trim()) {
                            return 'Name is required';
                        }
                        return undefined;
                    }
                });

                if (!newName || newName === currentName) {
                    return;
                }

                try {
                    // Rename all databases under this cluster
                    for (const db of databases) {
                        await client.renameCluster(db.id, newName.trim());
                    }
                    clusterProvider.refresh();
                    vscode.window.showInformationMessage(`Renamed to "${newName}"`);
                } catch (error) {
                    const message = error instanceof Error ? error.message : 'Unknown error';
                    vscode.window.showErrorMessage(`Failed to rename: ${message}`);
                }
            }
        })
    );

    // Toggle Favorite
    context.subscriptions.push(
        vscode.commands.registerCommand('queryStudio.toggleFavorite', async (item) => {
            if (!item?.cluster) {
                return;
            }

            const cluster = item.cluster as ClusterInfo;
            try {
                await client.setClusterFavorite(cluster.id, !cluster.isFavorite);
                clusterProvider.refresh();
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Unknown error';
                vscode.window.showErrorMessage(`Failed to update favorite: ${message}`);
            }
        })
    );

    // Copy Cluster Info
    context.subscriptions.push(
        vscode.commands.registerCommand('queryStudio.copyClusterInfo', async (item) => {
            // DatabaseTreeItem: has .cluster
            if (item?.cluster) {
                const cluster = item.cluster as ClusterInfo;
                const info = cluster.type === 'kusto'
                    ? `Cluster: ${cluster.url}\nDatabase: ${cluster.database}\nName: ${cluster.name}`
                    : `Organization: ${cluster.url}\nProject: ${cluster.database}\nName: ${cluster.name}`;
                await vscode.env.clipboard.writeText(info);
                vscode.window.showInformationMessage('Connection info copied to clipboard');
                return;
            }

            // ClusterTreeItem: has .databases array and .clusterUrl
            if (item?.databases && Array.isArray(item.databases)) {
                const databases = item.databases as ClusterInfo[];
                const clusterName = item.clusterName || databases[0]?.name || 'cluster';
                const clusterUrl = item.clusterUrl || databases[0]?.url || '';
                const type = item.clusterType || databases[0]?.type || 'kusto';
                const dbNames = databases.map((d: ClusterInfo) => d.database).join(', ');

                const info = type === 'kusto'
                    ? `Cluster: ${clusterUrl}\nName: ${clusterName}\nDatabases: ${dbNames}`
                    : `Organization: ${clusterUrl}\nName: ${clusterName}\nProjects: ${dbNames}`;
                await vscode.env.clipboard.writeText(info);
                vscode.window.showInformationMessage('Connection info copied to clipboard');
            }
        })
    );

    // Edit Connection (right-click on database or cluster item)
    context.subscriptions.push(
        vscode.commands.registerCommand('queryStudio.editConnection', async (item) => {
            // DatabaseTreeItem: edit a single database entry
            if (item?.cluster) {
                const cluster = item.cluster as ClusterInfo;
                await editSingleConnection(client, clusterProvider, cluster);
                return;
            }

            // ClusterTreeItem: edit the cluster URL/name (applies to all databases under it)
            if (item?.databases && Array.isArray(item.databases)) {
                const databases = item.databases as ClusterInfo[];
                const currentUrl = item.clusterUrl || databases[0]?.url || '';
                const currentName = item.clusterName || databases[0]?.name || '';
                const isKusto = (item.clusterType || databases[0]?.type) === 'kusto';

                const url = await vscode.window.showInputBox({
                    prompt: isKusto ? 'Cluster URL' : 'Organization URL',
                    value: currentUrl,
                    ignoreFocusOut: true,
                    validateInput: (v) => v ? undefined : 'URL is required'
                });
                if (!url) return;

                const name = await vscode.window.showInputBox({
                    prompt: 'Display name',
                    value: currentName,
                    ignoreFocusOut: true,
                    validateInput: (v) => v?.trim() ? undefined : 'Name is required'
                });
                if (!name) return;

                const finalUrl = isKusto ? normalizeKustoUrl(url) : url;
                if (finalUrl === currentUrl && name === currentName) return;

                try {
                    for (const db of databases) {
                        await client.removeCluster(db.id);
                        const updated: ClusterInfo = {
                            id: Date.now().toString() + '_' + db.database,
                            name: name.trim(),
                            url: finalUrl,
                            database: db.database,
                            type: db.type,
                            isFavorite: db.isFavorite,
                            organization: db.organization
                        };
                        await client.addCluster(updated);
                    }
                    clusterProvider.refresh();
                    vscode.window.showInformationMessage(`Updated "${name}"`);
                } catch (error) {
                    const message = error instanceof Error ? error.message : 'Unknown error';
                    vscode.window.showErrorMessage(`Failed to update connection: ${message}`);
                }
            }
        })
    );

    // Get Databases (right-click on cluster → discover databases)
    context.subscriptions.push(
        vscode.commands.registerCommand('queryStudio.getDatabases', async (item) => {
            if (!item?.databases || !Array.isArray(item.databases)) return;
            const databases = item.databases as ClusterInfo[];
            const clusterUrl = item.clusterUrl || databases[0]?.url;
            const clusterName = item.clusterName || databases[0]?.name || 'cluster';

            if (!clusterUrl) return;

            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Fetching databases from ${clusterName}...`,
                cancellable: false
            }, async () => {
                try {
                    // Use .show databases to list all databases on the cluster
                    const result = await client.executeQuery({
                        query: '.show databases | project DatabaseName',
                        clusterUrl: clusterUrl,
                        database: databases[0]?.database || '',
                        type: 'kusto'
                    });

                    if (!result.success) {
                        vscode.window.showErrorMessage(`Failed to get databases: ${result.error}`);
                        return;
                    }

                    if (result.rowCount === 0) {
                        vscode.window.showInformationMessage('No databases found on this cluster.');
                        return;
                    }

                    // Get existing database names for this cluster
                    const existingDbs = new Set(databases.map(d => d.database.toLowerCase()));

                    // Build QuickPick items, marking already-added ones
                    const dbNames: string[] = result.rows.map(row => row[0]);
                    const items = dbNames.map(dbName => ({
                        label: dbName,
                        description: existingDbs.has(dbName.toLowerCase()) ? 'already added' : '',
                        picked: !existingDbs.has(dbName.toLowerCase()),
                        dbName
                    }));

                    const selected = await vscode.window.showQuickPick(items, {
                        canPickMany: true,
                        placeHolder: `Select databases to add from ${clusterName} (${dbNames.length} found)`
                    });

                    if (!selected || selected.length === 0) return;

                    let added = 0;
                    for (const pick of selected) {
                        if (existingDbs.has(pick.dbName.toLowerCase())) continue;
                        try {
                            const cluster: ClusterInfo = {
                                id: Date.now().toString() + '_' + added,
                                name: clusterName,
                                url: clusterUrl,
                                database: pick.dbName,
                                type: 'kusto',
                                isFavorite: false
                            };
                            await client.addCluster(cluster);
                            added++;
                        } catch (err) {
                            console.error(`Failed to add ${pick.dbName}:`, err);
                        }
                    }

                    if (added > 0) {
                        clusterProvider.refresh();
                        vscode.window.showInformationMessage(`Added ${added} database(s) to ${clusterName}`);
                    }
                } catch (error) {
                    const msg = error instanceof Error ? error.message : 'Unknown error';
                    vscode.window.showErrorMessage(`Failed to get databases: ${msg}`);
                }
            });
        })
    );

    // Show Tables (right-click on database → show table names in tree)
    context.subscriptions.push(
        vscode.commands.registerCommand('queryStudio.showTables', async (item) => {
            if (!item?.cluster) return;
            const cluster = item.cluster as ClusterInfo;
            if (cluster.type !== 'kusto') {
                vscode.window.showInformationMessage('Show Tables is only available for Kusto databases.');
                return;
            }

            let tableNames: string[] | undefined;

            // Try schema cache first
            try {
                const schema = await client.getSchema(cluster.url, cluster.database);
                if (schema?.tables?.length > 0) {
                    tableNames = schema.tables.map(t => t.name).sort();
                }
            } catch {
                // Cache miss — will query the cluster
            }

            // Fall back to querying the cluster
            if (!tableNames) {
                tableNames = await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: `Fetching tables from ${cluster.database}...`,
                    cancellable: false
                }, async (): Promise<string[] | undefined> => {
                    try {
                        const result = await client.executeQuery({
                            query: '.show tables | project TableName | order by TableName asc',
                            clusterUrl: cluster.url,
                            database: cluster.database,
                            type: 'kusto'
                        });
                        if (!result.success) {
                            vscode.window.showErrorMessage(`Failed to get tables: ${result.error}`);
                            return undefined;
                        }
                        return result.rows.map(row => row[0]);
                    } catch (error) {
                        const msg = error instanceof Error ? error.message : 'Unknown error';
                        vscode.window.showErrorMessage(`Failed to get tables: ${msg}`);
                        return undefined;
                    }
                });
            }

            if (!tableNames || tableNames.length === 0) {
                vscode.window.showInformationMessage('No tables found.');
                return;
            }

            // Let user pick which tables to show in the tree
            const items = tableNames.map(name => ({
                label: name,
                picked: true
            }));

            const selected = await vscode.window.showQuickPick(items, {
                canPickMany: true,
                placeHolder: `Select tables to show (${tableNames.length} found in ${cluster.database})`
            });

            if (!selected || selected.length === 0) return;

            clusterProvider.setTableNames(cluster.url, cluster.database, selected.map(s => s.label));
        })
    );

    // Insert Table Name (click on table in tree → insert into editor)
    context.subscriptions.push(
        vscode.commands.registerCommand('queryStudio.insertTableName', async (tableName: string) => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;

            await editor.edit(editBuilder => {
                if (editor.selection.isEmpty) {
                    editBuilder.insert(editor.selection.active, tableName);
                } else {
                    editBuilder.replace(editor.selection, tableName);
                }
            });
        })
    );

    // Fetch Schema (manual trigger from context menu on database)
    context.subscriptions.push(
        vscode.commands.registerCommand('queryStudio.fetchSchema', async (item) => {
            let clusterUrl: string | undefined;
            let database: string | undefined;

            if (item?.cluster) {
                // Called from tree view context menu
                const cluster = item.cluster as ClusterInfo;
                clusterUrl = cluster.url;
                database = cluster.database;
            } else {
                // Called from command palette - use active cluster
                const activeCluster = clusterProvider.getActiveCluster();
                if (activeCluster && activeCluster.type === 'kusto') {
                    clusterUrl = activeCluster.url;
                    database = activeCluster.database;
                }
            }

            if (!clusterUrl || !database) {
                vscode.window.showWarningMessage('No Kusto database selected. Select a database first.');
                return;
            }

            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Fetching schema...',
                cancellable: false
            }, async (progress) => {
                try {
                    progress.report({ message: `Connecting to ${database}...` });
                    const result = await client.fetchSchema(clusterUrl!, database!, true);

                    if (result.success) {
                        if (result.tableCount > 0) {
                            vscode.window.showInformationMessage(
                                `Schema loaded: ${result.tableCount} tables. Autocomplete is now available.`
                            );
                            clusterProvider.setTableCount(clusterUrl!, database!, result.tableCount);
                        } else {
                            vscode.window.showWarningMessage('No tables found in database.');
                        }
                    } else {
                        vscode.window.showErrorMessage(`Failed to fetch schema: ${result.error}`);
                    }
                } catch (error) {
                    const message = error instanceof Error ? error.message : 'Unknown error';
                    vscode.window.showErrorMessage(`Failed to fetch schema: ${message}`);
                }
            });
        })
    );

    // Refresh Schema for active database (force refresh, bypass cache)
    context.subscriptions.push(
        vscode.commands.registerCommand('queryStudio.refreshSchema', async () => {
            const activeCluster = clusterProvider.getActiveCluster();
            if (!activeCluster || activeCluster.type !== 'kusto') {
                vscode.window.showWarningMessage('No active Kusto database. Select a database first.');
                return;
            }

            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Refreshing schema...',
                cancellable: false
            }, async (progress) => {
                try {
                    progress.report({ message: `Connecting to ${activeCluster.database}...` });
                    // Force refresh to bypass cache
                    const result = await client.fetchSchema(activeCluster.url, activeCluster.database, true);

                    if (result.success) {
                        if (result.tableCount > 0) {
                            vscode.window.showInformationMessage(
                                `Schema refreshed: ${result.tableCount} tables.`
                            );
                            clusterProvider.setTableCount(activeCluster.url, activeCluster.database, result.tableCount);
                        } else {
                            vscode.window.showWarningMessage('No tables found in database.');
                        }
                    } else {
                        vscode.window.showErrorMessage(`Failed to refresh schema: ${result.error}`);
                    }
                } catch (error) {
                    const message = error instanceof Error ? error.message : 'Unknown error';
                    vscode.window.showErrorMessage(`Failed to refresh schema: ${message}`);
                }
            });
        })
    );

    // Clear Schema Cache
    context.subscriptions.push(
        vscode.commands.registerCommand('queryStudio.clearSchemaCache', async () => {
            const choice = await vscode.window.showQuickPick(
                [
                    { label: 'Clear All', description: 'Clear schema cache for all databases', value: 'all' },
                    { label: 'Clear Current', description: 'Clear cache for active database only', value: 'current' }
                ],
                { placeHolder: 'Select what to clear' }
            );

            if (!choice) return;

            try {
                if (choice.value === 'all') {
                    await client.clearSchemaCache();
                    vscode.window.showInformationMessage('Schema cache cleared for all databases');
                } else {
                    const activeCluster = clusterProvider.getActiveCluster();
                    if (!activeCluster) {
                        vscode.window.showWarningMessage('No active database selected');
                        return;
                    }
                    await client.clearSchemaCache(activeCluster.url, activeCluster.database);
                    vscode.window.showInformationMessage(`Schema cache cleared for ${activeCluster.database}`);
                }
            } catch (error) {
                const msg = error instanceof Error ? error.message : 'Unknown error';
                vscode.window.showErrorMessage(`Failed to clear cache: ${msg}`);
            }
        })
    );

    // Set Default Area Path (for ADO)
    context.subscriptions.push(
        vscode.commands.registerCommand('queryStudio.setDefaultAreaPath', async (item) => {
            let projectName: string | undefined;

            // Get project from tree item if provided (DatabaseTreeItem or AreaPathTreeItem)
            if (item?.cluster) {
                const cluster = item.cluster as ClusterInfo;
                if (cluster.type !== 'ado') {
                    vscode.window.showWarningMessage('Default Area Path is only applicable for Azure DevOps data sources.');
                    return;
                }
                projectName = cluster.database; // database = project for ADO
            }

            // Prompt for area path
            const config = vscode.workspace.getConfiguration('queryStudio.ado');
            const currentAreaPath = config.get<string>('defaultAreaPath') || '';

            // Suggest the project name as default if no current value
            const placeholder = projectName
                ? `e.g., ${projectName}\\Team\\Sprint`
                : 'e.g., MyProject\\Team\\Sprint';

            const areaPath = await vscode.window.showInputBox({
                prompt: 'Enter the default Area Path for WIQL queries',
                placeHolder: placeholder,
                value: currentAreaPath || projectName || '',
                ignoreFocusOut: true
            });

            if (areaPath === undefined) {
                return; // User cancelled
            }

            try {
                // Update the setting (empty string clears it)
                await config.update('defaultAreaPath', areaPath || undefined, vscode.ConfigurationTarget.Global);
                clusterProvider.refresh();

                if (areaPath) {
                    vscode.window.showInformationMessage(`Default Area Path set to: ${areaPath}`);
                } else {
                    vscode.window.showInformationMessage('Default Area Path cleared.');
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Unknown error';
                vscode.window.showErrorMessage(`Failed to update setting: ${message}`);
            }
        })
    );

    // Clear Default Area Path
    context.subscriptions.push(
        vscode.commands.registerCommand('queryStudio.clearDefaultAreaPath', async () => {
            try {
                const config = vscode.workspace.getConfiguration('queryStudio.ado');
                await config.update('defaultAreaPath', undefined, vscode.ConfigurationTarget.Global);
                clusterProvider.refresh();
                vscode.window.showInformationMessage('Default Area Path cleared.');
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Unknown error';
                vscode.window.showErrorMessage(`Failed to clear setting: ${message}`);
            }
        })
    );

    // Export All Clusters
    context.subscriptions.push(
        vscode.commands.registerCommand('queryStudio.exportAllClusters', async () => {
            try {
                const clusters = await client.getClusters();

                if (clusters.length === 0) {
                    vscode.window.showInformationMessage('No data sources to export');
                    return;
                }

                // Format as CSV
                const header = 'Name,Type,URL,Database/Project,Favorite';
                const rows = clusters.map(c =>
                    `"${c.name}","${c.type}","${c.url}","${c.database}","${c.isFavorite}"`
                );
                const csv = [header, ...rows].join('\n');

                // Also create JSON version
                const json = JSON.stringify(clusters, null, 2);

                // Ask user for format
                const format = await vscode.window.showQuickPick(
                    [
                        { label: 'CSV', description: 'Comma-separated values', value: 'csv' },
                        { label: 'JSON', description: 'JavaScript Object Notation', value: 'json' },
                        { label: 'Copy to Clipboard', description: 'Copy as text', value: 'clipboard' }
                    ],
                    { placeHolder: 'Select export format' }
                );

                if (!format) return;

                if (format.value === 'clipboard') {
                    // Format for clipboard (readable text)
                    const text = clusters.map(c => {
                        const type = c.type === 'kusto' ? 'Kusto' : 'ADO';
                        const fav = c.isFavorite ? '⭐' : '';
                        return `${fav}${c.name} (${type})\n  URL: ${c.url}\n  ${c.type === 'kusto' ? 'Database' : 'Project'}: ${c.database}`;
                    }).join('\n\n');
                    await vscode.env.clipboard.writeText(text);
                    vscode.window.showInformationMessage(`Copied ${clusters.length} data sources to clipboard`);
                    return;
                }

                const content = format.value === 'csv' ? csv : json;
                const ext = format.value;

                const uri = await vscode.window.showSaveDialog({
                    filters: { [ext.toUpperCase()]: [ext] },
                    defaultUri: vscode.Uri.file(`data-sources.${ext}`)
                });

                if (uri) {
                    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));
                    vscode.window.showInformationMessage(`Exported ${clusters.length} data sources to ${uri.fsPath}`);
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Unknown error';
                vscode.window.showErrorMessage(`Failed to export: ${message}`);
            }
        })
    );
}

async function addKustoCluster(client: SidecarClient, clusterProvider: ClusterTreeProvider) {
    const input = await vscode.window.showInputBox({
        prompt: 'Enter Kusto cluster name or URL',
        placeHolder: 'mycluster or https://mycluster.kusto.windows.net',
        ignoreFocusOut: true,
        validateInput: (value) => {
            if (!value) {
                return 'Cluster name or URL is required';
            }
            return undefined;
        }
    });

    if (!input) {
        return;
    }

    // Auto-complete the URL
    const clusterUrl = normalizeKustoUrl(input);

    const database = await vscode.window.showInputBox({
        prompt: 'Enter default database name',
        placeHolder: 'MyDatabase',
        ignoreFocusOut: true
    });

    if (!database) {
        return;
    }

    const name = await vscode.window.showInputBox({
        prompt: 'Enter a display name for this cluster',
        placeHolder: extractClusterName(clusterUrl),
        value: extractClusterName(clusterUrl),
        ignoreFocusOut: true
    });

    if (!name) {
        return;
    }

    try {
        const cluster: ClusterInfo = {
            id: Date.now().toString(),
            name: name,
            url: clusterUrl,
            database: database,
            type: 'kusto',
            isFavorite: false
        };

        await client.addCluster(cluster);
        clusterProvider.refresh();
        vscode.window.showInformationMessage(`Added cluster "${name}"`);
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        vscode.window.showErrorMessage(`Failed to add cluster: ${message}`);
    }
}

async function addAdoFromUrl(client: SidecarClient, clusterProvider: ClusterTreeProvider) {
    const url = await vscode.window.showInputBox({
        prompt: 'Paste an Azure DevOps URL (work item, project, or board)',
        placeHolder: 'https://dev.azure.com/org/project/... or https://org.visualstudio.com/project/...',
        ignoreFocusOut: true,
        validateInput: (value) => {
            if (!value) {
                return 'URL is required';
            }
            if (!value.includes('dev.azure.com') && !value.includes('visualstudio.com')) {
                return 'Invalid Azure DevOps URL';
            }
            return undefined;
        }
    });

    if (!url) {
        return;
    }

    // Parse the URL to extract org and project
    const parsed = parseAdoUrl(url);
    if (!parsed) {
        vscode.window.showErrorMessage('Could not extract organization and project from URL');
        return;
    }

    // Confirm with user
    const name = await vscode.window.showInputBox({
        prompt: 'Enter a display name',
        placeHolder: `${parsed.org}/${parsed.project}`,
        value: `${parsed.org}/${parsed.project}`,
        ignoreFocusOut: true
    });

    if (!name) {
        return;
    }

    try {
        const cluster: ClusterInfo = {
            id: Date.now().toString(),
            name: name,
            url: parsed.orgUrl,
            database: parsed.project,
            type: 'ado',
            isFavorite: false,
            organization: parsed.org
        };

        await client.addCluster(cluster);
        clusterProvider.refresh();
        vscode.window.showInformationMessage(`Added "${name}" from URL`);
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        vscode.window.showErrorMessage(`Failed to add organization: ${message}`);
    }
}

/**
 * Parse Azure DevOps URLs to extract org and project
 * Supports:
 * - https://dev.azure.com/{org}/{project}/...
 * - https://{org}.visualstudio.com/{project}/...
 */
function parseAdoUrl(url: string): { org: string; project: string; orgUrl: string } | null {
    try {
        const parsed = new URL(url);
        const hostname = parsed.hostname.toLowerCase();
        const pathParts = parsed.pathname.split('/').filter(p => p);

        // Format: https://dev.azure.com/{org}/{project}/...
        if (hostname === 'dev.azure.com') {
            if (pathParts.length >= 2) {
                const org = pathParts[0];
                const project = pathParts[1];
                return {
                    org,
                    project,
                    orgUrl: `https://dev.azure.com/${org}`
                };
            }
        }

        // Format: https://{org}.visualstudio.com/{project}/...
        if (hostname.endsWith('.visualstudio.com')) {
            const org = hostname.replace('.visualstudio.com', '');
            if (pathParts.length >= 1) {
                const project = pathParts[0];
                return {
                    org,
                    project,
                    orgUrl: `https://${hostname}`
                };
            }
        }

        return null;
    } catch {
        return null;
    }
}

async function addAdoOrganization(client: SidecarClient, clusterProvider: ClusterTreeProvider) {
    const orgUrl = await vscode.window.showInputBox({
        prompt: 'Enter Azure DevOps organization URL',
        placeHolder: 'https://dev.azure.com/myorg',
        ignoreFocusOut: true,
        validateInput: (value) => {
            if (!value) {
                return 'Organization URL is required';
            }
            if (!value.includes('dev.azure.com') && !value.includes('visualstudio.com')) {
                return 'Invalid Azure DevOps URL';
            }
            return undefined;
        }
    });

    if (!orgUrl) {
        return;
    }

    const project = await vscode.window.showInputBox({
        prompt: 'Enter default project name',
        placeHolder: 'MyProject',
        ignoreFocusOut: true
    });

    if (!project) {
        return;
    }

    const name = await vscode.window.showInputBox({
        prompt: 'Enter a display name',
        placeHolder: extractOrgName(orgUrl),
        value: extractOrgName(orgUrl),
        ignoreFocusOut: true
    });

    if (!name) {
        return;
    }

    try {
        const cluster: ClusterInfo = {
            id: Date.now().toString(),
            name: name,
            url: orgUrl,
            database: project,
            type: 'ado',
            isFavorite: false,
            organization: extractOrgName(orgUrl)
        };

        await client.addCluster(cluster);
        clusterProvider.refresh();
        vscode.window.showInformationMessage(`Added organization "${name}"`);
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        vscode.window.showErrorMessage(`Failed to add organization: ${message}`);
    }
}

function normalizeKustoUrl(input: string): string {
    let url = input.trim();

    // Remove any trailing slashes
    url = url.replace(/\/+$/, '');

    // If it's already a full URL, return as is
    if (url.startsWith('https://') || url.startsWith('http://')) {
        return url;
    }

    // If it contains a known Kusto domain, just add https://
    const knownDomains = ['.kusto.windows.net', '.kusto.azure.com', '.kustomfa.windows.net', '.kusto.data.microsoft.com'];
    for (const domain of knownDomains) {
        if (url.toLowerCase().includes(domain.replace('.', ''))) {
            return `https://${url}`;
        }
    }

    // If it contains .kusto. or other ADX-like patterns, just add https://
    if (url.includes('.kusto.') || url.includes('.kustomfa.') || url.includes('.data.microsoft.com')) {
        return `https://${url}`;
    }

    // If it ends with a recognized TLD, treat as a full hostname
    const knownTlds = ['.net', '.com', '.org', '.io', '.cloud', '.azure'];
    if (url.includes('.') && !url.includes(' ') && knownTlds.some(tld => url.toLowerCase().endsWith(tld))) {
        return `https://${url}`;
    }

    // Otherwise, assume it's a cluster name (possibly with region like "m365dprd.westeurope")
    // and add the full domain. Default to kusto.windows.net (most common)
    return `https://${url}.kusto.windows.net`;
}

function extractClusterName(url: string): string {
    try {
        const match = url.match(/https?:\/\/([^.]+)/);
        return match ? match[1] : url;
    } catch {
        return url;
    }
}

function extractOrgName(url: string): string {
    try {
        if (url.includes('dev.azure.com')) {
            const match = url.match(/dev\.azure\.com\/([^/]+)/);
            return match ? match[1] : url;
        }
        if (url.includes('visualstudio.com')) {
            const match = url.match(/([^.]+)\.visualstudio\.com/);
            return match ? match[1] : url;
        }
        return url;
    } catch {
        return url;
    }
}

async function addDataSourceFromImage(
    client: SidecarClient,
    clusterProvider: ClusterTreeProvider,
    mode: string
) {
    // Show options: Paste from Clipboard or Select File
    const choice = await vscode.window.showQuickPick([
        { label: '$(clippy) Paste from Clipboard', value: 'clipboard', description: 'Use screenshot from clipboard (Ctrl+V)' },
        { label: '$(file-media) Select Image File', value: 'file', description: 'Choose an image file' }
    ], { placeHolder: 'How would you like to provide the screenshot?' });

    if (!choice) return;

    let imageBase64: string | undefined;
    let mimeType: string | undefined;

    if (choice.value === 'clipboard') {
        const result = await ClipboardImageCapture.captureFromClipboard();
        if (!result) {
            return; // User cancelled or no image
        }
        imageBase64 = result.base64;
        mimeType = result.mimeType;
    } else {
        const result = await selectImageFile();
        if (!result) return;
        imageBase64 = result.base64;
        mimeType = result.mimeType;
    }

    // Show progress while extracting
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Analyzing screenshot with AI...',
        cancellable: false
    }, async () => {
        try {
            const extracted = await client.extractDataSourceFromImage({
                imageBase64: imageBase64!,
                imageMimeType: mimeType!,
                mode: mode === 'kusto' ? 'kusto' : 'ado'
            });

            if (!extracted.success) {
                // Handle auth required - prompt VS Code GitHub sign-in and retry
                if (extracted.error === 'AUTH_REQUIRED') {
                    try {
                        const session = await vscode.authentication.getSession('github', ['read:user'], { createIfNone: true });
                        if (session) {
                            await client.setAiToken(session.accessToken);
                            const retry = await client.extractDataSourceFromImage({
                                imageBase64: imageBase64!,
                                imageMimeType: mimeType!,
                                mode: mode === 'kusto' ? 'kusto' : 'ado'
                            });
                            if (retry.success) {
                                await handleExtractedResult(client, clusterProvider, retry, mode);
                                return;
                            }
                            vscode.window.showErrorMessage(`Could not extract info: ${retry.error || 'Unknown error'}`);
                            return;
                        }
                    } catch {
                        // Sign-in cancelled or failed
                    }
                    vscode.window.showErrorMessage('GitHub sign-in is required for AI features. Please sign in and try again.');
                    return;
                }
                vscode.window.showErrorMessage(`Could not extract info: ${extracted.error || 'Unknown error'}`);
                return;
            }

            await handleExtractedResult(client, clusterProvider, extracted, mode);
        } catch (error) {
            const msg = error instanceof Error ? error.message : 'Unknown error';
            vscode.window.showErrorMessage(`Extraction failed: ${msg}`);
        }
    });
}

async function selectImageFile(): Promise<{ base64: string; mimeType: string } | undefined> {
    const uris = await vscode.window.showOpenDialog({
        filters: { 'Images': ['png', 'jpg', 'jpeg', 'gif', 'webp'] },
        canSelectMany: false,
        title: 'Select screenshot'
    });

    if (!uris || uris.length === 0) return undefined;

    const fileBuffer = await vscode.workspace.fs.readFile(uris[0]);
    const base64 = Buffer.from(fileBuffer).toString('base64');
    const ext = uris[0].path.split('.').pop()?.toLowerCase();
    const mimeType = ext === 'png' ? 'image/png' :
                     ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' :
                     ext === 'gif' ? 'image/gif' :
                     ext === 'webp' ? 'image/webp' : 'image/png';

    return { base64, mimeType };
}

async function handleExtractedResult(
    client: SidecarClient,
    clusterProvider: ClusterTreeProvider,
    extracted: ExtractedDataSourceInfo,
    mode: string
) {
    // Use multi-cluster flow for kusto when clusters array is available
    if (mode === 'kusto' && extracted.clusters && extracted.clusters.length > 0) {
        await addMultipleClusters(client, clusterProvider, extracted.clusters);
        return;
    }

    // Fallback to single-item confirm flow (ADO or when no clusters array)
    await confirmAndAddDataSource(client, clusterProvider, extracted, mode);
}

async function addMultipleClusters(
    client: SidecarClient,
    clusterProvider: ClusterTreeProvider,
    clusters: ExtractedClusterItem[]
) {
    // Build a flat list of cluster/database pairs for QuickPick
    interface ClusterDbItem extends vscode.QuickPickItem {
        clusterUrl: string;
        database?: string;
        clusterDisplayName?: string;
    }

    const items: ClusterDbItem[] = [];
    for (const cluster of clusters) {
        if (cluster.databases.length === 0) {
            // Cluster with no databases
            items.push({
                label: cluster.displayName || cluster.clusterUrl,
                description: cluster.clusterUrl,
                picked: true,
                clusterUrl: cluster.clusterUrl,
                clusterDisplayName: cluster.displayName
            });
        } else {
            for (const db of cluster.databases) {
                items.push({
                    label: `${cluster.displayName || cluster.clusterUrl} / ${db}`,
                    description: cluster.clusterUrl,
                    picked: true,
                    clusterUrl: cluster.clusterUrl,
                    database: db,
                    clusterDisplayName: cluster.displayName
                });
            }
        }
    }

    const selected = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        placeHolder: `Select data sources to add (${items.length} found in screenshot)`
    });

    if (!selected || selected.length === 0) {
        return;
    }

    let added = 0;
    for (const item of selected) {
        try {
            const clusterInfo: ClusterInfo = {
                id: Date.now().toString() + '_' + added,
                name: item.clusterDisplayName || extractClusterName(item.clusterUrl),
                url: normalizeKustoUrl(item.clusterUrl),
                database: item.database || '',
                type: 'kusto',
                isFavorite: false
            };
            await client.addCluster(clusterInfo);
            added++;
        } catch (err) {
            console.error(`Failed to add ${item.label}:`, err);
        }
    }

    if (added > 0) {
        clusterProvider.refresh();
        vscode.window.showInformationMessage(`Added ${added} data source(s) from screenshot`);
    }
}

async function editSingleConnection(
    client: SidecarClient,
    clusterProvider: ClusterTreeProvider,
    cluster: ClusterInfo
) {
    const isKusto = cluster.type === 'kusto';

    const url = await vscode.window.showInputBox({
        prompt: isKusto ? 'Cluster URL' : 'Organization URL',
        value: cluster.url,
        ignoreFocusOut: true,
        validateInput: (v) => v ? undefined : 'URL is required'
    });
    if (!url) return;

    const database = await vscode.window.showInputBox({
        prompt: isKusto ? 'Database name' : 'Project name',
        value: cluster.database,
        ignoreFocusOut: true
    });
    if (database === undefined) return;

    const name = await vscode.window.showInputBox({
        prompt: 'Display name',
        value: cluster.name,
        ignoreFocusOut: true,
        validateInput: (v) => v?.trim() ? undefined : 'Name is required'
    });
    if (!name) return;

    const finalUrl = isKusto ? normalizeKustoUrl(url) : url;

    if (finalUrl === cluster.url && database === cluster.database && name === cluster.name) {
        return;
    }

    try {
        await client.removeCluster(cluster.id);
        const updated: ClusterInfo = {
            id: Date.now().toString(),
            name: name.trim(),
            url: finalUrl,
            database: database || '',
            type: cluster.type,
            isFavorite: cluster.isFavorite,
            organization: cluster.organization
        };
        await client.addCluster(updated);
        clusterProvider.refresh();
        vscode.window.showInformationMessage(`Updated "${name}"`);
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        vscode.window.showErrorMessage(`Failed to update connection: ${message}`);
    }
}

async function confirmAndAddDataSource(
    client: SidecarClient,
    clusterProvider: ClusterTreeProvider,
    extracted: ExtractedDataSourceInfo,
    mode: string
) {
    // Pre-fill the add dialog with extracted values, allow user to edit
    const clusterUrl = await vscode.window.showInputBox({
        prompt: mode === 'kusto' ? 'Cluster URL (extracted from screenshot)' : 'Organization URL',
        value: extracted.clusterUrl || '',
        ignoreFocusOut: true,
        validateInput: (v) => v ? undefined : 'URL is required'
    });
    if (!clusterUrl) return;

    const database = await vscode.window.showInputBox({
        prompt: mode === 'kusto' ? 'Database name' : 'Project name',
        value: extracted.database || '',
        ignoreFocusOut: true
    });
    if (!database) return;

    const displayName = await vscode.window.showInputBox({
        prompt: 'Display name',
        value: extracted.displayName || extractClusterName(clusterUrl),
        ignoreFocusOut: true
    });
    if (!displayName) return;

    try {
        const cluster: ClusterInfo = {
            id: Date.now().toString(),
            name: displayName,
            url: mode === 'kusto' ? normalizeKustoUrl(clusterUrl) : clusterUrl,
            database: database,
            type: mode === 'kusto' ? 'kusto' : 'ado',
            isFavorite: false,
            organization: mode === 'ado' ? extracted.organization : undefined
        };

        await client.addCluster(cluster);
        clusterProvider.refresh();
        vscode.window.showInformationMessage(`Added "${displayName}" from screenshot!`);
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        vscode.window.showErrorMessage(`Failed to add data source: ${message}`);
    }
}

async function importFromKustoExplorer(
    client: SidecarClient,
    clusterProvider: ClusterTreeProvider
) {
    try {
        // First try the default location
        let result = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Scanning Kusto Explorer connections...',
            cancellable: false
        }, async () => {
            return await client.importFromKustoExplorer();
        });

        // If default location fails, offer to select a file
        if (!result.success) {
            const choice = await vscode.window.showQuickPick([
                { label: '$(file) Select exported XML file', value: 'select', description: 'Choose a file exported from Kusto Explorer' },
                { label: '$(x) Cancel', value: 'cancel', description: '' }
            ], {
                placeHolder: result.error || 'Default location not found. Select an exported connections file.'
            });

            if (!choice || choice.value === 'cancel') {
                return;
            }

            // Show file picker
            const files = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                filters: {
                    'XML files': ['xml'],
                    'All files': ['*']
                },
                title: 'Select Kusto Explorer exported connections file'
            });

            if (!files || files.length === 0) {
                return;
            }

            // Try with the selected file
            result = await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Reading connections file...',
                cancellable: false
            }, async () => {
                return await client.importFromKustoExplorer(files[0].fsPath);
            });

            if (!result.success) {
                vscode.window.showWarningMessage(result.error || 'Failed to import connections');
                return;
            }
        }

        if (result.connections.length === 0) {
            vscode.window.showInformationMessage('No connections found in the file');
            return;
        }

        // Let user select which connections to import
        const items = result.connections.map(conn => ({
            label: conn.name,
            description: conn.database ? `${conn.clusterUrl} / ${conn.database}` : conn.clusterUrl,
            picked: true,
            connection: conn
        }));

        const selected = await vscode.window.showQuickPick(items, {
            canPickMany: true,
            placeHolder: `Select connections to import (${result.connections.length} found)`
        });

        if (!selected || selected.length === 0) {
            return;
        }

        // Import selected connections
        let imported = 0;
        let skipped = 0;
        for (const item of selected) {
            const conn = item.connection;
            try {
                let database = conn.database;

                // If no database specified, ask user to enter one
                if (!database) {
                    database = await vscode.window.showInputBox({
                        prompt: `Enter database name for ${conn.name} (${conn.clusterUrl})`,
                        placeHolder: 'e.g., SampleDB',
                        title: 'Database Required'
                    });

                    if (!database) {
                        // User cancelled - skip this connection
                        skipped++;
                        continue;
                    }
                }

                const cluster: ClusterInfo = {
                    id: Date.now().toString() + '_' + imported,
                    name: conn.name,
                    url: normalizeKustoUrl(conn.clusterUrl),
                    database: database,
                    type: 'kusto',
                    isFavorite: false
                };
                await client.addCluster(cluster);
                imported++;
            } catch (err) {
                console.error(`Failed to import ${conn.name}:`, err);
            }
        }

        clusterProvider.refresh();
        const skippedMsg = skipped > 0 ? ` (${skipped} skipped)` : '';
        vscode.window.showInformationMessage(`Imported ${imported} connections from Kusto Explorer${skippedMsg}`);
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        vscode.window.showErrorMessage(`Import failed: ${message}`);
    }
}
