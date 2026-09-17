import { useEffect, useMemo, useState, type ReactNode } from "react";
import { WorkerPoolContextProvider, type WorkerInitializationRenderOptions, type WorkerPoolOptions } from "@pierre/diffs/react";
import { DIFF_WORD_MAX_LENGTH } from "./DiffEditor";
import { diffsThemeName } from "../themes/diffs";
import { currentTheme, subscribeTheme } from "../themes/bus";

function workerCount(): number {
    const available = typeof navigator === "undefined" ? 2 : (navigator.hardwareConcurrency ?? 2);
    return Math.max(1, Math.min(2, available - 1));
}

// The pool behind this provider is a process-wide singleton, so every pane that
// shows diffs shares these options and the workers they spin up.
const POOL_OPTIONS: WorkerPoolOptions = {
    workerFactory: () => new Worker(new URL("@pierre/diffs/worker/worker.js", import.meta.url), { type: "module", name: "sikemux-diff" }),
    poolSize: workerCount(),
    totalASTLRUCacheSize: 192,
};

export function DiffWorkerProvider({ children }: { children: ReactNode }) {
    const [themeName, setThemeName] = useState(() => diffsThemeName(currentTheme()));
    useEffect(() => subscribeTheme((theme) => setThemeName(diffsThemeName(theme))), []);

    // Naming the theme is not optional. Left unset, the pool resolves the
    // bundled default, which this app replaces with an empty table, so every
    // render rejects and the rejections pile up until the window stops drawing.
    const highlighterOptions = useMemo<WorkerInitializationRenderOptions>(
        () => ({
            theme: themeName,
            langs: ["text"],
            lineDiffType: "none",
            maxLineDiffLength: DIFF_WORD_MAX_LENGTH,
        }),
        [themeName],
    );

    if (typeof Worker === "undefined") return <>{children}</>;
    return (
        <WorkerPoolContextProvider poolOptions={POOL_OPTIONS} highlighterOptions={highlighterOptions}>
            {children}
        </WorkerPoolContextProvider>
    );
}
