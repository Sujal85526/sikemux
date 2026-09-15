/**
 * A trackpad says nothing when the fingers stop and nothing when they leave, so
 * this much quiet is the only sign a gesture is over. It has to outlast holding
 * still mid-swipe, which is a pause a person measures in tenths of a second —
 * anything shorter closes the swipe under fingers that are still on the glass.
 */
export const GESTURE_END_MS = 320;
/** Below this the gesture is diagonal enough to belong to whatever is under it. */
const HORIZONTAL_RATIO = 1.5;
/** How far a gesture can pull past the first or last screen of the session. */
const OVERSCROLL = 0.15;
/** How much of the pull gets through before the resistance takes over. */
const GIVE = 0.55;
/**
 * How far the track has to slide off a screen before the one arriving is the one
 * you are on. Half a screen, because the screen it leaves behind is then half a
 * screen the other way, and anything closer would hand the session back and
 * forth across a single threshold.
 */
const HANDOVER = 0.5;

/** One element between the wheel event's target and the screen it happened on. */
export interface PaneScroller {
    readonly overflowX: string;
    readonly scrollWidth: number;
    readonly clientWidth: number;
    readonly scrollLeft: number;
}

/** Whether the session has another screen on either side of the one a gesture is on. */
export interface PanEnds {
    readonly hasPrevious: boolean;
    readonly hasNext: boolean;
}

/** Where a pull has put the track, in screens along it. */
export interface Panned {
    /** The screen the pull has moved onto, which the rest of it counts from. */
    readonly slot: number;
    /** What is left of the pull once that screen has been taken off it. */
    readonly raw: number;
    /** How far past that screen the finger is, after the ends of the session resist it. */
    readonly offset: number;
}

const scrollsSideways = (node: PaneScroller) => (node.overflowX === "auto" || node.overflowX === "scroll") && node.scrollWidth > node.clientWidth;

function atEdge(node: PaneScroller, deltaX: number): boolean {
    if (deltaX > 0) return node.scrollLeft >= node.scrollWidth - node.clientWidth - 1;
    return node.scrollLeft <= 0;
}

/**
 * Whether the stage takes this gesture. Decided on a gesture's first event and
 * kept until it ends: anything under the pointer that can still scroll sideways
 * keeps the whole gesture, so a pane that reaches its edge halfway through does
 * not hand the rest of the swipe to the stage.
 */
export function claimsWheel(chain: readonly PaneScroller[], deltaX: number, deltaY: number): boolean {
    if (chain.some((node) => scrollsSideways(node) && !atEdge(node, deltaX))) return false;
    return Math.abs(deltaX) > HORIZONTAL_RATIO * Math.abs(deltaY);
}

/**
 * Gives a little and then less and less, so the ends of a session feel like ends
 * rather than like something broken. Spread over about a screen of pull: give it
 * all away in the first fraction and the rest of the pull moves nothing at all.
 */
const resisted = (past: number) => (OVERSCROLL * GIVE * past) / (GIVE * past + OVERSCROLL);

/**
 * Where the track sits after a gesture has dragged `raw` screens, in screens
 * from the one it is on. The finger is followed one for one, except past the
 * first or last screen, where there is nothing to uncover.
 */
export function dragOffset(raw: number, ends: PanEnds): number {
    if (raw > 0 && !ends.hasNext) return resisted(raw);
    if (raw < 0 && !ends.hasPrevious) return -resisted(-raw);
    return raw;
}

/**
 * Where a pull of `raw` screens from `slot` puts the track. A screen pulled more
 * than halfway on is the screen the track is now counted from, and a screen
 * comes off the pull so the finger carries straight on into the next one. Done
 * over and over, so one long pull runs through as many screens as it reaches.
 */
export function panned(raw: number, slot: number, screens: number): Panned {
    for (;;) {
        const ends = { hasPrevious: slot > 0, hasNext: slot < screens - 1 };
        const offset = dragOffset(raw, ends);
        const step = offset > HANDOVER && ends.hasNext ? 1 : offset < -HANDOVER && ends.hasPrevious ? -1 : 0;
        if (step === 0) return { slot, raw, offset };
        slot += step;
        raw -= step;
    }
}
