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
            const last = st.toasts[st.toasts.length - 1];
            if (last && last.kind === kind && last.text === text) return {};
            const id = counter++;
            const toast: Toast = { id, kind, text };
            window.setTimeout(() => useToasts.getState().dismiss(id), kind === "error" ? 6000 : 3500);
            return { toasts: [...st.toasts, toast] };
        }),
    dismiss: (id) => set((st) => ({ toasts: st.toasts.filter((t) => t.id !== id) })),
}));

export function notify(kind: ToastKind, text: string): void {
    useToasts.getState().push(kind, text);
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
