import type { ReactNode } from "react";

/** Text inside these is a painted copy, not something the reader sees twice. */
export const SHIMMER_COPY = ".chat-shimmer-band";

/*
 * The sweep across a live label, for a host with the `chat-shimmer` class. A
 * dim and a bright copy of the text sit behind opposite masks that slide on
 * the compositor, so a running agent repaints nothing per frame. The host's
 * own text only holds the layout and the selection.
 */
export function Shimmer({ children }: { children: ReactNode }) {
    return (
        <>
            {children}
            <span className="chat-shimmer-band dim" aria-hidden="true" inert>
                <span className="chat-shimmer-copy">{children}</span>
            </span>
            <span className="chat-shimmer-band lit" aria-hidden="true" inert>
                <span className="chat-shimmer-copy">{children}</span>
            </span>
        </>
    );
}
