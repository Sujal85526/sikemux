import { PULL_STATE_LABEL, pullState, useBranchPull, useHostRepo } from "../codehost/project";
import type { AgentWorktree } from "../state/types";
import { IconFolder, IconGit, IconPullRequest } from "../ui/Icons";

/** An agent row's title, with the project and worktree it runs in on a line beneath when there is one to name. */
export function AgentRowText({ title, project, worktree }: { title: string; project?: string; worktree?: AgentWorktree }) {
    if (!project && !worktree) return <span className="agent-title">{title}</span>;
    return (
        <span className="agent-text">
            <span className="agent-title">{title}</span>
            <span className="agent-meta">
                {project && (
                    <span className="agent-meta-project">
                        <IconFolder size={11} />
                        <span>{project}</span>
                    </span>
                )}
                {worktree && (
                    <span className="agent-meta-branch" title={worktree.path}>
                        <IconGit size={11} />
                        <span>{worktree.branch}</span>
                    </span>
                )}
                {worktree && <WorktreePull worktree={worktree} />}
            </span>
        </span>
    );
}

function WorktreePull({ worktree }: { worktree: AgentWorktree }) {
    const host = useHostRepo(worktree.path, true);
    const pull = useBranchPull(host.repo, worktree.branch, true);
    if (!pull) return null;
    const state = pullState(pull);
    return (
        <span className="agent-meta-pr" data-state={state} title={`#${pull.number} ${pull.title} — ${PULL_STATE_LABEL[state] ?? state}`}>
            <IconPullRequest size={11} />
            <span>#{pull.number}</span>
        </span>
    );
}
