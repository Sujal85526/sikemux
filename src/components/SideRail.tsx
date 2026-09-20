import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { selectedAgentRuntimeProfiles } from "../agentProfiles";
import { usePageVisible } from "../hooks/usePageVisible";
import { prefersReducedMotion } from "../lib/motion";
import * as cmd from "../state/commands";
import { rollupAgentStates } from "../state/agentStatus";
import { useResource, useResourceEnabled } from "../state/resources";
import { agentCatalogR, agentUsageR } from "../state/resources.defs";
import { agentIdsOf } from "../state/selectors";
import { useStore } from "../state/store";
import type { Agent, AgentRuntimeState, Session } from "../state/types";
import { IconFolder, IconPlus, Logo } from "./Icons";
import { AgentStateIndicator } from "./AgentStateIndicator";
import { Tooltip } from "./Tooltip";
import { UpdateChip, VersionChip } from "./TopBar";
import { useRailPan } from "./useRailPan";
import { ProjectPage } from "./rail/ProjectPage";
import { ServicesPage } from "./rail/ServicesPage";
import type { UsageAgentType } from "./rail/RailLimits";

const USAGE_REFRESH_MS = 5 * 60_000;
/** How far a pointer travels before it is reordering rather than clicking. */
const DRAG_THRESHOLD_PX = 6;

interface Drag {
    id: string;
    startX: number;
    active: boolean;
}

interface Drop {
    targetId: string;
    placement: "before" | "after";
}

/**
 * One rail.
 *
 * The agent rail used to be the other half of this: a provider switch, an Open
 * heading, a Recent heading, a history list and three plan gauges, in a second
 * column. All of it is here now, because a project's chats belong to the
 * project and had no business being filed one column away from it.
 *
 * The shape is one track of pages — a page per project, Services last — so a
 * single swipe walks the projects and arrives at the ssh hosts. Each page is
 * one project: its surfaces as a tree branching off its chip in the strip
 * above, every chat it has under that, and what its plan has left at the foot.
 */
