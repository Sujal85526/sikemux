import { cloneElement, useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Themed tooltip.
 *
 * Native `title=""` waits ~1s, renders in the OS font on an OS surface, and
 * never appears for keyboard users. This shows on hover *and* focus, matches
 * the chrome, and portals to <body> so pane overflow can't clip it.
 */

const OPEN_DELAY_MS = 380;
const GAP = 8;

type Side = "top" | "bottom" | "left" | "right";

interface Placement {
    left: number;
    top: number;
    side: Side;
}

/**
 * Wraps a single interactive child. The child keeps its own props; the tooltip
 * only attaches listeners and an `aria-label` when it has no accessible name.
 */
export function Tooltip({
    label,
    side = "bottom",
    children,
    disabled = false,
}: {
    /** Tooltip text. Falsy label renders the child untouched. */
    label: ReactNode;
    side?: Side;
    children: ReactElement;
    disabled?: boolean;
}) {
    const [placement, setPlacement] = useState<Placement | null>(null);
    const anchorRef = useRef<HTMLElement | null>(null);
    const timerRef = useRef<number | undefined>(undefined);

    const hide = useCallback(() => {
        window.clearTimeout(timerRef.current);
        setPlacement(null);
    }, []);

    const show = useCallback(
        (immediate: boolean) => {
            window.clearTimeout(timerRef.current);
            const open = () => {
                const anchor = anchorRef.current;
                if (!anchor) return;
                setPlacement(resolvePlacement(anchor.getBoundingClientRect(), side));
            };
            if (immediate) open();
            else timerRef.current = window.setTimeout(open, OPEN_DELAY_MS);
        },
        [side],
    );

    useEffect(() => () => window.clearTimeout(timerRef.current), []);

    // Any scroll or resize invalidates the measured rect — cheaper to dismiss
    // than to track the anchor across virtualised lists.
    useEffect(() => {
        if (!placement) return;
        window.addEventListener("scroll", hide, true);
        window.addEventListener("resize", hide);
        return () => {
            window.removeEventListener("scroll", hide, true);
            window.removeEventListener("resize", hide);
        };
    }, [placement, hide]);

    if (disabled || !label) return children;

    // React 19 types element props as `unknown`; the child is always a DOM
    // element here, so read its handlers through a narrow event-handler map.
    const childProps = children.props as Record<string, ((event: unknown) => void) | undefined>;
    const child = cloneElement(children, {
        ref: (node: HTMLElement | null) => {
            anchorRef.current = node;
            assignRef((children as { ref?: unknown }).ref, node);
        },
        onMouseEnter: chain(childProps.onMouseEnter, () => show(false)),
        onMouseLeave: chain(childProps.onMouseLeave, hide),
        onFocus: chain(childProps.onFocus, () => show(true)),
        onBlur: chain(childProps.onBlur, hide),
        onPointerDown: chain(childProps.onPointerDown, hide),
    } as Record<string, unknown>);

    return (
        <>
            {child}
            {placement &&
                createPortal(
                    <div className={`tip tip-${placement.side}`} role="tooltip" style={{ left: placement.left, top: placement.top }}>
                        {label}
                    </div>,
                    document.body,
                )}
        </>
    );
}

function chain<E>(existing: ((event: E) => void) | undefined, added: (event: E) => void) {
    return (event: E) => {
        existing?.(event);
        added(event);
    };
}

function assignRef(ref: unknown, node: HTMLElement | null): void {
    if (typeof ref === "function") ref(node);
    else if (ref && typeof ref === "object") (ref as { current: HTMLElement | null }).current = node;
}

/**
 * Anchors the tooltip on the requested side, flipping to the opposite side when
 * it would leave the viewport, then clamps along the cross axis.
 */
function resolvePlacement(rect: DOMRect, preferred: Side): Placement {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const room: Record<Side, number> = { top: rect.top, bottom: vh - rect.bottom, left: rect.left, right: vw - rect.right };
    const opposite: Record<Side, Side> = { top: "bottom", bottom: "top", left: "right", right: "left" };
    // 34px covers a single-line tip plus its padding and the gap.
    const side = room[preferred] < 34 && room[opposite[preferred]] > room[preferred] ? opposite[preferred] : preferred;

    if (side === "top" || side === "bottom") {
        return {
            side,
            left: clamp(rect.left + rect.width / 2, 8, vw - 8),
            top: side === "top" ? rect.top - GAP : rect.bottom + GAP,
        };
    }
    return {
        side,
        left: side === "left" ? rect.left - GAP : rect.right + GAP,
        top: clamp(rect.top + rect.height / 2, 8, vh - 8),
    };
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}
