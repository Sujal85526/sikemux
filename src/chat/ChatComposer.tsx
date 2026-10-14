import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { errorText } from "../lib/format";
import { open } from "@tauri-apps/plugin-dialog";
import { ComposerPickers } from "./ComposerPickers";
import type { SessionConfig } from "./sessionConfig";
import { basename, joinPath } from "../lib/paths";
import { animate } from "../lib/motion";
import { hasPrimaryModifier, PRIMARY_SHORTCUT } from "../lib/platform";
import { registerPathDrop } from "../state/dropRegistry";
import { registerTextInsert } from "../state/textInsertRegistry";
import type { Agent, ProviderProfile } from "../state/types";
import * as cmd from "../state/commands";
import { IconArrowUp, IconClose, IconPlus } from "../ui/Icons";
import { FileTypeIcon } from "../ui/FileIcon";
import { usePathRoots } from "./FileRef";
import { useImagePreview } from "./imagePreview";
import { YoloToggle } from "./YoloToggle";
import type { WorktreeSwitchState } from "./worktreeSwitch";
import { DictateButton } from "./DictateButton";
import { finishDictationInto, useVoice, writesInto } from "../voice/dictation";
import { ContextMeter } from "./ContextMeter";
import { imagesInClipboard, savePastedClipboard } from "./pasteImage";
import { arrowsBrowse, recallPrompt, type HistoryPosition } from "./promptHistory";
import { MAX_MENU_ENTRIES, mergePaths, removeToken, tokenAt, type ProjectEntry } from "./composerInput";
import { canSwitchMode } from "../agents/agentLaunch";
import { AgentMark } from "../agents/AgentMark";
import { receiveForAgent } from "../agents/agentInbox";
import type { AcpAvailableCommand, ChatState, ContextUsage } from "./types";
import type { OutgoingMessage } from "./queuedMessages";
import type { PromptContext } from "../api/acp";
import type { RepoRef } from "../codehost/types";
import type { TrackedItem, TrackedKind } from "../codehost/tracked";
import type { TrackedMatches } from "./TrackedSource";
import { ContextMark } from "./ContextChip";
import { contextChip } from "./promptContext";
import { mentionContext, useMates, type Mate } from "./agentMentions";
import type { EarlierChat } from "./earlierChats";
import type { MenuKeys, MenuPick } from "./ComposerMenu";
import { ComposerMenu, DictationPreview } from "./chatParts";

/** Puts the caret at `at` once the next frame has the new draft in the box. */
function caretTo(editor: RefObject<HTMLTextAreaElement | null>, at: number) {
    window.requestAnimationFrame(() => {
        editor.current?.focus();
        editor.current?.setSelectionRange(at, at);
    });
}

function ComposerAttachment({ path, onRemove }: { path: string; onRemove: () => void }) {
    const preview = useImagePreview(path);
    return (
        <span className={preview ? "image" : "file"} title={path}>
            {preview ? <img alt={basename(path)} src={preview} /> : <FileTypeIcon name={basename(path)} size={34} />}
            <button type="button" aria-label={`Remove ${basename(path)}`} onClick={onRemove}>
                <IconClose size={10} />
            </button>
        </span>
    );
}

/**
 * An item to hand over with the message. One picked with `#` is read in full only when the message is sent, and an
 * earlier chat picked with `@` is opened again only then.
 */
interface ComposerContext {
    uri: string;
    title: string;
    text: string | null;
    tracked: { repo: RepoRef; kind: TrackedKind; number: number } | null;
    earlier?: EarlierChat;
}

function mergeContext(current: ComposerContext[], incoming: readonly ComposerContext[]): ComposerContext[] {
    return [...current, ...incoming.filter((item) => !current.some((other) => other.uri === item.uri))];
}

