import { useEffect, useSyncExternalStore } from "react";

export interface ResourceDef<Args extends unknown[], T> {
    kind: string;
    fetch: (...args: Args) => Promise<T>;
    staleAfterMs?: number;
    keyFn?: (args: Args) => string;
}

type Status = "loading" | "ok" | "error";

interface Entry<T> {
    kind: string;
    args: unknown[];
    status: Status;
    data?: T;
    error?: string;
    fetchedAt: number;
}

type AnyDef = ResourceDef<unknown[], unknown>;

const cache = new Map<string, Entry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();
const subs = new Map<string, Set<() => void>>();
const defsByKind = new Map<string, AnyDef>();

function defaultKey(args: unknown[]): string {
    let key = "";
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        const t = typeof a;
        if (a === null || a === undefined) {
            key += i ? "|n" : "n";
        } else if (t === "string" || t === "number" || t === "boolean") {
            key += i ? "|" + String(a) : String(a);
        } else {
            key += i ? "|" + JSON.stringify(a) : JSON.stringify(a);
        }
    }
    return key;
}

function keyOf(kind: string, args: unknown[], def?: AnyDef): string {
    const k = def?.keyFn ? def.keyFn(args as never) : defaultKey(args);
    return `${kind}|${k}`;
}

function stringifyError(err: unknown): string {
    if (err == null) return "";
    if (typeof err === "string") return err;
    if (err instanceof Error) return err.message;
    if (typeof err === "object") {
        const e = err as { message?: unknown; category?: unknown };
        if (typeof e.message === "string" && e.message) return e.message;
        if (typeof e.category === "string" && e.category) return e.category;
        try {
            return JSON.stringify(err);
        } catch {
            return "unknown error";
        }
    }
    return String(err);
}

function notify(key: string): void {
    subs.get(key)?.forEach((fn) => fn());
}

function setEntry(key: string, entry: Entry<unknown>): void {
    cache.set(key, entry);
    notify(key);
}

function trigger<Args extends unknown[], T>(def: ResourceDef<Args, T>, key: string, args: Args): Promise<T> {
    const existing = inflight.get(key);
    if (existing) return existing as Promise<T>;
    const current = cache.get(key) as Entry<T> | undefined;
    setEntry(key, {
        kind: def.kind,
        args,
        status: "loading",
        data: current?.data,
        fetchedAt: current?.fetchedAt ?? 0,
    });
    const p = def
        .fetch(...args)
        .then((data) => {
            setEntry(key, {
                kind: def.kind,
                args,
                status: "ok",
                data,
                fetchedAt: Date.now(),
            });
            return data;
        })
        .catch((err: unknown) => {
            setEntry(key, {
                kind: def.kind,
                args,
                status: "error",
                data: current?.data,
                error: stringifyError(err),
                fetchedAt: Date.now(),
            });
            throw err;
        })
        .finally(() => {
            inflight.delete(key);
        });
    inflight.set(key, p);
    return p as Promise<T>;
}

export function resource<Args extends unknown[], T>(def: ResourceDef<Args, T>): ResourceDef<Args, T> {
    defsByKind.set(def.kind, def as unknown as AnyDef);
    return def;
}

export interface ResourceHandle<T> {
    data: T | undefined;
    status: Status;
    error: string | undefined;
    refresh: () => Promise<void>;
}

export function useResourceEnabled<Args extends unknown[], T>(enabled: boolean, def: ResourceDef<Args, T>, ...args: Args): ResourceHandle<T> {
    const key = enabled ? keyOf(def.kind, args as unknown[], def as unknown as AnyDef) : "";

    useEffect(() => {
        if (!enabled) return;
        const entry = cache.get(key);
        const stale = !entry || (def.staleAfterMs != null && Date.now() - entry.fetchedAt > def.staleAfterMs);
        if (stale) {
            void trigger(def, key, args).catch(() => {});
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [enabled, key]);

    const entry = useSyncExternalStore(
        (cb) => {
            if (!enabled) return () => {};
            let set = subs.get(key);
            if (!set) {
                set = new Set();
                subs.set(key, set);
            }
            set.add(cb);
            return () => {
                set!.delete(cb);
                if (set!.size === 0) subs.delete(key);
            };
        },
        () => (enabled ? (cache.get(key) as Entry<T> | undefined) : undefined),
        () => undefined,
    );

    return {
        data: entry?.data,
        status: entry?.status ?? "loading",
        error: entry?.error,
        refresh: () => (enabled ? trigger(def, key, args).then(() => {}) : Promise.resolve()),
    };
}

export function useResource<Args extends unknown[], T>(def: ResourceDef<Args, T>, ...args: Args): ResourceHandle<T> {
    return useResourceEnabled(true, def, ...args);
}

export function fetchResource<Args extends unknown[], T>(def: ResourceDef<Args, T>, ...args: Args): Promise<T> {
    return trigger(def, keyOf(def.kind, args as unknown[], def as unknown as AnyDef), args);
}

export function peekResource<Args extends unknown[], T>(def: ResourceDef<Args, T>, ...args: Args): T | undefined {
    const e = cache.get(keyOf(def.kind, args as unknown[], def as unknown as AnyDef)) as Entry<T> | undefined;
    return e?.data;
}

export function invalidate(predicate: (kind: string, args: unknown[]) => boolean): void {
    for (const [key, entry] of [...cache]) {
        if (!predicate(entry.kind, entry.args)) continue;
        if (subs.has(key)) {
            const def = defsByKind.get(entry.kind);
            if (def) {
                void trigger(def, key, entry.args).catch(() => {});
            } else {
                cache.delete(key);
                notify(key);
            }
        } else {
            cache.delete(key);
            notify(key);
        }
    }
}
