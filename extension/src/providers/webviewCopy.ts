/**
 * Client-side syntax highlighting and rich-text clipboard support for webviews.
 *
 * `vscode.env.clipboard` can only carry plain text, so anything that needs to
 * land on the clipboard as formatted HTML has to be written from inside the
 * webview. This module is injected into a webview's script block and exposes
 * two globals: `questHighlightToHtml` and `questCopyRich`.
 *
 * Colours are emitted as literal hex values in inline styles rather than CSS
 * variables or classes, because Outlook, Word and Teams discard stylesheets and
 * only honour inline styles on the pasted fragment.
 */
export const COPY_SCRIPT = `
    // ---- Syntax highlighting for clipboard output ----

    var QUEST_COPY_THEMES = {
        light: {
            background: '#ffffff', border: '#d0d7de', text: '#24292f',
            comment: '#008000', string: '#a31515', number: '#098658',
            keyword: '#0000ff', control: '#af00db', func: '#795e26', operator: '#24292f'
        },
        dark: {
            background: '#1e1e1e', border: '#3c3c3c', text: '#d4d4d4',
            comment: '#6a9955', string: '#ce9178', number: '#b5cea8',
            keyword: '#569cd6', control: '#c586c0', func: '#dcdcaa', operator: '#d4d4d4'
        }
    };

    // Tabular/flow operators render in the control colour; the rest are keywords.
    var QUEST_CONTROL_WORDS = {
        kusto: ['let','where','project','project-away','project-rename','project-reorder','project-keep',
                'summarize','join','union','extend','order','sort','take','limit','top','top-nested',
                'distinct','count','render','mv-expand','mv-apply','parse','parse-where','evaluate',
                'lookup','range','sample','sample-distinct','serialize','invoke','facet','find','search',
                'getschema','print','datatable','materialize','fork','partition','as','reduce','scan','consume'],
        ado: ['select','from','where','order','group','asc','desc','ever','under','mode'],
        outlook: ['where','project','take','limit','sort','order','count','extend','summarize','top','distinct'],
        mcp: ['where','project','project-reorder','take','sort','count','extend']
    };

    var QUEST_KEYWORDS = {
        kusto: ['by','on','kind','asc','desc','and','or','not','has','has_cs','hasprefix','hassuffix',
                'contains','contains_cs','startswith','endswith','in','!in','between','matches','regex',
                'nulls','first','last','step','from','to','with','true','false','null','bin','hint',
                'inner','outer','leftouter','rightouter','fullouter','leftanti','rightanti','leftsemi','rightsemi','anti','semi'],
        ado: ['and','or','not','in','contains','under','workitems','workitemlinks','by'],
        outlook: ['by','and','or','not','contains','startswith','endswith','has','in','asc','desc','true','false','ago'],
        mcp: ['by','and','or','not','contains','startswith','endswith','has','matches','asc','desc','true','false']
    };

    function questEscapeHtml(text) {
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    /**
     * Splits a query into coloured spans. Returns the inner HTML of the code block.
     */
    function questTokenize(query, language, theme) {
        var controls = QUEST_CONTROL_WORDS[language] || QUEST_CONTROL_WORDS.kusto;
        var keywords = QUEST_KEYWORDS[language] || QUEST_KEYWORDS.kusto;
        var out = '';
        var i = 0;

        function span(color, text) {
            return '<span style="color:' + color + '">' + questEscapeHtml(text) + '</span>';
        }

        while (i < query.length) {
            var rest = query.slice(i);

            // Line comments: // for KQL-family, -- for WIQL
            var comment = /^(\\/\\/[^\\n]*|--[^\\n]*)/.exec(rest);
            if (comment) {
                out += span(theme.comment, comment[0]);
                i += comment[0].length;
                continue;
            }

            // String literals, tolerating escaped quotes
            var str = /^('(?:[^'\\\\]|\\\\.)*'|"(?:[^"\\\\]|\\\\.)*")/.exec(rest);
            if (str) {
                out += span(theme.string, str[0]);
                i += str[0].length;
                continue;
            }

            // Bracketed field names, e.g. WIQL's [System.Title]
            var bracketed = /^\\[[^\\]]*\\]/.exec(rest);
            if (bracketed) {
                out += span(theme.keyword, bracketed[0]);
                i += bracketed[0].length;
                continue;
            }

            // Numbers, including KQL timespan literals such as 7d or 30m
            var num = /^\\d+(?:\\.\\d+)?(?:ms|[smhd])?\\b/.exec(rest);
            if (num) {
                out += span(theme.number, num[0]);
                i += num[0].length;
                continue;
            }

            // Identifiers, including hyphenated operators like project-away
            var word = /^[A-Za-z_@$][A-Za-z0-9_]*(?:-[A-Za-z][A-Za-z0-9_]*)*/.exec(rest);
            if (word) {
                var raw = word[0];
                var lower = raw.toLowerCase();
                var after = rest.slice(raw.length);
                var isCall = /^\\s*\\(/.test(after);

                if (controls.indexOf(lower) >= 0) {
                    out += span(theme.control, raw);
                } else if (keywords.indexOf(lower) >= 0) {
                    out += span(theme.keyword, raw);
                } else if (isCall) {
                    out += span(theme.func, raw);
                } else {
                    out += questEscapeHtml(raw);
                }
                i += raw.length;
                continue;
            }

            // Whitespace passes through untouched so indentation survives
            var ws = /^\\s+/.exec(rest);
            if (ws) {
                out += questEscapeHtml(ws[0]);
                i += ws[0].length;
                continue;
            }

            // Operators and punctuation
            var op = /^(\\||[=!<>]=|[+\\-*\\/%<>=(),.;:\\[\\]{}])/.exec(rest);
            if (op) {
                out += span(theme.operator, op[0]);
                i += op[0].length;
                continue;
            }

            out += questEscapeHtml(query[i]);
            i += 1;
        }

        return out;
    }

    /**
     * Wraps a highlighted query in a self-contained, inline-styled code block.
     */
    function questHighlightToHtml(query, language, themeName) {
        var theme = QUEST_COPY_THEMES[themeName] || QUEST_COPY_THEMES.light;
        var body = questTokenize(query, language, theme);
        var preStyle = [
            'background-color:' + theme.background,
            'color:' + theme.text,
            'border:1px solid ' + theme.border,
            'border-radius:4px',
            'padding:10px 12px',
            'margin:0',
            'font-family:Consolas,\\'Courier New\\',monospace',
            'font-size:10.5pt',
            'line-height:1.4',
            'white-space:pre-wrap'
        ].join(';');
        return '<pre style="' + preStyle + '">' + body + '</pre>';
    }

    /**
     * Places both an HTML and a plain-text flavour on the clipboard.
     *
     * A temporary off-screen selection is required because execCommand('copy')
     * only fires a copy event when something is selected. The caller's own
     * selection is restored afterwards.
     */
    function questCopyRich(plain, html) {
        var copied = false;
        var handler = function (event) {
            event.clipboardData.setData('text/html', html);
            event.clipboardData.setData('text/plain', plain);
            event.preventDefault();
        };

        var scratch = document.createElement('div');
        scratch.setAttribute('style', 'position:fixed;left:-9999px;top:0;white-space:pre;');
        scratch.textContent = plain;
        document.body.appendChild(scratch);

        var selection = window.getSelection();
        var previous = [];
        for (var r = 0; r < selection.rangeCount; r++) {
            previous.push(selection.getRangeAt(r));
        }

        var range = document.createRange();
        range.selectNodeContents(scratch);
        selection.removeAllRanges();
        selection.addRange(range);

        document.addEventListener('copy', handler);
        try {
            copied = document.execCommand('copy');
        } catch (err) {
            copied = false;
        }
        document.removeEventListener('copy', handler);

        selection.removeAllRanges();
        for (var p = 0; p < previous.length; p++) {
            selection.addRange(previous[p]);
        }
        scratch.remove();

        return copied;
    }
`;
