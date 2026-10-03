import { useEffect } from "react";
import { IS_MACOS } from "../lib/platform";
import { useStore } from "../state/store";
import { swallow } from "../state/toast";
import { notchApi } from "./notchSettings";

/** Starts the notch helper with the Notch settings, and passes it every change to them. */
export function NotchBridge() {
    const settings = useStore((s) => s.notch);
    useEffect(() => {
        if (!IS_MACOS) return;
        notchApi.configure(settings).catch(swallow("start the notch"));
    }, [settings]);
    return null;
}
