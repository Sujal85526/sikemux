import { useEffect, useMemo, useRef, useState } from "react";
import { agentApi, type AgentInfo, type AgentModelInfo } from "../api/agents";
import {
    MAX_AGENT_MODEL_LENGTH,
    MAX_AGENT_PROMPT_LENGTH,
    normalizePermissionMode,
    permissionCopyForType,
    supportedEfforts,
    supportedPermissionModes,
} from "../agentLaunch";
import { basename, prettyPath } from "../lib/paths";
import * as cmd from "../state/commands";
import { useResource, useResourceEnabled } from "../state/resources";
import { agentCatalogR, agentModelsR } from "../state/resources.defs";
import { useStore } from "../state/store";
import type { AgentEffort, AgentPermissionMode, AgentType } from "../state/types";
import { notify } from "../state/toast";
import { Dropdown } from "./Dropdown";
import { AgentIcon, IconAgent, IconClose, IconGit, IconShield } from "./Icons";
import "../styles/new-agent.css";

/** Sentinel for "type a model this provider's list doesn't carry". */
const CUSTOM_MODEL = "\0custom";

/**
 * Full model IDs shipped as a last-resort floor. Live CLI discovery is merged
 * on top, so new releases appear immediately while a failed IPC/subprocess can
 * no longer collapse the picker to only the configured default.
 */
const MODEL_FALLBACKS: Partial<Record<AgentType, readonly AgentModelInfo[]>> = {
    claude: [
        { id: "claude-opus-5[1m]", label: "Opus (1M context)" },
        { id: "claude-fable-5", label: "Fable" },
        { id: "claude-sonnet-5", label: "Sonnet" },
        { id: "claude-haiku-4-5-20251001", label: "Haiku" },
    ],
    codex: [
        { id: "gpt-5.6-sol", label: "GPT-5.6-Sol" },
        { id: "gpt-5.6-terra", label: "GPT-5.6-Terra" },
        { id: "gpt-5.6-luna", label: "GPT-5.6-Luna" },
        { id: "gpt-5.5", label: "GPT-5.5" },
        { id: "gpt-5.2", label: "GPT-5.2" },
    ],
};

