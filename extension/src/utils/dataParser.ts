/**
 * Utility functions for parsing external data (JSON, CSV) into table format
 */

export interface ParsedData {
    columns: string[];
    rows: any[][];
    rowCount: number;
}

/**
 * Parse data from string (auto-detects JSON or CSV)
 */
export function parseData(data: string): ParsedData {
    const trimmed = data.trim();

    // Try JSON first
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
        try {
            return parseJson(trimmed);
        } catch {
            // Fall through to CSV
        }
    }

    // Try CSV/TSV
    return parseCsv(trimmed);
}

/**
 * Parse JSON array of objects into table format
 */
export function parseJson(data: string): ParsedData {
    let parsed = JSON.parse(data);

    // Handle single object by wrapping in array
    if (!Array.isArray(parsed)) {
        parsed = [parsed];
    }

    if (parsed.length === 0) {
        return { columns: [], rows: [], rowCount: 0 };
    }

    // Collect all unique keys from all objects
    const columnSet = new Set<string>();
    for (const obj of parsed) {
        if (obj && typeof obj === 'object') {
            Object.keys(obj).forEach(key => columnSet.add(key));
        }
    }

    const columns = Array.from(columnSet);

    // Convert objects to rows
    const rows = parsed.map((obj: any) => {
        return columns.map(col => {
            const value = obj?.[col];
            // Convert objects/arrays to JSON strings for display
            if (value !== null && typeof value === 'object') {
                return JSON.stringify(value);
            }
            return value ?? null;
        });
    });

    return {
        columns,
        rows,
        rowCount: rows.length
    };
}

/**
 * Parse CSV or TSV data into table format
 */
export function parseCsv(data: string): ParsedData {
    const lines = data.split(/\r?\n/).filter(line => line.trim());

    if (lines.length === 0) {
        return { columns: [], rows: [], rowCount: 0 };
    }

    // Detect delimiter (tab, comma, or semicolon)
    const firstLine = lines[0];
    let delimiter = ',';
    if (firstLine.includes('\t')) {
        delimiter = '\t';
    } else if (firstLine.split(';').length > firstLine.split(',').length) {
        delimiter = ';';
    }

    // Parse header
    const columns = parseCsvLine(firstLine, delimiter);

    // Parse data rows
    const rows: any[][] = [];
    for (let i = 1; i < lines.length; i++) {
        const values = parseCsvLine(lines[i], delimiter);
        // Pad or trim to match column count
        while (values.length < columns.length) {
            values.push('');
        }
        rows.push(values.slice(0, columns.length));
    }

    return {
        columns,
        rows,
        rowCount: rows.length
    };
}

/**
 * Parse a single CSV line, handling quoted values
 */
function parseCsvLine(line: string, delimiter: string): string[] {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        const nextChar = line[i + 1];

        if (inQuotes) {
            if (char === '"') {
                if (nextChar === '"') {
                    // Escaped quote
                    current += '"';
                    i++;
                } else {
                    // End of quoted value
                    inQuotes = false;
                }
            } else {
                current += char;
            }
        } else {
            if (char === '"') {
                inQuotes = true;
            } else if (char === delimiter) {
                result.push(current.trim());
                current = '';
            } else {
                current += char;
            }
        }
    }

    result.push(current.trim());
    return result;
}

/**
 * Try to infer if data is valid table data
 */
export function isValidTableData(data: string): boolean {
    const trimmed = data.trim();
    if (!trimmed) return false;

    // Check for JSON array/object
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
        try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) {
                return parsed.length > 0 && typeof parsed[0] === 'object';
            }
            return typeof parsed === 'object' && parsed !== null;
        } catch {
            return false;
        }
    }

    // Check for CSV/TSV (at least 2 lines with consistent column count)
    const lines = trimmed.split(/\r?\n/).filter(line => line.trim());
    if (lines.length < 1) return false;

    // Detect delimiter
    const firstLine = lines[0];
    let delimiter = ',';
    if (firstLine.includes('\t')) {
        delimiter = '\t';
    } else if (firstLine.split(';').length > firstLine.split(',').length) {
        delimiter = ';';
    }

    const headerCols = parseCsvLine(firstLine, delimiter).length;
    return headerCols > 0;
}
