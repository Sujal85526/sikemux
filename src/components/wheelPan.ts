/**
 * A trackpad sends no gesture-end event, so this much quiet counts as the end of
 * one. Only a swipe too small to land waits for it, and three missed frames is
 * long enough to ride out a stutter without the wait being felt.
 */
export const GESTURE_END_MS = 60;
/** How many of the last wheel events the flick estimate looks at. */
export const VELOCITY_SAMPLES = 5;
/** Below this the gesture is diagonal enough to belong to whatever is under it. */
const HORIZONTAL_RATIO = 1.5;
/** How far a gesture can pull past the first or last screen of the session. */
const OVERSCROLL = 0.15;
/** How much of the pull gets through before the resistance takes over. */
const GIVE = 0.55;
/** How far a gesture has to pull before it lands on the screen next door. */
const COMMIT = 0.3;
/** Screens per millisecond that counts as a flick however short the drag was. */
const FLICK = 0.0009;
/** How far a flick still has to have moved the track, so one stray fast event is not one. */
const FLICK_TRAVEL = 0.06;

/** One element between the wheel event's target and the screen it happened on. */
export interface PaneScroller {
    readonly overflowX: string;
    readonly scrollWidth: number;
    readonly clientWidth: number;
    readonly scrollLeft: number;
}

/** Whether the session has another screen on either side of the one a gesture started on. */
export interface PanEnds {
    readonly hasPrevious: boolean;
    readonly hasNext: boolean;
}

export type SnapStep = -1 | 0 | 1;

/** One wheel event's contribution, in screens and milliseconds. */
export interface WheelSample {
    readonly delta: number;
    readonly at: number;
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
 * from the one it started on. A gesture never uncovers more than the screen
 * next door, and past the first or last screen there is nothing to uncover.
 */
export function dragOffset(raw: number, ends: PanEnds): number {
    if (raw > 0) return ends.hasNext ? Math.min(raw, 1) : resisted(raw);
    if (raw < 0) return ends.hasPrevious ? Math.max(raw, -1) : -resisted(-raw);
    return 0;
}

/** Screens per millisecond over the last few events, which is what tells a flick from a drag. */
export function wheelVelocity(samples: readonly WheelSample[]): number {
    const recent = samples.slice(-VELOCITY_SAMPLES);
    const first = recent[0];
    const last = recent.at(-1);
    if (!first || !last || last.at <= first.at) return 0;
    const moved = recent.slice(1).reduce((sum, sample) => sum + sample.delta, 0);
    return moved / (last.at - first.at);
}

const towards = (n: number): SnapStep => (n > 0 ? 1 : n < 0 ? -1 : 0);

/**
 * Which screen the gesture lands on, counted from the one it started on. Asked
 * on every event of a gesture rather than once at the end, so the answer is the
 * moment the swipe showed what it wanted. Never more than one screen away, so a
 * single flick cannot skip one.
 */
export function snapTarget(offset: number, velocity: number, ends: PanEnds): SnapStep {
    const drag = towards(offset);
    if (drag === 0) return 0;
    const flick = Math.abs(velocity) >= FLICK && Math.abs(offset) >= FLICK_TRAVEL ? towards(velocity) : 0;
    // A flick back the way it came puts the screen it started on back, however far it got.
    if (flick !== 0 && flick !== drag) return 0;
    if (flick === 0 && Math.abs(offset) < COMMIT) return 0;
    if (drag > 0) return ends.hasNext ? 1 : 0;
    return ends.hasPrevious ? -1 : 0;
}
