import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { TopBar } from "./components/TopBar";
import { SideRail } from "./components/SideRail";
import { AgentRail } from "./components/AgentRail";
import { SeshPicker } from "./components/SeshPicker";
import { Workspace } from "./components/Workspace";
import { useKeymap } from "./keymap";
import { hydrateFromDisk, subscribePersist } from "./state/persist";
import { useWorkspace } from "./state/workspace";

export default function App() {
  useKeymap();
  const leftOpen = useWorkspace((s) => s.leftRailOpen);
  const rightOpen = useWorkspace((s) => s.rightRailOpen);
  const pickerOpen = useWorkspace((s) => s.pickerOpen);
  const setHome = useWorkspace((s) => s.setHome);

  useEffect(() => {
    invoke<string>("home_dir")
      .then(setHome)
      .catch(() => {});
    // Restore persisted state, then start saving on change.
    let unsub = () => {};
    void hydrateFromDisk().finally(() => {
      unsub = subscribePersist();
    });
    return () => unsub();
  }, [setHome]);

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
    </div>
  );
}
