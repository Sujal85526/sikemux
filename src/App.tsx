import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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
      .catch(() => {})
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
