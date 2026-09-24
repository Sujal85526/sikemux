import { useMemo } from "react";
import { useStore } from "../state/store";
import { frontendPlugin, type FrontendPlugin } from "./registry";

/** Plugins that are both registered here and compiled into the native side of this build. */
export function useInstalledPlugins(): readonly FrontendPlugin[] {
    const manifests = useStore((s) => s.pluginManifests);
    return useMemo(() => manifests.flatMap((manifest) => frontendPlugin(manifest.id) ?? []), [manifests]);
}
