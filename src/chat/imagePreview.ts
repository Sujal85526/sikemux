import { useEffect, useState } from "react";
import { fsapi } from "../api/fs";
import { isImagePath } from "../editor/media";

const MAX_CACHED = 32;
const MAX_PREVIEW_BYTES = 16 * 1024 * 1024;
/* A null entry is a file we already tried and cannot show, so a transcript
   that scrolls past it again does not read it again. */
const previews = new Map<string, string | null>();
const pending = new Map<string, Promise<string | null>>();

function remember(path: string, src: string | null): string | null {
    previews.delete(path);
    previews.set(path, src);
    for (const oldest of previews.keys()) {
        if (previews.size <= MAX_CACHED) break;
        previews.delete(oldest);
    }
    return src;
}

function loadPreview(path: string): Promise<string | null> {
    const running = pending.get(path);
    if (running) return running;
    const request = fsapi
        .readFileBase64(path)
        .then((blob) =>
            remember(path, blob.mime.startsWith("image/") && blob.size <= MAX_PREVIEW_BYTES ? `data:${blob.mime};base64,${blob.data}` : null),
        )
        .catch(() => remember(path, null))
        .finally(() => pending.delete(path));
    pending.set(path, request);
    return request;
}

export function localPath(uri: string | null | undefined): string | null {
    if (!uri) return null;
    if (!uri.startsWith("file://")) return uri.startsWith("/") ? uri : null;
    let path: string;
    try {
        path = decodeURIComponent(new URL(uri).pathname);
    } catch {
        return null;
    }
    return /^\/[A-Za-z]:/.test(path) ? path.slice(1) : path;
}

export function localImagePath(uri: string | null | undefined): string | null {
    const path = localPath(uri);
    return path && isImagePath(path) ? path : null;
}

/** Reads a local image as a data URL; null while it loads and if it cannot be shown. */
export function useImagePreview(path: string | null): string | null {
    const [src, setSrc] = useState<string | null>(null);
    useEffect(() => {
        if (!path || !isImagePath(path)) {
            setSrc(null);
            return;
        }
        if (previews.has(path)) {
            setSrc(previews.get(path) ?? null);
            return;
        }
        setSrc(null);
        let live = true;
        void loadPreview(path).then((loaded) => {
            if (live) setSrc(loaded);
        });
        return () => {
            live = false;
        };
    }, [path]);
    return src;
}
