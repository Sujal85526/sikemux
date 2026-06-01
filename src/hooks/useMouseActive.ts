import { useEffect, useRef } from "react";

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
