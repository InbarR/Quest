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
Query work items using WIQL or KQL-like syntax.

```wiql
WorkItems
| where State == "Active"
| where AssignedTo == @me
```

### Outlook Mode
Query your local Outlook data - emails, calendar, contacts.

```oql
Inbox
| where ReceivedTime > ago(7d)
| where Subject contains "meeting"
```

## How to Switch Modes

- Click the **mode indicator** in the status bar
- Use **Ctrl+Shift+M** to toggle modes
- Click the **toggle button** in the sidebar header
