import { useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import { usePty } from "./usePty";
import { useXterm } from "./useXterm";

const SWITCH_KEEPALIVE_MS = 120_000;

export function TerminalPane({
    cwd,
    startup,
    active,
    visible = active,
    spawnWhen = visible,
}: {
    cwd?: string;
    startup?: string;
    active: boolean;
    visible?: boolean;
    spawnWhen?: boolean;
}) {
    const [shouldMount, setShouldMount] = useState(visible);
    const hostRef = useRef<HTMLDivElement>(null);
    const ptyReady = usePty({ cwd, startup, hostRef, spawnWhen });

    useEffect(() => {
        if (visible) {
            setShouldMount(true);
            return;
        }
        const id = window.setTimeout(() => setShouldMount(false), SWITCH_KEEPALIVE_MS);
        return () => window.clearTimeout(id);
    }, [visible]);

    useXterm({ hostRef, ptyReady, shouldMount, active, visible });

    return <div ref={hostRef} className="terminal-host" />;
}
