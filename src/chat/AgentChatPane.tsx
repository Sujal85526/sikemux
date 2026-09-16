import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useVirtualizer } from "@tanstack/react-virtual";
import { open } from "@tauri-apps/plugin-dialog";
import { acpApi, type AcpEvent } from "../api/acp";
import { fsapi } from "../api/fs";
import { invokeCommand as invoke } from "../api/invoke";
import { ComposerPickers, sessionConfigs, type SessionConfig } from "./ComposerPickers";
import { permissionCopyForType } from "../agentLaunch";
import { basename } from "../lib/paths";
import { registerPathDrop } from "../state/dropRegistry";
import type { Agent, ProviderProfile } from "../state/types";
import * as cmd from "../state/commands";
import { swallow } from "../state/toast";
import {
    IconAgent,
    IconArrowDown,
    IconArrowUp,
    IconCheck,
    IconClose,
    IconCommand,
    IconFile,
    IconPlus,
    IconShieldBolt,
    IconTimer,
    IconWarning,
} from "../components/Icons";
import { chatReducer, initialChatState } from "./reducer";
import { localImagePath, localPath, useImagePreview } from "./imagePreview";
import type { AcpAsyncTask, AcpAvailableCommand, AcpPermissionRequest, AcpSubagent, AcpToolCall, ChatMessage, ChatPart, ChatState } from "./types";

const MAX_ATTACHMENTS = 32;
const MAX_DETAIL_CHARS = 120_000;

