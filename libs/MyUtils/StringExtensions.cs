using System;
using System.Collections.Generic;
using System.Linq;
#if NET48
using System.Windows.Forms;
#endif

namespace MyUtils
{
    public static class StringExtensions
    {
        public static bool IsEmpty(this string str)
        {
            return string.IsNullOrEmpty(str);
        }

        public static bool IsNotEmpty(this string str)
        {
            return !IsEmpty(str);
        }

#if NET48
        public static bool IsNotEmpty(this TextBox txt)
        {
            return txt != null && !IsEmpty(txt.Text);
        }

        public static bool IsEmpty(this TextBox txt)
        {
            return txt == null || IsEmpty(txt.Text);
        }
#endif

        public static string[] Split(this string str, string splitter, StringSplitOptions options = StringSplitOptions.None)
        {
            return str.Split(new[] { splitter }, options);
        }

        public static string Joined(this IEnumerable<string> arr, string delim = ",", bool withQuotes = false)
        {
            if (withQuotes)
            {
                arr = arr.Select(AddQuotes);
            }

            return string.Join(delim, arr);
        }

        public static string AddQuotes(this string str)
        {
            return $"\"{str}\"";
        }

        public static string CapitalizeFirstLetter(this string input)
        {
            if (string.IsNullOrEmpty(input))
            {
                return input;
            }

            return char.ToUpper(input[0]) + input.Substring(1);
        }
    }
}
