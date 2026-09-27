import { Checkbox, Tooltip } from "../../../plugin-api/ui";
import type { RepoRef } from "../api";
import { actionsSettings, SECTION_LABEL, SECTIONS, setFollowBranch, showSection, slugOf, type RunsView } from "../state";
import { GithubMark } from "./ActionsIcon";

interface Props {
    paneId: string;
    repo: RepoRef;
    view: RunsView;
    projectBranch: string | null;
    onPickRepo: () => void;
}

export function ActionsSidebar({ paneId, repo, view, projectBranch, onPickRepo }: Props) {
    const known = !!repo.owner && !!repo.name;
    const slug = slugOf(repo);
    const followBranch = actionsSettings.useSelect((settings) => settings.followBranch);

    return (
        <div className="gha-side">
            <button type="button" className="gha-repo-button" onClick={onPickRepo} title="Choose a repository">
                <GithubMark size={13} />
                <span className="gha-repo-slug">{known ? slug : "Choose a repository"}</span>
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
                        {SECTION_LABEL[section]}
                    </button>
                ))}
            </div>
        </div>
    );
}
