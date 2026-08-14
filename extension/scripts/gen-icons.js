/**
 * Generates src/providers/webviewIcons.ts from @vscode/codicons.
 *
 * Only the icons Quest actually uses are inlined, as CSS mask-image data URIs.
 * This keeps the icon set consistent with VS Code without shipping the 146 KB
 * codicon font, and because the glyph is painted with `background-color:
 * currentColor` it inherits the surrounding theme colour automatically.
 *
 * Run with: npm run gen-icons
 */
const fs = require('fs');
const path = require('path');

const ICON_DIR = path.join(__dirname, '..', 'node_modules', '@vscode', 'codicons', 'src', 'icons');
const OUT = path.join(__dirname, '..', 'src', 'providers', 'webviewIcons.ts');

// Quest name -> codicon name. Quest names are kept stable so markup does not
// churn if we later swap which codicon backs one of them.
const ICONS = {
    'set-query': 'arrow-up',
    'copy': 'copy',
    'globe': 'globe',
    'rerun': 'refresh',
    'save': 'save',
    'chart': 'graph',
    'pivot': 'table',
    'compare': 'diff',
    'transpose': 'arrow-both',
    'columns': 'list-selection',
    'presets': 'layout',
    'clear-colors': 'clear-all',
    'search': 'search',
    'filter': 'filter',
    'close': 'close',
    'star': 'star-full',
    'star-outline': 'star-empty',
    'trash': 'trash',
    'history': 'history',
    'play': 'play',
    'add': 'add',
    'edit': 'edit',
    'open-external': 'link-external',
    'eye': 'eye',
    'chevron-down': 'chevron-down',
    'loading': 'loading',
    'check': 'check',
    'error': 'error',
    'warning': 'warning',
    'sparkle': 'sparkle',
    'chat': 'comment-discussion',
    'gear': 'gear',
    'file': 'go-to-file',
    'export': 'desktop-download'
};

/** Inline an SVG as a data URI suitable for use in CSS mask-image. */
function toDataUri(svg) {
    const cleaned = svg
        .replace(/<\?xml[^>]*\?>/g, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    // Minimal escaping only. Encoding '<' and '>' would roughly double the
    // payload, and both are accepted unencoded inside a quoted url("...").
    const encoded = cleaned
        .replace(/%/g, '%25')
        .replace(/"/g, "'")
        .replace(/#/g, '%23');
    return `data:image/svg+xml,${encoded}`;
}

const rules = [];
for (const [questName, codiconName] of Object.entries(ICONS)) {
    const file = path.join(ICON_DIR, codiconName + '.svg');
    if (!fs.existsSync(file)) { throw new Error(`missing codicon: ${codiconName}`); }
    const uri = toDataUri(fs.readFileSync(file, 'utf8'));
    // The URI is stored once in a custom property; `.qi` then feeds it to both
    // the prefixed and unprefixed mask properties, which halves the payload.
    rules.push(`.qi-${questName} { --qi: url("${uri}"); }`);
}

const css = `.qi {
    display: inline-block;
    width: 1em;
    height: 1em;
    vertical-align: -0.15em;
    background-color: currentColor;
    -webkit-mask-image: var(--qi);
    mask-image: var(--qi);
    -webkit-mask-repeat: no-repeat;
    mask-repeat: no-repeat;
    -webkit-mask-position: center;
    mask-position: center;
    -webkit-mask-size: 100% 100%;
    mask-size: 100% 100%;
    flex-shrink: 0;
}
.qi-spin { animation: qi-spin 1.2s linear infinite; }
@keyframes qi-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
${rules.join('\n')}`;

const banner = `// GENERATED FILE - do not edit by hand.
// Regenerate with: npm run gen-icons
// Source: @vscode/codicons (MIT), inlined as CSS masks so no font is shipped.
`;

fs.writeFileSync(
    OUT,
    `${banner}\n/** Codicon-backed icon styles for Quest webviews. */\nexport const ICON_STYLES = \`${css.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')}\`;\n`
);

console.log(`wrote ${path.relative(process.cwd(), OUT)}  (${ICONS && Object.keys(ICONS).length} icons, ${Math.round(css.length / 1024)} KB css)`);
