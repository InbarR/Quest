import * as vscode from 'vscode';
import { SidecarClient, CompletionItem as SidecarCompletionItem } from '../../sidecar/SidecarClient';
import { getActiveConnection } from '../../commands/queryCommands';

// KQL Keywords
const KQL_KEYWORDS = [
    'let', 'set', 'alias', 'declare', 'pattern', 'restrict', 'access',
    'where', 'project', 'project-away', 'project-keep', 'project-rename', 'project-reorder',
    'extend', 'summarize', 'sort', 'order', 'top', 'take', 'limit',
    'join', 'union', 'lookup', 'mv-expand', 'mv-apply', 'parse', 'parse-where', 'parse-kv',
    'split', 'evaluate', 'distinct', 'count', 'render', 'as', 'on', 'kind', 'with', 'of', 'by',
    'asc', 'desc', 'nulls', 'first', 'last', 'inner', 'outer', 'left', 'right', 'anti', 'semi',
    'fullouter', 'leftanti', 'rightanti', 'leftsemi', 'rightsemi', 'innerunique', 'leftouter', 'rightouter',
    'print', 'datatable', 'externaldata', 'find', 'search', 'fork', 'facet',
    'sample', 'sample-distinct', 'scan', 'serialize', 'range', 'invoke', 'getschema', 'materialize', 'toscalar', 'consume',
    'and', 'or', 'not', 'in', 'has', 'contains', 'startswith', 'endswith', 'matches', 'between',
    'true', 'false', 'null', 'ago', 'now'
];

// KQL Functions
const KQL_FUNCTIONS = [
    'count', 'countif', 'dcount', 'dcountif', 'sum', 'sumif', 'avg', 'avgif', 'min', 'max', 'minif', 'maxif',
    'percentile', 'percentiles', 'stdev', 'variance', 'make_list', 'make_set', 'make_bag',
    'arg_max', 'arg_min', 'any', 'anyif', 'take_any', 'hll', 'hll_merge', 'tdigest', 'tdigest_merge',
    'strcat', 'strlen', 'substring', 'tolower', 'toupper', 'trim', 'trim_start', 'trim_end',
    'split', 'replace', 'extract', 'extract_all', 'parse_json', 'parse_csv', 'parse_xml', 'parse_url',
    'tostring', 'toint', 'tolong', 'todouble', 'toreal', 'tobool', 'todatetime', 'totimespan', 'toguid',
    'datetime', 'now', 'ago', 'startofday', 'startofweek', 'startofmonth', 'startofyear',
    'endofday', 'endofweek', 'endofmonth', 'endofyear', 'dayofweek', 'dayofmonth', 'dayofyear',
    'weekofyear', 'monthofyear', 'getyear', 'getmonth', 'bin', 'floor', 'ceiling',
    'format_datetime', 'format_timespan', 'datetime_add', 'datetime_diff', 'datetime_part',
    'iif', 'iff', 'case', 'coalesce', 'isempty', 'isnotempty', 'isnull', 'isnotnull',
    'array_length', 'array_concat', 'array_slice', 'pack', 'pack_all', 'bag_keys', 'bag_merge',
    'hash', 'hash_md5', 'hash_sha256', 'base64_encode_tostring', 'base64_decode_tostring',
    'url_encode', 'url_decode', 'gzip_compress_to_base64_string', 'gzip_decompress_from_base64_string'
];

// KQL Operators (for pipe completions)
const KQL_OPERATORS = [
    { label: 'where', detail: 'Filter rows based on condition', insertText: 'where ${1:condition}' },
    { label: 'project', detail: 'Select columns', insertText: 'project ${1:column1}, ${2:column2}' },
    { label: 'extend', detail: 'Add computed columns', insertText: 'extend ${1:newColumn} = ${2:expression}' },
    { label: 'summarize', detail: 'Aggregate data', insertText: 'summarize ${1:aggregation} by ${2:column}' },
    { label: 'sort by', detail: 'Sort results', insertText: 'sort by ${1:column} ${2|asc,desc|}' },
    { label: 'top', detail: 'Take top N rows', insertText: 'top ${1:10} by ${2:column}' },
    { label: 'take', detail: 'Limit rows', insertText: 'take ${1:100}' },
    { label: 'join', detail: 'Join with another table', insertText: 'join kind=${1|inner,left,right,outer|} (${2:table}) on ${3:column}' },
    { label: 'union', detail: 'Union with other tables', insertText: 'union ${1:table}' },
    { label: 'distinct', detail: 'Get distinct values', insertText: 'distinct ${1:column}' },
    { label: 'count', detail: 'Count rows', insertText: 'count' },
    { label: 'mv-expand', detail: 'Expand multi-value column', insertText: 'mv-expand ${1:column}' },
    { label: 'parse', detail: 'Parse string pattern', insertText: 'parse ${1:column} with ${2:pattern}' },
    { label: 'render', detail: 'Render visualization', insertText: 'render ${1|timechart,barchart,piechart,table|}' }
];

