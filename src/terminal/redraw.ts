const ESC = 0x1b;
const BRACKET = 0x5b;
const ZERO = 0x30;
const ERASE_IN_LINE = 0x4b;

/**
 * xterm's transparent canvas can occasionally retain old glyphs in WKWebView
 * after an erase sequence. zsh-autosuggestions redraws its ghost text with an
 * erase-to-end-of-line, so match only that — the broader erase sequences that
 * prompts and TUIs emit constantly do not need a whole-screen repaint.
 */
export function needsTerminalRedraw(bytes: Uint8Array): boolean {
    for (let i = 0; i + 2 < bytes.length; i++) {
        if (bytes[i] !== ESC || bytes[i + 1] !== BRACKET) continue;
        // CSI 0 K means the same thing as a bare CSI K.
        const final = bytes[i + 2] === ZERO ? i + 3 : i + 2;
        if (bytes[final] === ERASE_IN_LINE) return true;
    }
    return false;
}
