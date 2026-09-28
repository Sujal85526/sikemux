import { Checkbox, Tooltip } from "../../../plugin-api/ui";
import type { ActionsStatus, RepoRef } from "../api";
import { actionsSettings, SECTION_LABEL, SECTIONS, setFollowBranch, showSection, type RunsView } from "../state";
import { GithubMark, SectionIcon, SignOutIcon, UpDown } from "./ActionsIcon";
import { Avatar } from "./Pictures";

function avatarOf(account: ActionsStatus): string {
    return account.host === "github.com"
        ? `https://avatars.githubusercontent.com/${account.login}?s=64`
        : `https://${account.host}/${account.login}.png?size=64`;
}

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
                {account && (
                    <div className="gha-account">
                        <Avatar url={avatarOf(account)} />
                        <span className="gha-account-who">
                            <span className="gha-account-login">{account.login}</span>
                            <span className="gha-account-host">{account.host}</span>
                        </span>
                        <Tooltip label="Sign out">
                            <button type="button" className="gha-icon-btn" disabled={signingOut} onClick={onSignOut} aria-label="Sign out">
                                <SignOutIcon />
                            </button>
                        </Tooltip>
                    </div>
                )}
            </footer>
        </div>
    );
}
