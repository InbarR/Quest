using System;
using System.Drawing;
using System.Linq;
using System.Windows.Forms;

namespace MyUtils
{
    public class MyListView : ListView
    {
        public Point LastHit;

        private Action<string> _logFunc;

        public MyListView()
        {
            var contextMenu = new ContextMenuStrip();
            MouseClick += OnMouseClick;
            FullRowSelect = true;
            KeyDown += OnKeyDown;

            AddMenuItem(contextMenu, "Copy Cell", (s, e) => OnCopyCell(true, false));
            AddMenuItem(contextMenu, "Highlight Row", (s, e) => OnHighlightRow(), Properties.Resources.highlight);
            AddMenuItem(contextMenu, "Copy Row", (s, e) => OnCopyRow(false));
            AddMenuItem(contextMenu, "Copy With Headers", (s, e) => OnCopyRow(true));
            AddMenuItem(contextMenu, "Copy Column", (s, e) => OnCopyCell(false, false));
            AddMenuItem(contextMenu, "Copy Column Distinct Values", (s, e) => OnCopyCell(false, true), Properties.Resources.copy);
            AddMenuItem(contextMenu, "Copy Column Distinct Values As One Line", (s, e) => OnCopyCell(false, true, true), Properties.Resources.copy);

            ContextMenuStrip = contextMenu;
        }

        public void SetLogFunc(Action<string> logFunc)
        {
            _logFunc = logFunc;

            AddMenuItem(ContextMenuStrip, "Count Column Distinct Values", (s, e) => OnCopyCell(false, true, count: true), Properties.Resources.hash);
        }

        private void OnKeyDown(object sender, KeyEventArgs e)
        {
            try
            {
                if (e.Modifiers == Keys.Control && e.KeyCode == Keys.A)
                {
                    foreach (ListViewItem item in Items)
                    {
                        item.Selected = true;
                    }

                    return;
                }

                if (e.KeyCode == Keys.Space)
                {
                    OnHighlightRow();
                    return;
                }

                if (e.Modifiers == Keys.Control && e.KeyCode == Keys.C)
                {
                    OnCopyCell(false, true);
                }
            }
            catch
            {
                // ignored
            }
        }

        private void OnCopyRow(bool withHeader)
        {
            try
            {
                var rows = SelectedItems.Cast<ListViewItem>()
                    .Select(i => i.SubItems.Cast<ListViewItem.ListViewSubItem>().Select(s => s.Text).Joined()).ToList();

                if (withHeader)
                {
                    rows.Insert(0, Columns.Cast<ColumnHeader>().Select(c => c.Text).Joined());
                }

                Clipboard.SetDataObject(rows.Joined("\n"));
            }
            catch
            {
                // ignored
            }
        }

        private void OnMouseClick(object sender, MouseEventArgs e)
        {
            try
            {
                LastHit = e.Location;

                if (e.Button == MouseButtons.Right)
                {
                    ContextMenuStrip.Show(this, e.Location);
                }
            }
            catch
            {
                // ignored
            }
        }

        public void AddMenuItem(string title, EventHandler handler, Image image = null)
        {
            AddMenuItem(ContextMenuStrip, title, handler, image);
        }

        private static void AddMenuItem(ContextMenuStrip menu, string title, EventHandler handler, Image image = null)
        {
            var item = new ToolStripButton(title, image, handler);
            menu.Items.Add(item);
        }

        private string RemoveDoubleLines(string str)
        {
            str = str.Replace("    ", "\n");

            while (str.Contains("\n\n"))
            {
                str = str.Replace("\n\n", "\n");
            }

            return str;
        }

        public string GetCellText()
        {
            var subItems = GetSelectedCell(true, false);
            if (subItems == null)
            {
                return null;
            }

            return subItems.First();
        }

        private void OnCopyCell(bool selected, bool distinct, bool oneLine = false, bool count = false)
        {
            try
            {
                var subItems = GetSelectedCell(selected, distinct);
                if (subItems == null)
                {
                    return;
                }

                string txt = oneLine ?
                    subItems.Select(s => s.AddQuotes()).Joined() :
                    subItems.Select(c => RemoveDoubleLines(c)).Joined("\n");

                if (count)
                {
                    _logFunc?.Invoke(subItems.Length.ToString());
                    return;
                }

                Clipboard.SetDataObject(txt);
            }
            catch
            {
                // ignored
            }
        }

        private void OnHighlightRow()
        {
            try
            {
                var color = Color.Blue;

                foreach (var row in SelectedItems.Cast<ListViewItem>())
                {
                    row.UseItemStyleForSubItems = true;
                    row.BackColor = row.BackColor == color ? Color.White : color;
                }
            }
            catch
            {
                // ignored
            }
        }

        public string[] GetSelectedCell(bool selected, bool distinct, bool addQuotes = false)
        {
            var hit = HitTest(LastHit);

            if (hit.Item == null)
            {
                return null;
            }

            int index = GetCellIndex(hit);

            var items = selected ? SelectedItems.Cast<ListViewItem>() : Items.Cast<ListViewItem>();
            var subItems = items.Select(i => addQuotes ? i.SubItems[index].Text.AddQuotes() : i.SubItems[index].Text).Where(s => s.IsNotEmpty());

            if (distinct)
            {
                subItems = subItems.Distinct();
            }

            return subItems.ToArray();
        }

        public static int GetCellIndex(ListViewHitTestInfo hit)
        {
            for (var i = 0; i < hit.Item.SubItems.Count; ++i)
            {
                if (hit.Item.SubItems[i] == hit.SubItem)
                {
                    return i;
                }
            }

            throw new Exception("Failed to get subitem - " + hit.SubItem.Text);
        }
    }
}
