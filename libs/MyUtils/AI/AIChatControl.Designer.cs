namespace MyUtils.AI
{
    partial class AIChatControl
    {
        private System.ComponentModel.IContainer components = null;
        private System.Windows.Forms.SplitContainer mainSplitContainer;
        private System.Windows.Forms.RichTextBox chatOutputTextBox;
        private System.Windows.Forms.Panel inputPanel;
        private System.Windows.Forms.TextBox chatInputTextBox;

        protected override void Dispose(bool disposing)
        {
            if (disposing && (components != null))
            {
                components.Dispose();
            }
            base.Dispose(disposing);
        }

        private void InitializeComponent()
        {
            System.ComponentModel.ComponentResourceManager resources = new System.ComponentModel.ComponentResourceManager(typeof(AIChatControl));
            this.mainSplitContainer = new System.Windows.Forms.SplitContainer();
            this.chatOutputTextBox = new System.Windows.Forms.RichTextBox();
            this.inputPanel = new System.Windows.Forms.Panel();
            this.toolStrip1 = new System.Windows.Forms.ToolStrip();
            this.newChatButton = new System.Windows.Forms.ToolStripButton();
            this.sendButton = new System.Windows.Forms.ToolStripButton();
            this.chatInputTextBox = new System.Windows.Forms.TextBox();
            this.contextMenuStrip1 = new System.Windows.Forms.ContextMenuStrip();
            ((System.ComponentModel.ISupportInitialize)(this.mainSplitContainer)).BeginInit();
            this.mainSplitContainer.Panel1.SuspendLayout();
            this.mainSplitContainer.Panel2.SuspendLayout();
            this.mainSplitContainer.SuspendLayout();
            this.inputPanel.SuspendLayout();
            this.toolStrip1.SuspendLayout();
            this.SuspendLayout();
            // 
            // mainSplitContainer
            // 
            this.mainSplitContainer.Dock = System.Windows.Forms.DockStyle.Fill;
            this.mainSplitContainer.Location = new System.Drawing.Point(0, 0);
            this.mainSplitContainer.Margin = new System.Windows.Forms.Padding(4, 5, 4, 5);
            this.mainSplitContainer.Name = "mainSplitContainer";
            this.mainSplitContainer.Orientation = System.Windows.Forms.Orientation.Horizontal;
            // 
            // mainSplitContainer.Panel1
            // 
            this.mainSplitContainer.Panel1.Controls.Add(this.chatOutputTextBox);
            // 
            // mainSplitContainer.Panel2
            // 
            this.mainSplitContainer.Panel2.Controls.Add(this.inputPanel);
            this.mainSplitContainer.Size = new System.Drawing.Size(600, 615);
            this.mainSplitContainer.SplitterDistance = 277;
            this.mainSplitContainer.SplitterWidth = 6;
            this.mainSplitContainer.TabIndex = 0;
            // 
            // chatOutputTextBox
            // 
            this.chatOutputTextBox.BackColor = System.Drawing.Color.FromArgb(((int)(((byte)(240)))), ((int)(((byte)(240)))), ((int)(((byte)(240)))));
            this.chatOutputTextBox.BorderStyle = System.Windows.Forms.BorderStyle.None;
            this.chatOutputTextBox.Dock = System.Windows.Forms.DockStyle.Fill;
            this.chatOutputTextBox.Font = new System.Drawing.Font("Segoe UI", 9.75F, System.Drawing.FontStyle.Regular, System.Drawing.GraphicsUnit.Point, ((byte)(0)));
            this.chatOutputTextBox.Location = new System.Drawing.Point(0, 0);
            this.chatOutputTextBox.Margin = new System.Windows.Forms.Padding(4, 5, 4, 5);
            this.chatOutputTextBox.Name = "chatOutputTextBox";
            this.chatOutputTextBox.ReadOnly = true;
            this.chatOutputTextBox.ScrollBars = System.Windows.Forms.RichTextBoxScrollBars.Vertical;
            this.chatOutputTextBox.Size = new System.Drawing.Size(600, 277);
            this.chatOutputTextBox.TabIndex = 0;
            this.chatOutputTextBox.Text = "";
            // 
            // inputPanel
            // 
            this.inputPanel.BackColor = System.Drawing.Color.White;
            this.inputPanel.Controls.Add(this.toolStrip1);
            this.inputPanel.Controls.Add(this.chatInputTextBox);
            this.inputPanel.Dock = System.Windows.Forms.DockStyle.Fill;
            this.inputPanel.Location = new System.Drawing.Point(0, 0);
            this.inputPanel.Margin = new System.Windows.Forms.Padding(4, 5, 4, 5);
            this.inputPanel.Name = "inputPanel";
            this.inputPanel.Padding = new System.Windows.Forms.Padding(12);
            this.inputPanel.Size = new System.Drawing.Size(600, 332);
            this.inputPanel.TabIndex = 0;
            // 
            // toolStrip1
            // 
            this.toolStrip1.ImageScalingSize = new System.Drawing.Size(24, 24);
            this.toolStrip1.Items.AddRange(new System.Windows.Forms.ToolStripItem[] {
            this.newChatButton,
            this.sendButton});
            this.toolStrip1.Location = new System.Drawing.Point(12, 12);
            this.toolStrip1.Name = "toolStrip1";
            this.toolStrip1.Size = new System.Drawing.Size(576, 34);
            this.toolStrip1.TabIndex = 5;
            this.toolStrip1.Text = "toolStrip1";
            // 
            // newChatButton
            // 
            this.newChatButton.Image = ((System.Drawing.Image)(resources.GetObject("newChatButton.Image")));
            this.newChatButton.ImageTransparentColor = System.Drawing.Color.Magenta;
            this.newChatButton.Name = "newChatButton";
            this.newChatButton.Size = new System.Drawing.Size(75, 29);
            this.newChatButton.Text = "New";
            this.newChatButton.Click += new System.EventHandler(this.NewChatButton_Click);
            // 
            // sendButton
            // 
            this.sendButton.Image = ((System.Drawing.Image)(resources.GetObject("sendButton.Image")));
            this.sendButton.ImageTransparentColor = System.Drawing.Color.Magenta;
            this.sendButton.Name = "sendButton";
            this.sendButton.Size = new System.Drawing.Size(80, 29);
            this.sendButton.Text = "Send";
            this.sendButton.Click += new System.EventHandler(this.SendButton_Click);
            // 
            // chatInputTextBox
            // 
            this.chatInputTextBox.Anchor = ((System.Windows.Forms.AnchorStyles)((((System.Windows.Forms.AnchorStyles.Top | System.Windows.Forms.AnchorStyles.Bottom) 
            | System.Windows.Forms.AnchorStyles.Left) 
            | System.Windows.Forms.AnchorStyles.Right)));
            this.chatInputTextBox.BorderStyle = System.Windows.Forms.BorderStyle.FixedSingle;
            this.chatInputTextBox.Enabled = true;
            this.chatInputTextBox.Font = new System.Drawing.Font("Segoe UI", 9.75F, System.Drawing.FontStyle.Regular, System.Drawing.GraphicsUnit.Point, ((byte)(0)));
            this.chatInputTextBox.Location = new System.Drawing.Point(12, 51);
            this.chatInputTextBox.Margin = new System.Windows.Forms.Padding(4, 5, 4, 5);
            this.chatInputTextBox.Multiline = true;
            this.chatInputTextBox.Name = "chatInputTextBox";
            this.chatInputTextBox.ScrollBars = System.Windows.Forms.ScrollBars.Vertical;
            this.chatInputTextBox.Size = new System.Drawing.Size(572, 264);
            this.chatInputTextBox.TabIndex = 0;
            this.chatInputTextBox.KeyDown += new System.Windows.Forms.KeyEventHandler(this.ChatInputTextBox_KeyDown);
            // 
            // contextMenuStrip1
            // 
            this.contextMenuStrip1.ImageScalingSize = new System.Drawing.Size(24, 24);
            this.contextMenuStrip1.Name = "contextMenuStrip1";
            this.contextMenuStrip1.Size = new System.Drawing.Size(61, 4);
            // 
            // AIChatControl
            // 
            this.AutoScaleDimensions = new System.Drawing.SizeF(9F, 20F);
            this.AutoScaleMode = System.Windows.Forms.AutoScaleMode.Font;
            this.Controls.Add(this.mainSplitContainer);
            this.Margin = new System.Windows.Forms.Padding(4, 5, 4, 5);
            this.Name = "AIChatControl";
            this.Size = new System.Drawing.Size(600, 615);
            this.mainSplitContainer.Panel1.ResumeLayout(false);
            this.mainSplitContainer.Panel2.ResumeLayout(false);
            ((System.ComponentModel.ISupportInitialize)(this.mainSplitContainer)).EndInit();
            this.mainSplitContainer.ResumeLayout(false);
            this.inputPanel.ResumeLayout(false);
            this.inputPanel.PerformLayout();
            this.toolStrip1.ResumeLayout(false);
            this.toolStrip1.PerformLayout();
            this.ResumeLayout(false);

        }

        private System.Windows.Forms.ToolStrip toolStrip1;
        private System.Windows.Forms.ToolStripButton newChatButton;
        private System.Windows.Forms.ToolStripButton sendButton;
        private System.Windows.Forms.ContextMenuStrip contextMenuStrip1;
    }
}