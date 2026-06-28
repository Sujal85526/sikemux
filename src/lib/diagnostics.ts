import { invoke } from "@tauri-apps/api/core";
import { busStats } from "../state/bus";
import { resourceStats } from "../state/resources";
import { getState } from "../state/store";

type LongTaskEntry = {
    name: string;
    startTime: number;
    duration: number;
};

type MemoryInfo = {
    usedJSHeapSize?: number;
    totalJSHeapSize?: number;
    jsHeapSizeLimit?: number;
};

declare global {
    interface Window {
        sikemuxDiagnostics?: {
            snapshot: () => Record<string, unknown>;
            native: () => Promise<unknown>;
            longTasks: () => LongTaskEntry[];
            clearLongTasks: () => void;
        };
    }
}

const longTasks: LongTaskEntry[] = [];
const MAX_LONG_TASKS = 200;

function memorySnapshot(): MemoryInfo | null {
    const perf = performance as Performance & { memory?: MemoryInfo };
    return perf.memory ?? null;
}

function domSnapshot() {
    return {
        elements: document.getElementsByTagName("*").length,
        xterms: document.querySelectorAll(".xterm").length,
        canvases: document.querySelectorAll("canvas").length,
        codeMirrorEditors: document.querySelectorAll(".cm-editor").length,
        visibleWindowLayers: document.querySelectorAll(".window-layer.visible").length,
    };
}

function storeSnapshot() {
    const s = getState();
    return {
        sessions: Object.keys(s.sessions).length,
        windows: Object.keys(s.windows).length,
        agents: Object.keys(s.agents).length,
        editorViews: Object.keys(s.editorViews).length,
        gitViews: Object.keys(s.gitViews).length,
        rundeckViews: Object.keys(s.rundeckViews).length,
        brunoViews: Object.keys(s.brunoViews).length,
        gitCmdLog: s.gitCmdLog.length,
    };
}

export function installDiagnostics(): void {
    if (window.sikemuxDiagnostics) return;

    window.sikemuxDiagnostics = {
        snapshot: () => ({
            at: new Date().toISOString(),
            memory: memorySnapshot(),
            dom: domSnapshot(),
            store: storeSnapshot(),
            resources: resourceStats(),
            bus: busStats(),
            longTaskCount: longTasks.length,
            lastLongTasks: longTasks.slice(-10),
        }),
        native: () => invoke("runtime_diagnostics"),
        longTasks: () => longTasks.slice(),
        clearLongTasks: () => {
            longTasks.length = 0;
        },
    };

    if (typeof PerformanceObserver !== "undefined") {
        try {
            const observer = new PerformanceObserver((list) => {
                for (const entry of list.getEntries()) {
                    longTasks.push({
                        name: entry.name,
                        startTime: entry.startTime,
                        duration: entry.duration,
                    });
                    if (longTasks.length > MAX_LONG_TASKS) longTasks.splice(0, longTasks.length - MAX_LONG_TASKS);
                }
            });
            observer.observe({ type: "longtask", buffered: true });
        } catch {
            // WebKit may not expose longtask; snapshot diagnostics still work.
        }
    }
}