function mergedModels(type: AgentType | null, discovered: readonly AgentModelInfo[] | undefined): AgentModelInfo[] {
    const seen = new Set<string>();
    return [...(discovered ?? []), ...(type ? (MODEL_FALLBACKS[type] ?? []) : [])].filter((candidate) => {
        if (seen.has(candidate.id)) return false;
        seen.add(candidate.id);
        return true;
    });
}

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
    const [prompt, setPrompt] = useState("");
    const [launching, setLaunching] = useState(false);
    const [error, setError] = useState("");
    const modelCatalog = useResourceEnabled(type != null, agentModelsR, type ?? "codex");

    const launchRoot = originRef.current.cwd;
    const launchSessionId = originRef.current.sessionId;
    const matchingProfiles = useMemo(() => profiles.filter((profile) => profile.provider === type), [profiles, type]);
    const effortOptions = type ? supportedEfforts(type) : [];
    const selectedAgent = type ? agents.find((agent) => agent.type === type) : undefined;
    const defaultModel = selectedAgent?.defaultModel ?? null;
    const defaultEffort = selectedAgent?.defaultEffort ?? null;
    const availableModels = useMemo(() => mergedModels(type, modelCatalog.data), [type, modelCatalog.data]);
    const modelOptions = useMemo(() => {
        const configuredDefault = availableModels.find((candidate) => candidate.id === defaultModel);
        return [
            {
                value: "",
                label: configuredDefault?.label ?? defaultModel ?? "CLI default",
                detail:
                    defaultModel && configuredDefault?.label !== defaultModel
                        ? `${defaultModel} · CLI default`
                        : defaultModel
                          ? "CLI default"
                          : "configured by the provider",
            },
            ...availableModels
                .filter((candidate) => candidate.id !== defaultModel)
                .map((candidate) => ({
                    value: candidate.id,
                    label: candidate.label,
                    detail: candidate.label !== candidate.id ? candidate.id : undefined,
                })),
            {
                value: CUSTOM_MODEL,
                label: "Custom…",
                detail:
                    modelCatalog.status === "loading"
                        ? "loading CLI models…"
                        : modelCatalog.status === "error"
                          ? "CLI lookup failed · manual override"
                          : "override for this task",
            },
        ];
    }, [availableModels, defaultModel, modelCatalog.status]);

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
            // On failure the ids stay undefined so addAgent falls back to its
            // own cache rather than claiming an existing session as new.
            const baselineSessionIds = await agentApi
                .sessions(type, launchRoot)
                .then((rows) => rows.map((row) => row.id))
                .catch(() => undefined);
            const initialTitle = prompt.trim().split(/\r?\n/, 1)[0].slice(0, 72);
            const attached = cmd.addAgent(type, undefined, initialTitle, {
                permissionMode,
                profileId: profileId || undefined,
                cwd: launchRoot,
                sessionId: launchSessionId,
                model: model.trim() || undefined,
                effort,
                initialPrompt: prompt.trim(),
                baselineSessionIds,
            });
            if (!attached) throw new Error("The project that opened this page is no longer available.");
            notify("success", `${labelForType(type, agents)} started in ${basename(launchRoot)}`);
            cmd.closeAgentPalette();
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
            launchingRef.current = false;
            setLaunching(false);
        }
    }

    // The page is a pane, not a modal: Tab flows out to the rails like it does
    // from any other pane. Enter launches only from the task composer so it
    // keeps its normal activation behavior on dropdowns and buttons.
    function onPageKeyDown(event: React.KeyboardEvent) {
        event.stopPropagation();
        if (event.key === "Escape") {
            event.preventDefault();
            cmd.closeAgentPalette();
            return;
        }
        if (event.key === "Enter" && event.target === composerRef.current && !event.shiftKey && !event.nativeEvent.isComposing) {
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
    const modelMessage =
        type && modelCatalog.status === "error"
            ? `${selectedLabel} model lookup failed; showing bundled full model IDs.`
            : type && modelCatalog.status === "ok" && modelCatalog.data?.length === 0 && (MODEL_FALLBACKS[type]?.length ?? 0) > 0
              ? `${selectedLabel} returned no models; showing bundled full model IDs.`
              : "";
    const permissionCopy = permissionCopyForType(type ?? "codex", permissionMode);
    const launchBlocked = !type || !prompt.trim() || launching;

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

                            {customModel ? (
                                <span className="na-chip na-chip-model">
                                    <input
                                        ref={modelRef}
                                        aria-label="Model"
                                        size={Math.max(14, model.length + 2)}
                                        value={model}
                                        onChange={(event) => setModel(event.target.value)}
                                        maxLength={MAX_AGENT_MODEL_LENGTH}
                                        placeholder={defaultModel || "model id"}
                                        spellCheck={false}
                                    />
                                    <button
                                        type="button"
                                        aria-label="Use the CLI default model"
                                        title="Use the CLI default model"
                                        onClick={() => {
                                            setCustomModel(false);
                                            setModel("");
                                        }}>
                                        <IconClose size={10} />
                                    </button>
                                </span>
                            ) : (
                                <Dropdown
                                    className="na-chip"
                                    title="Model"
                                    label="Model"
                                    value={model}
                                    options={modelOptions}
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
                                        {
                                            value: "",
                                            label: defaultEffort ?? "CLI default",
                                            detail: defaultEffort ? "CLI default" : "configured by the provider",
                                        },
                                        ...effortOptions
                                            .filter((option) => option !== defaultEffort)
                                            .map((option) => ({ value: option, label: option })),
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
                        </div>

                        <button
                            type="button"
                            className="new-agent-launch"
                            aria-keyshortcuts="Enter"
                            disabled={launchBlocked}
                            onClick={() => void launch()}>
                            {launching ? "starting…" : "Start task"}
                            <kbd>↵</kbd>
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
                    ) : modelMessage ? (
                        <span className="error" role="status">
                            {modelMessage}
                            {modelCatalog.status === "error" && (
                                <button type="button" onClick={() => void modelCatalog.refresh().catch(() => {})}>
                                    Try again
                                </button>
                            )}
                        </span>
                    ) : (
                        <span>
                            <kbd>↵</kbd> start · <kbd>⇧↵</kbd> new line · <kbd>esc</kbd> dismiss · resume past chats from the agent rail
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
