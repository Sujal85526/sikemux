import type { ComponentType, ReactNode } from "react";
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
    /** What ⌘P does while this surface is in front, in place of the file finder. */
    readonly quickOpen?: () => void;
}

export interface PluginTopBarProps {
    /** The folder of the project in front, or null when something else is. */
    readonly projectCwd: string | null;
    /** Whether the pointer is over the right of the top bar, where the item would appear. */
    readonly stripHovered: boolean;
}

export interface FrontendPlugin {
    readonly id: string;
    readonly surfaces: readonly PluginSurface[];
    readonly open: () => void;
    readonly openTitle: string;
    /** Always mounted; it decides for itself when to show. */
    readonly Overlay?: ComponentType;
    readonly TopBarItem?: ComponentType<PluginTopBarProps>;
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

export function frontendPlugins(): readonly FrontendPlugin[] {
    return [...plugins.values()];
}

export function pluginSurface(kind: string): PluginSurface | undefined {
    return isPluginKind(kind) ? surfaces.get(kind) : undefined;
}
