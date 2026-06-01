export function basename(path: string): string {
    return path.replace(/\/+$/, "").split("/").pop() || path;
}

export function dirname(path: string): string {
    const trimmed = path.replace(/\/+$/, "");
    const i = trimmed.lastIndexOf("/");
    return i < 0 ? "" : trimmed.slice(0, i);
}

export function prettyPath(path: string, home: string | null | undefined): string {
    return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

export function expandHome(path: string, home: string | null | undefined): string {
    if (!home) return path;
    if (path === "~") return home;
    if (path.startsWith("~/")) return `${home}${path.slice(1)}`;
    return path;
}
