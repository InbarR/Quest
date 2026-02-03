using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace MyUtils
{
    public static class Common
    {
        public static void ProtectEntry(Action action, Action<string> onError = null)
        {
            try
            {
                action();
            }
            catch (Exception e)
            {
                onError?.Invoke(e.Message);
            }
        }

        public static int ToInt(this string value)
        {
            return int.TryParse(value, out int result) ? result : 0;
        }

        public static void DeleteOldFiles(string folder)
        {
            try
            {
                if (!Directory.Exists(folder))
                {
                    return;
                }

                foreach (var file in Directory.EnumerateFiles(folder))
                {
                    var time = new FileInfo(file).LastAccessTime;
                    if (!(DateTime.Now.Subtract(time).TotalDays > 14))
                    {
                        continue;
                    }

                    File.Delete(file);
                }
            }
            catch
            {
                // ignored
            }
        }

        public static void ShowError(Exception ex)
        {
            MessageBox.Show(ex.Message, "Error", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }

        public static string GetFile(string filter)
        {
            using (OpenFileDialog openFileDialog = new OpenFileDialog()
            {
                ValidateNames = false
            })
            {
                openFileDialog.Filter = filter;
                if (openFileDialog.ShowDialog() == DialogResult.OK)
                {
                    return openFileDialog.FileName;
                }
            }

            return null;
        }

        public static string SanitizeForFilename(string input)
        {
            if (string.IsNullOrEmpty(input))
            {
                return input;
            }

            var invalidChars = new char[] { '\\', '/', ':', '*', '?', '"', '<', '>', '|', ' ' };

            return new string(input.Trim().Where(c => !invalidChars.Contains(c)).ToArray());
        }
    }
}
