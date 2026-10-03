import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useMemo, useState } from "react";
import { remoteApi, type PublishedChat } from "../api/remote";
import { backdropPicture, grainDotColor } from "../remote/backdrop";
import { usePaneImage } from "../lib/paneImage";
import { readPalette } from "../remote/palette";
import { remoteChats, remoteTitles, remoteWorkspace } from "../remote/workspace";
import { activeAgentId } from "../state/selectors";
import { currentTheme, subscribeTheme } from "../themes/bus";
import { swallow } from "../state/toast";
import { useStore } from "../state/store";

/** Long enough that opening or renaming several projects publishes once. */
export const PUBLISH_DELAY_MS = 400;

/**
 * Tells the core which projects and agents can be started and what the app calls its agents, for the notch and paired
 * devices, and which agent is on screen. While remote access is on, also the theme and backdrop devices draw in.
 */
export function RemoteWorkspaceBridge() {
    const [enabled, setEnabled] = useState(false);
    const [themeChanges, setThemeChanges] = useState(0);
    const sessions = useStore((s) => s.sessions);
    const sessionOrder = useStore((s) => s.sessionOrder);
    const profiles = useStore((s) => s.providerProfiles);
    const permissionMode = useStore((s) => s.defaultAgentPermissionMode);
    const published = useMemo(
        () => JSON.stringify(remoteWorkspace(sessions, sessionOrder, profiles, permissionMode)),
        [sessions, sessionOrder, profiles, permissionMode],
    );
    const agents = useStore((s) => s.agents);
    const windows = useStore((s) => s.windows);
    const windowsBySession = useStore((s) => s.windowsBySession);
    const chats = useMemo(
        () => JSON.stringify(remoteChats({ agents, windows, sessions, sessionOrder, windowsBySession })),
        [agents, windows, sessions, sessionOrder, windowsBySession],
    );
    const titles = useMemo(() => JSON.stringify(remoteTitles({ agents })), [agents]);
    const active = useStore((s) => activeAgentId(s, s.sessions[s.activeSessionId]));
    const focused = useWindowFocused();
    const onScreen = focused ? active : undefined;

    useEffect(() => {
        const controller = new AbortController();
        remoteApi
            .subscribe((status) => setEnabled(status.enabled), controller.signal)
            .then(() => remoteApi.status())
            .then((status) => {
                if (!controller.signal.aborted) setEnabled(status.enabled);
            })
            .catch((error: unknown) => {
                if (!controller.signal.aborted) swallow("remote access status")(error);
            });
        return () => controller.abort();
    }, []);

    const texture = useStore((s) => s.paneShader);
    const paneImage = usePaneImage();
    useEffect(() => {
        if (!enabled) return;
        const timer = window.setTimeout(() => {
            const picture = texture && paneImage ? backdropPicture(paneImage) : null;
            remoteApi.publishBackdrop(texture, picture).catch(swallow("publish the pane backdrop to paired devices"));
        }, PUBLISH_DELAY_MS);
        return () => window.clearTimeout(timer);
    }, [enabled, texture, paneImage]);

    useEffect(() => subscribeTheme(() => setThemeChanges((count) => count + 1)), []);

    useEffect(() => {
        if (!enabled) return;
        const timer = window.setTimeout(() => {
            const palette = readPalette({ shaderDot: grainDotColor(currentTheme()) });
            remoteApi.publishPalette(palette).catch(swallow("publish the theme to paired devices"));
        }, PUBLISH_DELAY_MS);
        return () => window.clearTimeout(timer);
    }, [enabled, themeChanges]);

    useEffect(() => {
        const timer = window.setTimeout(() => {
            const { projects, launchers } = JSON.parse(published) as ReturnType<typeof remoteWorkspace>;
            remoteApi.publishWorkspace(projects, launchers).catch(swallow("publish projects to the core"));
        }, PUBLISH_DELAY_MS);
        return () => window.clearTimeout(timer);
    }, [published]);

    useEffect(() => {
        const timer = window.setTimeout(() => {
            remoteApi
                .publishAgents(JSON.parse(chats) as PublishedChat[], JSON.parse(titles) as Record<string, string>)
                .catch(swallow("publish agents to the core"));
        }, PUBLISH_DELAY_MS);
        return () => window.clearTimeout(timer);
    }, [chats, titles]);

    useEffect(() => {
        remoteApi.publishOnScreen(onScreen ? [onScreen] : []).catch(swallow("tell the core which agent is on screen"));
    }, [onScreen]);

    return null;
}

/** Whether the app's window is the one the person is using: a window behind another app is not looked at. */
function useWindowFocused(): boolean {
    const [focused, setFocused] = useState(true);
    useEffect(() => {
        let disposed = false;
        let unlisten: (() => void) | undefined;
        const onFocus = () => setFocused(true);
        const onBlur = () => setFocused(false);
        const watchPage = () => {
            window.addEventListener("focus", onFocus);
            window.addEventListener("blur", onBlur);
        };
        try {
            getCurrentWindow()
                .onFocusChanged(({ payload }) => setFocused(payload))
                .then((stop) => (disposed ? stop() : (unlisten = stop)))
                .catch(watchPage);
        } catch {
            watchPage();
        }
        return () => {
            disposed = true;
            unlisten?.();
            window.removeEventListener("focus", onFocus);
            window.removeEventListener("blur", onBlur);
        };
    }, []);
    return focused;
}
