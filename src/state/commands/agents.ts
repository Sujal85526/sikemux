import type { AgentSession } from "../../api/agents";
import { MAX_AGENT_MODEL_LENGTH, normalizePermissionMode, type ChatAgentType } from "../../agents/agentLaunch";
import { emit } from "../bus";
import { reduceAgentState } from "../agentStatus";
import { peekResource } from "../resources";
import { agentSessionsR } from "../resources.defs";
import { getState, mutate, type StoreState } from "../store";
import { notify } from "../toast";
import { agentIdsWithLiveSessions } from "../agentLiveSessions";
import { agentSupportsSkipPermissions } from "./agentLogic";
import { agentDirectCommand, agentStartup } from "./agentLaunchCommand";
import { activeAgentId, agentIdsOf, agentWindowId, ownerSessionId } from "../selectors";
import { agentWindow } from "../agentWindow";
import { newId } from "../layout";
import type { Agent, AgentEffort, AgentPermissionMode, AgentType, ProviderProfile } from "../types";
import { selectSession } from "./sessions";
import { withActiveSession } from "./shared";
import { closeWindowById } from "./tabs";

const FALLBACK_AGENT_TITLE_MAX = 13;

function profileLaunchOptions(profile: ProviderProfile | undefined, model?: string, effort?: AgentEffort) {
    return {
        model,
        effort,
        configPath: profile?.configPath,
        environmentKeys: profile?.environmentKeys,
    };
}

function usableAgentSessionTitle(row: AgentSession, current: string): string {
    const title = row.title.trim();
    if (!title) return current;
    if (title.length <= FALLBACK_AGENT_TITLE_MAX && row.id.startsWith(title)) return current;
    return title;
}

export function agentSessionMetadataPending(agent: Agent): boolean {
    if (!agent.resumeId) return true;
    const title = agent.title.trim();
    if (!title || title.toLowerCase() === agent.type) return true;
    return title.length <= FALLBACK_AGENT_TITLE_MAX && agent.resumeId.startsWith(title);
}

export function configureEmptyAgent(id: string, type: ChatAgentType, profileId?: string): void {
    mutate((d) => {
        const agent = d.agents[id];
        const activity = d.agentActivity[id];
        if (!agent || activity?.backendState === "working" || activity?.backendState === "blocked") return;
        const profile = profileId ? d.providerProfiles.find((item) => item.id === profileId && item.provider === type) : undefined;
        if (profileId && !profile) return;
        const mode = normalizePermissionMode(type, agent.permissionMode ?? d.defaultAgentPermissionMode);
        agent.type = type;
        agent.profileId = profile?.id;
        agent.title = profile?.name || type;
        agent.executablePath = profile?.executablePath;
        agent.permissionMode = mode;
        agent.skipPermissions = mode === "bypass";
        delete agent.resumeId;
        delete agent.model;
        delete agent.effort;
        delete agent.baselineSessionIds;
        const options = profileLaunchOptions(profile);
        agent.startup = agentStartup(type, undefined, mode, profile?.executablePath, options);
        agent.directCommand = agentDirectCommand(type, undefined, mode, profile?.executablePath, options);
    });
}

export function setAgentModelPreferences(id: string, model: string | undefined, effort: AgentEffort | undefined): void {
    mutate((d) => {
        const agent = d.agents[id];
        if (!agent) return;
        agent.model = model;
        agent.effort = effort;
        const profile = d.providerProfiles.find((item) => item.id === agent.profileId && item.provider === agent.type);
        const options = profileLaunchOptions(profile, model, effort);
        const executable = profile?.executablePath || agent.executablePath;
        const mode = agent.permissionMode ?? (agent.skipPermissions ? "bypass" : "workspace-write");
        agent.startup = agentStartup(agent.type, agent.resumeId, mode, executable, options);
        agent.directCommand = agentDirectCommand(agent.type, agent.resumeId, mode, executable, options);
    });
}

