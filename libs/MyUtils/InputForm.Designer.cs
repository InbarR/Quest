
namespace MyUtils
{
    partial class InputForm
    {
        /// <summary>
        /// Required designer variable.
        /// </summary>
        private System.ComponentModel.IContainer components = null;

        /// <summary>
        /// Clean up any resources being used.
        /// </summary>
        /// <param name="disposing">true if managed resources should be disposed; otherwise, false.</param>
        protected override void Dispose(bool disposing)
        {
            if (disposing && (components != null))
            {
                components.Dispose();
            }
            base.Dispose(disposing);
        }

        #region Windows Form Designer generated code

        /// <summary>
        /// Required method for Designer support - do not modify
        /// the contents of this method with the code editor.
        /// </summary>
        private void InitializeComponent()
        {
            System.ComponentModel.ComponentResourceManager resources = new System.ComponentModel.ComponentResourceManager(typeof(InputForm));
            this.txtInput = new System.Windows.Forms.TextBox();
            this.toolStrip1 = new System.Windows.Forms.ToolStrip();
            this.btnGo = new System.Windows.Forms.ToolStripButton();
            this.lblItems = new System.Windows.Forms.ToolStripLabel();
            this.btnLast = new System.Windows.Forms.ToolStripButton();
            this.txtSubnet = new System.Windows.Forms.ToolStripTextBox();
            this.lblSubnet = new System.Windows.Forms.ToolStripLabel();
            this.toolStripSeparator1 = new System.Windows.Forms.ToolStripSeparator();
            this.tsUpper = new System.Windows.Forms.ToolStripButton();
            this.tsLower = new System.Windows.Forms.ToolStripButton();
            this.tsEncode = new System.Windows.Forms.ToolStripButton();
            this.tsDecode = new System.Windows.Forms.ToolStripButton();
            this.toolStripSeparator2 = new System.Windows.Forms.ToolStripSeparator();
            this.tsSha = new System.Windows.Forms.ToolStripComboBox();
            this.toolStrip1.SuspendLayout();
            this.SuspendLayout();
            // 
            // txtInput
            // 
            this.txtInput.Anchor = ((System.Windows.Forms.AnchorStyles)((((System.Windows.Forms.AnchorStyles.Top | System.Windows.Forms.AnchorStyles.Bottom) 
            | System.Windows.Forms.AnchorStyles.Left) 
            | System.Windows.Forms.AnchorStyles.Right)));
            this.txtInput.Location = new System.Drawing.Point(15, 16);
            this.txtInput.Margin = new System.Windows.Forms.Padding(3, 4, 3, 4);
            this.txtInput.Multiline = true;
            this.txtInput.Name = "txtInput";
            this.txtInput.Size = new System.Drawing.Size(2282, 970);
            this.txtInput.TabIndex = 0;
            this.txtInput.TextChanged += new System.EventHandler(this.txtInput_TextChanged);
            // 
            // toolStrip1
            // 
            this.toolStrip1.Dock = System.Windows.Forms.DockStyle.Bottom;
            this.toolStrip1.ImageScalingSize = new System.Drawing.Size(20, 20);
            this.toolStrip1.Items.AddRange(new System.Windows.Forms.ToolStripItem[] {
            this.btnGo,
            this.lblItems,
            this.btnLast,
            this.txtSubnet,
            this.lblSubnet,
            this.toolStripSeparator1,
            this.tsUpper,
            this.tsLower,
            this.tsEncode,
            this.tsDecode,
            this.toolStripSeparator2,
            this.tsSha});
            this.toolStrip1.Location = new System.Drawing.Point(0, 750);
            this.toolStrip1.Name = "toolStrip1";
            this.toolStrip1.Size = new System.Drawing.Size(1665, 38);
            this.toolStrip1.TabIndex = 5;
            this.toolStrip1.Text = "Base64";
            // 
            // btnGo
            // 
            this.btnGo.Image = ((System.Drawing.Image)(resources.GetObject("btnGo.Image")));
            this.btnGo.ImageTransparentColor = System.Drawing.Color.Magenta;
            this.btnGo.Name = "btnGo";
            this.btnGo.Size = new System.Drawing.Size(163, 33);
            this.btnGo.Text = "Go (Ctrl + Enter)";
            this.btnGo.Click += new System.EventHandler(this.btnGo_Click);
            // 
            // lblItems
            // 
            this.lblItems.Name = "lblItems";
            this.lblItems.Size = new System.Drawing.Size(75, 33);
            this.lblItems.Text = "0 Items.";
            // 
            // btnLast
            // 
            this.btnLast.Alignment = System.Windows.Forms.ToolStripItemAlignment.Right;
            this.btnLast.Image = ((System.Drawing.Image)(resources.GetObject("btnLast.Image")));
            this.btnLast.ImageTransparentColor = System.Drawing.Color.Magenta;
            this.btnLast.Name = "btnLast";
            this.btnLast.Size = new System.Drawing.Size(139, 33);
            this.btnLast.Text = "Last (Ctrl + L)";
            this.btnLast.Click += new System.EventHandler(this.btnLast_Click);
            // 
            // txtSubnet
            // 
            this.txtSubnet.Alignment = System.Windows.Forms.ToolStripItemAlignment.Right;
            this.txtSubnet.BorderStyle = System.Windows.Forms.BorderStyle.FixedSingle;
            this.txtSubnet.Font = new System.Drawing.Font("Segoe UI", 9F);
            this.txtSubnet.Name = "txtSubnet";
            this.txtSubnet.Size = new System.Drawing.Size(343, 38);
            // 
            // lblSubnet
            // 
            this.lblSubnet.Alignment = System.Windows.Forms.ToolStripItemAlignment.Right;
            this.lblSubnet.Name = "lblSubnet";
            this.lblSubnet.Size = new System.Drawing.Size(96, 33);
            this.lblSubnet.Text = "IP Subnets";
            // 
            // toolStripSeparator1
            // 
            this.toolStripSeparator1.Name = "toolStripSeparator1";
            this.toolStripSeparator1.Size = new System.Drawing.Size(6, 38);
            // 
            // tsUpper
            // 
            this.tsUpper.DisplayStyle = System.Windows.Forms.ToolStripItemDisplayStyle.Text;
            this.tsUpper.Image = ((System.Drawing.Image)(resources.GetObject("tsUpper.Image")));
            this.tsUpper.ImageTransparentColor = System.Drawing.Color.Magenta;
            this.tsUpper.Name = "tsUpper";
            this.tsUpper.Size = new System.Drawing.Size(65, 33);
            this.tsUpper.Text = "Upper";
            this.tsUpper.Click += new System.EventHandler(this.tsUpper_Click);
            // 
            // tsLower
            // 
            this.tsLower.DisplayStyle = System.Windows.Forms.ToolStripItemDisplayStyle.Text;
            this.tsLower.Image = ((System.Drawing.Image)(resources.GetObject("tsLower.Image")));
            this.tsLower.ImageTransparentColor = System.Drawing.Color.Magenta;
            this.tsLower.Name = "tsLower";
            this.tsLower.Size = new System.Drawing.Size(63, 33);
            this.tsLower.Text = "Lower";
            this.tsLower.Click += new System.EventHandler(this.tsLower_Click);
            // 
            // tsEncode
            // 
            this.tsEncode.DisplayStyle = System.Windows.Forms.ToolStripItemDisplayStyle.Text;
            this.tsEncode.Image = ((System.Drawing.Image)(resources.GetObject("tsEncode.Image")));
            this.tsEncode.ImageTransparentColor = System.Drawing.Color.Magenta;
            this.tsEncode.Name = "tsEncode";
            this.tsEncode.Size = new System.Drawing.Size(74, 33);
            this.tsEncode.Text = "Encode";
            this.tsEncode.Click += new System.EventHandler(this.tsEncode_Click);
            // 
            // tsDecode
            // 
            this.tsDecode.Checked = true;
            this.tsDecode.CheckOnClick = true;
            this.tsDecode.CheckState = System.Windows.Forms.CheckState.Checked;
            this.tsDecode.DisplayStyle = System.Windows.Forms.ToolStripItemDisplayStyle.Text;
            this.tsDecode.Image = ((System.Drawing.Image)(resources.GetObject("tsDecode.Image")));
            this.tsDecode.ImageTransparentColor = System.Drawing.Color.Magenta;
            this.tsDecode.Name = "tsDecode";
            this.tsDecode.Size = new System.Drawing.Size(77, 33);
            this.tsDecode.Text = "Decode";
            this.tsDecode.Click += new System.EventHandler(this.tsEncode_Click);
            // 
            // toolStripSeparator2
            // 
            this.toolStripSeparator2.Name = "toolStripSeparator2";
            this.toolStripSeparator2.Size = new System.Drawing.Size(6, 38);
            // 
            // tsSha
            // 
            this.tsSha.DropDownStyle = System.Windows.Forms.ComboBoxStyle.DropDownList;
            this.tsSha.FlatStyle = System.Windows.Forms.FlatStyle.Standard;
            this.tsSha.Name = "tsSha";
            this.tsSha.Size = new System.Drawing.Size(121, 38);
            // 
            // InputForm
            // 
            this.AutoScaleDimensions = new System.Drawing.SizeF(9F, 20F);
            this.AutoScaleMode = System.Windows.Forms.AutoScaleMode.Font;
            this.ClientSize = new System.Drawing.Size(1665, 788);
            this.Controls.Add(this.toolStrip1);
            this.Controls.Add(this.txtInput);
            this.FormBorderStyle = System.Windows.Forms.FormBorderStyle.SizableToolWindow;
            this.Margin = new System.Windows.Forms.Padding(3, 4, 3, 4);
            this.Name = "InputForm";
            this.Text = "InputForm";
            this.Load += new System.EventHandler(this.InputForm_Load);
            this.toolStrip1.ResumeLayout(false);
            this.toolStrip1.PerformLayout();
            this.ResumeLayout(false);
            this.PerformLayout();

        }

        #endregion

        public System.Windows.Forms.TextBox txtInput;
        private System.Windows.Forms.ToolStrip toolStrip1;
        private System.Windows.Forms.ToolStripLabel lblItems;
        private System.Windows.Forms.ToolStripTextBox txtSubnet;
        private System.Windows.Forms.ToolStripLabel lblSubnet;
        private System.Windows.Forms.ToolStripButton btnLast;
        private System.Windows.Forms.ToolStripButton btnGo;
        private System.Windows.Forms.ToolStripSeparator toolStripSeparator1;
        public System.Windows.Forms.ToolStripButton tsEncode;
        public System.Windows.Forms.ToolStripButton tsDecode;
        public System.Windows.Forms.ToolStripButton tsUpper;
        public System.Windows.Forms.ToolStripButton tsLower;
        private System.Windows.Forms.ToolStripComboBox tsSha;
        private System.Windows.Forms.ToolStripSeparator toolStripSeparator2;
    }
}