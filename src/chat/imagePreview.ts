import { useEffect, useState } from "react";
import { fsapi } from "../api/fs";
import { isImagePath } from "../editor/media";

const MAX_CACHED = 12;
/* A preview is only ever drawn a few hundred pixels wide, so a picture bigger
   than this is redrawn small before it is kept. A retina screenshot is several
   megabytes and would otherwise fill the cache on its own. */
const SHRINK_OVER_BYTES = 1024 * 1024;
const THUMB_EDGE = 720;
const MAX_CACHE_BYTES = 12 * 1024 * 1024;
/* A null entry is a file we already tried and cannot show, so a transcript
   that scrolls past it again does not read it again. */
const previews = new Map<string, string | null>();
const pending = new Map<string, Promise<string | null>>();
let cachedBytes = 0;

function remember(path: string, src: string | null): string | null {
    const held = previews.get(path);
    if (held !== undefined) cachedBytes -= held?.length ?? 0;
    previews.delete(path);
    previews.set(path, src);
    cachedBytes += src?.length ?? 0;
    for (const oldest of [...previews.keys()]) {
        if (oldest === path || (previews.size <= MAX_CACHED && cachedBytes <= MAX_CACHE_BYTES)) break;
        cachedBytes -= previews.get(oldest)?.length ?? 0;
        previews.delete(oldest);
    }
    return src;
}

function bytesOf(base64: string) {
    return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

/** Redraws a picture at thumbnail size, or null where the webview cannot. */
async function shrink(blob: Blob): Promise<string | null> {
    if (typeof createImageBitmap !== "function") return null;
    try {
        const bitmap = await createImageBitmap(blob);
        const scale = Math.min(1, THUMB_EDGE / Math.max(bitmap.width, bitmap.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        const context = canvas.getContext("2d");
        if (context) context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        bitmap.close();
        return context ? canvas.toDataURL("image/jpeg", 0.82) : null;
    } catch {
        return null;
    }
}

async function readPreview(path: string): Promise<string | null> {
    const blob = await fsapi.readFileBase64(path);
    if (!blob.mime.startsWith("image/")) return null;
    if (blob.size <= SHRINK_OVER_BYTES) return `data:${blob.mime};base64,${blob.data}`;
    return shrink(new Blob([bytesOf(blob.data)], { type: blob.mime }));
}

function loadPreview(path: string): Promise<string | null> {
    const running = pending.get(path);
    if (running) return running;
    const request = readPreview(path)
        .then((src) => remember(path, src))
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

/** What the preview cache is holding, in characters. */
export function previewCacheBytes(): number {
    return cachedBytes;
}

/** Reads a local image whole, for a viewer that wants it at its own size. */
export async function readImageSource(path: string): Promise<string | null> {
    try {
        const blob = await fsapi.readFileBase64(path);
        return blob.mime.startsWith("image/") ? `data:${blob.mime};base64,${blob.data}` : null;
    } catch {
        return null;
    }
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
