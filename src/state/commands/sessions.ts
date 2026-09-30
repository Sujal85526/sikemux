import type { PluginManifest } from "../../api/plugins";
import { fixedSessionName } from "../sessionNames";
import { isPluginKind, pluginIdOf, type PluginKind } from "../../plugins/kinds";
import { RAIL_GROUP_ORDER, railGroupOf } from "../railGroups";
import { filesApi } from "../../api/files";
import { lsp } from "../../api/lsp";
import { sshApi } from "../../api/ssh";
import { basename, dirname } from "../../lib/paths";
import { sshStartup } from "../../terminal/sshStartup";
import { taskPtyBindings } from "../../tasks/nativeRuntime";
import { getState, mutate, setState, type StoreState } from "../store";
import { reportError } from "../toast";
import { agentIdsOf } from "../selectors";
import { collectPanes } from "../layout";
import type { Window } from "../types";
import {
    attachSession,
    closeAgentDesk,
    dirtyPathsForSession,
    disposePaneState,
    guardDiscardDirty,
    guardStopAgents,
    makeSession,
    makeWindow,
    pruneWindowViews,
} from "./shared";

function projectWindows(cwd: string): Window[] {
    return [makeWindow(cwd, "Terminal", { role: "term" })];
}

export function createProjectSession(cwd: string): void {
    mutate((d) => {
        const existing = d.sessionOrder.map((id) => d.sessions[id]).find((s) => s.cwd === cwd && s.kind === "project");
        if (existing) {
            d.pickerOpen = false;
            d.zoomedPaneId = null;
            d.activeSessionId = existing.id;
            return;
        }
        const windows = projectWindows(cwd);
        attachSession(d as unknown as StoreState, makeSession("project", basename(cwd), cwd, windows[0].id), windows);
    });
}

export function createCommandSession(): void {
    mutate((d) => {
        const used = new Set<number>();
        for (const id of d.sessionOrder) {
            const s = d.sessions[id];
            if (s.kind === "command") {
                const n = parseInt(s.name, 10);
                if (Number.isFinite(n)) used.add(n);
            }
        }
        let n = 1;
        while (used.has(n)) n += 1;
        const win = makeWindow("", String(n));
        attachSession(d as unknown as StoreState, makeSession("command", String(n), "", win.id), [win]);
    });
}

export function focusCommandSession(): void {
    mutate((d) => {
        const commandId = d.sessionOrder.find((id) => d.sessions[id]?.kind === "command");
        if (!commandId) return;
        d.activeSessionId = commandId;
        d.zoomedPaneId = null;
        d.pickerOpen = false;
        d.settingsOpen = false;
    });
}

export function createSshSession(alias: string): void {
    mutate((d) => {
        const existing = d.sessionOrder.map((id) => d.sessions[id]).find((s) => s.kind === "ssh" && s.name === alias);
        if (existing) {
            d.pickerOpen = false;
            d.zoomedPaneId = null;
            d.activeSessionId = existing.id;
            return;
        }
        const win = makeWindow("", alias, { startup: sshStartup(alias), role: "named" });
        attachSession(d as unknown as StoreState, makeSession("ssh", alias, "", win.id), [win]);
    });
}

function openSingletonPaneSession(kind: PluginKind): void {
    mutate((d) => {
        const existing = d.sessionOrder.map((id) => d.sessions[id]).find((s) => s.kind === kind);
        if (existing) {
            d.activeSessionId = existing.id;
            d.zoomedPaneId = null;
            return;
        }
        const title = fixedSessionName(kind) ?? kind;
        const win = makeWindow("", title, { kind, role: kind, fixed: true });
        attachSession(d as unknown as StoreState, makeSession(kind, title, "", win.id), [win]);
    });
}

export const openPluginSession = (kind: PluginKind): void => openSingletonPaneSession(kind);

export const setPluginManifests = (pluginManifests: readonly PluginManifest[]): void => setState({ pluginManifests });

/** Switching a plugin off also closes whatever of it is open, since nothing can reach it any more. */
export function setPluginEnabled(id: string, enabled: boolean): void {
    if (!enabled) {
        const st = getState();
        for (const sessionId of st.sessionOrder) {
            const kind = st.sessions[sessionId]?.kind;
            if (kind && isPluginKind(kind) && pluginIdOf(kind) === id) closeSessionNow(sessionId);
        }
    }
    setState((s) => ({ disabledPlugins: enabled ? s.disabledPlugins.filter((known) => known !== id) : [...new Set([...s.disabledPlugins, id])] }));
}

export function selectSession(id: string): void {
    mutate((d) => {
        if (!d.sessions[id]) return;
        d.activeSessionId = id;
        d.zoomedPaneId = null;
        d.sessionSwitcher = null;
        d.pickerOpen = false;
        d.settingsOpen = false;
    });
}