function readContext(item: ComposerContext): Promise<PromptContext> {
    if (item.text !== null) return Promise.resolve({ uri: item.uri, title: item.title, text: item.text });
    const { earlier } = item;
    if (earlier) return import("./earlierChats").then(({ wakeEarlier }) => wakeEarlier(earlier));
    if (!item.tracked) return Promise.reject(new Error(`${item.title} has nothing to send`));
    const { repo, kind, number } = item.tracked;
    return Promise.all([import("../codehost/tracked"), import("../codehost/api")]).then(([{ loadTrackedContext }, { failureMessage }]) =>
        loadTrackedContext(repo, kind, number).catch((failure: unknown) => {
            throw new Error(`Could not read #${number}: ${failureMessage(failure)}`);
        }),
    );
}

const TrackedSource = lazy(() => import("./TrackedSource"));
const WorktreeToggle = lazy(() => import("./ChatWorktree").then(({ WorktreeToggle }) => ({ default: WorktreeToggle })));

function Chip({
    title,
    mark,
    kind,
    label,
    removeLabel,
    onRemove,
    answering = false,
}: {
    title: string;
    mark: ReactNode;
    kind?: string;
    label: ReactNode;
    removeLabel: string;
    onRemove: () => void;
    answering?: boolean;
}) {
    return (
        <span className={`chat-context-chip${answering ? " answering" : ""}`} title={title}>
            <span className="chat-context-mark" data-kind={kind}>
                {mark}
            </span>
            <span>{label}</span>
            <button type="button" aria-label={removeLabel} onClick={onRemove}>
                <IconClose size={11} />
            </button>
        </span>
    );
}

