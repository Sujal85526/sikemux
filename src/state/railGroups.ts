import type { PluginGroup, PluginManifest } from "../api/plugins";
import { isPluginKind, pluginIdOf } from "../plugins/kinds";
import type { SessionKind } from "./types";

export type RailGroup = "project" | "ssh" | PluginGroup | "command";

export const RAIL_GROUP_ORDER: readonly RailGroup[] = ["project", "ssh", "cloud", "ci-cd", "apis", "observability", "command"];

export const PLUGIN_GROUP_LABELS: Readonly<Record<PluginGroup, string>> = {
    cloud: "Cloud",
    "ci-cd": "CI/CD",
    apis: "API",
    observability: "Observability",
};

/** A session of a plugin that is not compiled into this build has no group, and the rail leaves it out. */
export function railGroupOf(kind: SessionKind, manifests: readonly PluginManifest[]): RailGroup | null {
    if (isPluginKind(kind)) {
        const id = pluginIdOf(kind);
        return manifests.find((manifest) => manifest.id === id)?.group ?? null;
    }
    if (kind === "aws") return "cloud";
    if (kind === "bruno") return "apis";
    return kind;
}
