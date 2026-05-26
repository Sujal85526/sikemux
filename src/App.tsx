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
import { Workspace } from "./components/Workspace";
import { Toaster } from "./components/Toaster";
import { useKeymap } from "./keymap";
import { filesApi } from "./api/files";
import { emit, subscribe } from "./state/bus";
import * as cmd from "./state/commands";
import { applyHydrate, subscribePersist } from "./state/persist";
import { dispatchFolder, dispatchPty } from "./state/dropRegistry";
import { swallow } from "./state/toast";
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
  const leftOpen = useStore((s) => s.leftRailOpen);
  const rightOpen = useStore((s) => s.rightRailOpen);
  // Agents are project-scoped — hide the rail elsewhere so the workspace
  // recovers its full width.
  const activeSessionIsProject = useStore(
    (s) => s.sessions[s.activeSessionId]?.kind === "project",
  );
  const pickerOpen = useStore((s) => s.pickerOpen);
  const agentPaletteOpen = useStore((s) => s.agentPaletteOpen);
  const filePaletteOpen = useStore((s) => s.filePaletteOpen);
  const settingsOpen = useStore((s) => s.settingsOpen);
  const awsAuthModal = useStore((s) => s.awsAuthModal);

  useEffect(() => {
    let unsub = () => {};
    invoke<BootInfo>("boot_init")
      .then((boot) => {
        cmd.setHome(boot.home);
        applyHydrate(boot.state);
        const st = getState();
        applyTheme(st.themeId);
        applyWindowOpacity(st.windowOpacity);
        // Re-apply persisted blur so reopens look identical (Rust starts at 0).
        cmd.setWindowBlur(st.windowBlur);
      })
      .catch(swallow("boot_init"))
      .finally(() => {
        unsub = subscribePersist();
      });
    return () => unsub();
  }, []);

  // Single fs-event subscription: invalidate every git/file-list resource
  // for the affected repo and emit a typed bus event. Consumers wake up
  // via the resource cache or by subscribing to the bus — no nonces.
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

  // Rundeck auth expired (token rejected, unconfigured, 401/403). Wipe all
  // rnd.* cache so stale matrices don't flash, and force rnd.status to
  // refetch — the Rundeck pane re-renders into the login screen when it
  // sees ok:false.
  useEffect(() => {
    return subscribe("rnd-auth-expired", () => {
      invalidate((kind) => kind.startsWith("rnd."));
    });
  }, []);

  // AWS auth expired (CLI returned token-expired / no-credentials /
  // cli-missing). Same recipe: drop all aws.* cache so stale tables
  // don't flash, force re-identification, and the TopBar chip flips
  // from green to red as the new identity status comes back.
  useEffect(() => {
    return subscribe("aws-auth-expired", () => {
      invalidate((kind) => kind.startsWith("aws."));
    });
  }, []);

  // OTA: silent boot check. If an update is available, we stash it in
  // store.pendingUpdate so the TopBar chip can offer it on demand — no
  // forced dialog. Re-checks every 30min so a long-running session
  // eventually notices a freshly-cut release. The chip never auto-clears:
  // dismissing it is just not clicking. Click triggers download + install.
  useEffect(() => {
    const firstCheck = window.setTimeout(() => void checkForUpdate(), 4000);
    const poll = window.setInterval(() => void checkForUpdate(), 30 * 60_000);
    return () => {
      window.clearTimeout(firstCheck);
      window.clearInterval(poll);
    };
  }, []);

  // File drag-drop. Tauri 2 disables HTML5 native drop on the webview
  // (would navigate to file://) and gives us this event instead, with
  // absolute paths + drop position. We hit-test via elementFromPoint and
  // dispatch to the first ancestor that has installed a drop handler:
  //   * `.terminal-host`        → TerminalPane writes quoted paths to PTY
  //                               (Claude Code / Codex @-file ingest).
  //   * `.tree-row.is-folder`   → FileTree copies into that folder.
  //   * `.ed-tree-scroll`       → FileTree copies into the repo root.
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
        <main className="stage">
          <Workspace />
        </main>
        {rightOpen && activeSessionIsProject && <AgentRail />}
      </div>
      {pickerOpen && <SeshPicker />}
      {agentPaletteOpen && <AgentPalette />}
      {filePaletteOpen && <FilePalette />}
      {settingsOpen && <SettingsPanel />}
      {awsAuthModal && <AwsAuthModal />}
      <Toaster />
    </div>
  );
}
