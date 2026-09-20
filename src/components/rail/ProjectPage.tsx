import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { AgentInfo, AgentUsage } from "../../api/agents";
import { selectedProviderProfile } from "../../agentProfiles";
import { keybindingLabelForAction, type KeybindingActionId } from "../../keybindings";
import * as cmd from "../../state/commands";
import type { ResourceHandle } from "../../state/resources";
import { useStore } from "../../state/store";
import type { Session, Window, WindowRole } from "../../state/types";
import { useAgentLog, type PastChat } from "../../hooks/useAgentLog";
import { IconCommand, WindowIcon } from "../Icons";
import { Tooltip } from "../Tooltip";
import { AgentLogGroup } from "./AgentLogGroup";
import { RailLimits, isUsageAgent, type UsageAgentType } from "./RailLimits";

/** How many past chats a page shows before you ask for more. */
const PAGE = 18;

/**
 * The surfaces a project always has. Agents are not among them any more: an
 * agent is a window too, but it has a name, and a thing with a name earns a row
 * of its own in the log below rather than a folder to be opened.
 */
const SURFACES: { role: WindowRole; label: string; action: KeybindingActionId }[] = [
    { role: "files", label: "Files", action: "window.files" },
    { role: "term", label: "Term", action: "window.terminal" },
    { role: "git", label: "Git", action: "window.git" },
    { role: "search", label: "Search", action: "window.search" },
];

export function ProjectPage({
    session,
    providers,
    usageFor,
}: {
    session: Session;
    providers: AgentInfo[];
    usageFor: (provider: UsageAgentType) => ResourceHandle<AgentUsage>;
}) {
    const windowsById = useStore((s) => s.windows);
    const windowsBySession = useStore((s) => s.windowsBySession);
    const activeSessionId = useStore((s) => s.activeSessionId);
    const keybindingOverrides = useStore((s) => s.keybindingOverrides);
    const profiles = useStore((s) => s.providerProfiles);
    const profileSelections = useStore((s) => s.selectedProviderProfileIds);

    const [shown, setShown] = useState(PAGE);
    const [query, setQuery] = useState("");
    const [filterOpen, setFilterOpen] = useState(false);
    const scrollRef = useRef<HTMLDivElement>(null);

    const { open, past, loading } = useAgentLog(session, providers);
    const kb = (id: KeybindingActionId) => keybindingLabelForAction(keybindingOverrides, id);

    /* Bringing the page to the front is part of acting on it: a row can be
       clicked on a project that is not the one in the stage, because every
       project's page is mounted whether it is in front or not. */
    const focusSession = useCallback(() => {
        if (session.id !== activeSessionId) cmd.selectSession(session.id);
    }, [session.id, activeSessionId]);

    const sessionWindows = (windowsBySession[session.id] ?? []).map((id) => windowsById[id]).filter(Boolean) as Window[];
    const tabCount = sessionWindows.filter((w) => w.role === "term").length;
    const activeRole = sessionWindows.find((w) => w.id === session.activeWindowId)?.role;

    const onSurface = (role: WindowRole) => {
        focusSession();
        if (role === "files") return cmd.openEditorPane();
        if (role === "git") return cmd.openGitWorkbench();
        if (role === "search") return cmd.focusGlobalSearch();
        const existing = sessionWindows.find((w) => w.role === role);
        if (existing) cmd.selectWindowId(existing.id);
        else if (role === "term") cmd.newWindow();
    };

    const onResume = (chat: PastChat) => {
        focusSession();
        const provider = providers.find((agent) => agent.type === chat.type);
        cmd.addAgent(chat.type, chat.id, chat.title, {
            profileId: selectedProviderProfile(chat.type, profiles, profileSelections)?.id,
            detectedExecutablePath: provider?.command,
            cwd: session.cwd,
            sessionId: session.id,
        });
    };

    /* The list pages in as you reach the end of it, and the first page may not
       fill the rail — with nothing to scroll, nothing would ever ask for more. */
    const revealIfShort = useCallback(() => {
        const el = scrollRef.current;
        if (!el) return;
        if (el.scrollHeight <= el.clientHeight && shown < past.length) setShown((n) => Math.min(n + PAGE, past.length));
    }, [shown, past.length]);

    useLayoutEffect(() => {
        revealIfShort();
        const el = scrollRef.current;
        if (!el || typeof ResizeObserver === "undefined") return;
        const observer = new ResizeObserver(revealIfShort);
        observer.observe(el);
        return () => observer.disconnect();
    }, [revealIfShort]);

    const onScroll = () => {
        const el = scrollRef.current;
        if (!el || shown >= past.length) return;
        if (el.scrollHeight - el.scrollTop - el.clientHeight < 160) setShown((n) => Math.min(n + PAGE, past.length));
    };

    /* Limits follow whichever provider this project is actually using. */
    const current = open.find((agent) => agent.id === session.activeWindowId) ?? open[0];
    const provider = isUsageAgent(current?.type) ? current.type : "claude";
    const usage = usageFor(provider);
    const detected = providers.some((agent) => agent.type === provider);

    return (
        <div className="rail-page">
            <div className="rail-scroll" ref={scrollRef} onScroll={onScroll}>
                <div className="proj-children branch">
                    {SURFACES.map((surface) => {
                        const on = session.id === activeSessionId && activeRole === surface.role;
                        const label = kb(surface.action);
                        const title = surface.role === "term" && tabCount > 1 ? `Term · ${tabCount} tabs — ${label}` : `${surface.label} — ${label}`;
                        return (
                            <Tooltip key={surface.role} label={title} side="right">
                                <button
                                    type="button"
                                    className={`proj-child${on ? " active" : ""}`}
                                    aria-label={surface.label}
                                    aria-current={on ? "page" : undefined}
                                    onClick={() => onSurface(surface.role)}>
                                    <span className="proj-child-tick" />
                                    <span className="proj-child-ic">
                                        <WindowIcon role={surface.role} size={13} />
                                    </span>
                                    <span className="proj-child-label">{surface.label}</span>
                                    {surface.role === "term" && tabCount > 1 && (
                                        <span className="proj-child-icons">
                                            {Array.from({ length: tabCount }, (_, i) => (
                                                <span key={i} className="proj-pip proj-pip-term">
                                                    <IconCommand size={14} />
                                                </span>
                                            ))}
                                        </span>
                                    )}
                                    <span className="proj-child-kbd">{label}</span>
                                </button>
                            </Tooltip>
                        );
                    })}
                </div>

                <AgentLogGroup
                    session={session}
                    open={open}
                    past={past}
                    shown={shown}
                    query={query}
                    filterOpen={filterOpen}
                    loading={loading}
                    onMore={() => setShown((n) => n + PAGE * 2)}
                    onQuery={setQuery}
                    onToggleFilter={() => {
                        setQuery("");
                        setFilterOpen((was) => !was);
                    }}
                    onSelect={(id) => {
                        focusSession();
                        cmd.selectAgent(id);
                    }}
                    onResume={onResume}
                    onNew={() => {
                        focusSession();
                        cmd.openAgentPalette();
                    }}
                />
            </div>
            {detected && <RailLimits provider={provider} usage={usage} label={providers.find((a) => a.type === provider)?.label} />}
        </div>
    );
}
