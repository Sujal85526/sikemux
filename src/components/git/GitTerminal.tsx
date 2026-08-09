import { useCallback, useEffect, useRef, useState } from "react";
import { TerminalPane } from "../../terminal/TerminalPane";
import { IconRefresh } from "../Icons";
import type { PtyContext } from "../../state/types";
import { basename } from "../../lib/paths";

/** A shell that dies faster than this counts as a failure, not a user `exit`. */
const RAPID_EXIT_MS = 1200;
/** Consecutive rapid exits before we stop respawning and wait for the user. */
const RAPID_EXIT_LIMIT = 3;

/**
 * The Git pane always shows exactly one live shell. Typing `exit` ends that
 * shell and immediately gets a fresh one in the same slot — the pane is never
 * left holding a dead terminal. A shell that dies instantly over and over (bad
 * login script, unreadable cwd) stops the loop and offers a manual restart
 * instead of respawning forever.
 */
export function GitTerminal({ repo, visible, context }: { repo: string; visible: boolean; context?: PtyContext }) {
    const [generation, setGeneration] = useState(0);
    const [stalled, setStalled] = useState(false);
    const startedAtRef = useRef(Date.now());
    const strikesRef = useRef(0);

    useEffect(() => {
        startedAtRef.current = Date.now();
    }, [generation]);

    const onExit = useCallback(() => {
        strikesRef.current = Date.now() - startedAtRef.current < RAPID_EXIT_MS ? strikesRef.current + 1 : 0;
        if (strikesRef.current >= RAPID_EXIT_LIMIT) {
            setStalled(true);
            return;
        }
        setGeneration((n) => n + 1);
    }, []);

    const restart = useCallback(() => {
        strikesRef.current = 0;
        startedAtRef.current = Date.now();
        setStalled(false);
        setGeneration((n) => n + 1);
    }, []);

    return (
        <div className="git-term">
            <div className="git-term-head">
                <span className="git-term-label">terminal</span>
                {repo && <span className="git-term-cwd">{basename(repo) || repo}</span>}
                <span className="git-term-grow" />
                <button type="button" className="git-term-restart" onClick={restart} title="Restart this shell">
                    <IconRefresh size={12} />
                </button>
            </div>
            <div className="git-term-body">
                {stalled ? (
                    <div className="git-term-stalled">
                        <span>the shell exited immediately {RAPID_EXIT_LIMIT} times in a row</span>
                        <button type="button" onClick={restart}>
                            start a new shell
                        </button>
                    </div>
                ) : (
                    <TerminalPane
                        key={generation}
                        cwd={repo || undefined}
                        active={false}
                        visible={visible}
                        spawnWhen={visible}
                        context={context}
                        onExit={onExit}
                    />
                )}
            </div>
        </div>
    );
}