export function setAgentPermissionMode(id: string, requestedMode: AgentPermissionMode): void {
    mutate((d) => {
        const currentAgent = d.agents[id];
        const profile = currentAgent?.profileId
            ? d.providerProfiles.find((item) => item.id === currentAgent.profileId && item.provider === currentAgent.type)
            : undefined;
        const a = d.agents[id];
        if (!a) return;
        const next = normalizePermissionMode(a.type, requestedMode);
        const current = a.permissionMode ?? (a.skipPermissions ? "bypass" : normalizePermissionMode(a.type, "workspace-write"));
        if (next === current) return;
        a.permissionMode = next;
        a.skipPermissions = next === "bypass";
        const launchOptions = profileLaunchOptions(profile, a.model, a.effort);
        const executablePath = profile?.executablePath || a.executablePath;
        a.startup = agentStartup(a.type, a.resumeId, next, executablePath, launchOptions);
        a.directCommand = agentDirectCommand(a.type, a.resumeId, next, executablePath, launchOptions);
    });
}

export function toggleAgentSkipPermissions(id: string): void {
    const agent = getState().agents[id];
    if (!agent || !agentSupportsSkipPermissions(agent.type)) return;
    const current = agent.permissionMode ?? (agent.skipPermissions ? "bypass" : normalizePermissionMode(agent.type, "workspace-write"));
    const next = current === "bypass" ? normalizePermissionMode(agent.type, "workspace-write") : "bypass";
    setAgentPermissionMode(id, next);
}

/** ⌥Y — toggle YOLO (skip-permissions) for the active agent, when one is on screen. */
export function toggleActiveAgentSkipPermissions(): void {
    const st = getState();
    const session = st.sessions[st.activeSessionId];
    const id = activeAgentId(st, session);
    if (id) toggleAgentSkipPermissions(id);
}

export interface AddAgentOptions {
    permissionMode?: AgentPermissionMode;
    profileId?: string | null;
    model?: string;
    effort?: AgentEffort;
    baselineSessionIds?: string[];
    cwd?: string;
    /** Pin launches to the project that opened the picker. */
    sessionId?: string;
    detectedExecutablePath?: string;
}

export function addAgent(type: AgentType, resumeId?: string, title?: string, options: AddAgentOptions = {}): boolean {
    if ((options.model?.trim().length ?? 0) > MAX_AGENT_MODEL_LENGTH) return false;
    let attached = false;
    mutate((d) => {
        const session = d.sessions[options.sessionId ?? d.activeSessionId];
        if (!session) return;
        if (session.kind !== "project") return;
        const existing = resumeId
            ? agentIdsOf(d, session.id)
                  .map((id) => d.agents[id])
                  .find((a) => a && a.type === type && a.resumeId === resumeId)
            : undefined;
        const sess = d.sessions[session.id];
        d.zoomedPaneId = null;
        // A successful launch closes the picker and activates the new PTY.
        d.agentPaletteOpen = false;
        if (existing) {
            const winId = agentWindowId(d, existing.id);
            if (winId) sess.activeWindowId = winId;
            attached = true;
            return;
        }
        const permissionMode = normalizePermissionMode(type, options.permissionMode ?? d.defaultAgentPermissionMode);
        const requestedProfileId = options.profileId === undefined ? d.selectedProviderProfileIds[type] : options.profileId;
        const profileId = requestedProfileId
            ? d.providerProfiles.find((profile) => profile.id === requestedProfileId && profile.provider === type)?.id
            : undefined;
        const cwd = options.cwd || session.cwd;
        const model = options.model?.trim() || undefined;
        const profile = profileId ? d.providerProfiles.find((item) => item.id === profileId) : undefined;
        const executablePath = profile?.executablePath || options.detectedExecutablePath;
        const launchOptions = profileLaunchOptions(profile, model, options.effort);
        const agent: Agent = {
            id: newId("agent"),
            type,
            title: title ?? type,
            startup: agentStartup(type, resumeId, permissionMode, executablePath, launchOptions),
            directCommand: agentDirectCommand(type, resumeId, permissionMode, executablePath, launchOptions),
            resumeId,
            createdAt: Date.now(),
            permissionMode,
            profileId,
            executablePath,
            cwd,
            model,
            effort: options.effort,
            ...(permissionMode === "bypass" ? { skipPermissions: true } : {}),
            launchState: "live",
        };
        // Fresh agents (no resumeId) record the sessions that already exist so
        // reconciliation never adopts the session you were just in. The rail
        // keeps this list warm; on a cold cache we fall back to an mtime check.
        if (!resumeId) {
            const known = options.baselineSessionIds ?? peekResource(agentSessionsR, type, cwd, profile?.configPath)?.map((row) => row.id);
            if (known) agent.baselineSessionIds = [...new Set(known)];
        }
        d.agents[agent.id] = agent;
        d.lastAgentType = type;
        const win = agentWindow(agent, cwd);
        d.windows[win.id] = win;
        d.windowsBySession[session.id] = [...(d.windowsBySession[session.id] ?? []), win.id];
        sess.activeWindowId = win.id;
        attached = true;
    });
    return attached;
}

