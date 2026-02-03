# Run Your Query

Execute queries and explore results with powerful tools.

## Query Editor Toolbar

When you have a query file open, the editor toolbar shows these buttons:

| Button | Name | Description |
|--------|------|-------------|
| **▶** | Run Query | Execute the current query (F5) |
| **⏹** | Cancel | Stop a running query (Shift+F5) |
| **💡** | Suggest | Get AI suggestions to improve your query |
| **❓** | Explain | Have AI explain what your query does |
| **⚙️** | Format | Format and clean up your query |

## Running Queries

**Keyboard:** Press **F5** to run the query at cursor position.

**Mouse:** Click the **▶ Run** button in the editor toolbar.

**Query Selection:**
- If you **select text**, only the selected portion runs
- If **no selection**, Quest finds the query block at your cursor
- Query blocks are separated by blank lines

## Results Panel Toolbar

After a query runs, the results panel shows these buttons:

| Button | Description |
|--------|-------------|
| **Set Query** | Load this query into the editor |
| **Copy** | Copy query with cluster/database info |
| **Save Result** | Save to results history |
| **Chart** | Visualize results as a chart |
| **Pivot** | Create pivot table from results |
| **Compare** | Compare two result tabs |
| **Columns** | Show/hide columns |
| **Presets** | Apply saved column configurations |

## Results Table Features

### Column Header Actions
Click a column header to:
- **Sort** ascending/descending
- **Hide** the column
- **Highlight** the column

### Row Actions
- **Single click** - Select row
- **Ctrl+Click** - Add/remove from selection
- **Shift+Click** - Select range
- **Double-click** - Open item (ADO work item, Outlook email, or URL)

### Right-Click Context Menu
- **Copy** - Copy cell, row, or selection
- **Preview** - See full row details in side panel
- **Color by value** - Add highlighting rule
- **View as JSON** - Expand complex values

## Filter Box

Type in the filter box to search results:

| Pattern | Description |
|---------|-------------|
| `text` | Filter rows containing "text" in any column |
| `column::value` | Filter specific column |
| `!text` | Exclude rows containing "text" |
| `::column` | Highlight a column |

Click the **mode button** (🔽/🖌️) to toggle between:
- **Filter mode** - Hide non-matching rows
- **Highlight mode** - Show all rows, highlight matches

## Multiple Result Tabs

Run multiple queries and switch between results using tabs. Each tab shows:
- AI-generated title describing the query
- Row count in brackets
- Click **×** to close a tab