export const SideRail = memo(function SideRail() {
    const sessionsById = useStore((s) => s.sessions);
    const sessionOrder = useStore((s) => s.sessionOrder);
    const activeSessionId = useStore((s) => s.activeSessionId);
    const windowsById = useStore((s) => s.windows);
    const windowsBySession = useStore((s) => s.windowsBySession);
    const agentsById = useStore((s) => s.agents);
    const activityById = useStore((s) => s.agentActivity);
    const backgroundById = useStore((s) => s.agentBackgroundWork);
    const profiles = useStore((s) => s.providerProfiles);
    const profileSelections = useStore((s) => s.selectedProviderProfileIds);
    const pageVisible = usePageVisible();

    const sessions = useMemo(() => sessionOrder.map((id) => sessionsById[id]).filter(Boolean), [sessionOrder, sessionsById]);
    const projects = useMemo(() => sessions.filter((s) => s.kind === "project"), [sessions]);
    const servicesPage = projects.length;

    const runtimeProfiles = useMemo(() => selectedAgentRuntimeProfiles(profiles, profileSelections), [profiles, profileSelections]);
    const catalog = useResource(agentCatalogR, runtimeProfiles);
    const providers = useMemo(() => (catalog.data ?? []).filter((agent) => agent.available !== false), [catalog.data]);

    /* One owner for the plan reads, not one per page: every project that runs
       the same CLI is asking the same question, and each answer boots that CLI. */
    const claude = providers.find((agent) => agent.type === "claude");
    const codex = providers.find((agent) => agent.type === "codex");
    const claudeUsage = useResourceEnabled(Boolean(claude), agentUsageR, "claude", claude?.command, claude?.configPath ?? undefined);
    const codexUsage = useResourceEnabled(Boolean(codex), agentUsageR, "codex", codex?.command, codex?.configPath ?? undefined);
    const refreshRef = useRef({ claude: claudeUsage.refresh, codex: codexUsage.refresh });
    refreshRef.current = { claude: claudeUsage.refresh, codex: codexUsage.refresh };
    useEffect(() => {
        if (!pageVisible || (!claude && !codex)) return;
        const timer = window.setInterval(() => {
            if (claude) void refreshRef.current.claude();
            if (codex) void refreshRef.current.codex();
        }, USAGE_REFRESH_MS);
        return () => window.clearInterval(timer);
    }, [claude, codex, pageVisible]);
    const usageFor = useCallback((provider: UsageAgentType) => (provider === "codex" ? codexUsage : claudeUsage), [claudeUsage, codexUsage]);

    const viewportRef = useRef<HTMLDivElement>(null);
    const trackRef = useRef<HTMLDivElement>(null);
    const runRef = useRef<HTMLDivElement>(null);

    const activeProject = projects.findIndex((p) => p.id === activeSessionId);
    const [page, setPage] = useState(() => (activeProject >= 0 ? activeProject : servicesPage));

    /* Choosing a project brings the rail to its page. Choosing a host does not
       take the rail away from the project you were reading. */
    useEffect(() => {
        if (activeProject >= 0) setPage(activeProject);
    }, [activeProject]);

    const onIndex = useCallback(
        (index: number) => {
            setPage(index);
            const project = projects[index];
            if (project && project.id !== activeSessionId) cmd.selectSession(project.id);
        },
        [projects, activeSessionId],
    );

    const clamped = Math.min(page, servicesPage);
    const { panning } = useRailPan(viewportRef, trackRef, servicesPage + 1, clamped, onIndex);

    /*
     * The strip moves, the tree does not.
     *
     * The tree holds the one left edge every label in the column sits on, and
     * the strip scrolls until the active project's mark lands on the spine, so
     * the branch reads as coming out of that chip. Doing it the other way round
     * made the content jump sideways every time the project changed.
     */
    const alignStrip = useCallback(() => {
        const run = runRef.current;
        const viewport = viewportRef.current;
        const chip = run?.querySelector<HTMLElement>(".proj-chip.active");
        const branch = trackRef.current?.querySelector<HTMLElement>(".proj-children.branch");
        const host = branch?.closest(".rail-page");
        if (!run || !viewport || !chip || !branch || !host) return;
        const mark = chip.querySelector<HTMLElement>(".proj-chip-ic") ?? chip;
        const runBox = run.getBoundingClientRect();
        /* Both measurements have to survive being taken mid-slide. Adding
           scrollLeft back cancels out a scroll still animating; the spine cannot
           be read off its live rect at all, because the page it belongs to is
           still off to the side — but its offset within its own page is a
           constant, and every page lands flush to the viewport. */
        const markInContent = mark.getBoundingClientRect().left - runBox.left + run.scrollLeft;
        const spineInPage = branch.getBoundingClientRect().left - host.getBoundingClientRect().left;
        const target = markInContent - (viewport.getBoundingClientRect().left + spineInPage - runBox.left);
        const max = Math.max(0, run.scrollWidth - run.clientWidth);
        const left = Math.max(0, Math.min(max, target));
        if (run.scrollTo) run.scrollTo({ left, behavior: prefersReducedMotion() ? "auto" : "smooth" });
        else run.scrollLeft = left;
    }, []);

    useLayoutEffect(() => {
        alignStrip();
    }, [alignStrip, clamped, projects.length]);

    /* ---- reordering ------------------------------------------------------
     * The strip is horizontal, so a reorder is a horizontal drag — and the page
     * swipe is a wheel gesture, never a pointer one, so the two never contend
     * for the same movement. Same split a browser's tab strip makes.
     */
    const [drag, setDrag] = useState<Drag | null>(null);
    const [drop, setDrop] = useState<Drop | null>(null);
    /* The refs are the truth and the state is only for painting: the handlers
       below outlive the render that created them, so anything they read out of
       that closure is whatever it was when the drag started. */
    const dragRef = useRef<Drag | null>(null);
    const dropRef = useRef<Drop | null>(null);

    const setDragging = (next: Drag | null) => {
        dragRef.current = next;
        setDrag(next);
    };
    const setDropping = (next: Drop | null) => {
        dropRef.current = next;
        setDrop(next);
    };

    const onChipPointerDown = (event: ReactPointerEvent<HTMLButtonElement>, id: string) => {
        if (event.button !== 0) return;
        setDragging({ id, startX: event.clientX, active: false });

        const move = (moved: PointerEvent) => {
            const held = dragRef.current;
            if (!held) return;
            if (!held.active) {
                if (Math.abs(moved.clientX - held.startX) < DRAG_THRESHOLD_PX) return;
                setDragging({ ...held, active: true });
                document.body.classList.add("is-sorting-projects");
            }
            const under = document.elementFromPoint(moved.clientX, moved.clientY)?.closest<HTMLElement>("[data-project-chip]");
            const targetId = under?.dataset.projectChip;
            if (!targetId || targetId === held.id) return setDropping(null);
            const bounds = under.getBoundingClientRect();
            setDropping({ targetId, placement: moved.clientX < bounds.left + bounds.width / 2 ? "before" : "after" });
        };

        const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            document.body.classList.remove("is-sorting-projects");
            const held = dragRef.current;
            const landed = dropRef.current;
            setDragging(null);
            setDropping(null);
            if (held?.active && landed) cmd.reorderSession(held.id, landed.targetId, landed.placement);
        };

        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
    };

    const onServices = !projects.length || clamped === servicesPage;
    const elsewhere = useMemo(() => {
        const states = projects.flatMap((project) =>
            agentIdsOf({ windowsBySession, windows: windowsById }, project.id).map((id) => activityById[id]),
        );
        const rollup = rollupAgentStates(states);
        return rollup && rollup !== "idle" ? rollup : null;
    }, [projects, windowsBySession, windowsById, activityById]);

    return (
        <aside className="side-rail one-rail">
            <div className="seg-head" role="tablist" aria-label="Rail section">
                <button
                    type="button"
                    role="tab"
                    className={`seg-btn${onServices ? "" : " active"}`}
                    aria-selected={!onServices}
                    disabled={projects.length === 0}
                    onClick={() => setPage(Math.max(0, activeProject))}>
                    Projects
                    {/* What the half of the rail you are not looking at is doing.
                        Without it, an agent needing you is a blind spot for as
                        long as you are over in Services. */}
                    {onServices && elsewhere && <span className={`seg-dot state-${elsewhere}`} aria-hidden="true" />}
                </button>
                <button
                    type="button"
                    role="tab"
                    className={`seg-btn${onServices ? " active" : ""}`}
                    aria-selected={onServices}
                    onClick={() => setPage(servicesPage)}>
                    Services
                </button>
            </div>

            <div className="proj-strip" aria-label="Projects">
                <div className="proj-strip-run" ref={runRef}>
                    {projects.map((project, index) => (
                        <ProjectChip
                            key={project.id}
                            project={project}
                            active={!onServices && index === clamped}
                            dragging={drag?.active === true && drag.id === project.id}
                            drop={drop?.targetId === project.id ? drop.placement : null}
                            agents={
                                agentIdsOf({ windowsBySession, windows: windowsById }, project.id)
                                    .map((id) => agentsById[id])
                                    .filter(Boolean) as Agent[]
                            }
                            activityById={activityById}
                            backgroundById={backgroundById}
                            onPointerDown={onChipPointerDown}
                            onSelect={() => {
                                setPage(index);
                                cmd.selectSession(project.id);
                            }}
                        />
                    ))}
                </div>
                <Tooltip label="Open project">
                    <button type="button" className="proj-chip proj-chip-add" aria-label="Open project" onClick={() => cmd.openPicker("projects")}>
                        <IconPlus size={12} />
                    </button>
                </Tooltip>
            </div>

            <div className={`rail-viewport${panning ? " is-panning" : ""}`} ref={viewportRef}>
                <div className="rail-track" ref={trackRef}>
                    {projects.map((project) => (
                        <ProjectPage key={project.id} session={project} providers={providers} usageFor={usageFor} />
                    ))}
                    <ServicesPage />
                </div>
            </div>

            <UpdateChip />

            <div className="rail-sig">
                <Logo size={13} />
                <span className="rail-sig-name">Sikemux</span>
                <VersionChip />
            </div>
        </aside>
    );
});