export function selectLastSession(): void {
    const id = getState().lastSessionId;
    if (id) selectSession(id);
}

export function reorderSession(sourceId: string, targetId: string, placement: "before" | "after"): void {
    mutate((d) => {
        const source = d.sessions[sourceId];
        const target = d.sessions[targetId];
        if (!source || !target || sourceId === targetId || source.kind !== target.kind) return;

        const slots = d.sessionOrder.flatMap((id, index) => (d.sessions[id]?.kind === source.kind ? [index] : []));
        const ordered = slots.map((index) => d.sessionOrder[index]).filter((id) => id !== sourceId);
        const targetIndex = ordered.indexOf(targetId);
        if (targetIndex < 0) return;

        ordered.splice(targetIndex + (placement === "after" ? 1 : 0), 0, sourceId);
        if (slots.every((slot, index) => d.sessionOrder[slot] === ordered[index])) return;
        slots.forEach((slot, index) => {
            d.sessionOrder[slot] = ordered[index];
        });
    });
}

export function closeSession(id: string): void {
    const st = getState();
    if (!st.sessions[id] || st.sessionOrder.length <= 1) return;
    const name = st.sessions[id].name;
    guardStopAgents(agentIdsOf(st, id), `Close ${name}?`, () =>
        guardDiscardDirty(dirtyPathsForSession(getState(), id), "close session", () => closeSessionNow(id)),
    );
}

function closeSessionNow(id: string): void {
    const beforeClose = getState();
    const closingCwd = beforeClose.sessions[id]?.cwd;
    const closingAgentIds = agentIdsOf(beforeClose, id);
    const taskPaneIds = (beforeClose.windowsBySession[id] ?? []).flatMap((windowId) => {
        const window = beforeClose.windows[windowId];
        return window
            ? collectPanes(window.root)
                  .filter((pane) => pane.externalPty)
                  .map((pane) => pane.id)
            : [];
    });
    mutate((d) => {
        if (d.sessionOrder.length <= 1) return;
        const closed = d.sessions[id];
        if (!closed) return;
        const idx = d.sessionOrder.indexOf(id);
        const winIds = d.windowsBySession[id] ?? [];
        const isSshConfig = winIds.some((windowId) => d.windows[windowId]?.role === "ssh-config");

        for (const wid of winIds) {
            const w = d.windows[wid];
            if (w) {
                for (const p of collectPanes(w.root as unknown as Window["root"])) {
                    if (d.gitModal?.ownerPaneId === p.id) d.gitModal = null;
                    disposePaneState(d, p.id);
                }
            }
            delete d.windows[wid];
        }
        delete d.windowsBySession[id];
        delete d.globalSearchBySession[id];
        delete d.sessions[id];
        d.sessionOrder = d.sessionOrder.filter((x) => x !== id);

        if (d.activeSessionId === id) {
            d.activeSessionId = d.sessionOrder[Math.min(idx, d.sessionOrder.length - 1)];
        }
        if (closed.kind !== "command" && !isSshConfig) {
            d.recent = [{ kind: closed.kind, name: closed.name, cwd: closed.cwd }, ...d.recent.filter((r) => r.cwd !== closed.cwd)].slice(0, 12);
        }
        d.zoomedPaneId = null;
    });
    if (!getState().sessions[id]) {
        for (const paneId of taskPaneIds) taskPtyBindings.release(paneId);
        for (const agentId of closingAgentIds) closeAgentDesk(agentId);
    }
    if (closingCwd) {
        const stillOpen = Object.values(getState().sessions).some((s) => s.cwd === closingCwd);
        if (!stillOpen) {
            filesApi.evict(closingCwd);
            void lsp.stop(closingCwd).catch(() => {});
        }
    }
}

export function closeActiveSession(): void {
    closeSession(getState().activeSessionId);
}

export function cycleSession(delta: number): void {
    mutate((d) => {
        const cur = d.sessions[d.activeSessionId];
        if (!cur) return;
        const groupIds = d.sessionOrder.filter((id) => d.sessions[id].kind === cur.kind);
        if (groupIds.length < 2) return;
        const idx = groupIds.indexOf(cur.id);
        d.activeSessionId = groupIds[(idx + delta + groupIds.length) % groupIds.length];
        d.zoomedPaneId = null;
    });
}

export function beginSessionSwitch(delta: number, releaseModifier: import("../types").KeyModifier): void {
    mutate((d) => {
        const cur = d.sessions[d.activeSessionId];
        if (!cur) return;
        const sessionIds = d.sessionOrder.filter((id) => d.sessions[id]?.kind === cur.kind);
        if (sessionIds.length < 2) return;
        const idx = sessionIds.indexOf(cur.id);
        d.sessionSwitcher = {
            sessionIds,
            selectedSessionId: sessionIds[(idx + delta + sessionIds.length) % sessionIds.length],
            releaseModifier,
        };
    });
}

