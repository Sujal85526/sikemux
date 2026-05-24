import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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
import { applyHydrate, subscribePersist } from "./state/persist";
import { useWorkspace } from "./state/workspace";
import { filesApi } from "./api/files";
import { applyTheme, applyWindowOpacity } from "./themes/bus";

interface BootInfo {
  home: string;
  state: string;
  recent: string[];
}

export default function App() {
  useKeymap();
  const leftOpen = useWorkspace((s) => s.leftRailOpen);
  const rightOpen = useWorkspace((s) => s.rightRailOpen);
  const pickerOpen = useWorkspace((s) => s.pickerOpen);
  const agentPaletteOpen = useWorkspace((s) => s.agentPaletteOpen);
  const filePaletteOpen = useWorkspace((s) => s.filePaletteOpen);
  const settingsOpen = useWorkspace((s) => s.settingsOpen);
  const awsAuthModal = useWorkspace((s) => s.awsAuthModal);

  useEffect(() => {
    let unsub = () => {};
    invoke<BootInfo>("boot_init")
      .then((boot) => {
        useWorkspace.getState().setHome(boot.home);
        applyHydrate(boot.state);
        // Push the (possibly hydrated) theme + opacity into the DOM and the
        // theme bus so visuals match persisted preferences from first paint.
        const st = useWorkspace.getState();
        applyTheme(st.themeId);
        applyWindowOpacity(st.windowOpacity);
        // Re-apply persisted blur radius so reopens look identical to last
        // session (the Rust side starts at 0).
        st.setWindowBlur(st.windowBlur);
      })
      .catch(() => {})
      .finally(() => {
        unsub = subscribePersist();
      });
    return () => unsub();
  }, []);

  // Global fs-event subscription. The backend invalidates its own file
  // index cache; we drop the matching frontend cache entry so the next
  // Cmd-P open reflects on-disk reality.
  useEffect(() => {
    const handle = listen<{ repo: string }>("git_changed", (e) => {
      filesApi.invalidate(e.payload.repo || undefined);
    });
    return () => {
      void handle.then((u) => u());
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
        {rightOpen && <AgentRail />}
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