function ProjectChip({
    project,
    active,
    dragging,
    drop,
    agents,
    activityById,
    backgroundById,
    onPointerDown,
    onSelect,
}: {
    project: Session;
    active: boolean;
    dragging: boolean;
    drop: "before" | "after" | null;
    agents: Agent[];
    activityById: Record<string, AgentRuntimeState | undefined>;
    backgroundById: Record<string, number>;
    onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>, id: string) => void;
    onSelect: () => void;
}) {
    const rollup = rollupAgentStates(agents.map((agent) => activityById[agent.id]));
    const background = agents.some((agent) => (backgroundById[agent.id] ?? 0) > 0);
    return (
        <Tooltip label={project.cwd || project.name} side="bottom">
            <button
                type="button"
                data-project-chip={project.id}
                className={`proj-chip${active ? " active" : ""}${dragging ? " dragging" : ""}${drop ? ` drop-${drop}` : ""}`}
                aria-current={active}
                onPointerDown={(event) => onPointerDown(event, project.id)}
                onClick={onSelect}>
                <span className="proj-chip-ic">
                    <IconFolder size={12} />
                </span>
                <span className="proj-chip-name">{project.name}</span>
                {(rollup || background) && <AgentStateIndicator state={rollup ?? "idle"} background={background} />}
            </button>
        </Tooltip>
    );
}
