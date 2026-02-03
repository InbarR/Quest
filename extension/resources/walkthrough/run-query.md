# Run Your Query

Execute queries and view results with a single keystroke.

## Running Queries

| Shortcut | Action |
|----------|--------|
| **F5** | Run current query |
| **Ctrl+Enter** | Run current query |
| **Shift+F5** | Cancel running query |

You can also click the **Run** button in the editor toolbar.

## Multi-Query Files

When your file contains multiple queries separated by blank lines, Quest runs only the query at your cursor position.

```kql
// Query 1 - cursor here runs this one
StormEvents | take 10

// Query 2
StormEvents | summarize count() by State
```

## Results Panel

Results appear in the bottom panel with these features:

- **Sort** - Click column headers to sort
- **Filter** - Type to filter rows
- **Export** - Export to CSV, JSON, or copy to clipboard
- **Re-run** - Click to run the query again

## Results History

Your recent query results are saved automatically. Find them in the **Saved Results** panel to review past executions.
