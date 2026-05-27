import { useToasts } from "../state/toast";
import { IconClose } from "./Icons";

export function Toaster() {
    const toasts = useToasts((s) => s.toasts);
    const dismiss = useToasts((s) => s.dismiss);
    if (toasts.length === 0) return null;
    return (
        <div className="toaster">
            {toasts.map((t) => (
                <div key={t.id} className={`toast toast-${t.kind}`}>
                    <span className="toast-text">{t.text}</span>
                    <button className="toast-x" onClick={() => dismiss(t.id)} title="Dismiss">
                        <IconClose size={10} />
                    </button>
                </div>
            ))}
        </div>
    );
}
