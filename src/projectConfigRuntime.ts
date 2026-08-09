import type { CustomCommand } from "./commands/registry";
import type { ProjectAction, ProjectConfigLoadResult, ProjectWorktreeCreateHook } from "./projectConfig";

const trustedConfigs = new Set<string>();

function trustKey(result: Extract<ProjectConfigLoadResult, { status: "valid" }>): string {
    return `${result.path}\0${result.fingerprint}`;
}

export function projectActionCommand(action: ProjectAction): CustomCommand {
    return {
        id: `project.${action.id}`,
        title: action.label,
        detail: action.description,
        command: action.command,
        contexts: action.contexts,
        placement: action.placement,
    };
}

export function worktreeHookCommand(hook: ProjectWorktreeCreateHook): CustomCommand {
    return {
        id: `project.worktree.${hook.id}`,
        title: hook.label,
        detail: "Project-defined worktree setup",
        command: hook.command,
        contexts: ["project"],
        placement: "background",
    };
}

export function trustProjectConfig(
    result: Extract<ProjectConfigLoadResult, { status: "valid" }>,
    confirm: (message: string) => boolean = window.confirm,
): boolean {
    const key = trustKey(result);
    if (!result.trust.requiresApproval || trustedConfigs.has(key)) return true;
    const detail = result.trust.reasons.join(", ");
    const approved = confirm(
        `Trust this sikemux.json?\n\nIt can run ${detail || `${result.trust.executableEntries} commands`} from this project. ` +
            "Review the file before approving. Trust lasts until Sikemux closes or the file changes.",
    );
    if (approved) trustedConfigs.add(key);
    return approved;
}

export function clearProjectConfigTrustForTests(): void {
    trustedConfigs.clear();
}
