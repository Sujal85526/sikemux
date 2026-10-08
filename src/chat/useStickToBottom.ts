import { useCallback, useLayoutEffect, useRef, useState, type RefObject, type UIEvent } from "react";

// How far above the last line still counts as reading the latest message.
export const BOTTOM_SLACK = 72;
const SETTLE_FRAMES = 24;
const SETTLE_MS = 400;

export function useStickToBottom({
    scrollRef,
    contentRef,
    rowsRef,
    visible,
    settling,
    onSettled,
    messageCount,
    revision,
}: {
    scrollRef: RefObject<HTMLDivElement | null>;
    contentRef: RefObject<HTMLDivElement | null>;
    rowsRef: RefObject<HTMLDivElement | null>;
    visible: boolean;
    settling: boolean;
    onSettled: () => void;
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

    /* Held out of sight, the transcript is pinned every frame until its height
       has held still for two, which is when its last rows have measured. */
    useLayoutEffect(() => {
        if (!settling) return;
        stickToBottomRef.current = true;
        setAtBottom(true);
        pinToBottom();
        let frame = 0;
        let frames = 0;
        let still = 0;
        let height = -1;
        const finish = () => {
            window.cancelAnimationFrame(frame);
            window.clearTimeout(timer);
            onSettled();
        };
        const step = () => {
            pinToBottom();
            const next = scrollRef.current?.scrollHeight ?? 0;
            still = next === height ? still + 1 : 0;
            height = next;
            frames += 1;
            if (still >= 2 || frames >= SETTLE_FRAMES) finish();
            else frame = window.requestAnimationFrame(step);
        };
        frame = window.requestAnimationFrame(step);
        // WebKit stops animation frames in a window behind another app.
        const timer = window.setTimeout(finish, SETTLE_MS);
        return () => {
            window.cancelAnimationFrame(frame);
            window.clearTimeout(timer);
        };
    }, [settling, onSettled, pinToBottom, scrollRef]);

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
