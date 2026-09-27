import { useToasts, type ToastKind } from "../state/toast";
import { IconCheck, IconClose, IconExclamation, IconInfoMark } from "./Icons";

const KIND_ICON: Record<ToastKind, typeof IconCheck> = {
    success: IconCheck,
    error: IconExclamation,
    info: IconInfoMark,
};

export function Toaster() {
    const toasts = useToasts((s) => s.toasts);
    const dismiss = useToasts((s) => s.dismiss);
    const pause = useToasts((s) => s.pause);
    const resume = useToasts((s) => s.resume);
    if (toasts.length === 0) return null;
    return (
        <div className="toaster" aria-live="polite" aria-atomic="false">
            {toasts.map((t) => {
                const KindIcon = KIND_ICON[t.kind];
                return (
                    <div
                        key={t.id}
                        onMouseEnter={() => pause(t.id, "pointer")}
                        onMouseLeave={() => resume(t.id, "pointer")}
                        onFocusCapture={() => pause(t.id, "focus")}
                        onBlurCapture={(event) => {
                            if (!event.currentTarget.contains(event.relatedTarget)) resume(t.id, "focus");
                        }}
                        className={`toast toast-${t.kind}`}
                        role={t.kind === "error" ? "alert" : "status"}>
                        <KindIcon size={14} className="toast-icon" />
                        <span className="toast-text">{t.text}</span>
                        {t.action && (
                            <button
                                className="toast-action"
                                onClick={() => {
                                    if (t.action?.dismissOnClick) dismiss(t.id);
                                    void t.action?.run(t.id);
                                }}>
                                {t.action.label}
                            </button>
                        )}
                        {t.persistent && (
                            <button className="toast-x" onClick={() => dismiss(t.id)} title="Dismiss" aria-label="Dismiss notification">
                                <IconClose size={10} />
                            </button>
                        )}
                    </div>
                );
            })}
        </div>
    );
}