export class KqlCompletionProvider implements vscode.CompletionItemProvider {
    constructor(private client: SidecarClient) {}

    async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        context: vscode.CompletionContext
    ): Promise<vscode.CompletionItem[]> {
        console.log('[KQL Completion] provideCompletionItems called');
        const items: vscode.CompletionItem[] = [];

        const linePrefix = document.lineAt(position).text.substring(0, position.character);
        const wordRange = document.getWordRangeAtPosition(position);
        const currentWord = wordRange ? document.getText(wordRange) : '';
        console.log(`[KQL Completion] linePrefix: "${linePrefix}", currentWord: "${currentWord}"`);

        // After pipe operator, suggest operators
        if (linePrefix.trimEnd().endsWith('|')) {
            return this.getOperatorCompletions();
        }

        // Try to get completions from sidecar (schema-aware)
        try {
            const offset = document.offsetAt(position);
            const activeConnection = getActiveConnection();

            const sidecarItems = await this.client.getCompletions({
                query: document.getText(),
                position: offset,
                clusterUrl: activeConnection.clusterUrl,
                database: activeConnection.database
            });

            for (const item of sidecarItems) {
                const completionItem = new vscode.CompletionItem(
                    item.label,
                    this.getCompletionKind(item.kind)
                );
                completionItem.detail = item.detail;
                if (item.insertText) {
                    completionItem.insertText = new vscode.SnippetString(item.insertText);
                }
                // Prioritize schema items over static completions
                completionItem.sortText = '0' + item.label;
                items.push(completionItem);
            }
        } catch (error) {
            // Fall back to static completions
            console.log('[KQL Completion] Schema completions failed:', error);
        }

        // Add static completions
        const keywordItems = this.getKeywordCompletions(currentWord);
        const functionItems = this.getFunctionCompletions(currentWord);
        items.push(...keywordItems);
        items.push(...functionItems);

        console.log(`[KQL Completion] Returning ${items.length} items (${keywordItems.length} keywords, ${functionItems.length} functions)`);
        return items;
    }

    private getOperatorCompletions(): vscode.CompletionItem[] {
        return KQL_OPERATORS.map(op => {
            const item = new vscode.CompletionItem(op.label, vscode.CompletionItemKind.Keyword);
            item.detail = op.detail;
            item.insertText = new vscode.SnippetString(op.insertText);
            item.sortText = '0' + op.label; // Sort operators first
            return item;
        });
    }

    private getKeywordCompletions(prefix: string): vscode.CompletionItem[] {
        const lower = prefix.toLowerCase();
        return KQL_KEYWORDS
            .filter(kw => kw.toLowerCase().startsWith(lower))
            .map(kw => {
                const item = new vscode.CompletionItem(kw, vscode.CompletionItemKind.Keyword);
                item.detail = 'KQL Keyword';
                item.sortText = '1' + kw;
                return item;
            });
    }

    private getFunctionCompletions(prefix: string): vscode.CompletionItem[] {
        const lower = prefix.toLowerCase();
        return KQL_FUNCTIONS
            .filter(fn => fn.toLowerCase().startsWith(lower))
            .map(fn => {
                const item = new vscode.CompletionItem(fn, vscode.CompletionItemKind.Function);
                item.detail = 'KQL Function';
                item.insertText = new vscode.SnippetString(`${fn}($1)`);
                item.sortText = '2' + fn;
                return item;
            });
    }

    private getCompletionKind(kind: string): vscode.CompletionItemKind {
        switch (kind) {
            case 'keyword': return vscode.CompletionItemKind.Keyword;
            case 'function': return vscode.CompletionItemKind.Function;
            case 'table': return vscode.CompletionItemKind.Class;
            case 'column': return vscode.CompletionItemKind.Field;
            case 'operator': return vscode.CompletionItemKind.Operator;
            default: return vscode.CompletionItemKind.Text;
        }
    }
}
