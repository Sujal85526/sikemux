import type { CustomCommand } from "./commands/registry";
import type { ProjectAction, ProjectConfigLoadResult, ProjectWorktreeCreateHook } from "./projectConfig";
import { confirmDialog, type ConfirmRequest } from "./state/dialog";

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

/**
 * Already-trusted configs resolve synchronously on the microtask queue; only a
 * first-time approval reaches the dialog.
 */
export async function trustProjectConfig(
    result: Extract<ProjectConfigLoadResult, { status: "valid" }>,
    ask: (request: ConfirmRequest) => Promise<boolean> = confirmDialog,
): Promise<boolean> {
    const key = trustKey(result);
    if (!result.trust.requiresApproval || trustedConfigs.has(key)) return true;
    const detail = result.trust.reasons.join(", ");
    const approved = await ask({
        title: "Trust this sikemux.json?",
        body:
            `It can run ${detail || `${result.trust.executableEntries} commands`} from this project. Review the file before approving.\n` +
            "Trust lasts until Sikemux closes or the file changes.",
        confirmLabel: "Trust project",
    });
    if (approved) trustedConfigs.add(key);
    return approved;
}

export function clearProjectConfigTrustForTests(): void {
    trustedConfigs.clear();
}
