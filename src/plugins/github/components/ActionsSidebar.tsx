import { Checkbox, Tooltip } from "../../../plugin-api/ui";
import type { ActionsStatus, RepoRef } from "../api";
import { actionsSettings, SECTION_LABEL, SECTIONS, setFollowBranch, showSection, type RunsView } from "../state";
import { GithubMark, SectionIcon, UpDown } from "./ActionsIcon";

interface Props {
    paneId: string;
    repo: RepoRef;
    view: RunsView;
    projectBranch: string | null;
    onPickRepo: () => void;
    account: ActionsStatus | undefined;
    signingOut: boolean;
    onSignOut: () => void;
}

export function ActionsSidebar({ paneId, repo, view, projectBranch, onPickRepo, account, signingOut, onSignOut }: Props) {
    const known = !!repo.owner && !!repo.name;
    const followBranch = actionsSettings.useSelect((settings) => settings.followBranch);

    return (
        <div className="gha-side">
            <button type="button" className="gha-repo-button" onClick={onPickRepo} title="Choose a repository">
                <span className="gha-repo-mark">
                    <GithubMark size={14} />
                </span>
                {known ? (
                    <span className="gha-repo-slug">
                        <span className="gha-repo-owner">{repo.owner}</span>
                        <span className="gha-repo-name">{repo.name}</span>
                    </span>
                ) : (
                    <span className="gha-repo-slug">Choose a repository</span>
                )}
                <span className="gha-repo-chevron">
                    <UpDown />
                </span>
            </button>

            {projectBranch && (
                <div className="gha-side-row">
                    <Tooltip label={`Only show runs on ${projectBranch}`}>
                        <span>
                            <Checkbox checked={followBranch} onChange={setFollowBranch}>
                                This branch
                            </Checkbox>
                        </span>
                    </Tooltip>
                </div>
            )}

            <div className="gha-side-section">
                {SECTIONS.map((section) => (
                    <button
                        key={section}
                        type="button"
                        className="gha-side-item"
                        data-on={view.section === section ? "1" : "0"}
                        onClick={() => showSection(paneId, section)}>
                        <SectionIcon section={section} />
                        <span>{SECTION_LABEL[section]}</span>
                    </button>
                ))}
            </div>

            <footer className="gha-side-foot">
                {account && !account.canWriteWorkflows && (
                    <p className="gha-warn-note">This token cannot start or re-run workflows. It is missing the workflow scope.</p>
                )}
                <div className="gha-side-foot-row">
                    <div className="gha-side-who" title={account ? `${account.login} on ${account.host}` : undefined}>
                        <span className="gha-side-host">{account?.host}</span>
                        <span className="gha-side-account">{account?.login}</span>
                    </div>
                    <button type="button" className="gha-foot-button" disabled={signingOut} onClick={onSignOut}>
                        Sign out
                    </button>
                </div>
            </footer>
        </div>
    );
}
