using System;
using System.Drawing;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace MyUtils.AI
{
    /// <summary>
    /// Event args for when a KQL query is found with optional cluster/database context.
    /// </summary>
    public class KqlQueryFoundEventArgs : EventArgs
    {
        public string Query { get; set; }
        public string Cluster { get; set; }
        public string Database { get; set; }
    }
    /// <summary>
    /// A reusable AI Chat control that can be added to forms via the designer.
    /// Provides a chat interface with text input, output display, and AI integration.
    /// </summary>
    public partial class AIChatControl : UserControl
    {
        private AIHelper _aiHelper;
        private AiChatSession _session;
        private string _systemPrompt;
        private string _contextData;
        private Action<string> _logger;
        private string _userContext;
        private System.Collections.Generic.List<string> _inputHistory;
        private int _historyIndex;

        /// <summary>
        /// Gets or sets the system prompt used for AI conversations.
        /// </summary>
        public string SystemPrompt
        {
            get => _systemPrompt;
            set => _systemPrompt = value;
        }

        public string UserContext
        {
            get => _userContext;
            set => _userContext = value;
        }

        /// <summary>
        /// Gets or sets additional context data that will be included with prompts.
        /// </summary>
        public string MoreContextData
        {
            get => _contextData;
            set => _contextData = value;
        }

        /// <summary>
        /// Gets or sets the logger action for diagnostic messages.
        /// </summary>
        public Action<string> Logger
        {
            get => _logger;
            set => _logger = value;
        }

        /// <summary>
        /// Gets whether the AI helper is initialized and ready.
        /// </summary>
        public bool IsAIReady => _aiHelper != null;

        /// <summary>
        /// Event raised when user wants to insert AI response into the main editor.
        /// </summary>
        public event EventHandler<string> InsertTextRequested;

        /// <summary>
        /// Event raised before a message is sent to the AI.
        /// </summary>
        public event EventHandler SendingMessage;

        /// <summary>
        /// Event raised when a KQL query is found in the AI's response.
        /// </summary>
        public event EventHandler<KqlQueryFoundEventArgs> KqlQueryFound;

        /// <summary>
        /// Initializes a new instance of the AIChatControl.
        /// </summary>
        public AIChatControl()
        {
            InitializeComponent();
            _session = new AiChatSession();
            _systemPrompt = "You are a helpful AI assistant.";
            _contextData = string.Empty;
            _userContext = string.Empty;
            _inputHistory = new System.Collections.Generic.List<string>();
            _historyIndex = -1;

            // Add context menu for inserting AI responses
            var contextMenu = new ContextMenuStrip();
            contextMenu.Items.Add("Copy Selection", null, (s, e) => CopySelection());
            contextMenu.Items.Add("Insert into Editor", null, (s, e) => InsertIntoEditor());
            contextMenu.Items.Add("New Chat", null, (s, e) => ClearChat());
            chatOutputTextBox.ContextMenuStrip = contextMenu;
        }

        private void CopySelection()
        {
            if (!string.IsNullOrEmpty(chatOutputTextBox.SelectedText))
            {
                Clipboard.SetText(chatOutputTextBox.SelectedText);
            }
        }

        private void InsertIntoEditor()
        {
            if (!string.IsNullOrEmpty(chatOutputTextBox.SelectedText))
            {
                InsertTextRequested?.Invoke(this, chatOutputTextBox.SelectedText);
            }
        }

        /// <summary>
        /// Initializes the AI helper with the specified configuration.
        /// </summary>
        /// <param name="config">The AI configuration to use.</param>
        public void InitializeAI(AiConfig config)
        {
            try
            {
                if (config == null)
                {
                    throw new ArgumentNullException(nameof(config));
                }

                _aiHelper = new AIHelper(config, (s, err) => Log(s));
                inputPanel.Enabled = true;
                
                Log("AI Chat initialized successfully.");
                AppendToChat("[System]", "AI Assistant ready. Type your message below.");
            }
            catch (Exception ex)
            {
                Log($"Failed to initialize AI: {ex.Message}");
                inputPanel.Enabled = false;
                AppendToChat("[System]", $"AI initialization failed: {ex.Message}");
            }
        }

        /// <summary>
        /// Initializes AI with default GitHub Models configuration.
        /// </summary>
        public void InitializeWithDefaults()
        {
            var config = new AiConfig
            {
                Provider = AiProvider.GitHubModels,
                Model = AiModel.GPT4oMini
            };
            InitializeAI(config);
        }

        /// <summary>
        /// Sends a message to the AI and displays the response.
        /// </summary>
        /// <param name="userMessage">The user's message.</param>
        public async Task SendMessageAsync(string userMessage)
        {
            SendingMessage?.Invoke(this, EventArgs.Empty);

            if (string.IsNullOrWhiteSpace(userMessage))
            {
                AppendToChat("[System]", "Please enter a message.");
                return;
            }

            if (_aiHelper == null)
            {
                AppendToChat("[System]", "AI not initialized. Call InitializeAI() first.");
                return;
            }

            try
            {
                sendButton.Enabled = false;
                newChatButton.Enabled = false;
                chatInputTextBox.Enabled = false;

                AppendToChat("You", userMessage);

                // Build system prompt with user context if available
                string effectiveSystemPrompt = _systemPrompt;
                if (!string.IsNullOrEmpty(_userContext))
                {
                    effectiveSystemPrompt = _systemPrompt + "\n\n" + _userContext;
                }
                _aiHelper.Config.SystemPrompt = effectiveSystemPrompt;

                var response = await _aiHelper.RunWithHistoryAsync(_session, userMessage);

                AppendToChat("AI", response);

                // Extract and raise event if KQL is found
                var kqlEventArgs = ExtractKqlQueryWithContext(response);
                if (kqlEventArgs != null && !string.IsNullOrEmpty(kqlEventArgs.Query))
                {
                    KqlQueryFound?.Invoke(this, kqlEventArgs);
                }
            }
            catch (Exception ex)
            {
                AppendToChat("[System]", $"Error: {ex.Message}");
                Log($"Chat error: {ex.Message}");
            }
            finally
            {
                // Re-enable input
                sendButton.Enabled = true;
                newChatButton.Enabled = true;
                chatInputTextBox.Enabled = true;
                chatInputTextBox.Focus();
            }
        }

        /// <summary>
        /// Clears the chat history display.
        /// </summary>
        public void ClearChat()
        {
            if (chatOutputTextBox.InvokeRequired)
            {
                chatOutputTextBox.Invoke(new Action(ClearChat));
                return;
            }

            chatOutputTextBox.Clear();
            _session.Clear();
        }

        /// <summary>
        /// Appends a message to the chat display with color coding.
        /// </summary>
        /// <param name="sender">The sender name (e.g., "You", "User", "AI", "System").</param>
        /// <param name="message">The message content.</param>
        public void AppendToChat(string sender, string message)
        {
            if (chatOutputTextBox.InvokeRequired)
            {
                chatOutputTextBox.Invoke(new Action(() => AppendToChat(sender, message)));
                return;
            }

            string timestamp = DateTime.Now.ToString("HH:mm:ss");
            
            Color senderColor;
            Color messageColor;
            
            if (sender.Equals("AI", StringComparison.OrdinalIgnoreCase))
            {
                senderColor = Color.Blue;
                messageColor = Color.DarkBlue;
            }
            else if (sender.Equals("User", StringComparison.OrdinalIgnoreCase) || 
                     sender.Equals("You", StringComparison.OrdinalIgnoreCase))
            {
                senderColor = Color.Green;
                messageColor = Color.DarkGreen;
            }
            else if (sender.StartsWith("[") && sender.EndsWith("]"))
            {
                senderColor = Color.Gray;
                messageColor = Color.DarkGray;
            }
            else
            {
                senderColor = Color.Black;
                messageColor = Color.Black;
            }

            chatOutputTextBox.SelectionStart = chatOutputTextBox.TextLength;
            chatOutputTextBox.SelectionColor = Color.Gray;
            chatOutputTextBox.AppendText($"[{timestamp}] ");

            chatOutputTextBox.SelectionStart = chatOutputTextBox.TextLength;
            chatOutputTextBox.SelectionColor = senderColor;
            chatOutputTextBox.SelectionFont = new Font(chatOutputTextBox.Font, FontStyle.Bold);
            chatOutputTextBox.AppendText($"{sender}: ");

            chatOutputTextBox.SelectionStart = chatOutputTextBox.TextLength;
            chatOutputTextBox.SelectionColor = messageColor;
            chatOutputTextBox.SelectionFont = new Font(chatOutputTextBox.Font, FontStyle.Regular);
            chatOutputTextBox.AppendText($"{message}\r\n\r\n");

            chatOutputTextBox.SelectionColor = chatOutputTextBox.ForeColor;
            chatOutputTextBox.ScrollToCaret();
        }

        private async void SendButton_Click(object sender, EventArgs e)
        {
            string message = chatInputTextBox.Text.Trim();
            if (!string.IsNullOrEmpty(message))
            {
                // Add to history
                AddToHistory(message);
                chatInputTextBox.Clear();
                await SendMessageAsync(message);
            }
        }

        private async void ChatInputTextBox_KeyDown(object sender, KeyEventArgs e)
        {
            // Handle history navigation with Up/Down arrows (only when single line or at start/end)
            if (e.KeyCode == Keys.Up && (chatInputTextBox.Lines.Length == 1 || 
                (chatInputTextBox.SelectionStart == 0 && chatInputTextBox.SelectionLength == 0)))
            {
                e.SuppressKeyPress = true;
                NavigateHistory(-1);
                return;
            }
            else if (e.KeyCode == Keys.Down && (chatInputTextBox.Lines.Length == 1 || 
                (chatInputTextBox.SelectionStart == chatInputTextBox.Text.Length && chatInputTextBox.SelectionLength == 0)))
            {
                e.SuppressKeyPress = true;
                NavigateHistory(1);
                return;
            }
            
            // Shift+Enter sends the message, Enter alone adds a new line
            if (e.KeyCode == Keys.Enter && e.Shift)
            {
                e.SuppressKeyPress = true;
                string message = chatInputTextBox.Text.Trim();
                if (!string.IsNullOrEmpty(message))
                {
                    // Add to history
                    AddToHistory(message);
                    chatInputTextBox.Clear();
                    await SendMessageAsync(message);
                }
            }
        }

        /// <summary>
        /// Adds a message to the input history.
        /// </summary>
        private void AddToHistory(string message)
        {
            if (string.IsNullOrWhiteSpace(message))
                return;

            // Don't add duplicates of the most recent entry
            if (_inputHistory.Count > 0 && _inputHistory[_inputHistory.Count - 1] == message)
                return;

            _inputHistory.Add(message);
            
            // Limit history to 50 entries
            if (_inputHistory.Count > 50)
            {
                _inputHistory.RemoveAt(0);
            }
            
            // Reset history index to after the last item
            _historyIndex = _inputHistory.Count;
        }

        /// <summary>
        /// Navigates through input history using arrow keys.
        /// </summary>
        /// <param name="direction">-1 for up (older), 1 for down (newer)</param>
        private void NavigateHistory(int direction)
        {
            if (_inputHistory.Count == 0)
                return;

            // Calculate new index
            int newIndex = _historyIndex + direction;
            
            // Clamp to valid range
            if (newIndex < 0)
            {
                newIndex = 0;
            }
            else if (newIndex >= _inputHistory.Count)
            {
                // Going down past the end clears the input
                newIndex = _inputHistory.Count;
                chatInputTextBox.Text = string.Empty;
                _historyIndex = newIndex;
                return;
            }
            
            _historyIndex = newIndex;
            chatInputTextBox.Text = _inputHistory[_historyIndex];
            
            // Move cursor to end
            chatInputTextBox.SelectionStart = chatInputTextBox.Text.Length;
            chatInputTextBox.SelectionLength = 0;
        }

        private void Log(string message)
        {
            _logger?.Invoke($"[AIChatControl] {message}");
        }
    
        private void NewChatButton_Click(object sender, EventArgs e)
        {
            ClearChat();
            AppendToChat("[System]", "New chat session started. Type your message below.");
            Log("New chat session started");
        }

        private void InsertButton_Click(object sender, EventArgs e)
        {
            InsertIntoEditor();
        }

        private KqlQueryFoundEventArgs ExtractKqlQueryWithContext(string text)
        {
            string query = ExtractKqlQuery(text);
            if (string.IsNullOrEmpty(query))
            {
                return null;
            }

            var result = new KqlQueryFoundEventArgs { Query = query };

            // Try to extract cluster from query (e.g., cluster("name").database("db"))
            var clusterMatch = Regex.Match(query, @"cluster\s*\(\s*[""']([^""']+)[""']\s*\)", RegexOptions.IgnoreCase);
            if (clusterMatch.Success)
            {
                result.Cluster = clusterMatch.Groups[1].Value;
            }

            // Try to extract database from query (e.g., database("name"))
            var dbMatch = Regex.Match(query, @"database\s*\(\s*[""']([^""']+)[""']\s*\)", RegexOptions.IgnoreCase);
            if (dbMatch.Success)
            {
                result.Database = dbMatch.Groups[1].Value;
            }

            // Also try to extract from surrounding text context (e.g., "Cluster: xxx, DB: yyy")
            if (string.IsNullOrEmpty(result.Cluster))
            {
                var contextClusterMatch = Regex.Match(text, @"Cluster:\s*([^\s,]+)", RegexOptions.IgnoreCase);
                if (contextClusterMatch.Success)
                {
                    result.Cluster = contextClusterMatch.Groups[1].Value;
                }
            }

            if (string.IsNullOrEmpty(result.Database))
            {
                var contextDbMatch = Regex.Match(text, @"(?:DB|Database):\s*([^\s,]+)", RegexOptions.IgnoreCase);
                if (contextDbMatch.Success)
                {
                    result.Database = contextDbMatch.Groups[1].Value;
                }
            }

            return result;
        }

        private string ExtractKqlQuery(string text)
        {
            if (string.IsNullOrWhiteSpace(text))
            {
                return null;
            }

            const string blockEnd = "```";
            string[] startMarkers = { "```kql", "```kusto", "```" };

            int startIndex = -1;
            string usedMarker = null;

            foreach (var marker in startMarkers)
            {
                startIndex = text.IndexOf(marker, StringComparison.OrdinalIgnoreCase);
                if (startIndex != -1)
                {
                    usedMarker = marker;
                    break;
                }
            }

            if (startIndex == -1)
            {
                return null;
            }

            var contentStartIndex = startIndex + usedMarker.Length;

            // Skip the first newline after the marker
            if (contentStartIndex < text.Length)
            {
                if (text[contentStartIndex] == '\r' && contentStartIndex + 1 < text.Length && text[contentStartIndex + 1] == '\n')
                {
                    contentStartIndex += 2;
                }
                else if (text[contentStartIndex] == '\n')
                {
                    contentStartIndex++;
                }
            }

            int endIndex = text.IndexOf(blockEnd, contentStartIndex, StringComparison.OrdinalIgnoreCase);
            if (endIndex == -1)
            {
                return null;
            }

            return text.Substring(contentStartIndex, endIndex - contentStartIndex).Trim();
        }
    }
}
