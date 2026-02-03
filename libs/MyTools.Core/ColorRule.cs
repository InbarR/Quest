using System;
using System.Collections.Generic;

namespace MyTools.Core
{
    public enum ColorRuleType
    {
        Equals,
        NotEquals,
        Contains,
        NotContains,
        GreaterThan,
        LessThan,
        GreaterThanOrEquals,
        LessThanOrEquals,
        Between,
        IsEmpty,
        IsNotEmpty
    }

    public class ColorRule
    {
        public string ColumnName { get; set; }
        public ColorRuleType RuleType { get; set; }
        public string Value { get; set; }
        public string Value2 { get; set; } // For Between rule
        public string BackgroundColor { get; set; }
        public string ForegroundColor { get; set; }
        public bool IsEnabled { get; set; } = true;

        public bool Matches(object cellValue)
        {
            if (!IsEnabled)
                return false;

            var cellStr = cellValue?.ToString() ?? "";

            switch (RuleType)
            {
                case ColorRuleType.Equals:
                    return string.Equals(cellStr, Value, StringComparison.OrdinalIgnoreCase);

                case ColorRuleType.NotEquals:
                    return !string.Equals(cellStr, Value, StringComparison.OrdinalIgnoreCase);

                case ColorRuleType.Contains:
                    return cellStr.Contains(Value, StringComparison.OrdinalIgnoreCase);

                case ColorRuleType.NotContains:
                    return !cellStr.Contains(Value, StringComparison.OrdinalIgnoreCase);

                case ColorRuleType.GreaterThan:
                    if (double.TryParse(cellStr, out double cellNum) && double.TryParse(Value, out double valueNum))
                        return cellNum > valueNum;
                    return false;

                case ColorRuleType.LessThan:
                    if (double.TryParse(cellStr, out cellNum) && double.TryParse(Value, out valueNum))
                        return cellNum < valueNum;
                    return false;

                case ColorRuleType.GreaterThanOrEquals:
                    if (double.TryParse(cellStr, out cellNum) && double.TryParse(Value, out valueNum))
                        return cellNum >= valueNum;
                    return false;

                case ColorRuleType.LessThanOrEquals:
                    if (double.TryParse(cellStr, out cellNum) && double.TryParse(Value, out valueNum))
                        return cellNum <= valueNum;
                    return false;

                case ColorRuleType.Between:
                    if (double.TryParse(cellStr, out cellNum) && 
                        double.TryParse(Value, out double min) && 
                        double.TryParse(Value2, out double max))
                        return cellNum >= min && cellNum <= max;
                    return false;

                case ColorRuleType.IsEmpty:
                    return string.IsNullOrWhiteSpace(cellStr);

                case ColorRuleType.IsNotEmpty:
                    return !string.IsNullOrWhiteSpace(cellStr);

                default:
                    return false;
            }
        }
    }

    public class ColorRuleSet
    {
        public List<ColorRule> Rules { get; set; } = new List<ColorRule>();

        public ColorRule FindMatchingRule(string columnName, object cellValue)
        {
            foreach (var rule in Rules)
            {
                if (rule.ColumnName == columnName && rule.Matches(cellValue))
                {
                    return rule;
                }
            }
            return null;
        }
    }
}
