import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { acpApi, type AcpEvent } from "../api/acp";
import { effortConfig, sessionConfigs, type SessionConfig } from "./ComposerPickers";
import { rowMeta } from "./messageMeta";
import { animate } from "../lib/motion";
import type { Agent, ProviderProfile } from "../state/types";
import * as cmd from "../state/commands";
import { useStore } from "../state/store";
import { IconArrowDown, IconFile, IconPlug, IconWarning } from "../ui/Icons";
import { chatReducer, initialChatState } from "./reducer";
import { PathRootsProvider } from "./FileRef";
import { ChatWelcome } from "./ChatWelcome";
import { guessClaudeWindow } from "./contextWindow";
import { agentApi } from "../api/agents";
import { FoldMemoryContext, newFoldMemory } from "./longText";
import { sentPrompts } from "./promptHistory";
import { eventMessage, permissionRequest, recordOf, statusFromEvent } from "./acpEvents";
import { activeToolLabel } from "./toolLabels";
import { combineQueued, nextBatch, type QueuedMessage } from "./queuedMessages";
import { formatDetail, runningSubagents } from "./transcript";
import {
    activityText,
    backendState,
    composerPlaceholder as placeholderFor,
    connectingLabel,
    knownEffort,
    permissionModeOf,
    RECONNECT_DELAYS,
} from "./chatStatus";
import { ChatAgentContext } from "./chatAgent";
import { ChatMessageRow } from "./ChatMessageRow";
import { ChatActivity } from "./ChatActivity";
import { PermissionRequest } from "./PermissionRequest";
import { BackgroundTasks, QueuedMessages, RunningSubagents } from "./LiveStack";
import { ChatComposer } from "./ChatComposer";

