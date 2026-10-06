import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { createPortal } from "react-dom";
import { deskAppearing } from "../state/deskMotion";
import { onStageFrame, useStageMoving } from "../state/nativeViews";
import { AddressBar } from "./AddressBar";

const MAX_WIDTH = 680;
const MARGIN = 16;

/**
 * The address opened from the keyboard: a field and its suggestions floating
 * over the middle of the page, rather than hanging from the toolbar.
 */
export function FloatingAddress({
    over,
    paneId,
    tabId,
    pageAddress,
    onGo,
    onClose,
}: {
    /** The page area the panel sits over. */
    over: RefObject<HTMLElement | null>;
    /** The desk pane the page is on, which the panel travels and fades with. */
    paneId: string;
    tabId: string | undefined;
    pageAddress: string;
    onGo: (url: string) => void;
    onClose: () => void;
}) {
    const panelRef = useRef<HTMLDivElement>(null);
    const placeRef = useRef(() => {});
    const moving = useStageMoving();

    /* Placed straight from a measurement, like the page under it: while the desk
       slides open the page moves without changing size, so nothing else would
       tell the panel to follow. The field sits a little above the middle of the
       page and the list grows down from it, rising only as far as a long list
       needs to stay on the page. */
    useLayoutEffect(() => {
        const page = over.current;
        const panel = panelRef.current;
        if (!page || !panel) return;
        let frame = 0;
        const place = () => {
            frame = 0;
            const area = page.getBoundingClientRect();
            const width = Math.min(MAX_WIDTH, area.width - 2 * MARGIN);
            const top = Math.max(area.top + MARGIN, Math.min(area.top + area.height * 0.36, area.bottom - panel.offsetHeight - MARGIN));
            const pane = page.closest<HTMLElement>(".pane");
            panel.style.left = `${area.left + (area.width - width) / 2}px`;
            panel.style.top = `${top}px`;
            panel.style.width = `${width}px`;
            panel.style.opacity = deskAppearing(paneId) ? "0" : pane ? getComputedStyle(pane).opacity : "";
        };
        const schedule = () => {
            if (!frame) frame = requestAnimationFrame(place);
        };
        placeRef.current = place;
        place();
        const observer = new ResizeObserver(schedule);
        observer.observe(page);
        observer.observe(panel);
        window.addEventListener("resize", schedule);
        return () => {
            observer.disconnect();
            if (frame) cancelAnimationFrame(frame);
            window.removeEventListener("resize", schedule);
        };
    }, [over, paneId]);

    useEffect(() => {
        placeRef.current();
        if (!moving) return;
        return onStageFrame(() => placeRef.current());
    }, [moving]);

    return createPortal(
        <div ref={panelRef} className="address-float" role="dialog" aria-label="Open address">
            <AddressBar floating tabId={tabId} pageAddress={pageAddress} onGo={onGo} onLeave={onClose} />
        </div>,
        document.body,
    );
}
