# Add a Data Source

Configure your data sources to start querying.

## Data Sources Panel Buttons

| Button | Icon | Description |
|--------|------|-------------|
| **Add** | ➕ | Add a new cluster or organization |
| **Refresh** | 🔄 | Reload the data source list |
| **Export** | 📤 | Export all data sources to a file |

## Adding a Kusto Cluster

1. Make sure you're in **Kusto mode** (check the mode toggle)
2. Click the **➕ Add** button in the Data Sources panel
3. Enter your cluster URL:
   - `https://help.kusto.windows.net` (free sample data!)
   - `https://yourcluster.kusto.windows.net`
4. Optionally set a **display name** for the cluster
5. Select a **database** from the dropdown
6. Click **Add** to save

## Adding an ADO Organization

1. Switch to **ADO mode** using the mode toggle
2. Click the **➕ Add** button
3. Enter your organization URL:
   - `https://dev.azure.com/yourorg`
4. Enter your **project name**
5. Click **Add** to save

## Data Source Context Menu

Right-click on any data source to see options:

| Option | Description |
|--------|-------------|
| **Set as Active** | Use this for queries |
| **Rename** | Change the display name |
| **Toggle Favorite** | Star/unstar the source |
| **Fetch Schema** | Load table/column metadata |
| **Copy Info** | Copy connection details |
| **Remove** | Delete this data source |

## Outlook Mode

No configuration needed! Outlook mode automatically connects to your local Outlook installation. Just switch to Outlook mode and start querying.
