import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { TopBar } from "./components/TopBar";
import { SideRail } from "./components/SideRail";
import { AgentRail } from "./components/AgentRail";
import { AgentPalette } from "./components/AgentPalette";
import { SeshPicker } from "./components/SeshPicker";
import { Workspace } from "./components/Workspace";
import { Toaster } from "./components/Toaster";
import { useKeymap } from "./keymap";
import { applyHydrate, subscribePersist } from "./state/persist";
import { useWorkspace } from "./state/workspace";

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

  useEffect(() => {
    let unsub = () => {};
    invoke<BootInfo>("boot_init")
      .then((boot) => {
        useWorkspace.getState().setHome(boot.home);
        applyHydrate(boot.state);
      })
      .catch(() => {})
      .finally(() => {
        unsub = subscribePersist();
      });
    return () => unsub();
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
      <Toaster />
    </div>
  );
}
