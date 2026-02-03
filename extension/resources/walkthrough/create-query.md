# Create Your First Query

Quest provides dedicated file types for each query language.

## File Extensions

| Extension | Language | Mode |
|-----------|----------|------|
| `.kql` | Kusto Query Language | Kusto |
| `.wiql` | Work Item Query Language | ADO |
| `.oql` | Outlook Query Language | Outlook |

## Quick Start Examples

### KQL Query
```kql
StormEvents
| where State == "FLORIDA"
| where StartTime > ago(30d)
| project EventType, BeginLocation, DamageProperty
| take 100
```

### OQL Query
```oql
Inbox
| where Subject contains "urgent"
| where ReceivedTime > ago(7d)
| project Subject, From, ReceivedTime
| take 50
```

### WIQL Query
```wiql
SELECT [System.Id], [System.Title], [System.State]
FROM WorkItems
WHERE [System.AssignedTo] = @Me
  AND [System.State] = 'Active'
```

## Tips

- Use **IntelliSense** (Ctrl+Space) for suggestions
- Hover over keywords for documentation
- Check the **Snippets** panel for templates
