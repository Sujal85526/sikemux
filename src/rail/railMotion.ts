import { useLayoutEffect, useRef } from "react";
import { animate, leavingRef } from "../lib/motion";
import { holdStageMotion } from "../state/nativeViews";

/*
 * A rail opens and closes like a drawer. It keeps its own width the whole time,
 * so nothing inside it rewraps; a negative margin on its stage side hands the
 * stage the room it is giving up, frame by frame, and a clip hides the part of
 * the rail the stage has moved over. The stage resizes on every frame, the way
 * it does while a rail is dragged wider.
 */

export const RAIL_MOTION_MS = 400;
const EASE = "cubic-bezier(0.25, 1, 0.5, 1)";

const isStart = (rail: HTMLElement) => rail.classList.contains("side-rail");

/** How far the rail must tuck under the stage to give back all of its room, gap included. */
function fullTuck(rail: HTMLElement): number {
    const gap = rail.parentElement ? parseFloat(getComputedStyle(rail.parentElement).columnGap) || 0 : 0;
    return rail.getBoundingClientRect().width + gap;
}

/** How far the rail is tucked under the stage right now, part way through a move or not. */
function currentTuck(rail: HTMLElement): number {
    const style = getComputedStyle(rail);
    return -(parseFloat(isStart(rail) ? style.marginRight : style.marginLeft) || 0);
}

function tucked(rail: HTMLElement, by: number, opacity: number): Keyframe {
    return isStart(rail)
        ? { marginRight: `${-by}px`, clipPath: `inset(0 ${by}px 0 0)`, opacity }
        : { marginLeft: `${-by}px`, clipPath: `inset(0 0 0 ${by}px)`, opacity };
}

/* A move turned around part way runs for the share of the distance left.
   An opening rail drops its frames when it lands, so no clip is left cutting off what pokes out of it. */
function move(rail: HTMLElement, from: number, to: number, full: number, fromOpacity: number): Animation | null {
    for (const running of rail.getAnimations()) running.cancel();
    const share = full > 0 ? Math.abs(to - from) / full : 1;
    const run = animate(rail, [tucked(rail, from, fromOpacity), tucked(rail, to, to === 0 ? 1 : 0)], {
        duration: Math.max(120, RAIL_MOTION_MS * Math.min(1, share)),
        easing: EASE,
        fill: to === 0 ? "none" : "forwards",
    });
    if (!run) return null;
    const release = holdStageMotion();
    void run.finished.catch(() => {}).finally(release);
    return run;
}

const leavingFrom = new WeakMap<HTMLElement, { tuck: number; opacity: number }>();

/** On a rail docked in the shell: closing tucks it back under the stage while the stage takes its room. */
export const leavingRail = leavingRef<HTMLElement>(
    (rail) => {
        /* Whatever followed it, such as its resize handle, may have gone with it, and the rail must stay on its own side of the stage. */
        if (isStart(rail)) rail.parentElement?.prepend(rail);
        else rail.parentElement?.append(rail);
        const from = leavingFrom.get(rail) ?? { tuck: 0, opacity: 1 };
        const full = fullTuck(rail);
        return move(rail, from.tuck, full, full, from.opacity);
    },
    {
        onRemove: (rail) => {
            // Only the docked rail: the hover peek's copy has its own way out.
            if (!rail.parentElement?.classList.contains("body")) return false;
            leavingFrom.set(rail, { tuck: currentTuck(rail), opacity: Number(getComputedStyle(rail).opacity) });
        },
    },
);

/** Opens a rail out from under the stage, but not when the window first draws it. */
export function useRailEntrance(visible: boolean, selector: string): void {
    const was = useRef(visible);
    useLayoutEffect(() => {
        const opened = visible && !was.current;
        was.current = visible;
        if (!opened) return;
        const rail = document.querySelector<HTMLElement>(`.shell > .body > ${selector}:not(.is-leaving)`);
        if (!rail) return;
        const full = fullTuck(rail);
        /* Reopened while still closing: take over from where the closing one has got to. */
        const leaving = document.querySelector<HTMLElement>(`.shell > .body > ${selector}.is-leaving`);
        if (!leaving) {
            move(rail, full, 0, full, 0);
            return;
        }
        const from = currentTuck(leaving);
        const opacity = Number(getComputedStyle(leaving).opacity);
        leaving.remove();
        move(rail, from, 0, full, opacity);
    }, [visible, selector]);
}
