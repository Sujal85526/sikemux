import { useEffect, useMemo, useRef, useState } from "react";
import { agentApi, type AgentInfo } from "../api/agents";
import { git, type GitWorktree } from "../api/git";
import {
    MAX_AGENT_MODEL_LENGTH,
    MAX_AGENT_PROMPT_LENGTH,
    normalizePermissionMode,
    permissionCopyForType,
    supportedEfforts,
    supportedPermissionModes,
} from "../agentLaunch";
import {
    aggregateAgentChatLoadState,
    mergeAgentChatLoadSummaries,
    searchAgentChats,
    type AgentChatLoadSummary,
    type AgentChatProviderLoad,
    type AgentChatRow,
} from "../agentChats";
import { useMouseActive } from "../hooks/useMouseActive";
import { basename, prettyPath } from "../lib/paths";
import * as cmd from "../state/commands";
import { useResource } from "../state/resources";
import { agentCatalogR } from "../state/resources.defs";
import { useStore } from "../state/store";
import type { AgentEffort, AgentPermissionMode, AgentType, AgentWorkspaceStrategy } from "../state/types";
import { notify } from "../state/toast";
import { AgentIcon, IconAgent, IconChevron, IconClock, IconClose, IconGit, IconSearch, IconShield } from "./Icons";
import "../styles/new-agent.css";

const MODEL_SUGGESTIONS: Readonly<Partial<Record<AgentType, readonly string[]>>> = {
    claude: ["sonnet", "opus", "haiku"],
};

const WORKSPACE_CHOICES: readonly {
    id: AgentWorkspaceStrategy;
    label: string;
    detail: string;
    badge?: string;
}[] = [
    {
        id: "current",
        label: "Current checkout",
        detail: "Start here. Best when this is the only task changing the project.",
        badge: "recommended",
    },
    {
        id: "agent-decides",
        label: "Agent decides",
        detail: "Stay here unless concurrent edits make lazy isolation useful.",
    },
    {
        id: "existing",
        label: "Existing worktree",
        detail: "Continue inside a Git lane that already exists.",
    },
];

function labelForType(type: AgentType, agents: readonly AgentInfo[]): string {
    return agents.find((agent) => agent.type === type)?.label ?? type;
}

function ago(unixSecs: number): string {
    if (!unixSecs) return "";
    const elapsed = Math.max(0, Date.now() / 1000 - unixSecs);
    if (elapsed < 90) return "now";
    if (elapsed < 3600) return `${Math.round(elapsed / 60)}m`;
    if (elapsed < 86400) return `${Math.round(elapsed / 3600)}h`;
    return `${Math.round(elapsed / 86400)}d`;
}

function handleRadioKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (!(["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown", "Home", "End"] as const).includes(event.key as never)) return;
    const group = event.currentTarget.closest<HTMLElement>("[role='radiogroup']");
    const radios = [...(group?.querySelectorAll<HTMLButtonElement>("button[role='radio']:not([disabled])") ?? [])];
    if (radios.length === 0) return;
    event.preventDefault();
    const current = Math.max(0, radios.indexOf(event.currentTarget));
    const next =
        event.key === "Home"
            ? 0
            : event.key === "End"
              ? radios.length - 1
              : event.key === "ArrowLeft" || event.key === "ArrowUp"
                ? (current - 1 + radios.length) % radios.length
                : (current + 1) % radios.length;
    radios[next].click();
    radios[next].focus();
}

function Orbit({ type }: { type: AgentType | null }) {
    return (
        <span className={`new-agent-orbit${type ? ` ${type}` : ""}`} aria-hidden="true">
            <span className="new-agent-orbit-ring outer" />
            <span className="new-agent-orbit-ring inner" />
            <span className="new-agent-orbit-node one" />
            <span className="new-agent-orbit-node two" />
            <span className="new-agent-orbit-core">{type ? <AgentIcon type={type} size={27} /> : <IconAgent size={24} />}</span>
        </span>
    );
}