function recordOf(value: unknown): Record<string, unknown> | null {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function eventMessage(event: AcpEvent): string {
    return typeof event.payload.message === "string" ? event.payload.message : "ACP session failed";
}

function formatDetail(value: unknown): string {
    let formatted: string;
    try {
        formatted = JSON.stringify(value, null, 2) ?? String(value);
    } catch {
        formatted = String(value);
    }
    return formatted.length > MAX_DETAIL_CHARS ? `${formatted.slice(0, MAX_DETAIL_CHARS)}\n… output truncated` : formatted;
}

function permissionRequest(payload: Record<string, unknown>): AcpPermissionRequest | null {
    const requestId = typeof payload.requestId === "string" ? payload.requestId : null;
    const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : null;
    const toolCall = recordOf(payload.toolCall);
    const options = Array.isArray(payload.options) ? payload.options : null;
    if (!requestId || !sessionId || !toolCall || typeof toolCall.toolCallId !== "string" || !options) return null;
    return {
        requestId,
        sessionId,
        toolCall: { ...toolCall, toolCallId: toolCall.toolCallId, title: typeof toolCall.title === "string" ? toolCall.title : "Agent tool" },
        options: options.flatMap((option) => {
            const row = recordOf(option);
            return row && typeof row.optionId === "string" && typeof row.name === "string" && typeof row.kind === "string"
                ? [{ optionId: row.optionId, name: row.name, kind: row.kind }]
                : [];
        }),
    };
}

function statusFromEvent(event: AcpEvent): "connecting" | "installing" | "starting" | "initializing" | "ready" | "stopped" | "error" {
    const value = event.payload.state;
    return value === "installing" || value === "starting" || value === "initializing" || value === "ready" || value === "stopped" || value === "error"
        ? value
        : "connecting";
}

function mergePaths(current: string[], incoming: readonly string[]): string[] {
    const merged = [...current];
    for (const path of incoming) {
        if (!path || path.includes("\0") || merged.includes(path)) continue;
        if (merged.length === MAX_ATTACHMENTS) break;
        merged.push(path);
    }
    return merged;
}

// Splits `mcp__server__tool` so the server name can be de-emphasized.
function toolLabel(title: string): { scope?: string; name: string } {
    const segments = title.split("__");
    return segments[0] === "mcp" && segments.length > 2 ? { scope: segments[1], name: segments.slice(2).join("__") } : { name: title };
}

function ToolPart({ tool }: { tool: AcpToolCall }) {
    const status = tool.status ?? "pending";
    const complete = status === "completed";
    const failed = status === "failed";
    const detail = tool.rawOutput ?? tool.rawInput ?? tool.content;
    const { scope, name } = toolLabel(tool.title);
    const head = (
        <>
            <span className="chat-tool-mark">
                {complete ? <IconCheck size={11} /> : failed ? <IconWarning size={11} /> : <IconCommand size={11} />}
            </span>
            {scope && <span className="chat-tool-scope">{scope}</span>}
            <span className="chat-tool-name">{name}</span>
            {!complete && <span className="chat-tool-status">{status.replace(/_/g, " ")}</span>}
        </>
    );
    if (detail === undefined) return <div className={`chat-tool status-${status} bare`}>{head}</div>;
    return (
        <details className={`chat-tool status-${status}`}>
            <summary>{head}</summary>
            <pre>{formatDetail(detail)}</pre>
        </details>
    );
}

function openLink(href: string) {
    const path = localPath(href);
    if (path) void fsapi.revealInFinder(path).catch(swallow("reveal chat file"));
    else void invoke("open_url", { url: href, app: null, shortcut: null }).catch(swallow("open chat link"));
}

function ChatImage({ src, path, className = "chat-image" }: { src: string; path: string; className?: string }) {
    return (
        <button type="button" className="chat-image-button" title={path} onClick={() => openLink(path)}>
            <img className={className} alt={basename(path)} src={src} />
        </button>
    );
}

/* An agent writes an attached file back as a link to it. A picture beats its
   percent-encoded name, so show the picture whenever we can read it. */
function ChatLink({ href, children }: { href?: string; children?: ReactNode }) {
    const imagePath = localImagePath(href);
    const preview = useImagePreview(imagePath);
    if (preview && imagePath) return <ChatImage src={preview} path={imagePath} />;
    return (
        <a
            href={href}
            onClick={(event) => {
                event.preventDefault();
                if (href) openLink(href);
            }}>
            {children}
        </a>
    );
}

const markdownComponents = { a: ChatLink };

function ResourceLinkPart({ content }: { content: Extract<ChatPart, { kind: "content" }>["content"] }) {
    const uri = typeof content.uri === "string" ? content.uri : undefined;
    const imagePath = localImagePath(uri);
    const preview = useImagePreview(imagePath);
    if (preview && imagePath) return <ChatImage src={preview} path={imagePath} />;
    return (
        <div className="chat-resource">
            <IconFile size={13} />
            <span>{content.title || content.name || uri || "Resource"}</span>
        </div>
    );
}

function ContentPart({ part }: { part: Extract<ChatPart, { kind: "content" }> }) {
    const content = part.content;
    if (content.type === "resource_link") return <ResourceLinkPart content={content} />;
    if (content.type === "image" && typeof content.data === "string" && typeof content.mimeType === "string") {
        return <img className="chat-image" alt="Agent attachment" src={`data:${content.mimeType};base64,${content.data}`} />;
    }
    return <pre className="chat-unknown-part">{formatDetail(content)}</pre>;
}

function MessagePart({ part }: { part: ChatPart }) {
    if (part.kind === "text") {
        return (
            <div className="chat-markdown">
                <Markdown remarkPlugins={[remarkGfm]} skipHtml components={markdownComponents}>
                    {part.text}
                </Markdown>
            </div>
        );
    }
    if (part.kind === "thought") {
        return (
            <details className="chat-thought">
                <summary>Reasoning</summary>
                <div className="chat-markdown">
                    <Markdown remarkPlugins={[remarkGfm]} skipHtml components={markdownComponents}>
                        {part.text}
                    </Markdown>
                </div>
            </details>
        );
    }
    if (part.kind === "tool") return <ToolPart tool={part.tool} />;
    if (part.kind === "subagent") return <SubagentPart subagent={part.subagent} />;
    return <ContentPart part={part} />;
}

function SentAttachment({ path }: { path: string }) {
    const preview = useImagePreview(path);
    if (preview) return <ChatImage src={preview} path={path} className="chat-attachment-thumb" />;
    return (
        <span title={path}>
            <IconFile size={12} />
            {basename(path)}
        </span>
    );
}

function ComposerAttachment({ path, onRemove }: { path: string; onRemove: () => void }) {
    const preview = useImagePreview(path);
    const remove = (
        <button type="button" aria-label={`Remove ${basename(path)}`} onClick={onRemove}>
            <IconClose size={11} />
        </button>
    );
    if (preview)
        return (
            <span className="image" title={path}>
                <img alt={basename(path)} src={preview} />
                {remove}
            </span>
        );
    return (
        <span title={path}>
            <IconFile size={14} />
            <span>{basename(path)}</span>
            {remove}
        </span>
    );
}

type PartGroup = { id: string; tools: Extract<ChatPart, { kind: "tool" }>[] } | { id: string; part: ChatPart };

function groupParts(parts: ChatPart[]): PartGroup[] {
    const groups: PartGroup[] = [];
    for (const part of parts) {
        const last = groups.at(-1);
        if (part.kind !== "tool") groups.push({ id: part.id, part });
        else if (last && "tools" in last) last.tools.push(part);
        else groups.push({ id: part.id, tools: [part] });
    }
    return groups;
}

function PartGroups({ parts }: { parts: ChatPart[] }) {
    return groupParts(parts).map((group) =>
        "tools" in group ? (
            <div className="chat-tools" key={group.id}>
                {group.tools.map((part) => (
                    <ToolPart key={part.id} tool={part.tool} />
                ))}
            </div>
        ) : (
            <MessagePart key={group.id} part={group.part} />
        ),
    );
}

function SubagentPart({ subagent }: { subagent: AcpSubagent }) {
    const parts = subagent.messages.flatMap((message) => message.parts);
    return (
        <details className={`chat-subagent state-${subagent.state}`}>
            <summary>
                <span className="chat-subagent-mark">
                    <IconAgent size={11} />
                </span>
                <span className="chat-subagent-name">{subagent.name}</span>
                <span className="chat-subagent-task">{subagent.task}</span>
                <span className="chat-subagent-state">{subagent.state}</span>
            </summary>
            <div className="chat-subagent-body">
                {parts.length > 0 ? <PartGroups parts={parts} /> : <span className="chat-subagent-empty">No output yet.</span>}
            </div>
        </details>
    );
}

function BackgroundTasks({ tasks, stopping, onStop }: { tasks: AcpAsyncTask[]; stopping: string[]; onStop: (taskId: string) => void }) {
    if (tasks.length === 0) return null;
    return (
        <div className="chat-tasks" aria-label="Background tasks">
            {tasks.map((task) => (
                <div className={`chat-task state-${task.state}`} key={task.asyncTaskId}>
                    <IconTimer size={12} />
                    <span className="chat-task-name">{task.name}</span>
                    <span className="chat-task-detail">{task.summary || task.description || task.lastToolName || task.taskType}</span>
                    {task.canStop && (
                        <button
                            type="button"
                            aria-label={`Stop ${task.name}`}
                            disabled={stopping.includes(task.asyncTaskId)}
                            onClick={() => onStop(task.asyncTaskId)}>
                            <IconClose size={10} />
                        </button>
                    )}
                </div>
            ))}
        </div>
    );
}

function connectingLabel(connection: ChatState["connection"]): string | null {
    if (connection === "installing") return "Installing structured-session adapter…";
    if (connection === "starting") return "Starting agent adapter…";
    if (connection === "connecting" || connection === "initializing") return "Connecting to agent session…";
    return null;
}

function elapsedLabel(seconds: number): string {
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/* Keeps its own clock so a ticking second redraws this row alone, not the
   whole transcript. */
function ChatActivity({ label }: { label: string }) {
    const [seconds, setSeconds] = useState(0);
    useEffect(() => {
        const started = Date.now();
        const timer = window.setInterval(() => setSeconds(Math.round((Date.now() - started) / 1000)), 1000);
        return () => window.clearInterval(timer);
    }, []);
    return (
        <div className="chat-activity" role="status">
            <span className="chat-activity-loader" aria-hidden="true" />
            <span className="chat-activity-label">{label}</span>
            {seconds > 0 && (
                <span className="chat-activity-elapsed" aria-hidden="true">
                    {elapsedLabel(seconds)}
                </span>
            )}
        </div>
    );
}

const ChatMessageRow = memo(function ChatMessageRow({ message }: { message: ChatMessage }) {
    return (
        <article className={`chat-message ${message.role}`}>
            <div className="chat-message-content">
                {message.attachments && message.attachments.length > 0 && (
                    <div className="chat-message-attachments">
                        {message.attachments.map((path) => (
                            <SentAttachment key={path} path={path} />
                        ))}
                    </div>
                )}
                <PartGroups parts={message.parts} />
            </div>
        </article>
    );
});

function SlashCommands({
    commands,
    selected,
    onSelect,
}: {
    commands: AcpAvailableCommand[];
    selected: number;
    onSelect: (command: AcpAvailableCommand) => void;
}) {
    return (
        <div className="chat-slash-menu" role="listbox" aria-label="Session commands">
            <div className="chat-slash-heading">
                <span>Session commands</span>
                <span>ACP</span>
            </div>
            {commands.map((command, index) => (
                <button
                    key={command.name}
                    type="button"
                    role="option"
                    aria-selected={index === selected}
                    className={index === selected ? "selected" : ""}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => onSelect(command)}>
                    <code>/{command.name}</code>
                    <span>{command.description}</span>
                    {command.input?.hint && <em>{command.input.hint}</em>}
                </button>
            ))}
        </div>
    );
}

function PermissionRequest({ request, busy, onReply }: { request: AcpPermissionRequest; busy: boolean; onReply: (optionId?: string) => void }) {
    return (
        <section className="chat-permission" aria-label={`Permission required for ${request.toolCall.title}`}>
            <div className="chat-permission-copy">
                <IconShieldBolt size={16} />
                <div>
                    <strong>{request.toolCall.title}</strong>
                    <span>Agent needs permission before this tool can continue.</span>
                </div>
            </div>
            <div className="chat-permission-actions">
                {request.options.map((option) => (
                    <button
                        key={option.optionId}
                        type="button"
                        disabled={busy}
                        className={option.kind.startsWith("reject") ? "reject" : "allow"}
                        onClick={() => onReply(option.optionId)}>
                        {option.name}
                    </button>
                ))}
                {!request.options.some((option) => option.kind.startsWith("reject")) && (
                    <button type="button" disabled={busy} className="reject" onClick={() => onReply()}>
                        Cancel
                    </button>
                )}
            </div>
        </section>
    );
}

export function AgentChatPane({
    agent,
    profile,
    cwd,
    active,
    visible = active,
    onBusyChange,
}: {
    agent: Agent;
    profile?: ProviderProfile;
    cwd: string;
    active: boolean;
    visible?: boolean;
    onBusyChange: (busy: boolean) => void;
}) {
    const [state, dispatch] = useReducer(chatReducer, initialChatState);
    const displayStateRef = useRef(state);
    if (visible) displayStateRef.current = state;
    const displayState = displayStateRef.current;
    const [draft, setDraft] = useState("");
    const [attachments, setAttachments] = useState<string[]>([]);
    const [slashSelection, setSlashSelection] = useState(0);
    const [slashDismissed, setSlashDismissed] = useState(false);
    const [composerError, setComposerError] = useState<string | null>(null);
    const [replyingPermission, setReplyingPermission] = useState<string | null>(null);
    const [stoppingTasks, setStoppingTasks] = useState<string[]>([]);
    const [atBottom, setAtBottom] = useState(true);
    const [restartKey, setRestartKey] = useState(0);
    const paneRef = useRef<HTMLDivElement>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const scrollContentRef = useRef<HTMLDivElement>(null);
    const stickToBottomRef = useRef(true);
    const lastScrollTopRef = useRef(0);
    const editorRef = useRef<HTMLTextAreaElement>(null);
    const queuedUpdatesRef = useRef<[string, Record<string, unknown>][]>([]);
    const updateFrameRef = useRef<number | null>(null);
    const agentRef = useRef(agent);
    agentRef.current = agent;
    const agentLockedRef = useRef(false);
    if (state.messages.length > 0) agentLockedRef.current = true;
    const sessionIdRef = useRef<string | null>(null);
    const lifecycleRef = useRef<Promise<unknown>>(Promise.resolve());
    const [changingConfig, setChangingConfig] = useState(false);
    const configPending = useRef(false);
    const [changingPermissions, setChangingPermissions] = useState(false);
    const [appliedPermissionMode, setAppliedPermissionMode] = useState<string | null>(null);
    const environmentKeys = JSON.stringify(profile?.environmentKeys ?? []);
    const permissionMode = agent.permissionMode ?? (agent.skipPermissions ? "bypass" : "workspace-write");

    const virtualizer = useVirtualizer({
        count: displayState.messages.length,
        getScrollElement: () => scrollRef.current,
        estimateSize: () => 76,
        overscan: 8,
        getItemKey: (index) => displayState.messages[index]?.id ?? index,
    });

    useEffect(() => {
        if (!active) return;
        const backendState =
            state.connection === "error" || state.connection === "stopped"
                ? "stopped"
                : state.permissions.length > 0
                  ? "blocked"
                  : state.running
                    ? "working"
                    : state.connection === "ready"
                      ? "idle"
                      : "unknown";
        cmd.noteAcpAgentState(agent.id, backendState);
    }, [active, agent.id, state.connection, state.running, state.permissions.length]);

    useEffect(() => onBusyChange(state.running), [onBusyChange, state.running]);

    useEffect(() => {
        const element = paneRef.current;
        if (!element) return;
        return registerPathDrop(element, (paths) => {
            setAttachments((current) => mergePaths(current, paths));
            setComposerError(null);
            window.requestAnimationFrame(() => editorRef.current?.focus());
        });
    }, []);

    /* The composer is disabled until the session connects, and focus put on a
       disabled field goes nowhere — so a chat has to be focused again once it
       is ready, not only when its pane appears. */
    useEffect(() => {
        if (!visible || state.connection !== "ready") return;
        const held = document.activeElement;
        if (held?.closest('input, textarea, [contenteditable="true"]') && !paneRef.current?.contains(held)) return;
        const frame = window.requestAnimationFrame(() => editorRef.current?.focus());
        return () => window.cancelAnimationFrame(frame);
    }, [state.connection, visible]);

    useEffect(() => {
        if (!active) return;
        const controller = new AbortController();
        let mounted = true;
        dispatch({ type: "reset" });
        setAppliedPermissionMode(null);
        setChangingPermissions(false);
        sessionIdRef.current = null;

        const flushUpdates = () => {
            if (updateFrameRef.current !== null) {
                window.cancelAnimationFrame(updateFrameRef.current);
                updateFrameRef.current = null;
            }
            const updates = queuedUpdatesRef.current.splice(0);
            for (const [sessionId, update] of updates) dispatch({ type: "session_update", sessionId, update });
        };

        const queueUpdate = (sessionId: string, update: Record<string, unknown>) => {
            queuedUpdatesRef.current.push([sessionId, update]);
            if (updateFrameRef.current === null) updateFrameRef.current = window.requestAnimationFrame(flushUpdates);
        };

        const handleEvent = (event: AcpEvent) => {
            if (!mounted || event.agentId !== agent.id) return;
            if (event.kind !== "session_update") flushUpdates();
            if (event.kind === "status") dispatch({ type: "status", state: statusFromEvent(event) });
            else if (event.kind === "ready") {
                dispatch({
                    type: "ready",
                    capabilities: recordOf(event.payload.capabilities) ?? {},
                    setup: recordOf(event.payload.setup) ?? {},
                });
            } else if (event.kind === "session_update") {
                const update = recordOf(event.payload.update);
                const sessionId = typeof event.payload.sessionId === "string" ? event.payload.sessionId : null;
                if (update && sessionId) queueUpdate(sessionId, update);
            } else if (event.kind === "turn_started") {
                if (sessionIdRef.current && agentRef.current.resumeId !== sessionIdRef.current) {
                    cmd.attachAgentSession(agent.id, sessionIdRef.current);
                }
                dispatch({ type: "turn_started" });
            } else if (event.kind === "turn_completed") {
                dispatch({
                    type: "turn_completed",
                    stopReason: typeof event.payload.stopReason === "string" ? event.payload.stopReason : undefined,
                });
            } else if (event.kind === "permission_request") {
                const request = permissionRequest(event.payload);
                if (request) dispatch({ type: "permission_requested", request });
            } else if (event.kind === "error") dispatch({ type: "error", message: eventMessage(event) });
        };

        const lifecycle = lifecycleRef.current
            .catch(() => {})
            .then(async () => {
                if (!mounted) return;
                await acpApi.subscribe(handleEvent, controller.signal);
                if (!mounted) return;
                const current = agentRef.current;
                const initialMode = current.permissionMode ?? (current.skipPermissions ? "bypass" : "workspace-write");
                const response = await acpApi.start({
                    agentId: current.id,
                    provider: current.type,
                    cwd,
                    resumeId: current.resumeId,
                    permissionMode: initialMode,
                    configPath: profile?.configPath,
                    executablePath: profile?.executablePath || current.executablePath,
                    model: current.model,
                    effort: current.effort,
                    environmentKeys: JSON.parse(environmentKeys) as string[],
                });
                if (!mounted) return;
                sessionIdRef.current = response.sessionId;
                dispatch({ type: "ready", capabilities: response.capabilities, setup: response.setup });
                setAppliedPermissionMode(initialMode);
            })
            .catch((error: unknown) => {
                if (!controller.signal.aborted && mounted) {
                    dispatch({ type: "error", message: error instanceof Error ? error.message : String(error) });
                }
            });

        lifecycleRef.current = lifecycle;
        return () => {
            mounted = false;
            sessionIdRef.current = null;
            if (updateFrameRef.current !== null) window.cancelAnimationFrame(updateFrameRef.current);
            updateFrameRef.current = null;
            queuedUpdatesRef.current = [];
            controller.abort();
            lifecycleRef.current = lifecycle.finally(() => acpApi.stop(agent.id).catch(() => {}));
        };
    }, [
        active,
        agent.id,
        agent.type,
        agent.profileId,
        agent.executablePath,
        cwd,
        profile?.configPath,
        profile?.executablePath,
        environmentKeys,
        restartKey,
    ]);

    useEffect(() => {
        if (state.connection !== "ready" || changingPermissions || appliedPermissionMode === null || permissionMode === appliedPermissionMode) return;
        const sessionId = sessionIdRef.current;
        setChangingPermissions(true);
        void acpApi
            .setPermissionMode(agent.id, permissionMode)
            .then(() => {
                if (sessionIdRef.current === sessionId) setAppliedPermissionMode(permissionMode);
            })
            .catch((error: unknown) => {
                if (sessionIdRef.current !== sessionId) return;
                const currentMode = agentRef.current.permissionMode ?? (agentRef.current.skipPermissions ? "bypass" : "workspace-write");
                if (currentMode === permissionMode)
                    cmd.setAgentPermissionMode(agent.id, appliedPermissionMode as NonNullable<Agent["permissionMode"]>);
                setComposerError(error instanceof Error ? error.message : String(error));
            })
            .finally(() => {
                if (sessionIdRef.current === sessionId) setChangingPermissions(false);
            });
    }, [agent.id, state.connection, permissionMode, appliedPermissionMode, changingPermissions]);

    useEffect(() => {
        if (state.title && state.title !== agent.title) cmd.setAgentTitle(agent.id, state.title);
    }, [agent.id, agent.title, state.title]);

    /* The scroller's own bottom, not the last message's — a permission card or
       an error sits below the list and still has to be reachable. Idempotent,
       so the observer below can call it until the heights stop moving. */
    const pinToBottom = useCallback(() => {
        const element = scrollRef.current;
        if (!element) return;
        const target = element.scrollHeight - element.clientHeight;
        if (Math.abs(element.scrollTop - target) < 1) return;
        element.scrollTop = target;
        lastScrollTopRef.current = element.scrollTop;
    }, []);

    /*
     * A restored session opens on estimated row heights. Landing at the
     * estimated bottom mounts the real rows, they measure taller, and the
     * bottom moves again — so one scroll after the messages arrive stops
     * short. Watching the content's height instead re-pins through every
     * settling pass, and through markdown and highlighting that arrive late.
     */
    useLayoutEffect(() => {
        const content = scrollContentRef.current;
        if (!content || typeof ResizeObserver === "undefined") return;
        const observer = new ResizeObserver(() => {
            if (stickToBottomRef.current) pinToBottom();
        });
        observer.observe(content);
        return () => observer.disconnect();
    }, [pinToBottom]);

    useLayoutEffect(() => {
        if (!visible || !stickToBottomRef.current || displayState.messages.length === 0) return;
        pinToBottom();
    }, [displayState.messages.length, displayState.revision, pinToBottom, visible]);

    const slashCommands = useMemo(() => {
        if (slashDismissed || !draft.startsWith("/") || /\s/.test(draft.slice(1))) return [];
        const needle = draft.slice(1).toLowerCase();
        return state.commands.filter((command) => command.name.toLowerCase().includes(needle)).slice(0, 8);
    }, [draft, slashDismissed, state.commands]);

    useEffect(() => setSlashSelection(0), [draft]);

    const selectCommand = (command: AcpAvailableCommand) => {
        setDraft(`/${command.name}${command.input?.hint ? " " : ""}`);
        setSlashDismissed(true);
        window.requestAnimationFrame(() => editorRef.current?.focus());
    };

    const send = async () => {
        const text = draft.trim();
        if (
            (!text && attachments.length === 0) ||
            state.running ||
            configPending.current ||
            state.connection !== "ready" ||
            changingPermissions ||
            permissionMode !== appliedPermissionMode
        )
            return;
        const commandName = text.match(/^\/([^\s]+)/)?.[1];
        if (commandName && state.commands.length > 0 && !state.commands.some((command) => command.name === commandName)) {
            setComposerError(`/${commandName} is not available in this session`);
            return;
        }
        const paths = [...attachments];
        setDraft("");
        setAttachments([]);
        setComposerError(null);
        setSlashDismissed(false);
        dispatch({ type: "local_prompt", text, paths });
        try {
            await acpApi.prompt(agent.id, text, paths);
        } catch (error) {
            dispatch({ type: "error", message: error instanceof Error ? error.message : String(error) });
        }
    };

    const chooseFiles = async () => {
        try {
            const selected = await open({ multiple: true, directory: false });
            if (!selected) return;
            setAttachments((current) => mergePaths(current, Array.isArray(selected) ? selected : [selected]));
            window.requestAnimationFrame(() => editorRef.current?.focus());
        } catch (error) {
            setComposerError(error instanceof Error ? error.message : String(error));
        }
    };

    const stopTask = async (taskId: string) => {
        setStoppingTasks((current) => [...current, taskId]);
        try {
            await acpApi.stopTask(agent.id, taskId);
        } catch (error) {
            setComposerError(error instanceof Error ? error.message : String(error));
        } finally {
            setStoppingTasks((current) => current.filter((candidate) => candidate !== taskId));
        }
    };

    const replyPermission = async (requestId: string, optionId?: string) => {
        setReplyingPermission(requestId);
        try {
            await acpApi.permissionReply(agent.id, requestId, optionId);
            dispatch({ type: "permission_cleared", requestId });
        } catch (error) {
            setComposerError(error instanceof Error ? error.message : String(error));
        } finally {
            setReplyingPermission(null);
        }
    };

    const permission = permissionCopyForType(agent.type, permissionMode);
    const changeConfig = async (config: SessionConfig, value: string) => {
        if (configPending.current || state.running || changingPermissions) return;
        configPending.current = true;
        setChangingConfig(true);
        setComposerError(null);
        const sessionId = sessionIdRef.current;
        try {
            const response = await acpApi.setConfig(agent.id, config.id, value);
            if (sessionIdRef.current !== sessionId) return;
            dispatch({ type: "config", options: response.configOptions });
            const options = sessionConfigs({ configOptions: response.configOptions });
            const model = options.find((option) => option.id === "model")?.currentValue ?? agent.model;
            const effort =
                options.find((option) => option.id === (agent.type === "claude" ? "effort" : "reasoning_effort"))?.currentValue ?? agent.effort;
            const knownEffort = ["off", "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(effort ?? "")
                ? (effort as Agent["effort"])
                : undefined;
            cmd.setAgentModelPreferences(agent.id, model, knownEffort);
        } catch (error) {
            if (sessionIdRef.current === sessionId) setComposerError(error instanceof Error ? error.message : String(error));
        } finally {
            configPending.current = false;
            setChangingConfig(false);
        }
    };
    const activeTool = useMemo(() => {
        const parts = displayState.messages.at(-1)?.parts ?? [];
        for (let index = parts.length - 1; index >= 0; index -= 1) {
            const part = parts[index];
            if (part.kind !== "tool") continue;
            const status = part.tool.status ?? "pending";
            return status === "completed" || status === "failed" ? null : toolLabel(part.tool.title).name;
        }
        return null;
    }, [displayState.messages]);
    const connecting = connectingLabel(displayState.connection);
    /* A permission card already says what the turn is waiting on, so a spinner
       beside it would only compete with it. */
    const activity =
        displayState.permissions.length > 0
            ? null
            : displayState.running
              ? (activeTool ?? "Thinking…")
              : displayState.messages.length > 0
                ? connecting
                : null;
    const composerPlaceholder =
        state.connection === "ready"
            ? "Ask about this project, or type / for commands"
            : state.connection === "error" || state.connection === "stopped"
              ? "Reconnect to continue this conversation"
              : state.connection === "installing"
                ? "Installing structured-session adapter…"
                : state.connection === "starting"
                  ? "Starting agent adapter…"
                  : "Connecting to agent session…";

    return (
        <div className="agent-chat-pane" ref={paneRef}>
            <div
                className="chat-scroll"
                ref={scrollRef}
                onScroll={(event) => {
                    const element = event.currentTarget;
                    const previous = lastScrollTopRef.current;
                    lastScrollTopRef.current = element.scrollTop;
                    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
                    // Content that grows or collapses moves the bottom on its
                    // own. Sitting at the bottom means stuck; only a scroll
                    // upwards from elsewhere means the reader walked away.
                    const next = distance < 72 ? true : element.scrollTop < previous - 1 ? false : stickToBottomRef.current;
                    if (next === stickToBottomRef.current) return;
                    stickToBottomRef.current = next;
                    setAtBottom(next);
                }}>
                <div className="chat-scroll-content" ref={scrollContentRef}>
                    {displayState.messages.length === 0 && (
                        <div className={`chat-connection-state ${displayState.connection}`} role="status">
                            {connecting && <span className="chat-activity-loader" aria-hidden="true" />}
                            <span>
                                {connecting ??
                                    (displayState.connection === "ready"
                                        ? "Start a session with this project."
                                        : displayState.connection === "error"
                                          ? "Structured session unavailable."
                                          : "Agent session stopped.")}
                            </span>
                            {(displayState.connection === "error" || displayState.connection === "stopped") && (
                                <button type="button" onClick={() => setRestartKey((value) => value + 1)}>
                                    Retry
                                </button>
                            )}
                        </div>
                    )}
                    {displayState.connection === "error" && agent.resumeId && (
                        <button
                            type="button"
                            onClick={() =>
                                cmd.addAgent(agent.type, undefined, undefined, {
                                    permissionMode: agent.permissionMode,
                                    profileId: agent.profileId,
                                    detectedExecutablePath: profile?.executablePath || agent.executablePath,
                                    cwd,
                                })
                            }>
                            Start new chat
                        </button>
                    )}
                    <div className="chat-virtual-space" style={{ height: `${virtualizer.getTotalSize()}px` }}>
                        {virtualizer.getVirtualItems().map((item) => {
                            const message = displayState.messages[item.index];
                            return (
                                <div
                                    key={message.id}
                                    data-index={item.index}
                                    ref={virtualizer.measureElement}
                                    className="chat-virtual-row"
                                    style={{ transform: `translateY(${item.start}px)` }}>
                                    <ChatMessageRow message={message} />
                                </div>
                            );
                        })}
                    </div>
                    {activity && <ChatActivity key={displayState.running ? "turn" : "connect"} label={activity} />}
                    {displayState.plan !== null && (
                        <details className="chat-plan">
                            <summary>Plan</summary>
                            <pre>{formatDetail(displayState.plan)}</pre>
                        </details>
                    )}
                    {displayState.permissions.map((request) => (
                        <PermissionRequest
                            key={request.requestId}
                            request={request}
                            busy={replyingPermission === request.requestId}
                            onReply={(optionId) => void replyPermission(request.requestId, optionId)}
                        />
                    ))}
                    {displayState.error && (
                        <div className="chat-error" role="alert">
                            <IconWarning size={14} />
                            <span>{displayState.error}</span>
                        </div>
                    )}
                    {displayState.messages.length > 0 && (displayState.connection === "error" || displayState.connection === "stopped") && (
                        <button type="button" onClick={() => setRestartKey((value) => value + 1)}>
                            Reconnect
                        </button>
                    )}
                </div>
            </div>

            {!atBottom && displayState.messages.length > 0 && (
                <button
                    type="button"
                    className="chat-jump-bottom"
                    aria-label="Jump to latest message"
                    onClick={() => {
                        stickToBottomRef.current = true;
                        setAtBottom(true);
                        pinToBottom();
                    }}>
                    <IconArrowDown size={14} />
                </button>
            )}

            <div className="chat-composer-wrap">
                <BackgroundTasks tasks={displayState.tasks} stopping={stoppingTasks} onStop={(taskId) => void stopTask(taskId)} />
                <div className="chat-composer">
                    {slashCommands.length > 0 && <SlashCommands commands={slashCommands} selected={slashSelection} onSelect={selectCommand} />}
                    {attachments.length > 0 && (
                        <div className="chat-attachments">
                            {attachments.map((path) => (
                                <ComposerAttachment
                                    key={path}
                                    path={path}
                                    onRemove={() => setAttachments((current) => current.filter((candidate) => candidate !== path))}
                                />
                            ))}
                        </div>
                    )}
                    <textarea
                        ref={editorRef}
                        value={draft}
                        disabled={state.connection !== "ready"}
                        aria-label="Message agent"
                        placeholder={composerPlaceholder}
                        rows={3}
                        onChange={(event) => {
                            setDraft(event.target.value);
                            setComposerError(null);
                            setSlashDismissed(false);
                        }}
                        onKeyDown={(event) => {
                            if (slashCommands.length > 0) {
                                if (event.key === "ArrowDown") {
                                    event.preventDefault();
                                    setSlashSelection((current) => (current + 1) % slashCommands.length);
                                    return;
                                }
                                if (event.key === "ArrowUp") {
                                    event.preventDefault();
                                    setSlashSelection((current) => (current - 1 + slashCommands.length) % slashCommands.length);
                                    return;
                                }
                                if (event.key === "Tab" || event.key === "Enter") {
                                    event.preventDefault();
                                    selectCommand(slashCommands[slashSelection]);
                                    return;
                                }
                                if (event.key === "Escape") {
                                    event.preventDefault();
                                    setSlashDismissed(true);
                                    return;
                                }
                            }
                            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                                event.preventDefault();
                                void send();
                            }
                        }}
                    />
                    {composerError && <div className="chat-composer-error">{composerError}</div>}
                    <div className="chat-composer-bar">
                        <button type="button" className="chat-composer-icon" aria-label="Add files" onClick={() => void chooseFiles()}>
                            <IconPlus size={17} />
                        </button>
                        <button
                            type="button"
                            className={`chat-permission-mode tone-${permission.tone}`}
                            disabled={
                                state.connection !== "ready" ||
                                changingConfig ||
                                state.running ||
                                state.permissions.length > 0 ||
                                changingPermissions ||
                                permissionMode !== appliedPermissionMode
                            }
                            title={permission.detail}
                            onClick={() => cmd.toggleAgentSkipPermissions(agent.id)}>
                            <IconShieldBolt size={14} />
                            <span>{permission.label}</span>
                        </button>
                        <ComposerPickers
                            agent={agent}
                            profile={profile}
                            setup={state.setup}
                            agentLocked={agentLockedRef.current}
                            disabled={
                                state.connection !== "ready" || state.running || changingPermissions || changingConfig || state.permissions.length > 0
                            }
                            onAgent={(type, profileId) => {
                                if (agentLockedRef.current || state.running || state.permissions.length > 0) return;
                                cmd.configureEmptyAgent(agent.id, type, profileId);
                            }}
                            onConfig={(config, value) => void changeConfig(config, value)}
                        />
                        <span className="chat-composer-spacer" />
                        {state.running ? (
                            <button
                                type="button"
                                className="chat-send stop"
                                aria-label="Stop agent"
                                onClick={() =>
                                    void acpApi
                                        .cancel(agent.id)
                                        .catch((error: unknown) => setComposerError(error instanceof Error ? error.message : String(error)))
                                }>
                                <span />
                            </button>
                        ) : (
                            <button
                                type="button"
                                className="chat-send"
                                aria-label="Send message"
                                disabled={
                                    state.connection !== "ready" ||
                                    changingConfig ||
                                    changingPermissions ||
                                    permissionMode !== appliedPermissionMode ||
                                    (!draft.trim() && attachments.length === 0)
                                }
                                onClick={() => void send()}>
                                <IconArrowUp size={18} />
                            </button>
                        )}
                    </div>
                </div>
            </div>
            <div className="chat-drop-target" aria-hidden="true">
                <IconFile size={22} />
                <span>Drop files or folders into this session</span>
            </div>
        </div>
    );
}
