import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { agentSupportsSkipPermissions } from "../state/commands/agentLogic";
import { ComposerPickers, type SessionConfig } from "./ComposerPickers";
import { basename, dirname, joinPath } from "../lib/paths";
import { animate } from "../lib/motion";
import { hasPrimaryModifier, PRIMARY_SHORTCUT } from "../lib/platform";
import { registerPathDrop } from "../state/dropRegistry";
import { registerTextInsert } from "../state/textInsertRegistry";
import type { Agent, ProviderProfile } from "../state/types";
import * as cmd from "../state/commands";
import { IconArrowUp, IconClose, IconFile, IconFolder, IconPlus } from "../ui/Icons";
import { FileIcon } from "../ui/FileIcon";
import { useResourceEnabled } from "../state/resources";
import { filesListR } from "../state/resources.defs";
import { usePathRoots } from "./FileRef";
import { useImagePreview } from "./imagePreview";
import { YoloToggle } from "./YoloToggle";
import { DictateButton } from "./DictateButton";
import { ContextMeter } from "./ContextMeter";
import { imagesInClipboard, savePastedClipboard } from "./pasteImage";
import { arrowsBrowse, recallPrompt, type HistoryPosition } from "./promptHistory";
import { entryName, mergePaths, projectEntries, rankEntries, removeToken, tokenAt, type ProjectEntry } from "./composerInput";
import { receiveForAgent } from "../agents/agentInbox";
import type { AcpAvailableCommand, ChatState, ContextUsage } from "./types";
import type { OutgoingMessage } from "./queuedMessages";

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

interface MenuRow {
    key: string;
    content: ReactNode;
    choose: () => void;
}

interface ComposerMenuModel {
    label: string;
    heading: string;
    aside: string;
    variant: "commands" | "entries";
    rows: MenuRow[];
    empty: string | null;
}

function ComposerMenu({ menu, selected }: { menu: ComposerMenuModel; selected: number }) {
    return (
        <div className={`chat-slash-menu ${menu.variant}`} role="listbox" aria-label={menu.label}>
            <div className="chat-slash-heading">
                <span>{menu.heading}</span>
                <span>{menu.aside}</span>
            </div>
            {menu.rows.length === 0 && menu.empty && <div className="chat-slash-empty">{menu.empty}</div>}
            {menu.rows.map((row, index) => (
                <button
                    key={row.key}
                    type="button"
                    role="option"
                    aria-selected={index === selected}
                    className={index === selected ? "selected" : ""}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={row.choose}>
                    {row.content}
                </button>
            ))}
        </div>
    );
}