export function AgentPalette() {
    const activeSession = useStore((state) => state.sessions[state.activeSessionId]);
    const home = useStore((state) => state.home);
    const profiles = useStore((state) => state.providerProfiles);
    const profileSelections = useStore((state) => state.selectedProviderProfileIds);
    const defaultPermissionMode = useStore((state) => state.defaultAgentPermissionMode);
    const catalog = useResource(agentCatalogR);
    const agents = useMemo(() => catalog.data ?? [], [catalog.data]);
    const originRef = useRef({ sessionId: activeSession?.id ?? "", cwd: activeSession?.cwd ?? "" });
    const composerRef = useRef<HTMLTextAreaElement>(null);
    const pageRef = useRef<HTMLElement>(null);
    const returnFocusRef = useRef<HTMLElement | null>(null);
    const launchingRef = useRef(false);
    const mouseActive = useMouseActive();

    const [type, setType] = useState<AgentType | null>(null);
    const [profileId, setProfileId] = useState("");
    const [model, setModel] = useState("");
    const [effort, setEffort] = useState<AgentEffort | undefined>(undefined);
    const [permissionMode, setPermissionMode] = useState<AgentPermissionMode>(defaultPermissionMode);
    const [workspaceStrategy, setWorkspaceStrategy] = useState<AgentWorkspaceStrategy>("current");
    const [existingPath, setExistingPath] = useState("");
    const [worktrees, setWorktrees] = useState<GitWorktree[]>([]);
    const [worktreeStatus, setWorktreeStatus] = useState<"loading" | "ready" | "error">("loading");
    const [worktreeAttempt, setWorktreeAttempt] = useState(0);
    const [prompt, setPrompt] = useState("");
    const [recentQuery, setRecentQuery] = useState("");
    const [history, setHistory] = useState<AgentChatLoadSummary>(() =>
        aggregateAgentChatLoadState({ detecting: true, cwd: originRef.current.cwd, providers: [] }),
    );
    const [historyAttempt, setHistoryAttempt] = useState(0);
    const [launching, setLaunching] = useState(false);
    const [error, setError] = useState("");

    const launchRoot = originRef.current.cwd;
    const launchSessionId = originRef.current.sessionId;
    const historyCwds = useMemo(
        () => [...new Set([launchRoot, ...worktrees.filter((item) => !item.bare).map((item) => item.path)].filter(Boolean))],
        [launchRoot, worktrees],
    );
    const matchingProfiles = useMemo(() => profiles.filter((profile) => profile.provider === type), [profiles, type]);
    const effortOptions = type ? supportedEfforts(type) : [];

    useEffect(() => {
        if (type || agents.length === 0) return;
        chooseType(agents[0].type);
        // The initial choice is intentionally tied to catalog arrival only.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [agents, type]);

    useEffect(() => {
        returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        const frame = window.requestAnimationFrame(() => composerRef.current?.focus());
        return () => {
            window.cancelAnimationFrame(frame);
            returnFocusRef.current?.focus();
        };
    }, []);

    useEffect(() => {
        let cancelled = false;
        if (catalog.status === "loading") {
            setHistory(aggregateAgentChatLoadState({ detecting: true, cwd: launchRoot, providers: [] }));
            return () => {
                cancelled = true;
            };
        }
        if (catalog.status === "error") {
            setHistory(aggregateAgentChatLoadState({ detecting: false, detectionFailed: true, cwd: launchRoot, providers: [] }));
            return () => {
                cancelled = true;
            };
        }

        const loads = new Map<string, AgentChatProviderLoad>();
        const key = (cwd: string, provider: AgentInfo) => `${cwd}\0${provider.type}`;
        for (const cwd of historyCwds) {
            for (const provider of agents) loads.set(key(cwd, provider), { provider, status: "loading" });
        }
        const publish = () => {
            if (cancelled) return;
            setHistory(
                mergeAgentChatLoadSummaries(
                    historyCwds.map((cwd) =>
                        aggregateAgentChatLoadState({
                            detecting: false,
                            cwd,
                            providers: agents.map((provider) => loads.get(key(cwd, provider)) ?? { provider, status: "loading" }),
                        }),
                    ),
                ),
            );
        };
        publish();
        for (const cwd of historyCwds) {
            for (const provider of agents) {
                void agentApi
                    .sessionResults([provider], cwd)
                    .then(([result]) => {
                        loads.set(key(cwd, provider), result ?? { provider, status: "error", sessions: [] });
                        publish();
                    })
                    .catch(() => {
                        loads.set(key(cwd, provider), { provider, status: "error", sessions: [] });
                        publish();
                    });
            }
        }
        return () => {
            cancelled = true;
        };
    }, [agents, catalog.status, historyAttempt, historyCwds, launchRoot]);

    useEffect(() => {
        if (!launchRoot) return;
        let cancelled = false;
        setWorktreeStatus("loading");
        void git
            .worktrees(launchRoot)
            .then((items) => {
                if (cancelled) return;
                const visible = items.filter((item) => !item.bare);
                setWorktrees(visible);
                setExistingPath((current) => current || visible.find((item) => !item.is_main)?.path || "");
                setWorktreeStatus("ready");
            })
            .catch(() => {
                if (!cancelled) {
                    setWorktrees([]);
                    setWorktreeStatus("error");
                }
            });
        return () => {
            cancelled = true;
        };
    }, [launchRoot, worktreeAttempt]);

    const filteredChats = useMemo(() => searchAgentChats(history.rows, recentQuery), [history.rows, recentQuery]);

    function chooseType(nextType: AgentType) {
        setType(nextType);
        setModel("");
        setEffort(undefined);
        setPermissionMode(normalizePermissionMode(nextType, defaultPermissionMode));
        const selected = profiles.find((profile) => profile.id === profileSelections[nextType] && profile.provider === nextType);
        setProfileId(selected?.id ?? profiles.find((profile) => profile.provider === nextType)?.id ?? "");
        setError("");
    }

    function resume(chat: AgentChatRow) {
        const attached = cmd.addAgent(chat.type, chat.id, chat.title, {
            cwd: chat.cwd,
            sessionId: launchSessionId,
            workspaceStrategy: chat.cwd === launchRoot ? "current" : "existing",
        });
        if (!attached) {
            setError("The project that opened this page is no longer available.");
            return;
        }
        cmd.closeAgentPalette();
    }

    async function launch() {
        if (launchingRef.current || !type || !launchRoot || !launchSessionId || !prompt.trim()) return;
        launchingRef.current = true;
        setLaunching(true);
        setError("");
        try {
            if (prompt.trim().length > MAX_AGENT_PROMPT_LENGTH) {
                throw new Error(`Keep the first task under ${Math.floor(MAX_AGENT_PROMPT_LENGTH / 1024)} KiB.`);
            }
            if (model.trim().length > MAX_AGENT_MODEL_LENGTH) {
                throw new Error(`Keep the model identifier under ${MAX_AGENT_MODEL_LENGTH} characters.`);
            }
            // Give the launch state one paint so keyboard users receive an
            // honest status announcement before the terminal takes focus.
            await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
            let cwd = launchRoot;
            if (workspaceStrategy === "existing") {
                if (worktreeStatus !== "ready") throw new Error("Wait for the registered worktrees to finish loading.");
                if (!existingPath) throw new Error("Choose an existing worktree before starting.");
                cwd = existingPath;
            }
            const baselineSessionIds = await agentApi
                .sessions(type, cwd)
                .then((rows) => rows.map((row) => row.id))
                .catch(() => history.rows.filter((row) => row.type === type && row.cwd === cwd).map((row) => row.id));
            const initialTitle = prompt.trim().split(/\r?\n/, 1)[0].slice(0, 72);
            const attached = cmd.addAgent(type, undefined, initialTitle, {
                permissionMode,
                profileId: profileId || undefined,
                cwd,
                sessionId: launchSessionId,
                model: model.trim() || undefined,
                effort,
                initialPrompt: prompt.trim(),
                workspaceStrategy,
                baselineSessionIds,
            });
            if (!attached) throw new Error("The project that opened this page is no longer available.");
            notify("success", `${labelForType(type, agents)} started in ${basename(cwd)}`);
            cmd.closeAgentPalette();
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
            launchingRef.current = false;
            setLaunching(false);
        }
    }

    function onPageKeyDown(event: React.KeyboardEvent) {
        event.stopPropagation();
        if (event.key === "Escape") {
            event.preventDefault();
            cmd.closeAgentPalette();
            return;
        }
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void launch();
            return;
        }
        if (event.key !== "Tab") return;
        const focusable = [
            ...(pageRef.current?.querySelectorAll<HTMLElement>(
                "button:not([disabled]):not([tabindex='-1']), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex='-1'])",
            ) ?? []),
        ];
        if (focusable.length === 0) {
            event.preventDefault();
            pageRef.current?.focus();
            return;
        }
        const first = focusable[0];
        const last = focusable.at(-1)!;
        if (event.shiftKey && (document.activeElement === first || document.activeElement === pageRef.current)) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === pageRef.current)) {
            event.preventDefault();
            first.focus();
        }
    }

    function retryHistory() {
        setHistoryAttempt((attempt) => attempt + 1);
        void catalog.refresh().catch(() => {});
    }

    const detectionMessage =
        catalog.status === "loading"
            ? "Detecting agent CLIs…"
            : catalog.status === "error"
              ? catalog.error || "Agent detection failed."
              : agents.length === 0
                ? "No supported agent CLIs were detected on PATH."
                : "";
    const selectedLabel = type ? labelForType(type, agents) : "agent";
    const selectedWorkspace = WORKSPACE_CHOICES.find((choice) => choice.id === workspaceStrategy)!;
    const launchBlocked = !type || !prompt.trim() || launching || (workspaceStrategy === "existing" && (worktreeStatus !== "ready" || !existingPath));

    return (
        <section
            ref={pageRef}
            className="new-agent-page"
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-agent-title"
            tabIndex={-1}
            onKeyDown={onPageKeyDown}>
            <header className="new-agent-topbar">
                <div>
                    <span className="new-agent-kicker">Sikemux launch desk</span>
                    <h1 id="new-agent-title">New agent</h1>
                </div>
                <span className="new-agent-project" title={launchRoot}>
                    <IconGit size={13} /> {prettyPath(launchRoot, home)}
                </span>
                <button type="button" className="new-agent-close" aria-label="Close new agent" onClick={cmd.closeAgentPalette}>
                    <IconClose size={14} />
                    <kbd>esc</kbd>
                </button>
            </header>

            <div className="new-agent-layout">
                <main className="new-agent-main">
                    <div className="new-agent-hero">
                        <Orbit type={type} />
                        <div>
                            <span className="new-agent-eyebrow">Give the lane a destination</span>
                            <h2>What should {selectedLabel} make?</h2>
                        </div>
                    </div>

                    <div className="new-agent-composer">
                        <textarea
                            ref={composerRef}
                            aria-label="Task for the new agent"
                            placeholder="Describe the outcome, constraints, and what done looks like…"
                            value={prompt}
                            onChange={(event) => setPrompt(event.target.value)}
                            maxLength={MAX_AGENT_PROMPT_LENGTH}
                            disabled={launching}
                            rows={5}
                        />
                        <div className="new-agent-composer-foot">
                            <span>
                                {prompt.trim().length
                                    ? `${prompt.trim().length} characters`
                                    : "A precise outcome gives the agent a cleaner first turn."}
                            </span>
                            <button type="button" className="new-agent-launch" disabled={launchBlocked} onClick={() => void launch()}>
                                {launching ? "Starting agent…" : "Start task"}
                                <kbd>⌘↵</kbd>
                            </button>
                        </div>
                    </div>

                    <section className="new-agent-config" aria-label="Launch configuration">
                        <div className="new-agent-config-block identity">
                            <div className="new-agent-section-heading">
                                <span>01</span>
                                <div>
                                    <h3>Agent</h3>
                                    <p>Runtime identity and reasoning shape.</p>
                                </div>
                            </div>
                            <div className="new-agent-type-list" role="radiogroup" aria-label="Agent">
                                {agents.map((agent) => (
                                    <button
                                        key={agent.type}
                                        type="button"
                                        role="radio"
                                        aria-checked={type === agent.type}
                                        tabIndex={type === agent.type ? 0 : -1}
                                        className={type === agent.type ? `selected ${agent.type}` : agent.type}
                                        onKeyDown={handleRadioKeyDown}
                                        onClick={() => chooseType(agent.type)}>
                                        <AgentIcon type={agent.type} size={17} />
                                        <span>{agent.label}</span>
                                    </button>
                                ))}
                            </div>
                            {detectionMessage && (
                                <p className={`new-agent-inline-status ${catalog.status === "error" ? "error" : ""}`} role="status">
                                    {detectionMessage}
                                </p>
                            )}
                            {type && (
                                <div className="new-agent-fields">
                                    <label>
                                        <span>Profile</span>
                                        {matchingProfiles.length ? (
                                            <select value={profileId} onChange={(event) => setProfileId(event.target.value)}>
                                                {matchingProfiles.map((profile) => (
                                                    <option key={profile.id} value={profile.id}>
                                                        {profile.name}
                                                        {profile.executablePath ? ` · ${profile.executablePath}` : " · PATH"}
                                                    </option>
                                                ))}
                                            </select>
                                        ) : (
                                            <span className="new-agent-field-value">System PATH · {type}</span>
                                        )}
                                    </label>
                                    <label>
                                        <span>Model</span>
                                        <input
                                            list={`new-agent-models-${type}`}
                                            value={model}
                                            onChange={(event) => setModel(event.target.value)}
                                            maxLength={MAX_AGENT_MODEL_LENGTH}
                                            placeholder="Provider default"
                                            spellCheck={false}
                                        />
                                        <datalist id={`new-agent-models-${type}`}>
                                            {(MODEL_SUGGESTIONS[type] ?? []).map((option) => (
                                                <option key={option} value={option} />
                                            ))}
                                        </datalist>
                                    </label>
                                </div>
                            )}
                            {type && effortOptions.length > 0 && (
                                <div className="new-agent-segments" role="radiogroup" aria-label="Reasoning effort">
                                    <span className="new-agent-segment-label">Effort</span>
                                    <button
                                        type="button"
                                        role="radio"
                                        aria-checked={effort === undefined}
                                        tabIndex={effort === undefined ? 0 : -1}
                                        className={effort === undefined ? "selected" : ""}
                                        onKeyDown={handleRadioKeyDown}
                                        onClick={() => setEffort(undefined)}>
                                        default
                                    </button>
                                    {effortOptions.map((option) => (
                                        <button
                                            key={option}
                                            type="button"
                                            role="radio"
                                            aria-checked={effort === option}
                                            tabIndex={effort === option ? 0 : -1}
                                            className={effort === option ? "selected" : ""}
                                            onKeyDown={handleRadioKeyDown}
                                            onClick={() => setEffort(option)}>
                                            {option}
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>

                        <div className="new-agent-config-block">
                            <div className="new-agent-section-heading">
                                <span>02</span>
                                <div>
                                    <h3>Safety</h3>
                                    <p>The boundary is explicit before launch.</p>
                                </div>
                            </div>
                            {type && (
                                <div className="new-agent-safety" role="radiogroup" aria-label="Safety boundary">
                                    {supportedPermissionModes(type).map((mode) => {
                                        const copy = permissionCopyForType(type, mode);
                                        return (
                                            <button
                                                key={mode}
                                                type="button"
                                                role="radio"
                                                aria-checked={permissionMode === mode}
                                                tabIndex={permissionMode === mode ? 0 : -1}
                                                className={`${permissionMode === mode ? "selected" : ""} ${copy.tone}`}
                                                onKeyDown={handleRadioKeyDown}
                                                onClick={() => setPermissionMode(mode)}>
                                                <IconShield size={13} />
                                                <span>
                                                    <b>{copy.label}</b>
                                                    <small>{copy.detail}</small>
                                                </span>
                                            </button>
                                        );
                                    })}
                                </div>
                            )}
                        </div>

                        <div className="new-agent-config-block workspace">
                            <div className="new-agent-section-heading">
                                <span>03</span>
                                <div>
                                    <h3>Workspace</h3>
                                    <p>Current checkout first; isolation only when useful.</p>
                                </div>
                            </div>
                            <div className="new-agent-workspaces" role="radiogroup" aria-label="Workspace strategy">
                                {WORKSPACE_CHOICES.map((choice) => (
                                    <button
                                        key={choice.id}
                                        type="button"
                                        role="radio"
                                        aria-checked={workspaceStrategy === choice.id}
                                        tabIndex={workspaceStrategy === choice.id ? 0 : -1}
                                        className={workspaceStrategy === choice.id ? "selected" : ""}
                                        onKeyDown={handleRadioKeyDown}
                                        onClick={() => setWorkspaceStrategy(choice.id)}>
                                        <span className="new-agent-workspace-signal" aria-hidden="true">
                                            <i />
                                            <i />
                                        </span>
                                        <span>
                                            <b>{choice.label}</b>
                                            {choice.badge && <em>{choice.badge}</em>}
                                            <small>{choice.detail}</small>
                                        </span>
                                    </button>
                                ))}
                            </div>
                            {workspaceStrategy === "existing" && (
                                <label className="new-agent-existing">
                                    <span>Worktree</span>
                                    <select
                                        value={existingPath}
                                        disabled={worktreeStatus !== "ready"}
                                        onChange={(event) => setExistingPath(event.target.value)}>
                                        <option value="">Choose an existing worktree…</option>
                                        {worktrees.map((item) => (
                                            <option key={item.path} value={item.path}>
                                                {item.branch ?? "detached"} · {prettyPath(item.path, home)}
                                            </option>
                                        ))}
                                    </select>
                                    {worktreeStatus === "loading" ? (
                                        <small role="status">Loading registered worktrees…</small>
                                    ) : worktreeStatus === "error" ? (
                                        <small>
                                            Worktrees unavailable.{" "}
                                            <button type="button" onClick={() => setWorktreeAttempt((attempt) => attempt + 1)}>
                                                Try again
                                            </button>
                                        </small>
                                    ) : worktrees.length === 0 ? (
                                        <small>No registered worktrees are available for this project.</small>
                                    ) : null}
                                </label>
                            )}
                            <p className="new-agent-workspace-summary">
                                <IconGit size={12} /> {selectedWorkspace.label} · {permissionCopyForType(type ?? "codex", permissionMode).label}
                            </p>
                        </div>
                    </section>

                    <div className="new-agent-feedback" aria-live="polite">
                        {launching && <span role="status">Launching {selectedLabel} and preparing the first turn…</span>}
                        {error && <span role="alert">{error}</span>}
                    </div>
                </main>

                <aside className="new-agent-history" aria-label="Recent chats">
                    <header>
                        <div>
                            <span>Resume</span>
                            <h2>Recent chats</h2>
                        </div>
                        <IconClock size={15} />
                    </header>
                    <label className="new-agent-history-search">
                        <IconSearch size={13} />
                        <span className="sr-only">Search recent chats</span>
                        <input
                            value={recentQuery}
                            onChange={(event) => setRecentQuery(event.target.value)}
                            placeholder="Search history…"
                            spellCheck={false}
                        />
                    </label>
                    <div className="new-agent-history-list">
                        {history.phase === "detecting" ? (
                            <div className="new-agent-history-state" role="status">
                                Detecting installed agent CLIs…
                            </div>
                        ) : history.phase === "history-loading" ? (
                            <div className="new-agent-history-state" role="status">
                                <span className="new-agent-history-loader" aria-hidden="true" />
                                Loading chat history…
                            </div>
                        ) : history.phase === "partial-error" && history.rows.length === 0 ? (
                            <div className="new-agent-history-state error" role="alert">
                                <span>
                                    {history.detectionFailed ? "Installed agents could not be detected." : "Recent chats could not be loaded."}
                                </span>
                                <button type="button" onClick={retryHistory}>
                                    Try again
                                </button>
                            </div>
                        ) : filteredChats.length === 0 ? (
                            <div className="new-agent-history-state">
                                {history.rows.length === 0 ? "No recent chats in this project." : "No chats match this search."}
                            </div>
                        ) : (
                            filteredChats.map((chat) => (
                                <button
                                    key={chat.key}
                                    type="button"
                                    className="new-agent-history-row"
                                    onMouseEnter={(event) => {
                                        if (mouseActive.current) event.currentTarget.focus({ preventScroll: true });
                                    }}
                                    onClick={() => resume(chat)}>
                                    <span className={`agent-glyph ${chat.type}`}>
                                        <AgentIcon type={chat.type} size={15} />
                                    </span>
                                    <span>
                                        <b>{chat.title}</b>
                                        <small>{chat.providerLabel}</small>
                                    </span>
                                    <time>{ago(chat.mtime)}</time>
                                    <IconChevron size={11} />
                                </button>
                            ))
                        )}
                    </div>
                    {history.phase === "partial-error" && history.rows.length > 0 && (
                        <p className="new-agent-history-note">
                            {history.failedProviderCount === 1
                                ? "1 provider history is unavailable."
                                : `${history.failedProviderCount} provider histories are unavailable.`}{" "}
                            <button type="button" onClick={retryHistory}>
                                Retry
                            </button>
                        </p>
                    )}
                </aside>
            </div>
        </section>
    );
}