const UPDATE_FLUSH_FALLBACK_MS = 250;
// How far above the last line still counts as reading the latest message.
const BOTTOM_SLACK = 72;

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
    const home = useStore((s) => s.home);
    const [state, dispatch] = useReducer(chatReducer, initialChatState);
    const [foldMemory] = useState(newFoldMemory);
    const displayStateRef = useRef(state);
    if (visible) displayStateRef.current = state;
    const displayState = displayStateRef.current;
    const [queued, setQueued] = useState<QueuedMessage[]>([]);
    const sentHistory = useMemo(
        () =>
            sentPrompts(
                state.messages,
                queued.map((message) => message.text),
            ),
        [state.messages, queued],
    );
    const queuedCount = useRef(0);
    const [composerError, setComposerError] = useState<string | null>(null);
    const [replyingPermission, setReplyingPermission] = useState<string | null>(null);
    const [stoppingTasks, setStoppingTasks] = useState<string[]>([]);
    const [atBottom, setAtBottom] = useState(true);
    const [restartKey, setRestartKey] = useState(0);
    const [reconnectAttempt, setReconnectAttempt] = useState(0);
    const paneRef = useRef<HTMLDivElement>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const scrollContentRef = useRef<HTMLDivElement>(null);
    const stickToBottomRef = useRef(true);
    const lastScrollTopRef = useRef(0);
    const lastGestureRef = useRef(0);
    const queuedUpdatesRef = useRef<[string, Record<string, unknown>][]>([]);
    const updateFrameRef = useRef<number | null>(null);
    const updateTimerRef = useRef<number | null>(null);
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
    const permissionMode = permissionModeOf(agent);

    /* A restored transcript opens on estimated row heights, and every row that
       measures taller or shorter than the estimate moves the bottom. Anchoring
       to the end makes the list hold the bottom still while that settles. */
    /* A message that has just arrived rises into place. Only new ones: a row
       the list remounts on scroll, or a transcript restored all at once, just shows. */
    const shownMessages = useRef<Set<string> | null>(null);
    useLayoutEffect(() => {
        const ids = displayState.messages.map((message) => message.id);
        const shown = shownMessages.current;
        if (!shown) {
            shownMessages.current = new Set(ids);
            return;
        }
        const fresh = ids.filter((id) => !shown.has(id));
        for (const id of fresh) shown.add(id);
        if (fresh.length === 0 || fresh.length > 2) return;
        for (const id of fresh) {
            const row = scrollRef.current?.querySelector<HTMLElement>(`.chat-virtual-row[data-index="${ids.indexOf(id)}"] > *`);
            animate(
                row,
                [
                    { opacity: 0, transform: "translateY(10px) scale(0.985)" },
                    { opacity: 1, transform: "none" },
                ],
                { duration: 200 },
            );
        }
    }, [displayState.messages]);

    const virtualizer = useVirtualizer({
        count: displayState.messages.length,
        getScrollElement: () => scrollRef.current,
        estimateSize: () => 76,
        overscan: 8,
        anchorTo: "end",
        scrollEndThreshold: BOTTOM_SLACK,
        getItemKey: (index) => displayState.messages[index]?.id ?? index,
        /* Rows are placed from the resize observer itself, in the frame a row
           changes size, rather than on the render after. A row that grows or
           folds by animation then pushes the rest along with it instead of
           overlapping them for a frame and catching up. */
        directDomUpdates: true,
    });

    useEffect(() => {
        if (!active) return;
        cmd.noteAcpAgentState(
            agent.id,
            backendState({ connection: state.connection, awaitingPermission: state.permissions.length > 0, running: state.running }),
        );
    }, [active, agent.id, state.connection, state.running, state.permissions.length]);

    /* A turn ends long before the work it started does. Shells, monitors and
       subagents keep going after the answer, and they die with the agent, so
       what is still running is what says the agent is still in use. */
    const liveTasks = useMemo(() => state.tasks.filter((task) => task.state === "running").length, [state.tasks]);
    const liveSubagents = useMemo(() => runningSubagents(state.messages).length, [state.messages]);
    useEffect(() => cmd.noteAgentBackgroundWork(agent.id, liveTasks, liveSubagents), [agent.id, liveTasks, liveSubagents]);
    useEffect(() => () => cmd.noteAgentBackgroundWork(agent.id, 0, 0), [agent.id]);

    useEffect(() => onBusyChange(state.running), [onBusyChange, state.running]);

    useEffect(() => setQueued([]), [agent.id, cwd]);

    /* A session drops when its adapter exits — a rate limit, a crash, a laptop
       waking up. It resumes itself so the conversation is there to carry on
       with, and only asks once the waits have run out. */
    useEffect(() => {
        if (state.connection === "ready") setReconnectAttempt(0);
    }, [state.connection]);

    useEffect(() => {
        const dropped = state.connection === "error" || state.connection === "stopped";
        if (!active || !dropped || reconnectAttempt >= RECONNECT_DELAYS.length) return;
        const timer = window.setTimeout(() => {
            setReconnectAttempt((value) => value + 1);
            setRestartKey((value) => value + 1);
        }, RECONNECT_DELAYS[reconnectAttempt]);
        return () => window.clearTimeout(timer);
    }, [active, reconnectAttempt, state.connection]);

    const reconnect = useCallback(() => {
        setReconnectAttempt(0);
        setRestartKey((value) => value + 1);
    }, []);

    useEffect(() => {
        if (!active) return;
        const controller = new AbortController();
        let mounted = true;
        const hold = Boolean(agentRef.current.resumeId);
        dispatch({ type: "reset", hold });
        if (!hold) {
            foldMemory.streamed.clear();
            foldMemory.expanded.clear();
        }
        setAppliedPermissionMode(null);
        setChangingPermissions(false);
        sessionIdRef.current = null;

        const flushUpdates = () => {
            if (updateFrameRef.current !== null) {
                window.cancelAnimationFrame(updateFrameRef.current);
                updateFrameRef.current = null;
            }
            if (updateTimerRef.current !== null) {
                window.clearTimeout(updateTimerRef.current);
                updateTimerRef.current = null;
            }
            const updates = queuedUpdatesRef.current.splice(0);
            for (const [sessionId, update] of updates) dispatch({ type: "session_update", sessionId, update });
        };

        /* WebKit stops animation frames for a window that is hidden or behind
           another app, and only the first of those shows in document.hidden.
           A timer keeps the queue draining either way. */
        const queueUpdate = (sessionId: string, update: Record<string, unknown>) => {
            queuedUpdatesRef.current.push([sessionId, update]);
            if (updateTimerRef.current === null) updateTimerRef.current = window.setTimeout(flushUpdates, UPDATE_FLUSH_FALLBACK_MS);
            if (!document.hidden && updateFrameRef.current === null) updateFrameRef.current = window.requestAnimationFrame(flushUpdates);
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
                const batch = Array.isArray(event.payload.updates) ? event.payload.updates : [];
                for (const entry of batch) {
                    const row = recordOf(entry);
                    if (!row) continue;
                    const update = recordOf(row.update);
                    const sessionId = typeof row.sessionId === "string" ? row.sessionId : null;
                    if (update && sessionId) queueUpdate(sessionId, update);
                }
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
                const initialMode = permissionModeOf(current);
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
                flushUpdates();
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
            if (updateTimerRef.current !== null) window.clearTimeout(updateTimerRef.current);
            updateTimerRef.current = null;
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
        foldMemory,
    ]);

    useEffect(() => {
        const sessionId = sessionIdRef.current;
        if (
            sessionId === null ||
            state.connection !== "ready" ||
            changingPermissions ||
            appliedPermissionMode === null ||
            permissionMode === appliedPermissionMode
        )
            return;
        setChangingPermissions(true);
        void acpApi
            .setPermissionMode(agent.id, permissionMode)
            .then(() => {
                if (sessionIdRef.current === sessionId) setAppliedPermissionMode(permissionMode);
            })
            .catch((error: unknown) => {
                if (sessionIdRef.current !== sessionId) return;
                if (permissionModeOf(agentRef.current) === permissionMode)
                    cmd.setAgentPermissionMode(agent.id, appliedPermissionMode as NonNullable<Agent["permissionMode"]>);
                setComposerError(error instanceof Error ? error.message : String(error));
            })
            .finally(() => {
                if (sessionIdRef.current === sessionId) setChangingPermissions(false);
            });
    }, [agent.id, state.connection, permissionMode, appliedPermissionMode, changingPermissions]);

    const setupRef = useRef(state.setup);
    setupRef.current = state.setup;
    const reported = state.usage !== null;
    useEffect(() => {
        const { resumeId, type } = agentRef.current;
        if (state.connection !== "ready" || reported || !resumeId || (type !== "claude" && type !== "codex")) return;
        let current = true;
        void agentApi
            .sessionContext(type, cwd, resumeId, profile?.configPath)
            .then((saved) => {
                if (!current || !saved) return;
                const size = saved.size ?? guessClaudeWindow(setupRef.current, agentRef.current.model);
                dispatch({ type: "saved_usage", usage: { used: saved.used, size } });
            })
            .catch(() => {});
        return () => {
            current = false;
        };
    }, [agent.id, agent.resumeId, cwd, profile?.configPath, state.connection, reported]);

    useEffect(() => {
        if (state.title && state.title !== agent.title) cmd.setAgentTitle(agent.id, state.title);
    }, [agent.id, agent.title, state.title]);

    const promptNow = useCallback(async (text: string, paths: string[]) => {
        dispatch({ type: "local_prompt", text, paths });
        cmd.titleAgentFromPrompt(agentRef.current.id, text);
        try {
            await acpApi.prompt(agentRef.current.id, text, paths);
        } catch (error) {
            dispatch({ type: "error", message: error instanceof Error ? error.message : String(error) });
        }
    }, []);

    /* Messages written mid-turn wait, then go out together as one prompt once
       the running turn ends, so nothing in flight is cut short. */
    useEffect(() => {
        if (state.connection !== "ready" || state.running || queued.length === 0) return;
        const batch = nextBatch(queued);
        const sent = new Set(batch.map((message) => message.id));
        setQueued((current) => current.filter((message) => !sent.has(message.id)));
        const next = combineQueued(batch);
        void promptNow(next.text, next.paths);
    }, [promptNow, queued, state.connection, state.running]);

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

    const noteGesture = useCallback(() => {
        lastGestureRef.current = performance.now();
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

    const steerable = state.capabilities.steering === true;

    const stop = () => {
        void acpApi.cancel(agent.id).catch((failure: unknown) => setComposerError(failure instanceof Error ? failure.message : String(failure)));
    };

    /* Steering stops whatever the agent has in flight so it reads this message
       now, so a message only goes this way when it is asked to. */
    const steer = async (messages: QueuedMessage[]) => {
        const steered = new Set(messages.map((message) => message.id));
        setQueued((current) => current.filter((candidate) => !steered.has(candidate.id)));
        const message = combineQueued(messages);
        dispatch({ type: "local_prompt", text: message.text, paths: message.paths });
        try {
            if ((await acpApi.steer(agent.id, message.text, message.paths)) !== "promptRequired") return;
            await acpApi.prompt(agent.id, message.text, message.paths);
        } catch (error) {
            dispatch({ type: "error", message: error instanceof Error ? error.message : String(error) });
        }
    };

    /** Says whether the composer may clear what it just handed over. */
    const send = (text: string, paths: string[], steerNow: boolean): boolean => {
        const commandName = text.match(/^\/([^\s]+)/)?.[1];
        if (commandName && state.commands.length > 0 && !state.commands.some((command) => command.name === commandName)) {
            setComposerError(`/${commandName} is not available in this session`);
            return false;
        }
        setComposerError(null);
        if (state.connection === "ready" && !state.running) {
            void promptNow(text, paths);
            return true;
        }

        /* Written mid-turn, or while the session is still coming up: it waits
           in the queue and goes out with the rest of it once the session is free. */
        queuedCount.current += 1;
        const message: QueuedMessage = { id: `queued-${queuedCount.current}`, text, paths };
        if (steerNow && steerable && state.running) {
            void steer([...queued, message]);
            return true;
        }
        setQueued((current) => [...current, message]);
        return true;
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
            const effort = effortConfig(options, agent.type)?.currentValue ?? agent.effort;
            cmd.setAgentModelPreferences(agent.id, model, knownEffort(effort));
        } catch (error) {
            if (sessionIdRef.current === sessionId) setComposerError(error instanceof Error ? error.message : String(error));
        } finally {
            configPending.current = false;
            setChangingConfig(false);
        }
    };
    const activeTool = useMemo(() => activeToolLabel(displayState.messages), [displayState.messages]);
    const subagents = useMemo(() => runningSubagents(displayState.messages), [displayState.messages]);
    const plan = useMemo(() => (displayState.plan === null ? null : formatDetail(displayState.plan)), [displayState.plan]);
    const connecting = connectingLabel(displayState.connection);
    const activity = activityText(displayState, activeTool);
    const disconnected = displayState.connection === "error" || displayState.connection === "stopped";
    const reconnecting = disconnected && reconnectAttempt < RECONNECT_DELAYS.length;
    const welcoming = displayState.messages.length === 0 && displayState.connection === "ready";
    const startNewChat = () =>
        cmd.addAgent(agent.type, undefined, undefined, {
            permissionMode: agent.permissionMode,
            profileId: agent.profileId,
            detectedExecutablePath: profile?.executablePath || agent.executablePath,
            cwd,
        });
    const chatAgent = useMemo(() => ({ id: agent.id, type: agent.type }), [agent.id, agent.type]);
    const composerPlaceholder = placeholderFor(state, { reconnecting, disconnected });

    return (
        <PathRootsProvider cwd={cwd} home={home} agentId={chatAgent.id}>
            <ChatAgentContext.Provider value={chatAgent}>
                <div className="agent-chat-pane" ref={paneRef}>
                    <div
                        className="chat-scroll"
                        ref={scrollRef}
                        onWheel={noteGesture}
                        onTouchMove={noteGesture}
                        onMouseDown={noteGesture}
                        onKeyDown={noteGesture}
                        onScroll={(event) => {
                            const element = event.currentTarget;
                            const previous = lastScrollTopRef.current;
                            lastScrollTopRef.current = element.scrollTop;
                            const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
                            // The transcript also scrolls itself, to hold the bottom
                            // still while rows settle into their real heights. Only a
                            // scroll up that a wheel, key or drag just asked for means
                            // the reader walked away; sitting at the bottom means stuck.
                            const gesture = lastGestureRef.current;
                            lastGestureRef.current = 0;
                            const walkedAway = element.scrollTop < previous - 1 && performance.now() - gesture < 150;
                            const next = walkedAway ? false : distance < BOTTOM_SLACK ? true : stickToBottomRef.current;
                            if (next === stickToBottomRef.current) return;
                            stickToBottomRef.current = next;
                            setAtBottom(next);
                        }}>
                        <div className="chat-scroll-content" ref={scrollContentRef}>
                            {welcoming && <ChatWelcome cwd={cwd} agentType={agent.type} />}
                            {displayState.messages.length === 0 && !welcoming && (
                                <div className={`chat-connection-state ${displayState.connection}`} role="status">
                                    {(connecting || reconnecting) && <span className="chat-activity-loader" aria-hidden="true" />}
                                    <span>
                                        {reconnecting
                                            ? "Reconnecting…"
                                            : (connecting ??
                                              (displayState.connection === "error" ? "Structured session unavailable." : "Agent session stopped."))}
                                    </span>
                                    {disconnected && !reconnecting && (
                                        <div className="chat-connection-actions">
                                            <button type="button" onClick={reconnect}>
                                                Reconnect
                                            </button>
                                            {agent.resumeId && (
                                                <button type="button" onClick={startNewChat}>
                                                    Start new chat
                                                </button>
                                            )}
                                        </div>
                                    )}
                                </div>
                            )}
                            <FoldMemoryContext value={foldMemory}>
                                <div className="chat-virtual-space" ref={virtualizer.containerRef}>
                                    {virtualizer.getVirtualItems().map((item) => {
                                        const message = displayState.messages[item.index];
                                        const meta = rowMeta(displayState.messages, item.index);
                                        return (
                                            <div
                                                key={message.id}
                                                data-index={item.index}
                                                ref={virtualizer.measureElement}
                                                className="chat-virtual-row">
                                                <ChatMessageRow
                                                    message={message}
                                                    live={displayState.running && item.index === displayState.messages.length - 1}
                                                    copyable={meta.text}
                                                    rate={meta.rate}
                                                />
                                            </div>
                                        );
                                    })}
                                </div>
                            </FoldMemoryContext>
                            {activity && <ChatActivity key={displayState.running ? "turn" : "connect"} label={activity} agentType={agent.type} />}
                            {plan !== null && (
                                <details className="chat-plan">
                                    <summary>Plan</summary>
                                    <pre>{plan}</pre>
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
                            {displayState.messages.length > 0 && disconnected && (
                                <div className="chat-reconnect" role="status">
                                    {reconnecting ? <span className="chat-activity-loader" aria-hidden="true" /> : <IconPlug size={13} />}
                                    <span>{reconnecting ? "Reconnecting…" : "This session dropped."}</span>
                                    {!reconnecting && (
                                        <div className="chat-connection-actions">
                                            <button type="button" onClick={reconnect}>
                                                Reconnect
                                            </button>
                                            {agent.resumeId && (
                                                <button type="button" onClick={startNewChat}>
                                                    Start new chat
                                                </button>
                                            )}
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>

                    <div className="chat-composer-wrap">
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
                        {(subagents.length > 0 || displayState.tasks.length > 0 || queued.length > 0) && (
                            <div className="chat-live-stack">
                                <RunningSubagents subagents={subagents} />
                                <BackgroundTasks tasks={displayState.tasks} stopping={stoppingTasks} onStop={(taskId) => void stopTask(taskId)} />
                                <QueuedMessages
                                    messages={queued}
                                    steerable={steerable && state.running}
                                    onSteer={(messages) => void steer(messages)}
                                    onDrop={(id) => setQueued((current) => current.filter((message) => message.id !== id))}
                                />
                            </div>
                        )}
                        <ChatComposer
                            agent={agent}
                            profile={profile}
                            paneRef={paneRef}
                            visible={visible}
                            connection={state.connection}
                            running={state.running}
                            steerable={steerable}
                            commands={state.commands}
                            setup={state.setup}
                            awaitingPermission={state.permissions.length > 0}
                            agentLocked={agentLockedRef.current}
                            changingConfig={changingConfig}
                            changingPermissions={changingPermissions}
                            permissionApplied={state.connection !== "ready" || permissionMode === appliedPermissionMode}
                            placeholder={composerPlaceholder}
                            error={composerError}
                            onError={setComposerError}
                            onSend={send}
                            onSteerQueued={() => {
                                if (queued.length > 0) void steer(queued);
                            }}
                            onStop={stop}
                            queuedCount={queued.length}
                            usage={state.usage}
                            onConfig={changeConfig}
                            history={sentHistory}
                        />
                    </div>
                    <div className="chat-drop-target" aria-hidden="true">
                        <IconFile size={22} />
                        <span>Drop files or folders into this session</span>
                    </div>
                </div>
            </ChatAgentContext.Provider>
        </PathRootsProvider>
    );
}
