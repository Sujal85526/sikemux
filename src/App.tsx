import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { checkForUpdate } from "./api/updater";
import { TopBar } from "./components/TopBar";
import { SideRail } from "./components/SideRail";
import { AgentRail } from "./components/AgentRail";
import { AgentPalette } from "./components/AgentPalette";
import { FilePalette } from "./components/FilePalette";
import { SeshPicker } from "./components/SeshPicker";
import { SettingsPanel } from "./components/SettingsPanel";
import { AwsAuthModal } from "./components/aws/AwsAuthModal";
import { RundeckJobPalette } from "./components/rundeck/RundeckJobPalette";
import { Workspace } from "./components/Workspace";
import { Toaster } from "./components/Toaster";
import { git } from "./api/git";
import { useKeymap } from "./keymap";
import { filesApi } from "./api/files";
import { emit, subscribe } from "./state/bus";
import * as cmd from "./state/commands";
import { applyHydrate, subscribePersist } from "./state/persist";
import { dispatchFolder, dispatchPty } from "./state/dropRegistry";
import { reportError, swallow } from "./state/toast";
import { invalidate } from "./state/resources";
import { getState, useStore } from "./state/store";
import { applyTheme, applyWindowOpacity } from "./themes/bus";

interface BootInfo {
    home: string;
    state: string;
    recent: string[];
}

export default function App() {
    useKeymap();
    const zen = useStore((s) => s.zenMode);
    const leftOpen = useStore((s) => s.leftRailOpen) && !zen;
    const rightOpen = useStore((s) => s.rightRailOpen) && !zen;
    const activeSessionIsProject = useStore((s) => s.sessions[s.activeSessionId]?.kind === "project");
    const pickerOpen = useStore((s) => s.pickerOpen);
    const agentPaletteOpen = useStore((s) => s.agentPaletteOpen);
    const filePaletteOpen = useStore((s) => s.filePaletteOpen);
    const rundeckJobPaletteOpen = useStore((s) => s.rundeckJobPaletteOpen);
    const settingsOpen = useStore((s) => s.settingsOpen);
    const awsAuthModal = useStore((s) => s.awsAuthModal);
    const projectRepoKey = useStore((s) =>
        s.sessionOrder
            .map((id) => {
                const sess = s.sessions[id];
                return sess?.kind === "project" ? sess.cwd : "";
            })
            .filter(Boolean)
            .join("\0"),
    );

    useEffect(() => {
        let unsub = () => {};
        invoke<BootInfo>("boot_init")
            .then((boot) => {
                cmd.setHome(boot.home);
                applyHydrate(boot.state);
                const st = getState();
                applyTheme(st.themeId);
                applyWindowOpacity(st.windowOpacity);
                cmd.setWindowBlur(st.windowBlur);
            })
            .catch(swallow("boot_init"))
            .finally(() => {
                unsub = subscribePersist();
            });
        return () => unsub();
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
        const unlistenP = getCurrentWebview().onDragDropEvent((e) => {
            if (e.payload.type !== "drop") return;
            const paths = e.payload.paths;
            if (!paths || paths.length === 0) return;
            const pos = e.payload.position;
            const dpr = window.devicePixelRatio || 1;
            const at = document.elementFromPoint(pos.x / dpr, pos.y / dpr);
            const term = at?.closest(".terminal-host") as HTMLElement | null;
            if (term && dispatchPty(term, paths)) return;
            const folder = at?.closest(".tree-row.is-folder") as HTMLElement | null;
            if (folder && dispatchFolder(folder, paths)) return;
            const treeRoot = at?.closest(".ed-tree-scroll") as HTMLElement | null;
            if (treeRoot) dispatchFolder(treeRoot, paths);
        });
        return () => {
            void unlistenP.then((u) => u());
        };
    }, []);

    return (
        <div className="shell">
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
            {agentPaletteOpen && <AgentPalette />}
            {filePaletteOpen && <FilePalette />}
            {rundeckJobPaletteOpen && <RundeckJobPalette />}
            {awsAuthModal && <AwsAuthModal />}
            <Toaster />
        </div>
    );
}
