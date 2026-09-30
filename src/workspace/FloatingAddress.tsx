import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { setNativeViewHoles } from "../state/nativeViews";
import { AddressBar } from "./AddressBar";

interface Place {
    left: number;
    top: number;
    width: number;
}

const MAX_WIDTH = 680;

/**
 * The address opened from the keyboard: a field and its suggestions floating
 * over the upper middle of the page, rather than hanging from the toolbar.
 */
export function FloatingAddress({
    over,
    tabId,
    pageAddress,
    onGo,
    onClose,
}: {
    /** The page area the panel sits over. */
    over: RefObject<HTMLElement | null>;
    tabId: string | undefined;
    pageAddress: string;
    onGo: (url: string) => void;
    onClose: () => void;
}) {
    const panelRef = useRef<HTMLDivElement>(null);
    const [place, setPlace] = useState<Place | null>(null);

    useLayoutEffect(() => {
        const area = over.current;
        if (!area) return;
        const measure = () => {
            const rect = area.getBoundingClientRect();
            const width = Math.min(MAX_WIDTH, rect.width - 32);
            setPlace({ left: rect.left + (rect.width - width) / 2, top: rect.top + rect.height * 0.18, width });
        };
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(area);
        window.addEventListener("resize", measure);
        return () => {
            observer.disconnect();
            window.removeEventListener("resize", measure);
        };
    }, [over]);

    /* The page is a native view that paints over the app, so it gives up the
       panel's box, and again each time the list under the field grows or shrinks. */
    useLayoutEffect(() => {
        const panel = panelRef.current;
        if (!panel || !place) return;
        const cut = () => {
            const radius = parseFloat(getComputedStyle(panel).borderTopLeftRadius) || 0;
            setNativeViewHoles(panelRef, [{ x: place.left, y: place.top, width: panel.offsetWidth, height: panel.offsetHeight, radius }]);
        };
        cut();
        const observer = new ResizeObserver(cut);
        observer.observe(panel);
        return () => observer.disconnect();
    }, [place]);
    useEffect(() => () => setNativeViewHoles(panelRef, []), []);

    return createPortal(
        <div
            ref={panelRef}
            className="address-float"
            role="dialog"
            aria-label="Open address"
            style={place ? { left: place.left, top: place.top, width: place.width } : { visibility: "hidden" }}>
            <AddressBar floating tabId={tabId} pageAddress={pageAddress} onGo={onGo} onLeave={onClose} />
        </div>,
        document.body,
    );
}