export function reconcileAgentSessions(type: AgentType, cwd: string, configPath: string | undefined, rows: AgentSession[]): void {
    if (rows.length === 0) return;
    mutate((d) => {
        const rowById = new Map(rows.map((row) => [row.id, row]));
        const matchingAgents: Agent[] = [];
        for (const sessionId of d.sessionOrder) {
            const session = d.sessions[sessionId];
            if (session?.kind !== "project") continue;
            for (const agentId of agentIdsOf(d, sessionId)) {
                const agent = d.agents[agentId];
                const agentConfigPath = agent?.profileId
                    ? d.providerProfiles.find((profile) => profile.id === agent.profileId && profile.provider === agent.type)?.configPath
                    : undefined;
                if (agent?.type === type && (agent.cwd || session.cwd) === cwd && agentConfigPath === configPath) matchingAgents.push(agent);
            }
        }
        if (matchingAgents.length === 0) return;

        const claimed = new Set<string>();
        for (const agent of matchingAgents) {
            if (!agent.resumeId) continue;
            claimed.add(agent.resumeId);
            const row = rowById.get(agent.resumeId);
            if (!row) continue;
            const nextTitle = usableAgentSessionTitle(row, agent.title);
            if (nextTitle !== agent.title) {
                agent.title = nextTitle;
                const winId = agentWindowId(d, agent.id);
                if (winId) d.windows[winId].name = nextTitle;
            }
        }

        const candidates = rows.filter((row) => !claimed.has(row.id)).sort((a, b) => b.mtime - a.mtime);
        if (candidates.length === 0) return;

        const freshAgents = matchingAgents
            .filter((agent) => !agent.resumeId && d.agentActivity[agent.id]?.source !== "acp")
            .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
        for (const agent of freshAgents) {
            // Only adopt a session that didn't exist when this agent launched,
            // otherwise it grabs the session you were just in and renames its
            // tab. `baselineSessionIds` is the snapshot taken at creation; when
            // it's missing (legacy agent / cold cache) fall back to "written at
            // or after launch", since a genuinely new session file appears
            // post-launch — never before.
            const baseline = agent.baselineSessionIds;
            const launchedAt = Math.floor((agent.createdAt ?? Date.now()) / 1000);
            const idx = candidates.findIndex((row) => (baseline ? !baseline.includes(row.id) : row.mtime >= launchedAt));
            if (idx < 0) continue;
            const [row] = candidates.splice(idx, 1);
            agent.resumeId = row.id;
            agent.title = usableAgentSessionTitle(row, agent.title);
            const profile = agent.profileId
                ? d.providerProfiles.find((item) => item.id === agent.profileId && item.provider === agent.type)
                : undefined;
            const launchOptions = profileLaunchOptions(profile, agent.model, agent.effort);
            agent.startup = agentStartup(
                agent.type,
                agent.resumeId,
                agent.permissionMode ?? (agent.skipPermissions ? "bypass" : "workspace-write"),
                profile?.executablePath || agent.executablePath,
                launchOptions,
            );
            agent.directCommand = agentDirectCommand(
                agent.type,
                agent.resumeId,
                agent.permissionMode ?? (agent.skipPermissions ? "bypass" : "workspace-write"),
                profile?.executablePath || agent.executablePath,
                launchOptions,
            );
            delete agent.baselineSessionIds;
            claimed.add(row.id);
        }
    });
}

