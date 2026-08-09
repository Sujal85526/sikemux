export interface PreviewHistory {
    entries: string[];
    index: number;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Embedded previews intentionally stay local. Remote pages can still be opened
 * in the user's browser, but they do not receive a privileged Sikemux surface.
 */
export function localPreviewUrl(raw: string): string | null {
    const value = raw.trim();
    if (!value) return null;
    const withProtocol = /^https?:\/\//i.test(value) ? value : `http://${value}`;
    try {
        const url = new URL(withProtocol);
        if (url.protocol !== "http:" && url.protocol !== "https:") return null;
        if (url.username || url.password || !LOOPBACK_HOSTS.has(url.hostname)) return null;
        return url.toString();
    } catch {
        return null;
    }
}

export function createPreviewHistory(initial?: string | null): PreviewHistory {
    const url = initial ? localPreviewUrl(initial) : null;
    return url ? { entries: [url], index: 0 } : { entries: [], index: -1 };
}

export function pushPreviewHistory(history: PreviewHistory, raw: string): PreviewHistory {
    const url = localPreviewUrl(raw);
    if (!url) return history;
    if (history.entries[history.index] === url) return history;
    return { entries: [...history.entries.slice(0, history.index + 1), url], index: history.index + 1 };
}

export function movePreviewHistory(history: PreviewHistory, delta: -1 | 1): PreviewHistory {
    if (history.entries.length === 0) return history;
    return { ...history, index: Math.max(0, Math.min(history.entries.length - 1, history.index + delta)) };
}

export const currentPreviewUrl = (history: PreviewHistory): string | null => history.entries[history.index] ?? null;