const MAX_ENTRIES = 8;

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
}) {
    const [draft, setDraft] = useState("");
    const [historyPosition, setHistoryPosition] = useState<HistoryPosition | null>(null);
    const recalledCaret = useRef<"start" | "end" | null>(null);
    const [caret, setCaret] = useState(0);
    const [attachments, setAttachments] = useState<string[]>([]);
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
        return receiveForAgent(agent.id, ({ text, paths }) => {
            if (paths?.length) setAttachments((current) => mergePaths(current, paths));
            const editor = editorRef.current;
            const current = editor?.value ?? "";
            const next = text ? `${current.trimEnd()}${current.trim() ? "\n\n" : ""}${text}` : current;
            setDraft(next);
            setCaret(next.length);
            window.requestAnimationFrame(() => {
                editorRef.current?.focus();
                editorRef.current?.setSelectionRange(next.length, next.length);
            });
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
            window.requestAnimationFrame(() => {
                editor.focus();
                editor.setSelectionRange(at, at);
            });
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
        window.requestAnimationFrame(() => {
            const editor = editorRef.current;
            if (!editor) return;
            editor.focus();
            editor.setSelectionRange(position, position);
        });
    };

    const takeToken = () => {
        if (!token) return;
        const next = removeToken(draft, token, caret);
        setDraft(next.text);
        placeCaret(next.caret);
    };

    const slashCommands = useMemo(() => {
        if (token?.trigger !== "/") return [];
        const needle = token.needle.toLowerCase();
        return commands.filter((command) => command.name.toLowerCase().includes(needle)).slice(0, 8);
    }, [commands, token?.trigger, token?.needle]);

    const files = useResourceEnabled(token?.trigger === "@" && !!cwd, filesListR, cwd);
    const entries = useMemo(() => projectEntries(files.data ?? []), [files.data]);
    const entryMatches = useMemo(
        () => (token?.trigger === "@" ? rankEntries(token.needle, entries, MAX_ENTRIES) : []),
        [entries, token?.trigger, token?.needle],
    );

    const selectCommand = (command: AcpAvailableCommand) => {
        if (!token) return;
        const spaced = Boolean(command.input?.hint) && !/^\s/.test(draft.slice(caret));
        const written = `/${command.name}${spaced ? " " : ""}`;
        setDraft(`${draft.slice(0, token.start)}${written}${draft.slice(caret)}`);
        placeCaret(token.start + written.length);
    };

    const selectEntry = (entry: ProjectEntry) => {
        takeToken();
        setAttachments((current) => mergePaths(current, [joinPath(cwd, entry.path)]));
        onError(null);
    };

    const menu: ComposerMenuModel | null =
        token?.trigger === "/" && slashCommands.length > 0
            ? {
                  label: "Session commands",
                  heading: "Session commands",
                  aside: "ACP",
                  variant: "commands",
                  empty: null,
                  rows: slashCommands.map((command) => ({
                      key: command.name,
                      choose: () => selectCommand(command),
                      content: (
                          <>
                              <code>/{command.name}</code>
                              <span>{command.description}</span>
                              {command.input?.hint && <em>{command.input.hint}</em>}
                          </>
                      ),
                  })),
              }
            : token?.trigger === "@" && cwd
              ? {
                    label: "Project files",
                    heading: "Files and folders",
                    aside: "attach",
                    variant: "entries",
                    empty: files.data === undefined ? "Reading the project…" : "Nothing in the project matches",
                    rows: entryMatches.map((entry) => ({
                        key: entry.path,
                        choose: () => selectEntry(entry),
                        content: (
                            <>
                                <span className="chat-menu-mark">
                                    {entry.folder ? <IconFolder size={13} /> : <FileIcon name={entryName(entry)} size={13} />}
                                </span>
                                <code>{entryName(entry)}</code>
                                <span>{dirname(entry.path.replace(/\/$/, "")) || "."}</span>
                            </>
                        ),
                    })),
                }
              : null;
    const menuRows = menu?.rows ?? [];
    const selected = Math.min(menuSelection, Math.max(0, menuRows.length - 1));

    const blocked = changingConfig || changingPermissions || !permissionApplied;
    const drafted = Boolean(draft.trim()) || attachments.length > 0;

    // Send and stop are one button: when it changes job, the new icon turns in rather than swapping in place.
    const stopping = running && !drafted;
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

    const send = (steerNow = false) => {
        const text = draft.trim();
        if ((!text && attachments.length === 0) || blocked) return;
        if (!onSend({ text, paths: attachments, context: [] }, steerNow)) return;
        setDraft("");
        setCaret(0);
        setMenuSelection(0);
        setAttachments([]);
        setMenuDismissed(false);
        setHistoryPosition(null);
    };

    const chooseFiles = async () => {
        try {
            const selection = await open({ multiple: true, directory: false });
            if (!selection) return;
            setAttachments((current) => mergePaths(current, Array.isArray(selection) ? selection : [selection]));
            window.requestAnimationFrame(() => editorRef.current?.focus());
        } catch (failure) {
            onError(failure instanceof Error ? failure.message : String(failure));
        }
    };

    return (
        <div className="chat-composer">
            {menu && <ComposerMenu menu={menu} selected={selected} />}
            <div className="chat-field">
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
                    aria-label="Message agent"
                    placeholder={placeholder}
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
                            .catch((failure) => onError(failure instanceof Error ? failure.message : String(failure)));
                    }}
                    onKeyDown={(event) => {
                        if (menu) {
                            if (event.key === "Escape") {
                                event.preventDefault();
                                setMenuDismissed(true);
                                return;
                            }
                            if (menuRows.length > 0 && !event.nativeEvent.isComposing) {
                                if (event.key === "ArrowDown") {
                                    event.preventDefault();
                                    setMenuSelection((current) => (current + 1) % menuRows.length);
                                    return;
                                }
                                if (event.key === "ArrowUp") {
                                    event.preventDefault();
                                    setMenuSelection((current) => (current - 1 + menuRows.length) % menuRows.length);
                                    return;
                                }
                                if (event.key === "Tab" || event.key === "Enter") {
                                    event.preventDefault();
                                    menuRows[selected].choose();
                                    return;
                                }
                            }
                        }
                        const plainKey = !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey && !event.nativeEvent.isComposing;
                        // As in an agent's terminal, Escape stops the turn it is running; whatever is typed stays.
                        if (event.key === "Escape" && running && plainKey) {
                            event.preventDefault();
                            onStop();
                            return;
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
                            if (hasPrimaryModifier(event.nativeEvent) && !draft.trim() && attachments.length === 0 && canSteerQueued) {
                                onSteerQueued();
                                return;
                            }
                            send(hasPrimaryModifier(event.nativeEvent));
                        }
                    }}
                />
            </div>
            {error && <div className="chat-composer-error">{error}</div>}
            <div className="chat-composer-bar">
                <button type="button" className="chat-composer-icon" aria-label="Add files" onClick={() => void chooseFiles()}>
                    <IconPlus size={17} />
                </button>
                {agentSupportsSkipPermissions(agent.type) && (
                    <YoloToggle
                        agent={agent}
                        relaunches={false}
                        disabled={
                            connection !== "ready" || changingConfig || running || awaitingPermission || changingPermissions || !permissionApplied
                        }
                    />
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
                        disabled={blocked || !drafted}
                        onClick={() => send()}>
                        <IconArrowUp size={15} />
                    </button>
                )}
            </div>
        </div>
    );
}
