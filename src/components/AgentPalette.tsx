import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentInfo } from "../api/agents";
import { useMouseActive } from "../hooks/useMouseActive";
import * as cmd from "../state/commands";
import { useResource } from "../state/resources";
import { agentCatalogR } from "../state/resources.defs";
import { useStore } from "../state/store";
import type { AgentPermissionMode } from "../state/types";
import { AgentIcon, IconAgent } from "./Icons";

const NORMAL: AgentPermissionMode = "workspace-write";
const YOLO: AgentPermissionMode = "bypass";

export function AgentPalette() {
    const session = useStore((state) => state.sessions[state.activeSessionId]);
    const profiles = useStore((state) => state.providerProfiles);
    const profileSelections = useStore((state) => state.selectedProviderProfileIds);
    const defaultMode = useStore((state) => state.defaultAgentPermissionMode);
    const catalog = useResource(agentCatalogR);
    const agents = useMemo(() => catalog.data ?? [], [catalog.data]);
    const [mode, setMode] = useState<AgentPermissionMode>(defaultMode === YOLO ? YOLO : NORMAL);
    const dialogRef = useRef<HTMLDivElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const originSessionId = useRef(session?.id ?? "");
    const returnFocusRef = useRef<HTMLElement | null>(null);
    const mouseActive = useMouseActive();

    useEffect(() => {
        returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        return () => returnFocusRef.current?.focus();
    }, []);

    useEffect(() => {
        const firstAction = listRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)");
        (firstAction ?? dialogRef.current)?.focus();
    }, [agents.length, catalog.status, mode]);

    useEffect(() => {
        if (session && session.id !== originSessionId.current) cmd.closeAgentPalette();
    }, [session]);

    function launch(agent: AgentInfo) {
        if (!session || session.kind !== "project") return;
        if (mode === YOLO && !cmd.agentSupportsSkipPermissions(agent.type)) return;
        const selectedProfile = profiles.find((profile) => profile.id === profileSelections[agent.type] && profile.provider === agent.type);
        cmd.addAgent(agent.type, undefined, undefined, {
            permissionMode: mode,
            profileId: selectedProfile?.id,
            cwd: session.cwd,
            sessionId: session.id,
        });
    }

    function moveFocus(current: HTMLButtonElement, delta: number) {
        const buttons = [...current.closest(".agent-picker-list")!.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
        const index = buttons.indexOf(current);
        buttons[(index + delta + buttons.length) % buttons.length]?.focus();
    }

    function onAgentKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
        if (event.key === "ArrowDown" || event.key === "ArrowRight") {
            event.preventDefault();
            moveFocus(event.currentTarget, 1);
        } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
            event.preventDefault();
            moveFocus(event.currentTarget, -1);
        }
    }

    function onModalKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
        if (event.key === "Escape") {
            event.preventDefault();
            cmd.closeAgentPalette();
            return;
        }
        if (event.key !== "Tab") return;
        const focusable = [...(dialogRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
        if (focusable.length === 0) {
            event.preventDefault();
            return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    }

    const status =
        catalog.status === "loading"
            ? "Detecting agent CLIs…"
            : catalog.status === "error"
              ? catalog.error || "Agent detection failed."
              : "No supported agent CLIs were detected on PATH.";

    return (
        <div className="picker-backdrop agent-picker-backdrop" onMouseDown={cmd.closeAgentPalette} onKeyDown={onModalKeyDown}>
            <div
                ref={dialogRef}
                className="picker agent-picker"
                role="dialog"
                aria-modal="true"
                aria-labelledby="agent-picker-title"
                tabIndex={-1}
                onMouseDown={(event) => event.stopPropagation()}>
                <header className="agent-picker-head">
                    <span className="agent-picker-mark" aria-hidden="true">
                        <IconAgent size={16} />
                    </span>
                    <span>
                        <strong id="agent-picker-title">Open agent CLI</strong>
                        <small>{session?.cwd ?? "Open a project first"}</small>
                    </span>
                    <div className="agent-picker-modes" role="radiogroup" aria-label="Agent mode">
                        <button
                            type="button"
                            role="radio"
                            aria-checked={mode === NORMAL}
                            className={mode === NORMAL ? "active" : ""}
                            onClick={() => setMode(NORMAL)}>
                            Normal
                        </button>
                        <button
                            type="button"
                            role="radio"
                            aria-checked={mode === YOLO}
                            className={mode === YOLO ? "active yolo" : "yolo"}
                            onClick={() => setMode(YOLO)}>
                            YOLO
                        </button>
                    </div>
                </header>

                <div className="picker-list agent-picker-list" ref={listRef}>
                    {agents.length === 0 && (
                        <div className="picker-empty" role="status">
                            {status}
                            {catalog.status === "error" && (
                                <button type="button" onClick={() => void catalog.refresh().catch(() => {})}>
                                    Try again
                                </button>
                            )}
                        </div>
                    )}
                    {agents.map((agent) => {
                        const supportsMode = mode === NORMAL || cmd.agentSupportsSkipPermissions(agent.type);
                        return (
                            <button
                                key={agent.type}
                                type="button"
                                className="picker-item agent-picker-item"
                                disabled={!supportsMode}
                                aria-label={`Start ${agent.label} in ${mode === YOLO ? "YOLO" : "Normal"} mode`}
                                onMouseEnter={(event) => {
                                    if (mouseActive.current) event.currentTarget.focus();
                                }}
                                onKeyDown={onAgentKeyDown}
                                onClick={() => launch(agent)}>
                                <span className={`picker-icon agent-glyph ${agent.type}`}>
                                    <AgentIcon type={agent.type} size={15} />
                                </span>
                                <span className="picker-name">{agent.label}</span>
                                <span className="picker-sub">{supportsMode ? `${agent.command} · opens directly in PTY` : "Normal mode only"}</span>
                            </button>
                        );
                    })}
                </div>

                <footer className="agent-picker-foot" aria-hidden="true">
                    <span>↑↓ choose</span>
                    <span>↵ open</span>
                    <span>esc dismiss</span>
                </footer>
            </div>
        </div>
    );
}
