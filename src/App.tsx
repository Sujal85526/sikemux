import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { TopBar } from "./components/TopBar";
import { SideRail } from "./components/SideRail";
import { ContextRail } from "./components/ContextRail";
import { SeshPicker } from "./components/SeshPicker";
import { Workspace } from "./components/Workspace";
import { useKeymap } from "./keymap";
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
  }, [setHome]);

  return (
    <div className="shell">
      <TopBar />
      <div className="body">
        {leftOpen && <SideRail />}
        <main className="stage">
          <Workspace />
        </main>
        {rightOpen && <ContextRail />}
      </div>
      {pickerOpen && <SeshPicker />}
    </div>
  );
}
