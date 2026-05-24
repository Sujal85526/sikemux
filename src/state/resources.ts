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

function keyOf(kind: string, args: unknown[]): string {
  return `${kind}|${args.map((a) => JSON.stringify(a)).join("|")}`;
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
        error: String(err),
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

/** Read a resource. Fetches on mount; refetches if stale; dedups inflight. */
export function useResource<Args extends unknown[], T>(
  def: ResourceDef<Args, T>,
  ...args: Args
): ResourceHandle<T> {
  const key = keyOf(def.kind, args as unknown[]);

  useEffect(() => {
    const entry = cache.get(key);
    const stale =
      !entry ||
      (def.staleAfterMs != null &&
        Date.now() - entry.fetchedAt > def.staleAfterMs);
    if (stale) {
      void trigger(def, key, args).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const entry = useSyncExternalStore(
    (cb) => {
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
    () => cache.get(key) as Entry<T> | undefined,
    () => undefined,
  );

  return {
    data: entry?.data,
    status: entry?.status ?? "loading",
    error: entry?.error,
    refresh: () => trigger(def, key, args).then(() => {}),
  };
}

/** Fire-and-forget fetch (for prefetch or imperative actions). */
export function fetchResource<Args extends unknown[], T>(
  def: ResourceDef<Args, T>,
  ...args: Args
): Promise<T> {
  return trigger(def, keyOf(def.kind, args as unknown[]), args);
}

/** Read currently-cached entry without triggering a fetch. */
export function peekResource<Args extends unknown[], T>(
  def: ResourceDef<Args, T>,
  ...args: Args
): T | undefined {
  const e = cache.get(keyOf(def.kind, args as unknown[])) as
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
