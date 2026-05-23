import { create } from "zustand";

export type ToastKind = "info" | "error" | "success";

export interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
}

interface ToastStore {
  toasts: Toast[];
  push: (kind: ToastKind, text: string) => void;
  dismiss: (id: number) => void;
}

let counter = 1;

export const useToasts = create<ToastStore>((set) => ({
  toasts: [],
  push: (kind, text) =>
    set((st) => {
      // Coalesce identical messages fired in quick succession (e.g. a watcher
      // emitting a burst of errors for the same root cause).
      const last = st.toasts[st.toasts.length - 1];
      if (last && last.kind === kind && last.text === text) return {};
      const id = counter++;
      const toast: Toast = { id, kind, text };
      window.setTimeout(
        () => useToasts.getState().dismiss(id),
        kind === "error" ? 6000 : 3500,
      );
      return { toasts: [...st.toasts, toast] };
    }),
  dismiss: (id) =>
    set((st) => ({ toasts: st.toasts.filter((t) => t.id !== id) })),
}));

export function notify(kind: ToastKind, text: string): void {
  useToasts.getState().push(kind, text);
}

/** Wrap a promise so its rejection surfaces as a toast and rethrows. */
export function withToast<T>(p: Promise<T>, label: string): Promise<T> {
  return p.catch((err) => {
    notify("error", `${label}: ${String(err)}`);
    throw err;
  });
}

/** Convenience for fire-and-forget paths that previously did `.catch(() => {})`. */
export function reportError(label: string): (err: unknown) => void {
  return (err) => notify("error", `${label}: ${String(err)}`);
}
