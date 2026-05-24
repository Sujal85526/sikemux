// Typed event bus — for cross-component signals that aren't state
// (file-open requests, fs change notifications, agent-focus, etc.).
// Decouples emitters from subscribers. The store should not carry
// nonces or one-shot flags — emit an event instead.

export type Event =
  | { type: "open-file"; path: string; line?: number; character?: number }
  | { type: "fs-changed"; repo: string }
  | { type: "git-refresh"; repo: string }
  | { type: "agent-focus"; sessionId: string };

type AnyHandler = (e: Event) => void;

const handlers = new Map<Event["type"], Set<AnyHandler>>();

export function subscribe<T extends Event["type"]>(
  type: T,
  fn: (e: Extract<Event, { type: T }>) => void,
): () => void {
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

export function emit<T extends Event["type"]>(
  e: Extract<Event, { type: T }>,
): void {
  handlers.get(e.type)?.forEach((fn) => fn(e));
}
