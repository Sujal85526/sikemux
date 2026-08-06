import { useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import { usePty } from "./usePty";
import { useXterm } from "./useXterm";

const SWITCH_KEEPALIVE_MS = 30_000;
const MAX_HIDDEN_RENDERERS = 4;
const hiddenRendererEvictions = new Map<symbol, () => void>();

function enforceHiddenRendererBudget() {
    while (hiddenRendererEvictions.size > MAX_HIDDEN_RENDERERS) {
        const oldest = hiddenRendererEvictions.values().next().value as (() => void) | undefined;
        if (!oldest) return;
        oldest();
    }
}

export function TerminalPane({
    cwd,
    startup,
    active,
    visible = active,
    spawnWhen = visible,
    activityKey,
}: {
    cwd?: string;
    startup?: string;
    active: boolean;
    visible?: boolean;
    spawnWhen?: boolean;
    activityKey?: string;
}) {
    const [shouldMount, setShouldMount] = useState(visible);
    const hostRef = useRef<HTMLDivElement>(null);
    const rendererTokenRef = useRef(Symbol("terminal-renderer"));
    const ptyReady = usePty({ cwd, startup, hostRef, spawnWhen, activityKey });

    useEffect(() => {
        const token = rendererTokenRef.current;
        const evict = () => {
            hiddenRendererEvictions.delete(token);
            setShouldMount(false);
        };
        if (visible) {
            hiddenRendererEvictions.delete(token);
            setShouldMount(true);
            return;
        }
        if (!shouldMount) return;
        hiddenRendererEvictions.delete(token);
        hiddenRendererEvictions.set(token, evict);
        enforceHiddenRendererBudget();
        const id = window.setTimeout(evict, SWITCH_KEEPALIVE_MS);
        return () => {
            window.clearTimeout(id);
            hiddenRendererEvictions.delete(token);
        };
    }, [visible, shouldMount]);

    useXterm({ hostRef, ptyReady, shouldMount, active, visible });

    return <div ref={hostRef} className="terminal-host" />;
}
