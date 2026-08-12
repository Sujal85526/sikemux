import { relaunch } from "@tauri-apps/plugin-process";
import { invokeCommand as invoke } from "./invoke";
import { getState, setState } from "../state/store";
import { swallow } from "../state/toast";

interface UpdateInfo {
    version: string;
    currentVersion: string;
    notes: string | null;
    date: string | null;
}

export async function checkForUpdate(): Promise<void> {
    try {
        const update = await invoke<UpdateInfo | null>("update_check", { channel: getState().updateChannel });
        if (!update) {
            setState({ pendingUpdate: null });
            return;
        }
        setState({
            pendingUpdate: {
                version: update.version,
                currentVersion: update.currentVersion,
                notes: update.notes,
                date: update.date,
                state: "available",
                error: null,
            },
        });
    } catch (error) {
        swallow("update check")(error);
    }
}

export async function installPendingUpdate(): Promise<void> {
    if (!getState().pendingUpdate) await checkForUpdate();
    const pending = getState().pendingUpdate;
    if (!pending) return;

    setState((st) => ({
        pendingUpdate: st.pendingUpdate ? { ...st.pendingUpdate, state: "installing", error: null } : null,
    }));

    try {
        const installed = await invoke<UpdateInfo>("update_install", { channel: getState().updateChannel });
        // Commit release bookkeeping only after the signed artifact was
        // installed successfully. A failed install keeps the previous version.
        setState({
            pendingUpdate: null,
            lastReleaseNotes: { version: installed.version, notes: installed.notes, date: installed.date },
        });
        await relaunch();
    } catch (e) {
        setState((st) => ({
            pendingUpdate: st.pendingUpdate ? { ...st.pendingUpdate, state: "error", error: String(e) } : null,
        }));
    }
}
