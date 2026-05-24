import { useEffect, useRef } from "react";

// When a list-picker re-orders or filters under a stationary mouse, the DOM
// node beneath the cursor changes — and the browser fires `mouseenter` on
// the new node, even though the user never moved. If the picker uses
// `onMouseEnter` to drive selection, that synthetic enter steals selection
// from whatever the keyboard had picked (typically item 0).
//
// This hook returns a ref that is `true` only when the mouse has actually
// moved since the last keystroke. Hover handlers gate selection updates on
// it. VSCode and Telescope both use this pattern.
export function useMouseActive(): { current: boolean } {
  const ref = useRef(false);
  useEffect(() => {
    const onMove = () => {
      ref.current = true;
    };
    const onKey = () => {
      ref.current = false;
    };
    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, []);
  return ref;
}