export function cycleSessionSwitch(delta: number): void {
    mutate((d) => {
        const switcher = d.sessionSwitcher;
        if (!switcher) return;
        const sessionIds = switcher.sessionIds.filter((id) => d.sessions[id]);
        if (sessionIds.length < 2) {
            d.sessionSwitcher = null;
            return;
        }
        const idx = sessionIds.indexOf(switcher.selectedSessionId);
        switcher.sessionIds = sessionIds;
        switcher.selectedSessionId = sessionIds[((idx < 0 ? 0 : idx) + delta + sessionIds.length) % sessionIds.length];
    });
}

export function commitSessionSwitch(): void {
    mutate((d) => {
        const selectedId = d.sessionSwitcher?.selectedSessionId;
        if (selectedId && d.sessions[selectedId]) {
            d.activeSessionId = selectedId;
            d.zoomedPaneId = null;
        }
        d.sessionSwitcher = null;
    });
}

export function cancelSessionSwitch(): void {
    mutate((d) => {
        d.sessionSwitcher = null;
    });
}

export function cycleSessionGroup(delta: number): void {
    mutate((d) => {
        const cur = d.sessions[d.activeSessionId];
        if (!cur) return;
        const groupOf = (id: string) => {
            const session = d.sessions[id];
            return session ? railGroupOf(session.kind, d.pluginManifests, d.disabledPlugins) : null;
        };
        const populated = RAIL_GROUP_ORDER.filter((group) => d.sessionOrder.some((id) => groupOf(id) === group));
        if (populated.length < 2) return;
        const curGroup = railGroupOf(cur.kind, d.pluginManifests, d.disabledPlugins);
        const curIdx = curGroup ? populated.indexOf(curGroup) : -1;
        if (curIdx === -1) return;
        const nextGroup = populated[(curIdx + delta + populated.length) % populated.length];
        const nextId = d.sessionOrder.find((id) => groupOf(id) === nextGroup);
        if (!nextId) return;
        d.activeSessionId = nextId;
        d.zoomedPaneId = null;
    });
}

export async function openSshConfigEditor(): Promise<void> {
    let configPath: string;
    try {
        configPath = await sshApi.configEnsure();
    } catch (error) {
        reportError("open SSH config")(error);
        return;
    }
    const sshDir = dirname(configPath);

    mutate((d) => {
        let owner = d.sessionOrder.find((sessionId) =>
            (d.windowsBySession[sessionId] ?? []).some((windowId) => d.windows[windowId]?.role === "ssh-config"),
        );
        const targetId = owner ? (d.windowsBySession[owner] ?? []).find((windowId) => d.windows[windowId]?.role === "ssh-config") : undefined;
        let target = targetId ? d.windows[targetId] : undefined;
        let editorPane = target ? collectPanes(target.root).find((pane) => pane.kind === "editor") : undefined;

        // Replace the short-lived bespoke SSH pane shape from development builds.
        if (!target || !editorPane) {
            const stale = target;
            target = makeWindow(sshDir, "ssh config", { kind: "editor", role: "ssh-config" });
            editorPane = target.root.type === "pane" ? target.root : undefined;
            d.windows[target.id] = target;
            if (stale && owner) {
                pruneWindowViews(d, stale);
                delete d.windows[stale.id];
                d.windowsBySession[owner] = (d.windowsBySession[owner] ?? []).map((id) => (id === stale.id ? target!.id : id));
            }
        }
        if (!editorPane) return;

        // Older builds attached this window to whichever project happened to be
        // active. Detach it and give it its own SSH-side session instead.
        if (owner && d.sessions[owner]?.kind !== "ssh") {
            const formerIds = d.windowsBySession[owner] ?? [];
            const remaining = formerIds.filter((id) => id !== target!.id);
            d.windowsBySession[owner] = remaining;
            if (d.sessions[owner].activeWindowId === target.id && remaining.length > 0) {
                d.sessions[owner].activeWindowId = remaining[0];
            }
            owner = undefined;
        }

        let configSession = owner ? d.sessions[owner] : undefined;
        if (!configSession) {
            configSession = makeSession("ssh", "SSH config", sshDir, target.id);
            attachSession(d as unknown as StoreState, configSession, [target]);
            owner = configSession.id;
        } else {
            d.activeSessionId = configSession.id;
            d.zoomedPaneId = null;
            d.pickerOpen = false;
        }

        const editorView = d.editorViews[editorPane.id] ?? { openTabs: [], activePath: null };
        if (!editorView.openTabs.includes(configPath)) editorView.openTabs.push(configPath);
        editorView.activePath = configPath;
        d.editorViews[editorPane.id] = editorView;

        configSession.activeWindowId = target.id;
        target.activePaneId = editorPane.id;
        d.zoomedPaneId = null;
        d.settingsOpen = false;
    });
}
