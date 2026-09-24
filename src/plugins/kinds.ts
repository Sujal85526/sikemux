/** A pane, session and window kind that belongs to a plugin: `<plugin id>:<surface>`. */
export type PluginKind = `${string}.${string}:${string}`;

const PLUGIN_KIND = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+:[a-z][a-z0-9-]*$/u;

export function isPluginKind(value: unknown): value is PluginKind {
    return typeof value === "string" && value.length <= 128 && PLUGIN_KIND.test(value);
}

export function pluginIdOf(kind: PluginKind): string {
    return kind.slice(0, kind.indexOf(":"));
}
