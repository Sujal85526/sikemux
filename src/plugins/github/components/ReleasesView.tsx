import { useState } from "react";
import { notify, openUrl, reportError, swallow } from "../../../plugin-api/host";
import { useResourceEnabled } from "../../../plugin-api/resources";
import { EmptyState, IconDownload, SkeletonRows } from "../../../plugin-api/ui";
import { actionsApi, failureMessage, type RepoRef } from "../api";
import { githubReleasesR } from "../resources";
import { formatAgo } from "../runStatus";
import { formatBytes } from "./Artifacts";
import { useNow } from "./hooks";

interface Props {
    repo: RepoRef;
    active: boolean;
}

export function ReleasesView({ repo, active }: Props) {
    const releases = useResourceEnabled(active, githubReleasesR, repo);
    const [saving, setSaving] = useState<number | null>(null);
    const now = useNow(false);

    if (releases.status === "loading" && !releases.data) return <SkeletonRows rows={6} label="Loading releases" />;
    if (releases.error) {
        return (
            <EmptyState
                title="Could not read releases"
                message={failureMessage(releases.error)}
                tone="error"
                action={{ label: "Try again", onClick: () => void releases.refresh() }}
            />
        );
    }
    const rows = releases.data ?? [];
    if (rows.length === 0) return <EmptyState icon={<IconDownload size={20} />} message="This repository has no releases." />;

    const save = (id: number, name: string) => {
        setSaving(id);
        void actionsApi
            .downloadAsset(repo, id, name)
            .then((saved) => notify("success", `Saved ${name} to ${saved.path}`))
            .catch(reportError(`Could not download ${name}`))
            .finally(() => setSaving(null));
    };

    return (
        <div className="gha-list">
            {rows.map((release) => (
                <div className="gha-release" key={release.id}>
                    <div className="gha-release-head">
                        <span className="gha-release-name">{release.name}</span>
                        <span className="gha-mono gha-dim">{release.tag}</span>
                        {release.draft && (
                            <span className="gha-state-chip" data-state="draft">
                                Draft
                            </span>
                        )}
                        {release.prerelease && (
                            <span className="gha-state-chip" data-state="pre">
                                Pre-release
                            </span>
                        )}
                        <span className="gha-dim">{formatAgo(release.publishedAt, now)}</span>
                        <button type="button" className="gha-link" onClick={() => void openUrl(release.url).catch(swallow("open GitHub"))}>
                            On GitHub
                        </button>
                    </div>
                    {release.body.trim() && <div className="gha-body-text clamp">{release.body}</div>}
                    {release.assets.map((asset) => (
                        <div className="gha-artifact" key={asset.id}>
                            <span className="gha-artifact-name">{asset.name}</span>
                            <span className="gha-dim">{formatBytes(asset.sizeBytes)}</span>
                            <span className="gha-dim">{asset.downloads} downloads</span>
                            <button type="button" className="gha-link" disabled={saving === asset.id} onClick={() => save(asset.id, asset.name)}>
                                {saving === asset.id ? "Saving…" : "Download"}
                            </button>
                        </div>
                    ))}
                </div>
            ))}
        </div>
    );
}
