import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";
import { setState } from "../state/store";

// We keep the Update object (which carries downloadAndInstall) out of the
// Zustand store because it isn't serialisable. The store gets only the
// displayable surface; this module owns the live handle.
let pendingHandle: Update | null = null;

/** Silent boot check. Populates store.pendingUpdate when something newer is
 *  available. Safe to call repeatedly — re-uses the same handle. */
export async function checkForUpdate(): Promise<void> {
    try {
        const update = await check();
        if (!update) {
            pendingHandle = null;
            setState({ pendingUpdate: null });
            return;
        }
        pendingHandle = update;
        const currentVersion = await getVersion().catch(() => "");
        setState({
            pendingUpdate: {
                version: update.version,
                currentVersion,
                notes: update.body ?? null,
                date: update.date ?? null,
                state: "available",
                error: null,
            },
        });
    } catch {
        // Network failures, no release yet, signature mismatch — stay silent.
        // The user can re-trigger via the chip, which calls check again.
    }
}

/** Triggered by the TopBar update chip. Downloads, verifies, installs, then
 *  relaunches. Updates store.pendingUpdate so the chip can render progress
 *  / error states. */
export async function installPendingUpdate(): Promise<void> {
    // If the handle was lost (e.g. page reload kept the chip but cleared the
    // module state), re-resolve it before installing.
    let update = pendingHandle;
    if (!update) {
        try {
            update = await check();
        } catch (e) {
            setState((st) => ({
                pendingUpdate: st.pendingUpdate ? { ...st.pendingUpdate, state: "error", error: String(e) } : null,
            }));
            return;
        }
        if (!update) {
            // No longer available (race with someone yanking the release).
            setState({ pendingUpdate: null });
            return;
        }
        pendingHandle = update;
    }

    setState((st) => ({
        pendingUpdate: st.pendingUpdate ? { ...st.pendingUpdate, state: "installing", error: null } : null,
    }));

    try {
        await update.downloadAndInstall();
        // Clear before relaunch so a brief race where the new binary boots
        // and sees the stale flag doesn't show a phantom chip.
        setState({ pendingUpdate: null });
        pendingHandle = null;
        await relaunch();
    } catch (e) {
        setState((st) => ({
            pendingUpdate: st.pendingUpdate ? { ...st.pendingUpdate, state: "error", error: String(e) } : null,
        }));
    }
}
