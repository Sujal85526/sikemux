import { create } from "zustand";

export type ToastKind = "info" | "error" | "success";

export interface ToastAction {
    label: string;
    run: (toastId: number) => void | Promise<void>;
    dismissOnClick?: boolean;
}

export interface ToastOptions {
    action?: ToastAction;
    timeoutMs?: number | null;
}

export interface Toast {
    id: number;
    kind: ToastKind;
    text: string;
    action?: ToastAction;
}

interface ToastStore {
    toasts: Toast[];
    push: (kind: ToastKind, text: string, options?: ToastOptions) => void;
    dismiss: (id: number) => void;
}

let counter = 1;

export const useToasts = create<ToastStore>((set) => ({
    toasts: [],
    push: (kind, text, options) =>
        set((st) => {
            const action = options?.action;
            const last = st.toasts[st.toasts.length - 1];
            if (last && last.kind === kind && last.text === text && (last.action?.label ?? "") === (action?.label ?? "")) return {};
            const id = counter++;
            const toast: Toast = action ? { id, kind, text, action } : { id, kind, text };
            const timeoutMs = options?.timeoutMs === undefined ? (action ? null : kind === "error" ? 6000 : 3500) : options.timeoutMs;
            if (timeoutMs != null && timeoutMs > 0) {
                window.setTimeout(() => useToasts.getState().dismiss(id), timeoutMs);
            }
            return { toasts: [...st.toasts, toast] };
        }),
    dismiss: (id) => set((st) => ({ toasts: st.toasts.filter((t) => t.id !== id) })),
}));

export function notify(kind: ToastKind, text: string, options?: ToastOptions): void {
    useToasts.getState().push(kind, text, options);
}

export function dismissToast(id: number): void {
    useToasts.getState().dismiss(id);
}

export interface AppErrorEnvelope {
    category: string;
    message: string;
}

function isAppError(e: unknown): e is AppErrorEnvelope {
    return (
        !!e && typeof e === "object" && typeof (e as AppErrorEnvelope).message === "string" && typeof (e as AppErrorEnvelope).category === "string"
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

export function reportError(label: string): (err: unknown) => void {
    return (err) => notify("error", `${label}: ${errMessage(err)}`);
}

const SWALLOW_RING_SIZE = 64;
const swallowed: { ts: number; label: string; err: unknown }[] = [];

export function swallow(label: string): (err: unknown) => void {
    return (err) => {
        swallowed.push({ ts: Date.now(), label, err });
        if (swallowed.length > SWALLOW_RING_SIZE) swallowed.shift();
    };
}

if (typeof window !== "undefined") {
    (window as unknown as { __swallowed?: () => typeof swallowed }).__swallowed = () => swallowed.slice();
}
