using System;
using System.Drawing;
using System.IO;
using System.Windows.Forms;

namespace MyUtils
{
    public partial class InputForm : Form
    {
        private readonly string _lastSubnetsFile;

        private Mode CurMode;
        private bool _showSubnets;
        public string Base64Mode;

        private InputForm(string lastSubnetsFile)
        {
            InitializeComponent();

            _lastSubnetsFile = lastSubnetsFile;

            KeyPreview = true;
            KeyDown += OnKeyDown;
        }

        private void OnKeyDown(object sender, KeyEventArgs e)
        {
            try
            {
                if (e.Modifiers == Keys.Control && e.KeyCode == Keys.Enter)
                {
                    btnGo.PerformClick();
                    return;
                }

                if (e.Modifiers == Keys.Control && e.KeyCode == Keys.L)
                {
                    btnLast.PerformClick();
                    return;
                }

                if (e.Modifiers == Keys.Control && e.KeyCode == Keys.V)
                {
                    txtInput.Text = Clipboard.GetText().Replace("\n", "\r\n");
                    e.Handled = true;
                    e.SuppressKeyPress = true;
                }
            }
            catch
            {
                // ignored
            }
        }

        public static (string, string) GetInput(Icon icon, string appFolder, Mode mode, bool minimized = false, string title = null)
        {
            string input;
            string extra;

            var lastSubnetsFile = appFolder == null ? null : Path.Combine(appFolder, "IpSubnets.txt");

            using (var form = new InputForm(lastSubnetsFile)
            {
                Text = title == null ? mode.ToString() : title,
                Icon = icon,
                CurMode = mode
            })
            {
                if (minimized)
                {
                    form.Height = 150;
                    form.Width = 300;
                    form.lblItems.Visible = false;
                    form.tsUpper.Visible = form.tsLower.Visible = false;
                }

                form.StartPosition = FormStartPosition.CenterScreen;

                if (form.ShowDialog() == DialogResult.Cancel)
                {
                    return (null, null);
                }

                input = form.txtInput.Text;
                extra = form.Base64Mode ?? (form.CurMode == Mode.Sha ? form.tsSha.Text : form.txtSubnet.Text);
            }

            return (input, extra);
        }

        private void InputForm_Load(object sender, EventArgs e)
        {
            try
            {
                KeyPreview = true;
                KeyDown += (s, e1) =>
                {
                    if (e1.KeyCode == Keys.Escape)
                    {
                        Close();
                        DialogResult = DialogResult.Cancel;
                    }
                };

                _showSubnets = false;

                Base64Mode = null;
                tsDecode.Visible = tsEncode.Visible = false;
                btnLast.Visible = lblSubnet.Visible = txtSubnet.Visible = false;
                tsSha.Visible = false;

                switch (CurMode)
                {
                    case Mode.Base64:
                        tsDecode.Visible = tsEncode.Visible = true;
                        tsDecode.PerformClick();
                        break;

                    case Mode.Unscrub:
                        _showSubnets = true;
                        txtSubnet.Text = @"192.168,10.0,10.1,0.0,169.254,255.255,172.16,127.0,172.24";
                        btnLast.Visible = lblSubnet.Visible = txtSubnet.Visible = true;
                        break;

                    case Mode.Sha:
                        tsSha.Visible = true;
                        tsSha.Items.AddRange(new[] { "SHA-1", "SHA-256" });
                        tsSha.SelectedIndex = 0;
                        break;
                }
            }
            catch
            {
                // ignored
            }
        }

        private void txtInput_TextChanged(object sender, EventArgs e)
        {
            try
            {
                lblItems.Text = $@"{txtInput.Text.Split("\n", StringSplitOptions.RemoveEmptyEntries).Length} Items.";
            }
            catch
            {
                // ignored
            }
        }

        private void btnLast_Click(object sender, EventArgs e)
        {
            try
            {
                if (!File.Exists(_lastSubnetsFile))
                {
                    return;
                }

                txtSubnet.Text = File.ReadAllText(_lastSubnetsFile);
            }
            catch
            {
                // ignored
            }
        }

        private void btnGo_Click(object sender, EventArgs e)
        {
            try
            {
                DialogResult = DialogResult.OK;

                if (_showSubnets && _lastSubnetsFile != null)
                {
                    File.WriteAllText(_lastSubnetsFile, txtSubnet.Text);
                }

                Close();
            }
            catch
            {
                // ignored
            }
        }

        private void tsEncode_Click(object sender, EventArgs e)
        {
            if (!(sender is ToolStripButton btn))
            {
                return;
            }

            tsEncode.Checked = tsDecode.Checked = false;
            tsDecode.BackColor = tsEncode.BackColor = Color.White;

            btn.Checked = true;
            btn.BackColor = Color.YellowGreen;

            Base64Mode = tsEncode.Checked ? "encode" : "decode";
        }

        private void tsUpper_Click(object sender, EventArgs e)
        {
            txtInput.Text = txtInput.Text.ToUpper();
        }

        private void tsLower_Click(object sender, EventArgs e)
        {
            txtInput.Text = txtInput.Text.ToLower();
        }
    }

    public enum Mode
    {
        Base64,
        Sha,
        Deserialize,
        Unscrub,
        Metro,
        Networks,
        Rename,
        Preset
    }
}
