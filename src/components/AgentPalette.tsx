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
import { modelChoicesFor } from "../agentModels";
import { basename, prettyPath } from "../lib/paths";
import * as cmd from "../state/commands";
import { useResource } from "../state/resources";
import { agentCatalogR } from "../state/resources.defs";
import { useStore } from "../state/store";
import type { AgentEffort, AgentPermissionMode, AgentType, AgentWorkspaceStrategy } from "../state/types";
import { notify } from "../state/toast";
import { Dropdown } from "./Dropdown";
import { AgentIcon, IconAgent, IconClose, IconGit, IconShield } from "./Icons";
import "../styles/new-agent.css";

/** Sentinel for "type a model this provider's list doesn't carry". */
const CUSTOM_MODEL = "\0custom";

const WORKSPACE_CHOICES: readonly { id: AgentWorkspaceStrategy; label: string; detail: string }[] = [
    { id: "current", label: "Current checkout", detail: "Start here. Best when this is the only task changing the project." },
    { id: "agent-decides", label: "Agent decides", detail: "Stay here unless concurrent edits make lazy isolation useful." },
    { id: "existing", label: "Existing worktree", detail: "Continue inside a Git lane that already exists." },
];

function labelForType(type: AgentType, agents: readonly AgentInfo[]): string {
    return agents.find((agent) => agent.type === type)?.label ?? type;
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
    const modelRef = useRef<HTMLInputElement>(null);
    const pageRef = useRef<HTMLElement>(null);
    const returnFocusRef = useRef<HTMLElement | null>(null);
    const launchingRef = useRef(false);

    const [type, setType] = useState<AgentType | null>(null);
    const [profileId, setProfileId] = useState("");
    const [model, setModel] = useState("");
    /** True once the reader asks for a model the provider's list doesn't carry. */
    const [customModel, setCustomModel] = useState(false);
    const [effort, setEffort] = useState<AgentEffort | undefined>(undefined);
    const [permissionMode, setPermissionMode] = useState<AgentPermissionMode>(defaultPermissionMode);
    const [workspaceStrategy, setWorkspaceStrategy] = useState<AgentWorkspaceStrategy>("current");
    const [existingPath, setExistingPath] = useState("");
    const [worktrees, setWorktrees] = useState<GitWorktree[]>([]);
    const [worktreeStatus, setWorktreeStatus] = useState<"loading" | "ready" | "error">("loading");
    const [prompt, setPrompt] = useState("");
    const [launching, setLaunching] = useState(false);
    const [error, setError] = useState("");

    const launchRoot = originRef.current.cwd;
    const launchSessionId = originRef.current.sessionId;
    const matchingProfiles = useMemo(() => profiles.filter((profile) => profile.provider === type), [profiles, type]);
    const effortOptions = type ? supportedEfforts(type) : [];
    // Hermes and OpenCode resolve their catalogs from live provider queries, so
    // they list nothing here and the field stays a plain text box.
    const modelChoices = useMemo(() => modelChoicesFor(type), [type]);

    useEffect(() => {
        if (customModel) modelRef.current?.focus();
    }, [customModel]);

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

    // The draft belongs to the project it was opened from — it launches into
    // that checkout. Leaving for another session retires it rather than letting
    // it follow along and start an agent somewhere the reader never chose.
    useEffect(() => {
        if (activeSession && activeSession.id !== originRef.current.sessionId) cmd.closeAgentPalette();
    }, [activeSession]);

    // Worktrees are only fetched for the one strategy that needs to pick one.
    useEffect(() => {
        if (!launchRoot || workspaceStrategy !== "existing") return;
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
    }, [launchRoot, workspaceStrategy]);

    function chooseType(nextType: AgentType) {
        setType(nextType);
        setModel("");
        setCustomModel(false);
        setEffort(undefined);
        setPermissionMode(normalizePermissionMode(nextType, defaultPermissionMode));
        const selected = profiles.find((profile) => profile.id === profileSelections[nextType] && profile.provider === nextType);
        setProfileId(selected?.id ?? profiles.find((profile) => profile.provider === nextType)?.id ?? "");
        setError("");
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
            // On failure the ids stay undefined so addAgent falls back to its
            // own cache rather than claiming an existing session as new.
            const baselineSessionIds = await agentApi
                .sessions(type, cwd)
                .then((rows) => rows.map((row) => row.id))
                .catch(() => undefined);
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

    // The page is a pane, not a modal: Tab flows out to the rails like it does
    // from any other pane. Only the two page-level shortcuts are claimed here.
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
        }
    }

    const detectionMessage =
        catalog.status === "loading"
            ? "Detecting agent CLIs…"
            : catalog.status === "error"
              ? catalog.error || "Agent detection failed."
              : agents.length === 0
                ? "No supported agent CLIs were detected on PATH."
                : "";
    const selectedLabel = type ? labelForType(type, agents) : "an agent";
    const permissionCopy = permissionCopyForType(type ?? "codex", permissionMode);
    const selectedWorkspace = WORKSPACE_CHOICES.find((choice) => choice.id === workspaceStrategy)!;
    const selectedWorktree = worktrees.find((item) => item.path === existingPath);
    const worktreeLabel =
        worktreeStatus === "loading"
            ? "loading worktrees…"
            : worktreeStatus === "error"
              ? "worktrees unavailable"
              : selectedWorktree
                ? (selectedWorktree.branch ?? basename(selectedWorktree.path))
                : "choose a worktree…";
    const launchBlocked = !type || !prompt.trim() || launching || (workspaceStrategy === "existing" && (worktreeStatus !== "ready" || !existingPath));

    return (
        <section ref={pageRef} className="new-agent-page" role="region" aria-label="New agent" tabIndex={-1} onKeyDown={onPageKeyDown}>
            <div className="new-agent-body">
                <header className="new-agent-head">
                    <span className={`new-agent-mark${type ? ` ${type}` : ""}`} aria-hidden="true">
                        {type ? <AgentIcon type={type} size={17} /> : <IconAgent size={16} />}
                    </span>
                    <h2>What should {selectedLabel} make?</h2>
                    <span className="new-agent-project" title={launchRoot}>
                        <IconGit size={11} /> {prettyPath(launchRoot, home)}
                    </span>
                </header>

                <div className="new-agent-composer">
                    <textarea
                        ref={composerRef}
                        aria-label="Task for the new agent"
                        placeholder="Describe the outcome, constraints, and what done looks like…"
                        value={prompt}
                        onChange={(event) => setPrompt(event.target.value)}
                        maxLength={MAX_AGENT_PROMPT_LENGTH}
                        disabled={launching}
                        rows={4}
                    />
                    <div className="new-agent-bar">
                        <div className="na-chips">
                            <Dropdown
                                icon={type ? <AgentIcon type={type} size={13} /> : <IconAgent size={13} />}
                                className={`na-chip${type ? ` ${type}` : ""}`}
                                title="Agent runtime"
                                label="Agent"
                                value={type ?? ""}
                                disabled={agents.length === 0}
                                options={
                                    agents.length === 0
                                        ? [{ value: "", label: "no agent" }]
                                        : agents.map((agent) => ({ value: agent.type, label: agent.label }))
                                }
                                onChange={(next) => chooseType(next as AgentType)}
                            />

                            {customModel || modelChoices.length === 0 ? (
                                <span className="na-chip na-chip-model">
                                    <input
                                        ref={modelRef}
                                        aria-label="Model"
                                        size={Math.max(14, model.length + 2)}
                                        value={model}
                                        onChange={(event) => setModel(event.target.value)}
                                        maxLength={MAX_AGENT_MODEL_LENGTH}
                                        placeholder="default model"
                                        spellCheck={false}
                                    />
                                    {modelChoices.length > 0 && (
                                        <button
                                            type="button"
                                            aria-label="Back to the listed models"
                                            title="Back to the listed models"
                                            onClick={() => {
                                                setCustomModel(false);
                                                setModel("");
                                            }}>
                                            <IconClose size={10} />
                                        </button>
                                    )}
                                </span>
                            ) : (
                                <Dropdown
                                    className="na-chip"
                                    title="Model"
                                    label="Model"
                                    value={model}
                                    options={[
                                        { value: "", label: "default model" },
                                        ...modelChoices,
                                        { value: CUSTOM_MODEL, label: "Custom…", detail: "type any model id" },
                                    ]}
                                    onChange={(next) => {
                                        if (next === CUSTOM_MODEL) {
                                            setCustomModel(true);
                                            setModel("");
                                        } else setModel(next);
                                    }}
                                />
                            )}

                            {matchingProfiles.length > 1 && (
                                <Dropdown
                                    icon={<IconAgent size={12} />}
                                    className="na-chip"
                                    title="Provider profile"
                                    label="Profile"
                                    value={profileId}
                                    options={matchingProfiles.map((profile) => ({
                                        value: profile.id,
                                        label: profile.name,
                                        detail: profile.executablePath || "PATH",
                                    }))}
                                    onChange={setProfileId}
                                />
                            )}

                            {effortOptions.length > 0 && (
                                <Dropdown
                                    icon={<IconSpark />}
                                    className="na-chip"
                                    title="Reasoning effort"
                                    label="Effort"
                                    value={effort ?? ""}
                                    options={[
                                        { value: "", label: "default effort" },
                                        ...effortOptions.map((option) => ({ value: option, label: option })),
                                    ]}
                                    onChange={(next) => setEffort((next || undefined) as AgentEffort | undefined)}
                                />
                            )}

                            {type && (
                                <Dropdown
                                    icon={<IconShield size={12} />}
                                    className={`na-chip ${permissionCopy.tone}`}
                                    title={permissionCopy.detail}
                                    label="Safety"
                                    value={permissionMode}
                                    menuWidth={260}
                                    options={supportedPermissionModes(type).map((mode) => {
                                        const copy = permissionCopyForType(type, mode);
                                        return { value: mode, label: copy.label, detail: copy.detail };
                                    })}
                                    onChange={(next) => setPermissionMode(next as AgentPermissionMode)}
                                />
                            )}

                            <Dropdown
                                icon={<IconGit size={12} />}
                                className="na-chip"
                                title={selectedWorkspace.detail}
                                label="Workspace"
                                value={workspaceStrategy}
                                menuWidth={260}
                                options={WORKSPACE_CHOICES.map((choice) => ({ value: choice.id, label: choice.label, detail: choice.detail }))}
                                onChange={(next) => setWorkspaceStrategy(next as AgentWorkspaceStrategy)}
                            />

                            {workspaceStrategy === "existing" && (
                                <Dropdown
                                    icon={<IconGit size={12} />}
                                    className="na-chip"
                                    title="Existing worktree"
                                    label="Worktree"
                                    value={existingPath}
                                    disabled={worktreeStatus !== "ready"}
                                    options={[
                                        // The placeholder only stands in for an empty choice — once a
                                        // worktree is picked its own row carries the label.
                                        ...(existingPath ? [] : [{ value: "", label: worktreeLabel }]),
                                        ...worktrees.map((item) => ({
                                            value: item.path,
                                            label: item.branch ?? "detached",
                                            detail: prettyPath(item.path, home),
                                        })),
                                    ]}
                                    onChange={setExistingPath}
                                />
                            )}
                        </div>

                        <button type="button" className="new-agent-launch" disabled={launchBlocked} onClick={() => void launch()}>
                            {launching ? "starting…" : "Start task"}
                            <kbd>⌘↵</kbd>
                        </button>
                    </div>
                </div>

                <div className="new-agent-feedback" aria-live="polite">
                    {error ? (
                        <span role="alert">{error}</span>
                    ) : launching ? (
                        <span role="status">Launching {selectedLabel} and preparing the first turn…</span>
                    ) : detectionMessage ? (
                        <span className={catalog.status === "error" ? "error" : ""} role="status">
                            {detectionMessage}
                            {catalog.status === "error" && (
                                <button type="button" onClick={() => void catalog.refresh().catch(() => {})}>
                                    Try again
                                </button>
                            )}
                        </span>
                    ) : (
                        <span>
                            <kbd>⌘↵</kbd> start · <kbd>esc</kbd> dismiss · resume past chats from the agent rail
                        </span>
                    )}
                </div>
            </div>
        </section>
    );
}

/** Effort glyph — a spark, kept local because nothing else needs it. */
function IconSpark() {
    return (
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
            <path d="M8 1.8 9.7 6.3 14.2 8 9.7 9.7 8 14.2 6.3 9.7 1.8 8 6.3 6.3Z" />
        </svg>
    );
}
