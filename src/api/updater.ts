import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";
import { setState } from "../state/store";
import { swallow } from "../state/toast";

let pendingHandle: Update | null = null;

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
    } catch (error) {
        swallow("update check")(error);
    }
}

export async function installPendingUpdate(): Promise<void> {
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
        setState({ pendingUpdate: null });
        pendingHandle = null;
        await relaunch();
    } catch (e) {
        setState((st) => ({
            pendingUpdate: st.pendingUpdate ? { ...st.pendingUpdate, state: "error", error: String(e) } : null,
        }));
    }
}
