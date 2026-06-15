export type Event =
    | { type: "open-file"; path: string; line?: number; character?: number }
    | { type: "fs-changed"; repo: string }
    | { type: "tree-native-drag-hover"; cwd: string | null; targetDir: string | null; highlightPath: string | null }
    | { type: "git-refresh"; repo: string }
    | { type: "agent-focus"; sessionId: string }
    | { type: "search-focus"; sessionId: string }
    | { type: "rnd-auth-expired"; reason: string }
    | { type: "aws-auth-expired"; profile: string; reason: string };

type AnyHandler = (e: Event) => void;

const handlers = new Map<Event["type"], Set<AnyHandler>>();

export function subscribe<T extends Event["type"]>(type: T, fn: (e: Extract<Event, { type: T }>) => void): () => void {
    let set = handlers.get(type);
    if (!set) {
        set = new Set();
        handlers.set(type, set);
    }
    set.add(fn as AnyHandler);
    return () => {
        set!.delete(fn as AnyHandler);
    };
}

export function emit<T extends Event["type"]>(e: Extract<Event, { type: T }>): void {
    handlers.get(e.type)?.forEach((fn) => fn(e));
}
