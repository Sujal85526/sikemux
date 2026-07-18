/**
 * xterm's transparent canvas can occasionally retain old glyphs in WKWebView
 * after an erase sequence. zsh-autosuggestions redraws its ghost text with
 * CSI K, so use that control sequence as a narrow signal to repaint the rows.
 */
export function needsTerminalRedraw(bytes: Uint8Array): boolean {
    for (let i = 0; i + 2 < bytes.length; i++) {
        if (bytes[i] !== 0x1b || bytes[i + 1] !== 0x5b) continue;
        let cursor = i + 2;
        while (cursor < bytes.length && ((bytes[cursor] >= 0x30 && bytes[cursor] <= 0x3f) || bytes[cursor] === 0x3b)) cursor++;
        if (bytes[cursor] === 0x4b || bytes[cursor] === 0x4a) return true; // CSI K / CSI J
    }
    return false;
}
