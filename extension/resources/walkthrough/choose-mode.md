# Choose Your Query Mode

Quest supports three query modes. Switch between them based on what data you want to query.

## Available Modes

### KQL Mode (Kusto)
Query Azure Data Explorer clusters using Kusto Query Language.

```kql
StormEvents
| where StartTime > ago(7d)
| summarize count() by State
| top 10 by count_
```

### ADO Mode (Azure DevOps)
Query work items using WIQL (Work Item Query Language).

```wiql
SELECT [System.Id], [System.Title], [System.State]
FROM WorkItems
WHERE [System.AssignedTo] = @Me
  AND [System.State] <> 'Closed'
```

### Outlook Mode
Query your local Outlook data - emails, calendar, contacts.

```oql
Inbox
| where ReceivedTime > ago(7d)
| where Subject contains "meeting"
```

## How to Switch Modes

There are three ways to change the active mode:

### 1. Status Bar Mode Selector
Click the **mode indicator** in the bottom status bar (shows "KQL", "ADO", or "Outlook"). A dropdown will appear letting you select the mode.

### 2. Sidebar Toggle Button
Click the **mode toggle button** in the Data Sources panel header. The icon changes based on current mode:
- Database icon = KQL mode
- Azure DevOps icon = ADO mode
- Outlook icon = Outlook mode

### 3. Automatic Detection
Quest automatically detects the mode based on:
- **File extension**: `.kql` = Kusto, `.wiql` = ADO, `.oql` = Outlook
- **Active data source**: Selecting a cluster sets KQL mode, selecting an ADO org sets ADO mode

## Mode Indicators

When you switch modes, these things update:

| Element | What Changes |
|---------|--------------|
| **Status bar** | Shows current mode (KQL/ADO/Outlook) and active connection |
| **Data Sources panel** | Shows relevant data sources for current mode |
| **IntelliSense** | Provides mode-specific completions and syntax |
| **Run button** | Executes query against the correct service |

## Tips

- **Each mode has its own data sources** - Add Kusto clusters for KQL, ADO organizations for ADO
- **Outlook requires no setup** - It uses your local Outlook installation
- **Queries stay in their tabs** - Switching modes doesn't affect existing result tabs
