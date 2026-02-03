using System;
using System.Collections.ObjectModel;

namespace MyTools.Core
{
    public static class LogService
    {
        public static ObservableCollection<LogMessage> Logs { get; } = new ObservableCollection<LogMessage>();

        public static void Info(string message)
        {
            AddLog(message, "#FFFFFF"); // White - more visible
        }

        public static void Error(string message)
        {
            AddLog(message, "#F44336"); // Bright Red - more visible
        }

        public static void Success(string message)
        {
            AddLog(message, "#4CAF50"); // Bright Green - more visible
        }

        public static void Warning(string message)
        {
            AddLog(message, "#FF9800"); // Bright Orange - more visible
        }

        public static void Debug(string message)
        {
            AddLog(message, "#9E9E9E"); // Light Gray - more visible
        }

        public static void Clear()
        {
            Logs.Clear();
        }

        private static void AddLog(string message, string color)
        {
            // Ensure UI thread update if binding directly
            // In MAUI, ObservableCollection changes should be on UI thread if bound
            // But this is Core, so we can't depend on MAUI. 
            // We'll let the UI layer handle the dispatching or use a thread-safe collection wrapper if needed.
            // For now, we'll just add it. The UI might need to use BindingBase.EnableCollectionSynchronization
            
            // Add new logs at the bottom (oldest to newest)
            Logs.Add(new LogMessage
            {
                Time = DateTime.Now.ToString("HH:mm:ss"),
                Message = message,
                ForeColor = color
            });

            if (Logs.Count > 1000)
            {
                Logs.RemoveAt(0); // Remove oldest log from the top
            }
        }
    }
}
