import { useEffect, useState } from "react";
import { invokeCommand as invoke } from "./api/invoke";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { checkForUpdate } from "./api/updater";
import { TopBar } from "./components/TopBar";
import { SideRail } from "./components/SideRail";
import { AgentRail } from "./components/AgentRail";
import { AgentSessionSync } from "./components/AgentSessionSync";
import { FilePalette } from "./components/FilePalette";
import { SeshPicker } from "./components/SeshPicker";
import { SessionSwitcher } from "./components/SessionSwitcher";
import { SettingsPanel } from "./components/SettingsPanel";
import { AwsAuthModal } from "./components/aws/AwsAuthModal";
import { RundeckJobPalette } from "./components/rundeck/RundeckJobPalette";
import { BrunoRequestPalette } from "./components/bruno/BrunoRequestPalette";
import { BrunoEnvPalette } from "./components/bruno/BrunoEnvPalette";
import { Workspace } from "./components/Workspace";
import { Toaster } from "./components/Toaster";
import { CommandPalette } from "./components/CommandPalette";
import { DiagnosticsOverlay, Onboarding, WhatsNewOverlay } from "./components/ExperienceOverlays";
import { TerminalPane } from "./terminal/TerminalPane";
import { AgentNotifications } from "./components/AgentNotifications";
import { CliOpenBridge } from "./components/CliOpenBridge";
import { git, type GitWorktree } from "./api/git";
import { runKeybindingAction, useKeymap } from "./keymap";
import { filesApi } from "./api/files";
import { emit, subscribe } from "./state/bus";
import * as cmd from "./state/commands";
import { applyHydrate, canFlushPersist, flushPersist, subscribePersist } from "./state/persist";
import { dispatchFolder, dispatchPty } from "./state/dropRegistry";
import { notify, reportError, swallow } from "./state/toast";
import { invalidate } from "./state/resources";
import { getState, useStore } from "./state/store";
import { applyTheme, applyWindowOpacity, registerCustomThemes } from "./themes/bus";
import { dirname } from "./lib/paths";
import type { StandaloneCommand } from "./commands/registry";
import { agentDetectionApi } from "./api/agentDetection";
import { loadProjectConfig, type ProjectConfigLoadResult } from "./projectConfig";
import { projectActionCommand, trustProjectConfig } from "./projectConfigRuntime";
import { worktreeHasLiveOwners } from "./worktreeLifecycle";
import { performanceTelemetry } from "./lib/performance";

interface BootInfo {
    home: string;
    state: string;
    recent: string[];
}

interface TreeDropTarget {
    rootPath: string;
    targetDir: string;
    highlightPath: string | null;
    dropEl: HTMLElement;
}

function elementAtPhysicalPosition(pos: { x: number; y: number }): HTMLElement | null {
    const dpr = window.devicePixelRatio || 1;
    return document.elementFromPoint(pos.x / dpr, pos.y / dpr) as HTMLElement | null;
}

function folderDropElement(treeRoot: HTMLElement, rootPath: string, dir: string): HTMLElement | null {
    if (dir === rootPath) return treeRoot;
    for (const row of treeRoot.querySelectorAll<HTMLElement>(".tree-row.is-folder")) {
        if (row.dataset.folderPath === dir) return row;
    }
    return null;
}

function resolveTreeDropTarget(at: HTMLElement | null): TreeDropTarget | null {
    const treeRoot = at?.closest(".ed-tree-scroll") as HTMLElement | null;
    const rootPath = treeRoot?.dataset.rootPath;
    if (!treeRoot || !rootPath) return null;

    const folder = at?.closest(".tree-row.is-folder") as HTMLElement | null;
    if (folder && treeRoot.contains(folder) && folder.dataset.folderPath) {
        return {
            rootPath,
            targetDir: folder.dataset.folderPath,
            highlightPath: folder.dataset.folderPath,
            dropEl: folder,
        };
    }

    const file = at?.closest(".tree-row.file") as HTMLElement | null;
    if (file && treeRoot.contains(file) && file.dataset.filePath) {
        const targetDir = file.dataset.dropDir || dirname(file.dataset.filePath);
        const dropEl = folderDropElement(treeRoot, rootPath, targetDir);
        if (!dropEl) return null;
        return {
            rootPath,
            targetDir,
            highlightPath: targetDir === rootPath ? null : targetDir,
            dropEl,
        };
    }

    return {
        rootPath,
        targetDir: rootPath,
        highlightPath: null,
        dropEl: treeRoot,
    };
}

