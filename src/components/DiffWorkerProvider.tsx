import type { ReactNode } from "react";
import { WorkerPoolContextProvider, type WorkerInitializationRenderOptions, type WorkerPoolOptions } from "@pierre/diffs/react";
import { DIFF_WORD_MAX_LENGTH } from "./DiffEditor";

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

const HIGHLIGHTER_OPTIONS: WorkerInitializationRenderOptions = {
    langs: ["text"],
    lineDiffType: "none",
    maxLineDiffLength: DIFF_WORD_MAX_LENGTH,
};

export function DiffWorkerProvider({ children }: { children: ReactNode }) {
    if (typeof Worker === "undefined") return <>{children}</>;
    return (
        <WorkerPoolContextProvider poolOptions={POOL_OPTIONS} highlighterOptions={HIGHLIGHTER_OPTIONS}>
            {children}
        </WorkerPoolContextProvider>
    );
}
