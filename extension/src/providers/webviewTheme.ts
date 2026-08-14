import { ICON_STYLES } from './webviewIcons';

/**
 * Design tokens shared by every Quest webview.
 *
 * Each panel used to carry its own copy of button, input and list styling,
 * which drifted over time. Centralising it here keeps the panels consistent
 * and means a change to the look only has to be made once.
 *
 * Everything is expressed with VS Code theme variables so custom themes and
 * light/dark switching are handled automatically.
 */
export const SHARED_STYLES = `
${ICON_STYLES}

/* ---- Base ---- */
.q-body {
    padding: 0;
    margin: 0;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background-color: var(--vscode-panel-background);
}

/* ---- Buttons ---- */
.q-btn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: 1px solid transparent;
    padding: 3px 9px;
    border-radius: 4px;
    font-size: 11px;
    line-height: 18px;
    font-family: inherit;
    cursor: pointer;
    white-space: nowrap;
    transition: background 60ms ease, border-color 60ms ease;
}
.q-btn:hover {
    background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground));
    border-color: var(--vscode-widget-border, transparent);
}
.q-btn:focus-visible {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: 1px;
}
.q-btn.primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
}
.q-btn.primary:hover { background: var(--vscode-button-hoverBackground); }
.q-btn:disabled { opacity: 0.5; cursor: default; }

/* Icon-only button, e.g. a row action */
.q-icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    padding: 0;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--vscode-foreground);
    cursor: pointer;
    opacity: 0.75;
}
.q-icon-btn:hover {
    opacity: 1;
    background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
}
.q-icon-btn:focus-visible {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: 1px;
}

/* ---- Inputs ---- */
.q-input {
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    padding: 3px 8px;
    border-radius: 4px;
    font-size: 11px;
    line-height: 18px;
    font-family: inherit;
}
.q-input::placeholder { color: var(--vscode-input-placeholderForeground, var(--vscode-descriptionForeground)); }
.q-input:focus {
    outline: none;
    border-color: var(--vscode-focusBorder);
}

/* ---- Toolbar ---- */
.q-toolbar {
    display: flex;
    align-items: center;
    gap: 6px;
    row-gap: 6px;
    flex-wrap: wrap;
    padding: 6px 10px;
    background: var(--vscode-panel-background);
    border-bottom: 1px solid var(--vscode-panel-border);
}
.q-sep {
    width: 1px;
    height: 16px;
    background: var(--vscode-panel-border);
    margin: 0 3px;
}

/* ---- List rows ---- */
.q-list { display: flex; flex-direction: column; }
.q-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 10px;
    border-bottom: 1px solid var(--vscode-panel-border);
    cursor: pointer;
    transition: background 60ms ease;
}
.q-row:hover { background: var(--vscode-list-hoverBackground); }
.q-row.selected {
    background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground);
}
.q-row .q-row-main { flex: 1; min-width: 0; }
.q-row .q-row-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.q-row .q-row-sub {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
/* Row actions stay out of the way until the row is hovered */
.q-row .q-row-actions { display: flex; gap: 2px; opacity: 0; }
.q-row:hover .q-row-actions, .q-row.selected .q-row-actions { opacity: 1; }

/* ---- Empty state ---- */
.q-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 28px 16px;
    text-align: center;
    color: var(--vscode-descriptionForeground);
}
.q-empty .qi { font-size: 22px; opacity: 0.5; }
.q-empty small { opacity: 0.8; }

/* ---- Scrollbars ---- */
.q-scroll { scrollbar-width: thin; scrollbar-color: var(--vscode-scrollbarSlider-background) transparent; }
.q-scroll::-webkit-scrollbar { width: 10px; height: 10px; }
.q-scroll::-webkit-scrollbar-track { background: transparent; }
.q-scroll::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background); border-radius: 5px; }
.q-scroll::-webkit-scrollbar-thumb:hover { background: var(--vscode-scrollbarSlider-hoverBackground); }
.q-scroll::-webkit-scrollbar-corner { background: transparent; }

/* ---- Badges ---- */
.q-badge {
    display: inline-block;
    padding: 0 6px;
    border-radius: 9px;
    font-size: 10px;
    line-height: 16px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
}
`;

/** Convenience helper for an icon span. */
export function icon(name: string, extraClass = ''): string {
    return `<span class="qi qi-${name}${extraClass ? ' ' + extraClass : ''}"></span>`;
}
