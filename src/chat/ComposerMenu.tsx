import { Fragment, useLayoutEffect, useMemo, type ReactNode, type RefObject } from "react";
import { AgentStateIndicator } from "../agents/AgentStateIndicator";
import type { TrackedItem } from "../codehost/tracked";
import type { RepoRef } from "../codehost/types";
import { formatAge } from "../lib/format";
import { dirname } from "../lib/paths";
import { useResourceEnabled } from "../state/resources";
import { filesListR } from "../state/resources.defs";
import { FileIcon } from "../ui/FileIcon";
import { AgentIcon, IconFolder } from "../ui/Icons";
import type { Mate } from "./agentMentions";
import { commandMatches, entryName, MAX_MENU_ENTRIES, projectEntries, rankEntries, type ComposerToken, type ProjectEntry } from "./composerInput";
import { ContextMark } from "./ContextChip";
import { earlierUri, useEarlierChats, type EarlierChat } from "./earlierChats";
import type { TrackedMatches } from "./TrackedSource";
import type { AcpAvailableCommand } from "./types";

function matchMates(mates: readonly Mate[], needle: string, limit: number): Mate[] {
    const wanted = needle.toLowerCase();
    if (!wanted) return [];
    return mates.filter((mate) => mate.name.toLowerCase().startsWith(wanted)).slice(0, limit);
}

/** What the person picked from the menu. */
export type MenuPick =
    | { kind: "command"; command: AcpAvailableCommand }
    | { kind: "mate"; mate: Mate }
    | { kind: "earlier"; earlier: EarlierChat; uri: string }
    | { kind: "entry"; entry: ProjectEntry }
    | { kind: "tracked"; item: TrackedItem; repo: RepoRef };

/** How the composer's keys drive the menu while it is open. */
export interface MenuKeys {
    count: number;
    choose: (index: number) => void;
}

interface MenuRow {
    key: string;
    content: ReactNode;
    pick: MenuPick;
    /** The heading it and the rows after it sit under, below the menu's own. */
    group?: string;
}

interface MenuModel {
    label: string;
    heading: string;
    aside: string;
    variant: "commands" | "entries";
    rows: MenuRow[];
    empty: string | null;
}

const agentMark = (type: Mate["type"]) => (
    <span className="chat-menu-mark">
        <span className={`agent-glyph ${type}`}>
            <AgentIcon type={type} size={13} />
        </span>
    </span>
);

