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

// Tauri commands now reject with `{ category, message }` (see src-tauri's
// AppError). Older paths still throw strings or plain Errors; coalesce all
// three so the toast text is human and the category — when present — is
// preserved on the error object for callers that want to branch on it.

export interface AppErrorEnvelope {
  category: string;
  message: string;
}

function isAppError(e: unknown): e is AppErrorEnvelope {
  return (
    !!e &&
    typeof e === "object" &&
    typeof (e as AppErrorEnvelope).message === "string" &&
    typeof (e as AppErrorEnvelope).category === "string"
  );
}

export function errMessage(e: unknown): string {
  if (isAppError(e)) return e.message;
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return String(e);
}

export function errCategory(e: unknown): string | null {
  return isAppError(e) ? e.category : null;
}

/** Wrap a promise so its rejection surfaces as a toast and rethrows. */
export function withToast<T>(p: Promise<T>, label: string): Promise<T> {
  return p.catch((err) => {
    notify("error", `${label}: ${errMessage(err)}`);
    throw err;
  });
}

/** Convenience for fire-and-forget paths that previously did `.catch(() => {})`. */
export function reportError(label: string): (err: unknown) => void {
  return (err) => notify("error", `${label}: ${errMessage(err)}`);
}
