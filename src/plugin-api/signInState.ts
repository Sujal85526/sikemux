import type { ResourceHandle } from "../state/resources";

export type PluginSignIn = "signed-in" | "checking" | "signed-out";

export function signInOf(status: ResourceHandle<{ readonly configured: boolean; readonly authFailed: boolean }>): PluginSignIn {
    if (!status.data) return status.status === "error" ? "signed-out" : "checking";
    return status.data.configured && !status.data.authFailed ? "signed-in" : "signed-out";
}
