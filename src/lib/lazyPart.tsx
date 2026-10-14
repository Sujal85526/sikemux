import { useEffect, useState, type ComponentType } from "react";

/**
 * A component kept in a chunk of its own. Once `preload` has fetched it, it draws in the frame it mounts; before that
 * it draws nothing and fetches itself.
 */
export function lazyPart<P extends object>(load: () => Promise<ComponentType<P>>) {
    let loaded: ComponentType<P> | null = null;
    let loading: Promise<ComponentType<P> | null> | null = null;
    const preload = () =>
        (loading ??= load().then(
            (component) => (loaded = component),
            () => (loading = null),
        ));

    function Part(props: P) {
        const [Component, setComponent] = useState(() => loaded);
        useEffect(() => {
            if (Component) return;
            let live = true;
            void preload().then((component) => {
                if (live && component) setComponent(() => component);
            });
            return () => {
                live = false;
            };
        }, [Component]);
        return Component ? <Component {...props} /> : null;
    }

    return { Part, preload };
}

export interface LazyPart {
    preload: () => Promise<unknown>;
}

/** Settles once every part has been fetched, or has failed to be and will try again when it mounts. */
export function loadParts(parts: readonly LazyPart[]): Promise<void> {
    return Promise.all(parts.map((part) => part.preload())).then(() => undefined);
}

/** Runs `work` once the page has nothing else to do, so fetching it never competes with drawing. */
export function whenIdle(work: () => void): () => void {
    if (typeof window.requestIdleCallback === "function") {
        const id = window.requestIdleCallback(work, { timeout: 2000 });
        return () => window.cancelIdleCallback(id);
    }
    const timer = window.setTimeout(work, 200);
    return () => window.clearTimeout(timer);
}
