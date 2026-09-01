import { useEffect, useRef, useState, type ReactNode } from "react";

type PeekSide = "left" | "right";
type PeekPhase = "closed" | "open" | "closing";

interface SidebarPeekProps {
    side: PeekSide;
    children: ReactNode;
}

const CLOSE_DURATION_MS = 180;

export function SidebarPeek({ side, children }: SidebarPeekProps) {
    const [phase, setPhase] = useState<PeekPhase>("closed");
    const closeTimer = useRef<number | null>(null);

    const clearCloseTimer = () => {
        if (closeTimer.current === null) return;
        window.clearTimeout(closeTimer.current);
        closeTimer.current = null;
    };

    const open = () => {
        clearCloseTimer();
        setPhase("open");
    };

    const close = () => {
        clearCloseTimer();
        setPhase("closing");
        closeTimer.current = window.setTimeout(() => {
            closeTimer.current = null;
            setPhase("closed");
        }, CLOSE_DURATION_MS);
    };

    useEffect(
        () => () => {
            clearCloseTimer();
        },
        [],
    );

    return (
        <div
            className={`sidebar-peek sidebar-peek--${side}`}
            data-testid={`sidebar-peek-${side}`}
            onPointerEnter={open}
            onPointerLeave={close}
            onFocusCapture={open}
            onBlurCapture={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) close();
            }}>
            <div className="sidebar-peek-sensor" aria-hidden="true" />
            {phase !== "closed" && (
                <div
                    className={`sidebar-peek-panel sidebar-peek-panel--${phase}`}
                    aria-hidden={phase === "closing"}
                    onAnimationEnd={() => {
                        if (phase === "closing") {
                            clearCloseTimer();
                            setPhase("closed");
                        }
                    }}>
                    {children}
                </div>
            )}
        </div>
    );
}
