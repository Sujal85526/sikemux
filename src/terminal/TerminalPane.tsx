import { useRef } from "react";
import "@xterm/xterm/css/xterm.css";
import { usePty } from "./usePty";
import { useXterm } from "./useXterm";

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
    const shouldMount = visible;
    const hostRef = useRef<HTMLDivElement>(null);
    const ptyReady = usePty({ cwd, startup, hostRef, spawnWhen });
    useXterm({ hostRef, ptyReady, shouldMount, active });

    return <div ref={hostRef} className="terminal-host" />;
}
