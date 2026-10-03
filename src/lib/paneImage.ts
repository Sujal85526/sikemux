import { useEffect, useState } from "react";
import { fsapi } from "../api/fs";
import { previewUrl } from "../editor/viewers/fileKinds";
import { useStore } from "../state/store";

const loads = new Map<string, Promise<HTMLImageElement | null>>();
const loaded = new Map<string, HTMLImageElement | null>();

/*
 * Read through a blob so the picture is same-origin: WebGL refuses to upload
 * one straight off `preview://`.
 */
async function decode(path: string): Promise<HTMLImageElement | null> {
    const { mime } = await fsapi.previewFile(path);
    if (!mime.startsWith("image/")) return null;
    const blob = await (await fetch(previewUrl(path))).blob();
    const image = new Image();
    image.src = URL.createObjectURL(blob);
    await image.decode();
    return image;
}

function loadPaneImage(path: string): Promise<HTMLImageElement | null> {
    let load = loads.get(path);
    if (!load) {
        load = decode(path)
            .then((image) => {
                loaded.set(path, image);
                return image;
            })
            .catch((error: unknown) => {
                console.warn("Pane image unavailable:", error instanceof Error ? error.message : error);
                loads.delete(path);
                return null;
            });
        loads.set(path, load);
    }
    return load;
}

/**
 * The picture every pane shares, decoded once, and whether it is still on its
 * way. A pane made after it has loaded gets it on its first render.
 */
export function usePaneImageState(): { image: HTMLImageElement | null; loading: boolean } {
    const path = useStore((s) => s.paneImage);
    const [image, setImage] = useState<{ path: string; image: HTMLImageElement | null } | null>(() =>
        path && loaded.has(path) ? { path, image: loaded.get(path) ?? null } : null,
    );
    useEffect(() => {
        if (!path) return;
        let live = true;
        void loadPaneImage(path).then((next) => {
            if (live) setImage((was) => (was?.path === path && was.image === next ? was : { path, image: next }));
        });
        return () => {
            live = false;
        };
    }, [path]);
    if (!path) return { image: null, loading: false };
    if (image?.path === path) return { image: image.image, loading: false };
    return loaded.has(path) ? { image: loaded.get(path) ?? null, loading: false } : { image: null, loading: true };
}

/** The picture every pane shares, decoded once. Null until it loads, and when none is set or it cannot be read. */
export function usePaneImage(): HTMLImageElement | null {
    return usePaneImageState().image;
}
