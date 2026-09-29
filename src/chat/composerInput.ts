export const MAX_ATTACHMENTS = 32;

export function mergePaths(current: string[], incoming: readonly string[]): string[] {
    const merged = [...current];
    for (const path of incoming) {
        if (!path || path.includes("\0") || merged.includes(path)) continue;
        if (merged.length === MAX_ATTACHMENTS) break;
        merged.push(path);
    }
    return merged;
}

/* The command a draft is naming is the one the caret sits in, so a slash works
   part-way through a sentence and not only as the first thing typed. */
export function slashTokenAt(text: string, caret: number): { start: number; needle: string } | null {
    if (caret <= 0) return null;
    const start = text.lastIndexOf("/", caret - 1);
    if (start < 0) return null;
    if (start > 0 && !/\s/.test(text[start - 1])) return null;
    const needle = text.slice(start + 1, caret);
    return /\s/.test(needle) ? null : { start, needle };
}