/** The menu over the composer for the `/`, `@` or `#` the caret is in. */
export default function ComposerMenu({
    token,
    agentId,
    cwd,
    commands,
    mates,
    taken,
    tracked,
    selected,
    keys,
    onPick,
}: {
    token: ComposerToken;
    agentId: string;
    cwd: string;
    commands: readonly AcpAvailableCommand[];
    mates: readonly Mate[];
    /** The uris of what the message already carries. */
    taken: readonly string[];
    tracked: TrackedMatches;
    selected: number;
    keys: RefObject<MenuKeys | null>;
    onPick: (pick: MenuPick) => void;
}) {
    const { trigger, needle } = token;
    const slashCommands = useMemo(() => (trigger === "/" ? commandMatches(commands, needle) : []), [commands, trigger, needle]);
    const files = useResourceEnabled(trigger === "@" && !!cwd, filesListR, cwd);
    const entries = useMemo(() => projectEntries(files.data ?? []), [files.data]);
    const entryMatches = useMemo(
        () => (trigger === "@" && cwd ? rankEntries(needle, entries, MAX_MENU_ENTRIES) : []),
        [entries, cwd, trigger, needle],
    );
    const mateMatches = useMemo(() => (trigger === "@" ? matchMates(mates, needle, MAX_MENU_ENTRIES) : []), [mates, trigger, needle]);
    const earlierMatches = useEarlierChats(agentId, trigger === "@" ? needle : null).filter((earlier) => !taken.includes(earlierUri(earlier)));
    const naming = mateMatches.length + earlierMatches.length > 0;

    const menu: MenuModel | null =
        trigger === "/" && slashCommands.length > 0
            ? {
                  label: "Session commands",
                  heading: "Session commands",
                  aside: "ACP",
                  variant: "commands",
                  empty: null,
                  rows: slashCommands.map((command) => ({
                      key: command.name,
                      pick: { kind: "command", command },
                      content: (
                          <>
                              <code>/{command.name}</code>
                              <span>{command.description}</span>
                              {command.input?.hint && <em>{command.input.hint}</em>}
                          </>
                      ),
                  })),
              }
            : trigger === "@" && (cwd || naming)
              ? {
                    label: naming ? "Agents and project files" : "Project files",
                    heading: naming ? "Agents, files and folders" : "Files and folders",
                    aside: naming ? "mention · attach" : "attach",
                    variant: "entries",
                    empty: files.data === undefined ? "Reading the project…" : "Nothing in the project matches",
                    rows: [
                        ...mateMatches.map((mate): MenuRow => ({
                            key: `agent:${mate.id}`,
                            pick: { kind: "mate", mate },
                            content: (
                                <>
                                    {agentMark(mate.type)}
                                    <code>@{mate.name}</code>
                                    <span className="chat-menu-mate">
                                        <span>{mate.title}</span>
                                        {mate.display && <AgentStateIndicator display={mate.display} />}
                                    </span>
                                </>
                            ),
                        })),
                        ...earlierMatches.map((earlier): MenuRow => ({
                            key: earlierUri(earlier),
                            group: "Earlier chats",
                            pick: { kind: "earlier", earlier, uri: earlierUri(earlier) },
                            content: (
                                <>
                                    {agentMark(earlier.chat.agent)}
                                    <span className="chat-menu-earlier">{earlier.chat.title}</span>
                                    <em>{formatAge(earlier.chat.mtime * 1000)}</em>
                                </>
                            ),
                        })),
                        ...entryMatches.map((entry): MenuRow => ({
                            key: entry.path,
                            group: earlierMatches.length > 0 ? "Files and folders" : undefined,
                            pick: { kind: "entry", entry },
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
                    ],
                }
              : trigger === "#"
                ? {
                      label: "Issues and pull requests",
                      heading: "Issues and pull requests",
                      aside: tracked.state === "ready" ? `${tracked.repo.owner}/${tracked.repo.name}` : "",
                      variant: "entries",
                      empty:
                          tracked.state === "loading"
                              ? "Reading open issues and pull requests…"
                              : tracked.state === "unavailable"
                                ? tracked.message
                                : "No open issue or pull request matches",
                      rows:
                          tracked.state === "ready"
                              ? tracked.matches.map((item) => ({
                                    key: `${item.kind}-${item.number}`,
                                    pick: { kind: "tracked", item, repo: tracked.repo },
                                    content: (
                                        <>
                                            <span className="chat-menu-mark" data-kind={item.kind}>
                                                <ContextMark kind={item.kind} size={13} />
                                            </span>
                                            <code>#{item.number}</code>
                                            <span>{item.title}</span>
                                        </>
                                    ),
                                }))
                              : [],
                  }
                : null;
    const rows = menu?.rows ?? [];
    const shown = Math.min(selected, Math.max(0, rows.length - 1));

    useLayoutEffect(() => {
        keys.current = menu ? { count: rows.length, choose: (index) => onPick(rows[index].pick) } : null;
    });
    useLayoutEffect(
        () => () => {
            keys.current = null;
        },
        [keys],
    );

    return (
        menu && (
            <div className={`chat-slash-menu ${menu.variant}`} role="listbox" aria-label={menu.label}>
                <div className="chat-slash-heading">
                    <span>{menu.heading}</span>
                    <span>{menu.aside}</span>
                </div>
                {rows.length === 0 && menu.empty && <div className="chat-slash-empty">{menu.empty}</div>}
                {rows.map((row, index) => (
                    <Fragment key={row.key}>
                        {row.group && row.group !== rows[index - 1]?.group && <div className="chat-slash-group">{row.group}</div>}
                        <button
                            type="button"
                            role="option"
                            aria-selected={index === shown}
                            className={index === shown ? "selected" : ""}
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => onPick(row.pick)}>
                            {row.content}
                        </button>
                    </Fragment>
                ))}
            </div>
        )
    );
}
