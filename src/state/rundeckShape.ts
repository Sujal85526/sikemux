export function envFolderOf(group: string | null): string | null {
    if (!group || !group.includes("/")) return null;
    const head = group.split("/")[0];
    return head || null;
}

export function inferEnv(project: string, group: string | null): string {
    return (envFolderOf(group) ?? project).toLowerCase();
}
