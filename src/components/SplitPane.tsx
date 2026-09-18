import { useRef, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";

const STEP = 0.02;

/**
 * Two panes and a handle between them.
 *
 * The caller owns the ratio, so whoever uses this decides where it is kept and
 * whether it survives a restart. `end` being absent is what closes the split —
 * the first pane then has the whole box and no handle is drawn.
 */
export function SplitPane({
    ratio,
    onRatio,
    end,
    children,
    orientation = "row",
    min = 320,
    label = "Resize panes",
    className,
}: {
    /** How much of the box the first pane takes, 0 to 1. */
    ratio: number;
    onRatio: (next: number) => void;
    /** The second pane. Without it there is no split. */
    end?: ReactNode;
    children: ReactNode;
    orientation?: "row" | "column";
    /** The smallest either pane may be squeezed to, in pixels. */
    min?: number;
    label?: string;
    className?: string;
}) {
    const hostRef = useRef<HTMLDivElement>(null);
    const across = orientation === "row";

    /* The floor is a share of the box, not a pixel count, because that is what
       the ratio is in — and in a box narrower than two minimums it would
       otherwise pin both ends past each other. */
    const clamp = (next: number) => {
        const box = hostRef.current?.getBoundingClientRect();
        const span = Math.max((across ? box?.width : box?.height) ?? 0, 1);
        const floor = Math.min(0.42, min / span);
        return Math.min(1 - floor, Math.max(floor, next));
    };

    const startResize = (event: PointerEvent<HTMLDivElement>) => {
        const host = hostRef.current;
        if (!host) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        const box = host.getBoundingClientRect();
        const move = (next: globalThis.PointerEvent) => {
            const travelled = across ? (next.clientX - box.left) / box.width : (next.clientY - box.top) / box.height;
            onRatio(clamp(travelled));
        };
        const stop = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", stop);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", stop, { once: true });
    };

    /* A handle nobody can reach from the keyboard is not a control. */
    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        const back = across ? "ArrowLeft" : "ArrowUp";
        const forward = across ? "ArrowRight" : "ArrowDown";
        if (event.key !== back && event.key !== forward) return;
        event.preventDefault();
        onRatio(clamp(ratio + (event.key === forward ? STEP : -STEP)));
    };

    return (
        <div
            ref={hostRef}
            className={`split split-${orientation}${end ? " split-open" : ""}${className ? ` ${className}` : ""}`}
            style={{ "--split-ratio": ratio } as CSSProperties}>
            <div className="split-pane">{children}</div>
            {end && (
                <>
                    <div
                        className="split-divider"
                        role="separator"
                        tabIndex={0}
                        aria-label={label}
                        aria-orientation={across ? "vertical" : "horizontal"}
                        aria-valuenow={Math.round(ratio * 100)}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        onPointerDown={startResize}
                        onKeyDown={onKeyDown}
                    />
                    <div className="split-pane">{end}</div>
                </>
            )}
        </div>
    );
}
