import { useCallback, useLayoutEffect, useRef, useState, type RefObject, type UIEvent } from "react";

// How far above the last line still counts as reading the latest message.
export const BOTTOM_SLACK = 72;

export function useStickToBottom({
    scrollRef,
    contentRef,
    rowsRef,
    visible,
    messageCount,
    revision,
}: {
    scrollRef: RefObject<HTMLDivElement | null>;
    contentRef: RefObject<HTMLDivElement | null>;
    rowsRef: RefObject<HTMLDivElement | null>;
    visible: boolean;
    messageCount: number;
    revision: number;
}) {
    const [atBottom, setAtBottom] = useState(true);
    const stickToBottomRef = useRef(true);
    const lastScrollTopRef = useRef(0);
    const lastGestureRef = useRef(0);

    /* The scroller's own bottom, not the last message's — a permission card or
       an error sits below the list and still has to be reachable. Idempotent,
       so the observer below can call it until the heights stop moving. */
    const pinToBottom = useCallback(() => {
        const element = scrollRef.current;
        if (!element) return;
        const target = element.scrollHeight - element.clientHeight;
        if (Math.abs(element.scrollTop - target) < 1) return;
        element.scrollTop = target;
        lastScrollTopRef.current = element.scrollTop;
    }, [scrollRef]);

    const noteGesture = useCallback(() => {
        lastGestureRef.current = performance.now();
    }, []);

    /*
     * A restored session opens on estimated row heights, and each row that
     * measures taller moves the bottom again, as does markdown or highlighting
     * that arrives late. The rows report that through the list itself; the
     * rest of the transcript, like the activity line and permission cards, is
     * watched here. Watching the whole content would watch a box around the
     * rows, which the browser can only report a frame late.
     */
    const rowsHeightRef = useRef<number | null>(null);
    const followRows = useCallback(
        (rows: { getTotalSize(): number }) => {
            const height = rows.getTotalSize();
            if (height === rowsHeightRef.current) return;
            rowsHeightRef.current = height;
            if (stickToBottomRef.current) pinToBottom();
        },
        [pinToBottom],
    );

    useLayoutEffect(() => {
        const content = contentRef.current;
        if (!content || typeof ResizeObserver === "undefined") return;
        const resized = new ResizeObserver(() => {
            if (stickToBottomRef.current) pinToBottom();
        });
        const watch = () => {
            resized.disconnect();
            for (const child of content.children) if (child !== rowsRef.current) resized.observe(child);
        };
        watch();
        const added = new MutationObserver(watch);
        added.observe(content, { childList: true });
        return () => {
            added.disconnect();
            resized.disconnect();
        };
    }, [contentRef, rowsRef, pinToBottom]);

    useLayoutEffect(() => {
        if (!visible || !stickToBottomRef.current || messageCount === 0) return;
        pinToBottom();
    }, [messageCount, revision, pinToBottom, visible]);

    const onScroll = (event: UIEvent<HTMLDivElement>) => {
        const element = event.currentTarget;
        const previous = lastScrollTopRef.current;
        lastScrollTopRef.current = element.scrollTop;
        const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
        // The transcript also scrolls itself, to hold the bottom
        // still while rows settle into their real heights. Only a
        // scroll up that a wheel, key or drag just asked for means
        // the reader walked away; sitting at the bottom means stuck.
        const gesture = lastGestureRef.current;
        lastGestureRef.current = 0;
        const walkedAway = element.scrollTop < previous - 1 && performance.now() - gesture < 150;
        const next = walkedAway ? false : distance < BOTTOM_SLACK ? true : stickToBottomRef.current;
        if (next === stickToBottomRef.current) return;
        stickToBottomRef.current = next;
        setAtBottom(next);
    };

    const jumpToBottom = () => {
        stickToBottomRef.current = true;
        setAtBottom(true);
        pinToBottom();
    };

    /** Stops holding the bottom, for a scroll this pane makes itself up into the transcript. */
    const leaveBottom = () => {
        stickToBottomRef.current = false;
        setAtBottom(false);
    };

    return { atBottom, noteGesture, onScroll, jumpToBottom, leaveBottom, followRows };
}
