import type { PluginManifest } from "../api/plugins";
import { isPluginKind, pluginIdOf } from "../plugins/kinds";
import type { SessionKind } from "./types";

export type RailGroup = "project" | "ssh" | "plugins" | "command";

export const RAIL_GROUP_ORDER: readonly RailGroup[] = ["project", "ssh", "plugins", "command"];

/** A session of a plugin that is not compiled into this build has no group, and the rail leaves it out. */
export function railGroupOf(kind: SessionKind, manifests: readonly PluginManifest[]): RailGroup | null {
    if (isPluginKind(kind)) {
        const id = pluginIdOf(kind);
        return manifests.some((manifest) => manifest.id === id) ? "plugins" : null;
    }
    if (kind === "aws" || kind === "bruno") return "plugins";
    return kind;
}
