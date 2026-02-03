using Manina.Windows.Forms;
using System;
using System.Linq;
using System.Windows.Forms;

namespace MyUtils
{
    public partial class MyTabControl : Manina.Windows.Forms.TabControl
    {
        public delegate bool PredFunc(Tab tab, Tab hitTab);

        private HitResult _hit;
        private readonly ContextMenu _menu;

        public MyTabControl()
        {
            InitializeComponent();

            ShowCloseTabButtons = true;

            _menu = new ContextMenu();
            _menu.MenuItems.Add("Rename", (s, _) => OnRename());
            _menu.MenuItems.Add("Close", (s, _) => CloseTabs(true));
            _menu.MenuItems.Add("Close All Tabs", (s, _) => CloseTabs(false));
            _menu.MenuItems.Add("Close All But This", (s, _) => CloseTabs(true));
            _menu.MenuItems.Add("Close By Name", (s, _) => CloseTabs(true, SameName));

            MouseUp += OnMouseUp;
        }

        private static bool SameName(Tab t, Tab hit)
        {
            try
            {
                if (t == null || hit == null)
                {
                    return false;
                }

                return t.Text.Split(" ")[0] == hit.Text.Split(" ")[0];
            }
            catch
            {
                // ignored
                return false;
            }
        }

        private void OnMouseUp(object sender, MouseEventArgs e)
        {

            _hit = PerformHitTest(e.Location);

            if (_hit.Tab)
            {
                if (e.Button == MouseButtons.Middle)
                {
                    CloseTab(_hit.HitTab);
                }

                if (e.Button == MouseButtons.Right)
                {
                    _menu.Show(this, e.Location);
                }
            }

        }

        public void AddColumnMenu(string title, Action action)
        {
            _menu.MenuItems.Add(title, (s, e) => action());
        }

        public void CloseTabs(bool onHit, PredFunc predFunc = null)
        {
            try
            {
                var hitTab = onHit ? _hit.HitTab : null;

                foreach (var tab in Tabs.ToArray())
                {
                    if (predFunc != null)
                    {
                        if (!predFunc(tab, hitTab))
                        {
                            continue;
                        }
                    }
                    else
                    {
                        if (tab == hitTab)
                        {
                            continue;
                        }
                    }

                    Tabs.Remove(tab);
                }

                hitTab?.Show();
            }
            catch
            {
                // ignored
            }
        }

        private void OnRename()
        {
            try
            {
                var hitTab = _hit.HitTab;

                var (input, _) = InputForm.GetInput(null, null, Mode.Rename, true);
                if (input.IsEmpty())
                {
                    return;
                }

                hitTab.Text = input;
            }
            catch
            {
                // ignored
            }
        }

        private void CloseTab(Tab tab)
        {
            try
            {
                Pages.Remove(tab);
                SelectedTab.Show();
            }
            catch
            {
                // ignored
            }
        }
    }
}
