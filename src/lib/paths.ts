// Path-string helpers — pure, POSIX-style ("/"-separated) as used throughout
// the app. Centralized so every picker, tree, review pane, and the editor
// derive names and display labels identically instead of each redefining
// their own `basename`/`pretty`/`expand` one-liners.

/** Final path segment, ignoring trailing slashes.
 *  `"/a/b/c/"` → `"c"`, `"x"` → `"x"`. */
export function basename(path: string): string {
    return path.replace(/\/+$/, "").split("/").pop() || path;
}

/** Everything before the final segment (no trailing slash).
 *  `"/a/b/c"` → `"/a/b"`, `"x"` → `""`. */
export function dirname(path: string): string {
    const trimmed = path.replace(/\/+$/, "");
    const i = trimmed.lastIndexOf("/");
    return i < 0 ? "" : trimmed.slice(0, i);
}

/** Collapse a leading home prefix to `~` for display. */
export function prettyPath(path: string, home: string | null | undefined): string {
    return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

/** Expand a leading `~` / `~/…` to the home directory — inverse of
 *  {@link prettyPath} for tilde paths. */
export function expandHome(path: string, home: string | null | undefined): string {
    if (!home) return path;
    if (path === "~") return home;
    if (path.startsWith("~/")) return `${home}${path.slice(1)}`;
    return path;
}
