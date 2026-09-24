export type { PluginFailure, PluginGroup, PluginManifest } from "../api/plugins";
export type { PluginKind } from "../plugins/kinds";
export { registerFrontendPlugin, type FrontendPlugin, type PluginSurface, type PluginTopBarProps } from "../plugins/registry";
export { createPluginBackend, isPluginFailure, type PluginBackend, type PluginStream, type PluginStreamHandlers } from "./backend";
export { definePluginSettings, type PluginSettings } from "./settings";
