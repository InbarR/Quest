# Run Your Query

Execute queries and explore results with powerful tools.

## Running Queries

| Shortcut | Action |
|----------|--------|
| **F5** | Run query at cursor |
| **Ctrl+Enter** | Run query at cursor |
| **Shift+F5** | Cancel running query |

You can also click the **▶ Run** button in the editor toolbar.

## Results Panel Toolbar

The results panel has these buttons:

| Button | Description |
|--------|-------------|
| **▶ Re-run** | Execute the query again |
| **📋 Copy Query** | Copy query with cluster info to clipboard |
| **💾 Save** | Save query to favorites |
| **📤 Export** | Export results to CSV or JSON |
| **🎨 Clear Colors** | Remove all color highlighting rules |
| **🔗 Open in ADX** | Open query in Azure Data Explorer web (Kusto only) |
| **🔗 Open in ADO** | Open query in Azure DevOps web (ADO only) |

## Results Table Features

### Column Actions (click column header)
- **Sort** ascending/descending
- **Hide column** to reduce clutter
- **Highlight column** for emphasis

### Row Actions
- **Single click** - Select row
- **Ctrl+Click** - Add/remove from selection
- **Shift+Click** - Select range
- **Double-click** - Open item (ADO work item, Outlook email, or URL)

### Right-Click Context Menu
- **Copy cell/row/selection** - Various copy options
- **Filter** - Quick filter by value
- **Preview** - See full row details in side panel
- **Color by value** - Add highlighting rule
- **View as JSON** - Expand complex values

## Filter Box

Type in the filter box to search results:
- `text` - Filter rows containing "text"
- `column::value` - Filter specific column
- `!text` - Exclude rows with "text"

Toggle between **Filter** (hide non-matching) and **Highlight** (show all, highlight matches) modes.

## Tabs

Run multiple queries and switch between results using tabs. Each tab shows:
- Query type icon (Kusto/ADO/Outlook)
- Row count
- Execution time
