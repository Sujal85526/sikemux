import { useEffect, useMemo, useState } from "react";
import { remoteApi, type PublishedChat } from "../api/remote";
import { remoteChats, remoteWorkspace } from "../remote/workspace";
import { swallow } from "../state/toast";
import { useStore } from "../state/store";

/** Long enough that opening or renaming several projects publishes once. */
export const PUBLISH_DELAY_MS = 400;

/** While remote access is on, tells the core which projects and agents paired devices may start, and the chats they can open. */
export function RemoteWorkspaceBridge() {
    const [enabled, setEnabled] = useState(false);
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

    useEffect(() => {
        if (!enabled) return;
        const timer = window.setTimeout(() => {
            const { projects, launchers } = JSON.parse(published) as ReturnType<typeof remoteWorkspace>;
            remoteApi.publishWorkspace(projects, launchers).catch(swallow("publish projects to paired devices"));
        }, PUBLISH_DELAY_MS);
        return () => window.clearTimeout(timer);
    }, [enabled, published]);

    useEffect(() => {
        if (!enabled) return;
        const timer = window.setTimeout(() => {
            remoteApi.publishChats(JSON.parse(chats) as PublishedChat[]).catch(swallow("publish chats to paired devices"));
        }, PUBLISH_DELAY_MS);
        return () => window.clearTimeout(timer);
    }, [enabled, chats]);

    return null;
}
