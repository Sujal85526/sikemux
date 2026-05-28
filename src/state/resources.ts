import { useEffect, useSyncExternalStore } from "react";

// Typed query cache. A "resource" is a (kind, fetchFn) pair; calling
// useResource(def, ...args) returns the cached data, fetching on demand
// and deduping concurrent calls. Refresh is event-driven: callers wire
// up invalidation in App.tsx via `invalidate(predicate)`.

export interface ResourceDef<Args extends unknown[], T> {
  kind: string;
  fetch: (...args: Args) => Promise<T>;
  /** Background refetch when an existing entry is older than this. */
  staleAfterMs?: number;
  /** Optional cache-key builder for non-primitive args. Defaults to a
   *  stable JSON-stringify of each arg, which is fine when args are
   *  primitives (the common case). Provide one when args contain large
   *  objects or order-sensitive fields. */
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
// Kind → def, so invalidation can refetch active subscribers.
const defsByKind = new Map<string, AnyDef>();

function defaultKey(args: unknown[]): string {
  // Fast path: every arg is a primitive (string|number|boolean|null/undef).
  // 95%+ of resources use just `(repo)` or `(profile)` so this avoids the
  // JSON.stringify allocation on every read.
  let key = "";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const t = typeof a;
    if (a === null || a === undefined) {
      key += i ? "|n" : "n";
    } else if (t === "string" || t === "number" || t === "boolean") {
      key += i ? "|" + String(a) : String(a);
    } else {
      // Non-primitive — fall back to JSON for correctness. Caller should
      // supply a `keyFn` if this hot-pathed object is expensive.
      key += i ? "|" + JSON.stringify(a) : JSON.stringify(a);
    }
  }
  return key;
}

function keyOf(kind: string, args: unknown[], def?: AnyDef): string {
  const k = def?.keyFn ? def.keyFn(args as never) : defaultKey(args);
  return `${kind}|${k}`;
}

// Tauri commands return Err values as { category, message } structured
// objects (see src-tauri/src/error.rs::AppError::Serialize). Naïve
// `String(err)` on those gives `[object Object]` and surfaces to the UI
// as gibberish red text. Pluck `.message` first, then fall back.
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

function trigger<Args extends unknown[], T>(
  def: ResourceDef<Args, T>,
  key: string,
  args: Args,
): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;
  const current = cache.get(key) as Entry<T> | undefined;
  // Optimistic: mark loading without clobbering data so renderers can show
  // a refresh spinner without dropping the previous result.
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

/** Define + register a resource. Registration enables event-driven refetch. */
export function resource<Args extends unknown[], T>(
  def: ResourceDef<Args, T>,
): ResourceDef<Args, T> {
  defsByKind.set(def.kind, def as unknown as AnyDef);
  return def;
}

export interface ResourceHandle<T> {
  data: T | undefined;
  status: Status;
  error: string | undefined;
  refresh: () => Promise<void>;
}

/** Read a resource only while `enabled` is true. Keeps hidden mounted panes
 *  subscribed safely without starting backend work. */
export function useResourceEnabled<Args extends unknown[], T>(
  enabled: boolean,
  def: ResourceDef<Args, T>,
  ...args: Args
): ResourceHandle<T> {
  const key = enabled ? keyOf(def.kind, args as unknown[], def as unknown as AnyDef) : "";

  useEffect(() => {
    if (!enabled) return;
    const entry = cache.get(key);
    const stale =
      !entry ||
      (def.staleAfterMs != null &&
        Date.now() - entry.fetchedAt > def.staleAfterMs);
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
    () => enabled ? (cache.get(key) as Entry<T> | undefined) : undefined,
    () => undefined,
  );

  return {
    data: entry?.data,
    status: entry?.status ?? "loading",
    error: entry?.error,
    refresh: () => enabled ? trigger(def, key, args).then(() => {}) : Promise.resolve(),
  };
}

/** Read a resource. Fetches on mount; refetches if stale; dedups inflight. */
export function useResource<Args extends unknown[], T>(
  def: ResourceDef<Args, T>,
  ...args: Args
): ResourceHandle<T> {
  return useResourceEnabled(true, def, ...args);
}

/** Fire-and-forget fetch (for prefetch or imperative actions). */
export function fetchResource<Args extends unknown[], T>(
  def: ResourceDef<Args, T>,
  ...args: Args
): Promise<T> {
  return trigger(def, keyOf(def.kind, args as unknown[], def as unknown as AnyDef), args);
}

/** Read currently-cached entry without triggering a fetch. */
export function peekResource<Args extends unknown[], T>(
  def: ResourceDef<Args, T>,
  ...args: Args
): T | undefined {
  const e = cache.get(keyOf(def.kind, args as unknown[], def as unknown as AnyDef)) as
    | Entry<T>
    | undefined;
  return e?.data;
}

/** Invalidate matching entries; active subscribers refetch immediately. */
export function invalidate(
  predicate: (kind: string, args: unknown[]) => boolean,
): void {
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
