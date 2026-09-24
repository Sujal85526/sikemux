import type { ReactNode } from "react";
import { isPluginKind, pluginIdOf, type PluginKind } from "./kinds";

export interface PluginSurfaceProps {
    readonly paneId: string;
    readonly visible: boolean;
}

export interface PluginSurface {
    readonly kind: PluginKind;
    readonly title: string;
    readonly icon: (size: number) => ReactNode;
    readonly render: (props: PluginSurfaceProps) => ReactNode;
}

export interface FrontendPlugin {
    readonly id: string;
    readonly surfaces: readonly PluginSurface[];
    readonly open: () => void;
    readonly openTitle: string;
}

const plugins = new Map<string, FrontendPlugin>();
const surfaces = new Map<PluginKind, PluginSurface>();

export function registerFrontendPlugin(plugin: FrontendPlugin): void {
    if (plugins.has(plugin.id)) throw new Error(`plugin ${plugin.id} is registered twice`);
    for (const surface of plugin.surfaces) {
        if (!isPluginKind(surface.kind) || pluginIdOf(surface.kind) !== plugin.id) {
            throw new Error(`plugin ${plugin.id} cannot own the surface kind ${surface.kind}`);
        }
    }
    plugins.set(plugin.id, plugin);
    for (const surface of plugin.surfaces) surfaces.set(surface.kind, surface);
}

export function frontendPlugin(id: string): FrontendPlugin | undefined {
    return plugins.get(id);
}

export function pluginSurface(kind: string): PluginSurface | undefined {
    return isPluginKind(kind) ? surfaces.get(kind) : undefined;
}