export default function App() {
    useKeymap();
    const [bootReady, setBootReady] = useState(false);
    const zen = useStore((s) => s.zenMode);
    const leftOpen = useStore((s) => s.leftRailOpen) && !zen;
    const rightOpen = useStore((s) => s.rightRailOpen) && !zen;
    const activeSessionIsProject = useStore((s) => s.sessions[s.activeSessionId]?.kind === "project");
    const pickerOpen = useStore((s) => s.pickerOpen);
    const filePaletteOpen = useStore((s) => s.filePaletteOpen);
    const rundeckJobPaletteOpen = useStore((s) => s.rundeckJobPaletteOpen);
    const brunoReqPaletteOpen = useStore((s) => s.brunoReqPaletteOpen);
    const brunoEnvPaletteOpen = useStore((s) => s.brunoEnvPaletteOpen);
    const settingsOpen = useStore((s) => s.settingsOpen);
    const commandPaletteOpen = useStore((s) => s.commandPaletteOpen);
    const commandPopup = useStore((s) => s.commandPopup);
    const keybindingOverrides = useStore((s) => s.keybindingOverrides);
    const customCommands = useStore((s) => s.customCommands);
    const recentCommandKeys = useStore((s) => s.recentCommandKeys);
    const activeKind = useStore((s) => s.sessions[s.activeSessionId]?.kind ?? null);
    const activeProjectCwd = useStore((s) => {
        const session = s.sessions[s.activeSessionId];
        return session?.kind === "project" ? session.cwd : "";
    });
    const [projectConfigState, setProjectConfigState] = useState<{ cwd: string; result: ProjectConfigLoadResult } | null>(null);
    const [worktreeState, setWorktreeState] = useState<{ cwd: string; items: GitWorktree[] } | null>(null);
    const projectConfig = projectConfigState?.cwd === activeProjectCwd ? projectConfigState.result : null;
    const activeWorktrees = worktreeState?.cwd === activeProjectCwd ? worktreeState.items : [];
    const activeTerminalWindowId = useStore((s) => {
        const id = s.sessions[s.activeSessionId]?.activeWindowId;
        return id && s.windows[id]?.role === "term" ? id : null;
    });
    const awsAuthModal = useStore((s) => s.awsAuthModal);
    const sessionSwitcherOpen = useStore((s) => s.sessionSwitcher !== null);
    const projectRepoKey = useStore((s) =>
        s.sessionOrder
            .map((id) => {
                const sess = s.sessions[id];
                return sess?.kind === "project" ? sess.cwd : "";
            })
            .filter(Boolean)
            .join("\0"),
    );
    const runStandalone =
        (id: string, execute: () => void): (() => void) =>
        () => {
            cmd.noteRecentCommand(`standalone:${id}`);
            execute();
        };
    const projectCommands: StandaloneCommand[] = [];
    if (projectConfig?.status === "valid") {
        for (const action of projectConfig.config.actions.filter(
            (candidate) => candidate.contexts.length === 0 || candidate.contexts.includes("project"),
        )) {
            projectCommands.push({
                id: `project.action.${action.id}`,
                title: action.label,
                detail: action.description || `Run from ${projectConfig.path}`,
                category: "Project · sikemux.json",
                execute: runStandalone(`project.action.${action.id}`, () => {
                    if (!trustProjectConfig(projectConfig)) return;
                    cmd.runCustomCommand(projectActionCommand(action));
                }),
            });
        }
        if (projectConfig.config.preview?.command) {
            projectCommands.push({
                id: "project.preview.start",
                title: "Start project preview",
                detail: projectConfig.config.preview.url ? `Serve ${projectConfig.config.preview.url}` : "Run the checked-in preview command",
                category: "Project · Preview",
                execute: runStandalone("project.preview.start", () => {
                    if (!trustProjectConfig(projectConfig)) return;
                    cmd.runCustomCommand({
                        id: "project.preview.start",
                        title: "Project preview",
                        detail: "Checked-in preview command",
                        command: projectConfig.config.preview!.command!,
                        contexts: ["project"],
                        placement: "terminal",
                    });
                }),
            });
        }
        if (projectConfig.config.preview?.url) {
            projectCommands.push({
                id: "project.preview.open",
                title: "Open project preview",
                detail: projectConfig.config.preview.url,
                category: "Project · Preview",
                execute: runStandalone("project.preview.open", () => {
                    void invoke("open_url", { url: projectConfig.config.preview!.url!, app: null, shortcut: null }).catch(
                        reportError("open project preview"),
                    );
                }),
            });
        }
    } else if (projectConfig?.status === "invalid") {
        projectCommands.push({
            id: "project.config.invalid",
            title: "Project config needs attention",
            detail: projectConfig.errors[0]?.message ?? "sikemux.json is invalid",
            category: "Project · sikemux.json",
            execute: runStandalone("project.config.invalid", () =>
                notify("error", `sikemux.json: ${projectConfig.errors.map((error) => `${error.path} ${error.message}`).join(" · ")}`),
            ),
        });
    }
    const worktreeCommands: StandaloneCommand[] = activeWorktrees
        .filter((worktree) => !worktree.bare)
        .flatMap((worktree) => [
            {
                id: `worktree.open.${worktree.path}`,
                title: worktree.current ? "Open current worktree" : `Open worktree: ${worktree.branch ?? "detached"}`,
                detail: worktree.path,
                category: "Project · Worktrees",
                execute: runStandalone(`worktree.open.${worktree.path}`, () => cmd.createProjectSession(worktree.path)),
            },
            ...(!worktree.is_main && !worktree.current
                ? [
                      {
                          id: `worktree.remove.${worktree.path}`,
                          title: `Remove worktree: ${worktree.branch ?? "detached"}`,
                          detail: "Safe removal; dirty worktrees are refused",
                          category: "Project · Worktrees",
                          execute: runStandalone(`worktree.remove.${worktree.path}`, () => {
                              if (worktreeHasLiveOwners(getState(), worktree.path)) {
                                  notify("info", "Close the worktree’s Sikemux project and agents before removing it");
                                  return;
                              }
                              if (!window.confirm(`Remove worktree ${worktree.branch ?? worktree.path}?\n\nDirty worktrees will be refused.`)) return;
                              void git
                                  .worktreeRemove(activeProjectCwd, worktree.path)
                                  .then(() => {
                                      setWorktreeState((state) =>
                                          state?.cwd === activeProjectCwd
                                              ? { ...state, items: state.items.filter((item) => item.path !== worktree.path) }
                                              : state,
                                      );
                                      notify("success", `Removed worktree ${worktree.branch ?? worktree.path}`);
                                  })
                                  .catch(reportError("remove worktree"));
                          }),
                      } satisfies StandaloneCommand,
                  ]
                : []),
        ]);
    const standaloneCommands: StandaloneCommand[] = [
        ...(activeKind === "project"
            ? [
                  {
                      id: "agents.launch",
                      title: "Launch an agent lane",
                      detail: "Choose a provider, safety boundary, and Git worktree",
                      category: "Agents",
                      execute: runStandalone("agents.launch", cmd.openAgentPalette),
                  } satisfies StandaloneCommand,
              ]
            : []),
        {
            id: "support.diagnostics",
            title: "Open runtime diagnostics",
            detail: "Inspect redacted runtime and agent-detection health",
            category: "Support",
            execute: runStandalone("support.diagnostics", cmd.openDiagnostics),
        },
        {
            id: "support.whats-new",
            title: "Open What’s New",
            detail: "Review the latest Sikemux release notes",
            category: "Support",
            execute: runStandalone("support.whats-new", cmd.openWhatsNew),
        },
        {
            id: "support.onboarding",
            title: "Replay onboarding",
            detail: "Open the first-run Sikemux walkthrough",
            category: "Support",
            execute: runStandalone("support.onboarding", cmd.openOnboarding),
        },
        {
            id: "session.export",
            title: "Copy active session bundle",
            detail: "Export a safe session copy to the clipboard",
            category: "Session",
            execute: runStandalone("session.export", () => void cmd.exportActiveSession().catch(reportError("session export"))),
        },
        {
            id: "session.import",
            title: "Import session from clipboard",
            detail: "Validate and import a safe dormant session copy",
            category: "Session",
            execute: runStandalone("session.import", () => void cmd.importSessionFromClipboard().catch(reportError("session import"))),
        },
        ...(activeTerminalWindowId
            ? [
                  {
                      id: "window.duplicate",
                      title: "Duplicate active terminal",
                      detail: "Clone the active window into a new terminal tab",
                      category: "Window",
                      execute: runStandalone("window.duplicate", () => cmd.duplicateWindow(activeTerminalWindowId)),
                  } satisfies StandaloneCommand,
              ]
            : []),
        {
            id: "agents.reload-manifests",
            title: "Reload agent manifests",
            detail: "Reload agent-state detection rules from disk",
            category: "Agents",
            execute: runStandalone("agents.reload-manifests", () => void agentDetectionApi.reload().catch(reportError("agent manifest reload"))),
        },
        ...worktreeCommands,
        ...projectCommands,
    ];

    useEffect(() => {
        let cancelled = false;
        let generation = 0;
        if (!activeProjectCwd) {
            setProjectConfigState(null);
            setWorktreeState(null);
            return;
        }
        const refresh = () => {
            const requestGeneration = ++generation;
            setProjectConfigState(null);
            setWorktreeState(null);
            void loadProjectConfig(activeProjectCwd).then((result) => {
                if (!cancelled && requestGeneration === generation) setProjectConfigState({ cwd: activeProjectCwd, result });
            });
            void git
                .worktrees(activeProjectCwd)
                .then((items) => {
                    if (!cancelled && requestGeneration === generation) setWorktreeState({ cwd: activeProjectCwd, items });
                })
                .catch(() => {
                    if (!cancelled && requestGeneration === generation) setWorktreeState({ cwd: activeProjectCwd, items: [] });
                });
        };
        refresh();
        const unsubscribe = subscribe("fs-changed", (event) => {
            if (!event.repo || event.repo === activeProjectCwd) refresh();
        });
        const unsubscribeGit = subscribe("git-refresh", (event) => {
            if (!event.repo || event.repo === activeProjectCwd) refresh();
        });
        return () => {
            cancelled = true;
            unsubscribe();
            unsubscribeGit();
        };
    }, [activeProjectCwd]);

    useEffect(() => {
        let disposed = false;
        let unsub = () => {};
        let bootFinished = false;
        const bootSpan = performanceTelemetry.startTrace("startup.boot");
        const finishBoot = (outcome: "success" | "error" | "cancelled") => {
            if (bootFinished) return;
            bootFinished = true;
            const recorded = performanceTelemetry.endSpan(bootSpan, { outcome });
            if (recorded) performanceTelemetry.recordLatency("startup.boot", recorded.durationMs);
        };
        invoke<BootInfo>("boot_init")
            .then((boot) => {
                if (disposed) return;
                const hydrateSpan = performanceTelemetry.startSpan(bootSpan, "startup.hydrate");
                try {
                    cmd.setHome(boot.home);
                    applyHydrate(boot.state);
                    const st = getState();
                    registerCustomThemes(st.customThemes);
                    applyTheme(st.themeId);
                    applyWindowOpacity(st.windowOpacity);
                    if (st.themeMode === "system") cmd.applySystemTheme(window.matchMedia("(prefers-color-scheme: dark)").matches);
                    cmd.setWindowBlur(st.windowBlur);
                    if (!st.onboardingComplete) cmd.openOnboarding();
                    else if (st.lastReleaseNotes && st.lastSeenVersion !== st.lastReleaseNotes.version) cmd.openWhatsNew();
                    performanceTelemetry.endSpan(hydrateSpan, { outcome: "success" });
                } catch (error) {
                    performanceTelemetry.endSpan(hydrateSpan, { outcome: "error" });
                    throw error;
                }
            })
            .catch((error) => {
                finishBoot("error");
                swallow("boot_init")(error);
            })
            .finally(() => {
                if (!disposed) {
                    unsub = subscribePersist();
                    setBootReady(true);
                }
                finishBoot(disposed ? "cancelled" : "success");
            });
        return () => {
            disposed = true;
            finishBoot("cancelled");
            unsub();
        };
    }, []);

    useEffect(
        () =>
            useStore.subscribe((state, previous) => {
                if (state.activeSessionId !== previous.activeSessionId && previous.sessions[previous.activeSessionId]) {
                    cmd.setLastSessionId(previous.activeSessionId);
                }
            }),
        [],
    );

    useEffect(() => {
        const media = window.matchMedia("(prefers-color-scheme: dark)");
        const apply = () => cmd.applySystemTheme(media.matches);
        media.addEventListener("change", apply);
        return () => media.removeEventListener("change", apply);
    }, []);

    useEffect(() => {
        let disposed = false;
        let closing = false;
        const onPageHide = () => {
            if (canFlushPersist()) void flushPersist();
        };
        window.addEventListener("pagehide", onPageHide);
        const closeListener = getCurrentWindow()
            .onCloseRequested(async (event) => {
                if (closing) return;
                // boot_init may still be loading the durable snapshot. Let Tauri
                // close normally instead of replacing it with initial UI state.
                if (!canFlushPersist()) return;
                closing = true;
                event.preventDefault();
                try {
                    const saved = (await flushPersist()) || (await flushPersist());
                    if (saved && !disposed) await getCurrentWindow().destroy();
                } finally {
                    closing = false;
                }
            })
            .catch(swallow("close persistence"));
        return () => {
            disposed = true;
            window.removeEventListener("pagehide", onPageHide);
            void closeListener.then((unlisten) => {
                if (typeof unlisten === "function") unlisten();
            });
        };
    }, []);

    useEffect(() => {
        const handle = listen<{ repo: string }>("git_changed", (e) => {
            const repo = e.payload.repo || "";
            filesApi.invalidate(repo || undefined);
            invalidate((kind, args) => {
                if (!kind.startsWith("git.") && kind !== "files.list") return false;
                if (!repo) return true;
                return args[0] === repo;
            });
            emit({ type: "fs-changed", repo });
        });
        return () => {
            void handle.then((u) => u());
        };
    }, []);

    useEffect(() => {
        const repos = projectRepoKey ? projectRepoKey.split("\0") : [];
        for (const repo of repos) {
            git.watchStart(repo).catch(reportError("repo watch"));
        }
        return () => {
            for (const repo of repos) {
                git.watchStop(repo).catch(swallow("repo watch stop"));
            }
        };
    }, [projectRepoKey]);

    useEffect(() => {
        return subscribe("rnd-auth-expired", () => {
            invalidate((kind) => kind.startsWith("rnd."));
        });
    }, []);

    useEffect(() => {
        return subscribe("aws-auth-expired", () => {
            invalidate((kind) => kind.startsWith("aws."));
        });
    }, []);

    useEffect(() => {
        const firstCheck = window.setTimeout(() => void checkForUpdate(), 4000);
        const poll = window.setInterval(() => void checkForUpdate(), 30 * 60_000);
        return () => {
            window.clearTimeout(firstCheck);
            window.clearInterval(poll);
        };
    }, []);

    useEffect(() => {
        const clearTreeHover = () => {
            emit({ type: "tree-native-drag-hover", cwd: null, targetDir: null, highlightPath: null });
        };

        const emitTreeHover = (at: HTMLElement | null) => {
            const target = resolveTreeDropTarget(at);
            emit({
                type: "tree-native-drag-hover",
                cwd: target?.rootPath ?? null,
                targetDir: target?.targetDir ?? null,
                highlightPath: target?.highlightPath ?? null,
            });
        };

        const unlistenP = getCurrentWebview().onDragDropEvent((e) => {
            if (e.payload.type === "leave") {
                clearTreeHover();
                return;
            }

            const at = elementAtPhysicalPosition(e.payload.position);

            if (e.payload.type === "enter" || e.payload.type === "over") {
                if (at?.closest(".terminal-host")) clearTreeHover();
                else emitTreeHover(at);
                return;
            }

            const paths = e.payload.paths;
            if (!paths || paths.length === 0) {
                clearTreeHover();
                return;
            }
            const term = at?.closest(".terminal-host") as HTMLElement | null;
            if (term && dispatchPty(term, paths)) {
                clearTreeHover();
                return;
            }
            const target = resolveTreeDropTarget(at);
            if (target) dispatchFolder(target.dropEl, paths);
            clearTreeHover();
        });
        return () => {
            void unlistenP.then((u) => u());
        };
    }, []);

    return (
        <div className="shell">
            {bootReady && <CliOpenBridge />}
            <AgentSessionSync />
            <AgentNotifications />
            <TopBar />
            <div className="body">
                {leftOpen && <SideRail />}
                <main className={`stage${settingsOpen ? " stage--settings" : ""}`}>
                    <Workspace />
                    {settingsOpen && <SettingsPanel />}
                </main>
                {rightOpen && activeSessionIsProject && <AgentRail />}
            </div>
            {pickerOpen && <SeshPicker />}
            {filePaletteOpen && <FilePalette />}
            {rundeckJobPaletteOpen && <RundeckJobPalette />}
            {brunoReqPaletteOpen && <BrunoRequestPalette />}
            {brunoEnvPaletteOpen && <BrunoEnvPalette />}
            {awsAuthModal && <AwsAuthModal />}
            {sessionSwitcherOpen && <SessionSwitcher />}
            {commandPaletteOpen && (
                <CommandPalette
                    keybindingOverrides={keybindingOverrides}
                    customCommands={customCommands}
                    recentCommandKeys={recentCommandKeys}
                    standaloneCommands={standaloneCommands}
                    context={activeKind}
                    onClose={cmd.closeCommandPalette}
                    onExecute={cmd.noteRecentCommand}
                    executeBuiltin={(id) => {
                        runKeybindingAction(id, new KeyboardEvent("keydown"), getState());
                    }}
                    executeCustom={(command) => {
                        cmd.runCustomCommand(command);
                    }}
                />
            )}
            {commandPopup && (
                <div className="experience-backdrop command-popup-backdrop" role="presentation" onMouseDown={cmd.closeCommandPopup}>
                    <section
                        className="command-popup"
                        role="dialog"
                        aria-modal="true"
                        aria-label={commandPopup.title}
                        onMouseDown={(event) => event.stopPropagation()}>
                        <header>
                            <span>{commandPopup.title}</span>
                            <button onClick={cmd.closeCommandPopup}>close</button>
                        </header>
                        <TerminalPane
                            key={commandPopup.id}
                            cwd={commandPopup.cwd || undefined}
                            startup={commandPopup.startup}
                            context={commandPopup.context}
                            active
                            visible
                        />
                    </section>
                </div>
            )}
            <Onboarding />
            <DiagnosticsOverlay />
            <WhatsNewOverlay />
            <Toaster />
        </div>
    );
}