export function attachAgentSession(id: string, resumeId: string): void {
    if (!resumeId.trim() || resumeId.length > 4_096 || /[\0\r\n]/.test(resumeId)) return;
    mutate((d) => {
        const agent = d.agents[id];
        if (!agent || agent.resumeId === resumeId) return;
        const profile = agent.profileId
            ? d.providerProfiles.find((candidate) => candidate.id === agent.profileId && candidate.provider === agent.type)
            : undefined;
        const launchOptions = profileLaunchOptions(profile, agent.model, agent.effort);
        const executablePath = profile?.executablePath || agent.executablePath;
        agent.resumeId = resumeId;
        agent.startup = agentStartup(
            agent.type,
            resumeId,
            agent.permissionMode ?? (agent.skipPermissions ? "bypass" : "workspace-write"),
            executablePath,
            launchOptions,
        );
        agent.directCommand = agentDirectCommand(
            agent.type,
            resumeId,
            agent.permissionMode ?? (agent.skipPermissions ? "bypass" : "workspace-write"),
            executablePath,
            launchOptions,
        );
        delete agent.baselineSessionIds;
    });
}

export function setAgentTitle(id: string, title: string): void {
    const value = title.trim();
    if (!value || value.length > 200 || /[\0\r\n]/.test(value)) return;
    mutate((d) => {
        const agent = d.agents[id];
        if (agent) agent.title = value;
    });
}

const PROMPT_TITLE_MAX = 72;

/* Stands in until the provider titles the conversation, which Claude only does
   once the first turn ends. */
export function titleAgentFromPrompt(id: string, text: string): void {
    const title = text.split(/\s+/).filter(Boolean).join(" ");
    if (!title || title.startsWith("/") || title.startsWith("<")) return;
    mutate((d) => {
        const agent = d.agents[id];
        if (!agent) return;
        const profile = agent.profileId ? d.providerProfiles.find((item) => item.id === agent.profileId && item.provider === agent.type) : undefined;
        if (agent.title !== (profile?.name || agent.type)) return;
        agent.title = [...title].slice(0, PROMPT_TITLE_MAX).join("");
    });
}

export function selectAgent(id: string): void {
    withActiveSession((d, session) => {
        const agent = d.agents[id];
        const winId = agentWindowId(d, id);
        if (!agent || !winId || !(d.windowsBySession[session.id] ?? []).includes(winId)) return;
        const sess = d.sessions[session.id];
        sess.activeWindowId = winId;
        // Picking a real agent tab replaces the draft, exactly like any other tab.
        d.agentPaletteOpen = false;
        if (agent.launchState === "dormant") {
            agent.launchState = "live";
            delete d.agentActivity[id];
            return;
        }
        const activity = d.agentActivity[id];
        if (activity) {
            activity.unread = false;
            if (activity.state === "done") activity.state = "idle";
        }
    });
}

/** Open an agent that lives in some other project, switching to it on the way. */
export function revealAgent(id: string): void {
    const state = getState();
    const windowId = agentWindowId(state, id);
    const sessionId = windowId ? ownerSessionId(state, windowId) : null;
    if (!sessionId) return;
    if (sessionId !== state.activeSessionId) selectSession(sessionId);
    selectAgent(id);
}

export function resumeAgent(id: string): void {
    mutate((d) => {
        const agent = d.agents[id];
        if (!agent) return;
        agent.launchState = "live";
        delete d.agentActivity[id];
    });
}

/* A turn is over long before the work it started is. Shells, monitors and
   subagents outlive the answer that launched them, and ending the agent ends
   them too, so the count of what is still going decides whether it can sleep. */
export function noteAgentBackgroundWork(id: string, tasks: number, subagents: number): void {
    mutate((d) => {
        if (!d.agents[id]) return;
        const count = tasks + subagents;
        if (count > 0) d.agentBackgroundWork[id] = count;
        else delete d.agentBackgroundWork[id];
        if (subagents > 0) d.agentSubagents[id] = subagents;
        else delete d.agentSubagents[id];
    });
}

export function agentHasBackgroundWork(state: StoreState, id: string): boolean {
    return (state.agentBackgroundWork[id] ?? 0) > 0;
}