function ComposerContextChip({ item, onRemove }: { item: ComposerContext; onRemove: () => void }) {
    if (item.earlier) {
        const { agent, title } = item.earlier.chat;
        return (
            <Chip
                title="Sending this opens the chat again under a new name and tells the agent who it is"
                mark={<AgentMark cli={agent} />}
                label={title}
                removeLabel={`Remove ${title}`}
                onRemove={onRemove}
            />
        );
    }
    const chip = contextChip(item);
    return (
        <Chip
            title={item.uri}
            mark={<ContextMark kind={chip.kind} size={14} />}
            kind={chip.kind ?? "other"}
            label={
                <>
                    {chip.number && <span className="chat-context-number">#{chip.number} </span>}
                    {chip.title}
                </>
            }
            removeLabel={`Remove ${chip.number ? `#${chip.number}` : chip.title}`}
            onRemove={onRemove}
        />
    );
}

export interface ComposerAnswering {
    name: string;
    cli: string;
    question: string;
    onRemove: () => void;
}

/* The composer keeps the draft to itself: a keystroke redraws these few rows
   rather than the transcript above them. */
export function ChatComposer({
    agent,
    profile,
    paneRef,
    visible,
    connection,
    running,
    steerable,
    commands,
    setup,
    awaitingPermission,
    agentLocked,
    changingConfig,
    changingPermissions,
    permissionApplied,
    placeholder,
    error,
    onError,
    onSend,
    onSteerQueued,
    onStop,
    queuedCount,
    usage,
    onConfig,
    history,
    worktree,
    answering,
    onDigit,
}: {
    agent: Agent;
    profile?: ProviderProfile;
    paneRef: RefObject<HTMLDivElement | null>;
    visible: boolean;
    connection: ChatState["connection"];
    running: boolean;
    steerable: boolean;
    commands: AcpAvailableCommand[];
    setup: Record<string, unknown>;
    awaitingPermission: boolean;
    agentLocked: boolean;
    changingConfig: boolean;
    changingPermissions: boolean;
    permissionApplied: boolean;
    placeholder: string;
    error: string | null;
    onError: (message: string | null) => void;
    onSend: (message: OutgoingMessage, steerNow: boolean) => boolean;
    onSteerQueued: () => void;
    onStop: () => void;
    queuedCount: number;
    usage: ContextUsage | null;
    onConfig: (config: SessionConfig, value: string) => void;
    history: readonly string[];
    worktree?: { state: WorktreeSwitchState; toggle: () => void };
    /** The question an agent asked that whatever is sent answers. */
    answering?: ComposerAnswering | null;
    /** A number key pressed in the empty box; true when it answered something. */
    onDigit?: (digit: number) => boolean;
}) {
    const [draft, setDraft] = useState("");
    const [historyPosition, setHistoryPosition] = useState<HistoryPosition | null>(null);
    const recalledCaret = useRef<"start" | "end" | null>(null);
    const [caret, setCaret] = useState(0);
    const [attachments, setAttachments] = useState<string[]>([]);
    const [contexts, setContexts] = useState<ComposerContext[]>([]);
    const [reading, setReading] = useState(false);
    const [menuSelection, setMenuSelection] = useState(0);
    const [menuDismissed, setMenuDismissed] = useState(false);
    const editorRef = useRef<HTMLTextAreaElement>(null);
    const { cwd } = usePathRoots();

    /* The field grows with what is typed until it reaches its CSS max-height,
       and scrolls from there. */
    useLayoutEffect(() => {
        const editor = editorRef.current;
        if (!editor) return;
        editor.style.height = "auto";
        editor.style.height = `${editor.scrollHeight}px`;
        // A recalled message opens with the caret where the next arrow press keeps browsing.
        if (recalledCaret.current) {
            const at = recalledCaret.current === "start" ? 0 : draft.length;
            editor.setSelectionRange(at, at);
            setCaret(at);
            recalledCaret.current = null;
        }
    }, [draft]);

    useEffect(() => {
        const element = paneRef.current;
        if (!element) return;
        return registerPathDrop(element, (paths) => {
            setAttachments((current) => mergePaths(current, paths));
            onError(null);
            window.requestAnimationFrame(() => editorRef.current?.focus());
        });
    }, [onError, paneRef]);

    useEffect(() => {
        if (!visible) return;
        return receiveForAgent(agent.id, ({ text, paths, context }) => {
            if (paths?.length) setAttachments((current) => mergePaths(current, paths));
            if (context?.length)
                setContexts((current) =>
                    mergeContext(
                        current,
                        context.map((item) => ({ ...item, tracked: null })),
                    ),
                );
            const editor = editorRef.current;
            const current = editor?.value ?? "";
            const next = text ? `${current.trimEnd()}${current.trim() ? "\n\n" : ""}${text}` : current;
            setDraft(next);
            setCaret(next.length);
            caretTo(editorRef, next.length);
        });
    }, [agent.id, visible]);

    useEffect(() => {
        const element = paneRef.current;
        if (!element) return;
        return registerTextInsert(element, (text) => {
            const editor = editorRef.current;
            if (!editor) return;
            const before = editor.value.slice(0, editor.selectionStart);
            const after = editor.value.slice(editor.selectionEnd);
            const inserted = `${before && !/\s$/.test(before) ? " " : ""}${text}`;
            const at = before.length + inserted.length;
            setDraft(`${before}${inserted}${after}`);
            setCaret(at);
            caretTo(editorRef, at);
        });
    }, [paneRef]);

    /* A chat is focused again once its session is ready, not only when its pane
       appears: a pane opened while the agent was still starting would otherwise
       keep the caret wherever it was. */
    useEffect(() => {
        if (!visible) return;
        const focusIsElsewhere = () => {
            const held = document.activeElement;
            if (held?.closest('input, textarea, [contenteditable="true"], [data-desk]') && !paneRef.current?.contains(held)) return true;
            return Boolean(held?.closest(".chat-picker-menu"));
        };
        if (focusIsElsewhere()) return;
        // Asked again when the frame runs: a menu opened since this was queued keeps its focus.
        const frame = window.requestAnimationFrame(() => {
            if (!focusIsElsewhere()) editorRef.current?.focus();
        });
        return () => window.cancelAnimationFrame(frame);
    }, [connection, paneRef, visible]);

    const token = menuDismissed ? null : tokenAt(draft, caret);

    const placeCaret = (position: number) => {
        setCaret(position);
        setMenuDismissed(true);
        caretTo(editorRef, position);
    };

    const takeToken = () => {
        if (!token) return;
        const next = removeToken(draft, token, caret);
        setDraft(next.text);
        placeCaret(next.caret);
    };

    const mates = useMates(agent.id);
    const [trackedList, setTrackedList] = useState<TrackedMatches>({ state: "loading" });
    const menuKeys = useRef<MenuKeys | null>(null);

    const selectCommand = (command: AcpAvailableCommand) => {
        if (!token) return;
        const spaced = Boolean(command.input?.hint) && !/^\s/.test(draft.slice(caret));
        const written = `/${command.name}${spaced ? " " : ""}`;
        setDraft(`${draft.slice(0, token.start)}${written}${draft.slice(caret)}`);
        placeCaret(token.start + written.length);
    };

    const selectMate = (mate: Mate) => {
        if (!token) return;
        const written = `@${mate.name} `;
        setDraft(`${draft.slice(0, token.start)}${written}${draft.slice(caret).replace(/^ /, "")}`);
        placeCaret(token.start + written.length);
    };

    const selectEarlier = (earlier: EarlierChat, uri: string) => {
        takeToken();
        setContexts((current) => mergeContext(current, [{ uri, title: earlier.chat.title, text: null, tracked: null, earlier }]));
        onError(null);
    };

    const selectEntry = (entry: ProjectEntry) => {
        takeToken();
        setAttachments((current) => mergePaths(current, [joinPath(cwd, entry.path)]));
        onError(null);
    };

    const selectTracked = (item: TrackedItem, repo: RepoRef) => {
        takeToken();
        const chosen = { uri: item.url, title: `#${item.number} ${item.title}`, text: null, tracked: { repo, kind: item.kind, number: item.number } };
        setContexts((current) => mergeContext(current, [chosen]));
        onError(null);
    };

    const pick = (choice: MenuPick) => {
        if (choice.kind === "command") selectCommand(choice.command);
        else if (choice.kind === "mate") selectMate(choice.mate);
        else if (choice.kind === "earlier") selectEarlier(choice.earlier, choice.uri);
        else if (choice.kind === "entry") selectEntry(choice.entry);
        else selectTracked(choice.item, choice.repo);
    };

    const blocked = changingConfig || changingPermissions || !permissionApplied || worktree?.state.kind === "preparing";
    const drafted = Boolean(draft.trim()) || attachments.length > 0 || contexts.length > 0;

    // Send and stop are one button: when it changes job, the new icon turns in rather than swapping in place.
    const dictating = useVoice(
        (state) => (state.phase === "listening" || state.phase === "transcribing") && writesInto(state.target, paneRef.current),
    );
    const heard = useVoice((state) =>
        (state.phase === "listening" || state.phase === "transcribing") && writesInto(state.target, paneRef.current) ? state.partial : "",
    );
    const stopping = running && !drafted && !dictating;
    useEffect(() => {
        if (dictating) editorRef.current?.focus();
    }, [dictating]);
    const sendButton = useRef<HTMLButtonElement>(null);
    const wasStopping = useRef(stopping);
    useLayoutEffect(() => {
        if (wasStopping.current === stopping) return;
        wasStopping.current = stopping;
        animate(
            sendButton.current?.firstElementChild,
            [
                { opacity: 0, transform: `scale(0.5) rotate(${stopping ? -90 : 90}deg)` },
                { opacity: 1, transform: "none" },
            ],
            {
                duration: 150,
            },
        );
    }, [stopping]);

    const canSteerQueued = running && steerable && queuedCount > 0;

    const clear = () => {
        setDraft("");
        setCaret(0);
        setMenuSelection(0);
        setAttachments([]);
        setContexts([]);
        setMenuDismissed(false);
        setHistoryPosition(null);
    };

    // Sending while the mic is on stops it first, then sends once what was said is in the box.
    const sendAfterDictation = useRef<boolean | null>(null);
    useEffect(() => {
        if (dictating || sendAfterDictation.current === null) return;
        const steerNow = sendAfterDictation.current;
        sendAfterDictation.current = null;
        send(steerNow);
    });

    const send = (steerNow = false) => {
        if (finishDictationInto(paneRef.current)) {
            sendAfterDictation.current = steerNow;
            return;
        }
        const text = draft.trim();
        if (!drafted || blocked || reading) return;
        const paths = attachments;
        const mentioned = mentionContext(text, mates);
        if (contexts.every((item) => item.text !== null)) {
            const context = [...contexts.map((item) => ({ uri: item.uri, title: item.title, text: item.text ?? "" })), ...mentioned];
            if (onSend({ text, paths, context }, steerNow)) clear();
            return;
        }
        setReading(true);
        void Promise.all(contexts.map(readContext))
            .then((context) => {
                if (onSend({ text, paths, context: [...context, ...mentioned] }, steerNow)) clear();
            })
            .catch((failure: unknown) => onError(errorText(failure)))
            .finally(() => setReading(false));
    };

    const chooseFiles = async () => {
        try {
            const selection = await open({ multiple: true, directory: false });
            if (!selection) return;
            setAttachments((current) => mergePaths(current, Array.isArray(selection) ? selection : [selection]));
            window.requestAnimationFrame(() => editorRef.current?.focus());
        } catch (failure) {
            onError(errorText(failure));
        }
    };

    return (
        <div className="chat-composer">
            {token?.trigger === "#" && (
                <Suspense fallback={null}>
                    <TrackedSource cwd={cwd} needle={token.needle} limit={MAX_MENU_ENTRIES} onMatches={setTrackedList} />
                </Suspense>
            )}
            {token && (
                <ComposerMenu.Part
                    token={token}
                    agentId={agent.id}
                    cwd={cwd}
                    commands={commands}
                    mates={mates}
                    taken={contexts.map((item) => item.uri)}
                    tracked={trackedList}
                    selected={menuSelection}
                    keys={menuKeys}
                    onPick={pick}
                />
            )}
            <div className="chat-field">
                {(attachments.length > 0 || contexts.length > 0 || answering) && (
                    <div className="chat-attachments">
                        {answering && (
                            <Chip
                                answering
                                title={answering.question}
                                mark={<AgentMark cli={answering.cli} />}
                                label={`Answering ${answering.name} · ${answering.question}`}
                                removeLabel="Stop answering"
                                onRemove={answering.onRemove}
                            />
                        )}
                        {attachments.map((path) => (
                            <ComposerAttachment
                                key={path}
                                path={path}
                                onRemove={() => setAttachments((current) => current.filter((candidate) => candidate !== path))}
                            />
                        ))}
                        {contexts.map((item) => (
                            <ComposerContextChip
                                key={item.uri}
                                item={item}
                                onRemove={() => setContexts((current) => current.filter((candidate) => candidate.uri !== item.uri))}
                            />
                        ))}
                    </div>
                )}
                <textarea
                    ref={editorRef}
                    value={draft}
                    aria-label="Message agent"
                    placeholder={heard ? "" : placeholder}
                    rows={2}
                    onChange={(event) => {
                        setDraft(event.target.value);
                        setCaret(event.target.selectionStart);
                        setMenuSelection(0);
                        setMenuDismissed(false);
                        onError(null);
                    }}
                    onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
                    onPaste={(event) => {
                        if (imagesInClipboard(event.clipboardData).length > 0) event.preventDefault();
                        void savePastedClipboard(event.clipboardData)
                            .then((paths) => {
                                if (paths.length === 0) return;
                                setAttachments((current) => mergePaths(current, paths));
                                onError(null);
                            })
                            .catch((failure) => onError(errorText(failure)));
                    }}
                    onKeyDown={(event) => {
                        const menu = token && menuKeys.current;
                        if (menu) {
                            if (event.key === "Escape") {
                                event.preventDefault();
                                setMenuDismissed(true);
                                return;
                            }
                            if (menu.count > 0 && !event.nativeEvent.isComposing) {
                                if (event.key === "ArrowDown") {
                                    event.preventDefault();
                                    setMenuSelection((current) => (current + 1) % menu.count);
                                    return;
                                }
                                if (event.key === "ArrowUp") {
                                    event.preventDefault();
                                    setMenuSelection((current) => (current - 1 + menu.count) % menu.count);
                                    return;
                                }
                                if (event.key === "Tab" || event.key === "Enter") {
                                    event.preventDefault();
                                    menu.choose(Math.min(menuSelection, menu.count - 1));
                                    return;
                                }
                            }
                        }
                        const plainKey = !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey && !event.nativeEvent.isComposing;
                        if (plainKey && onDigit && /^[1-9]$/.test(event.key) && !event.currentTarget.value && onDigit(Number(event.key))) {
                            event.preventDefault();
                            return;
                        }
                        // Escape first lets go of a selection. It stops a running turn only from an empty box, so a half-written message never stops the agent.
                        if (event.key === "Escape" && plainKey) {
                            const box = event.currentTarget;
                            if (box.selectionStart !== box.selectionEnd) {
                                event.preventDefault();
                                box.setSelectionRange(box.selectionEnd, box.selectionEnd);
                                return;
                            }
                            if (running && !drafted) {
                                event.preventDefault();
                                onStop();
                                return;
                            }
                        }
                        const direction = event.key === "ArrowUp" ? "older" : event.key === "ArrowDown" ? "newer" : null;
                        if (direction && plainKey) {
                            const { value } = event.currentTarget;
                            const recalled = arrowsBrowse(value, history, historyPosition, direction)
                                ? recallPrompt(history, historyPosition, value, direction)
                                : null;
                            if (recalled) {
                                event.preventDefault();
                                recalledCaret.current = direction === "older" ? "start" : "end";
                                setHistoryPosition(recalled.position);
                                setDraft(recalled.draft);
                                setMenuDismissed(true);
                                return;
                            }
                        }
                        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                            event.preventDefault();
                            if (hasPrimaryModifier(event.nativeEvent) && !drafted && canSteerQueued) {
                                onSteerQueued();
                                return;
                            }
                            if (finishDictationInto(paneRef.current)) return;
                            send(hasPrimaryModifier(event.nativeEvent));
                        }
                    }}
                />
                {heard && <DictationPreview.Part draft={draft} caret={caret} heard={heard} editor={editorRef} />}
            </div>
            {error && <div className="chat-composer-error">{error}</div>}
            <div className="chat-composer-bar">
                <button type="button" className="chat-composer-icon" aria-label="Add files" onClick={() => void chooseFiles()}>
                    <IconPlus size={17} />
                </button>
                {canSwitchMode(agent.type) && (
                    <YoloToggle
                        agent={agent}
                        relaunches={false}
                        disabled={
                            connection !== "ready" || changingConfig || running || awaitingPermission || changingPermissions || !permissionApplied
                        }
                    />
                )}
                {(worktree?.state.kind === "preparing" || worktree?.state.kind === "in") && (
                    <Suspense fallback={null}>
                        <WorktreeToggle state={worktree.state} onToggle={worktree.toggle} />
                    </Suspense>
                )}
                <ComposerPickers
                    agent={agent}
                    profile={profile}
                    setup={setup}
                    agentLocked={agentLocked}
                    disabled={connection !== "ready" || running || changingPermissions || changingConfig || awaitingPermission}
                    onAgent={(type, profileId) => {
                        if (agentLocked || running || awaitingPermission) return;
                        cmd.configureEmptyAgent(agent.id, type, profileId);
                    }}
                    onConfig={onConfig}
                />
                <ContextMeter usage={usage} agent={agent.type} />
                <span className="chat-composer-spacer" />
                <DictateButton into={paneRef} />
                {stopping ? (
                    <button ref={sendButton} type="button" className="chat-send stop" aria-label="Stop agent" onClick={onStop}>
                        <span />
                    </button>
                ) : (
                    <button
                        ref={sendButton}
                        type="button"
                        className="chat-send"
                        aria-label="Send message"
                        title={
                            canSteerQueued
                                ? `${PRIMARY_SHORTCUT}↵ steers ${queuedCount === 1 ? "the queued message" : "every queued message"} into this turn`
                                : running && steerable
                                  ? `Queues behind this turn — ${PRIMARY_SHORTCUT}↵ steers into it`
                                  : undefined
                        }
                        disabled={blocked || reading || (!drafted && !dictating)}
                        onClick={() => send()}>
                        <IconArrowUp size={15} />
                    </button>
                )}
            </div>
        </div>
    );
}