export function sleepAgents(ids: readonly string[]): string[] {
    const sleeping = new Set(ids);
    const slept: string[] = [];
    mutate((d) => {
        for (const id of sleeping) {
            const agent = d.agents[id];
            if (!agent?.resumeId || agent.launchState === "dormant") continue;
            agent.launchState = "dormant";
            delete d.agentBackgroundWork[id];
            delete d.agentSubagents[id];
            slept.push(id);
        }
    });
    return slept;
}

export function sleepAgent(id: string): boolean {
    const agent = getState().agents[id];
    if (!agent?.resumeId) {
        notify("info", "This agent is still establishing its resumable session");
        return false;
    }
    return sleepAgents([id]).length === 1;
}

export function setAgentKeepAlive(id: string, keepAlive: boolean): void {
    mutate((d) => {
        const agent = d.agents[id];
        if (!agent) return;
        if (keepAlive) agent.keepAlive = true;
        else delete agent.keepAlive;
    });
}

export async function sleepIdleAgents(): Promise<number> {
    const state = getState();
    const ids = Object.values(state.agents)
        .filter(
            (agent) =>
                agent.launchState !== "dormant" &&
                !!agent.resumeId &&
                !agent.keepAlive &&
                !agentHasBackgroundWork(state, agent.id) &&
                state.agentActivity[agent.id]?.backendState === "idle",
        )
        .map((agent) => agent.id);
    const live = await agentIdsWithLiveSessions(state, ids);
    const count = sleepAgents(ids.filter((id) => !live.has(id))).length;
    notify("info", count === 0 ? "No idle resumable agents to sleep" : `Put ${count} idle agent${count === 1 ? "" : "s"} to sleep`);
    return count;
}

export function noteAcpAgentState(id: string, state: import("../types").AgentBackendState): void {
    noteAgentActivity(id, {
        agentId: id,
        state,
        sequence: (getState().agentActivity[id]?.sequence ?? 0) + 1,
        source: "acp",
        confidence: "high",
        reason: "ACP session state",
    });
}

export function noteAgentActivity(id: string, event: "working" | "complete" | import("../agentStatus").AgentStateEvent): void {
    mutate((d) => {
        if (!d.agents[id]) return;
        const visible = activeAgentId(d, d.sessions[d.activeSessionId]) === id;
        const previous = d.agentActivity[id];
        const semantic =
            typeof event === "string"
                ? {
                      agentId: id,
                      state: event === "complete" ? ("idle" as const) : ("working" as const),
                      sequence: (previous?.sequence ?? 0) + 1,
                      source: "activity" as const,
                      confidence: "low" as const,
                      reason: event === "complete" ? "legacy activity settled" : "terminal input or output",
                  }
                : event;
        const reduced = reduceAgentState(previous, semantic, visible);
        if (reduced) d.agentActivity[id] = reduced;
    });
}

export function clearAgentUnread(id: string): void {
    mutate((d) => {
        const activity = d.agentActivity[id];
        if (activity) {
            activity.unread = false;
            if (activity.state === "done") activity.state = "idle";
        }
    });
}

/** An agent closes as its window does; the window's close handles its browser. */
export function closeAgent(id: string): void {
    const winId = agentWindowId(getState(), id);
    if (winId) closeWindowById(winId);
}

export function focusAgents(): void {
    // Agents only exist in project sessions. Other groups (plugins,
    // ssh, command) have no agents and no way back out of "agent" view, so the
    // The agent pane shortcut (⌥4) is a no-op there.
    if (getState().sessions[getState().activeSessionId]?.kind !== "project") return;
    withActiveSession((d, session) => {
        const sess = d.sessions[session.id];
        d.agentRailOpen = true;
        d.zoomedPaneId = null;
        if (d.windows[sess.activeWindowId]?.role === "agent") return;
        const first = (d.windowsBySession[session.id] ?? []).find((id) => d.windows[id]?.role === "agent");
        if (first) sess.activeWindowId = first;
        else d.agentPaletteOpen = true;
    });
    emit({ type: "agent-focus", sessionId: getState().activeSessionId });
}
