import { useState } from "react";
import { notify, openUrl, reportError, swallow } from "../../../plugin-api/host";
import { useResourceEnabled } from "../../../plugin-api/resources";
import { EmptyState, IconChevron, IconDownload, IconGit, SkeletonRows } from "../../../plugin-api/ui";
import { actionsApi, failureMessage, type Release, type RepoRef } from "../api";
import { githubReleasesR } from "../resources";
import { formatAgo } from "../runStatus";
import { formatBytes } from "./Artifacts";
import { useNow } from "./hooks";
import { Prose } from "./Pictures";

const LONG_NOTES = 280;

/** How many releases the backend reads, newest first. */
const RELEASES_READ = 100;

/** The newest release that is neither a draft nor a pre-release, which is the one GitHub marks as latest. */
export function latestOf(releases: readonly Release[]): number | null {
    return releases.find((release) => !release.draft && !release.prerelease)?.id ?? null;
}

function Assets({ release, saving, onSave }: { release: Release; saving: ReadonlySet<number>; onSave: (id: number, name: string) => void }) {
    if (release.assets.length === 0) return null;
    return (
        <details className="gha-assets">
            <summary className="gha-assets-head">
                <span className="gha-chevron">
                    <IconChevron size={11} />
                </span>
                <IconDownload size={12} />
                Assets
                <span className="gha-count">{release.assets.length}</span>
            </summary>
            {release.assets.map((asset) => (
                <div className="gha-artifact" key={asset.id}>
                    <span className="gha-artifact-name">{asset.name}</span>
                    <span className="gha-dim">{formatBytes(asset.sizeBytes)}</span>
                    <span className="gha-dim">{asset.downloads} downloads</span>
                    <button type="button" className="gha-link" disabled={saving.has(asset.id)} onClick={() => onSave(asset.id, asset.name)}>
                        {saving.has(asset.id) ? "Saving…" : "Download"}
                    </button>
                </div>
            ))}
        </details>
    );
}

interface Props {
    repo: RepoRef;
    active: boolean;
}

export function ReleasesView({ repo, active }: Props) {
    const releases = useResourceEnabled(active, githubReleasesR, repo);
    const [saving, setSaving] = useState<ReadonlySet<number>>(() => new Set());
    const [opened, setOpened] = useState<ReadonlySet<number>>(() => new Set());
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
    const latest = latestOf(rows);

    const save = (id: number, name: string) => {
        if (saving.has(id)) return;
        setSaving((was) => new Set(was).add(id));
        void actionsApi
            .downloadAsset(repo, id, name)
            .then((saved) => notify("success", `Saved ${name} to ${saved.path}`))
            .catch(reportError(`Could not download ${name}`))
            .finally(() =>
                setSaving((was) => {
                    const next = new Set(was);
                    next.delete(id);
                    return next;
                }),
            );
    };

    const toggle = (id: number) =>
        setOpened((was) => {
            const next = new Set(was);
            if (!next.delete(id)) next.add(id);
            return next;
        });

    return (
        <div className="gha-list">
            {rows.map((release) => (
                <div className="gha-release" key={release.id}>
                    <div className="gha-release-head">
                        <span className="gha-release-name">{release.name}</span>
                        {release.id === latest && (
                            <span className="gha-state-chip" data-state="open">
                                Latest
                            </span>
                        )}
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
                        <span className="gha-release-spacer" />
                        <button type="button" className="gha-link" onClick={() => void openUrl(release.url).catch(swallow("open GitHub"))}>
                            On GitHub
                        </button>
                    </div>
                    <div className="gha-release-meta">
                        <IconGit size={11} />
                        <span className="gha-mono">{release.tag}</span>
                        {release.author && (
                            <span>
                                <span className="gha-release-author">{release.author}</span> released this
                            </span>
                        )}
                        <span>{formatAgo(release.publishedAt, now)}</span>
                    </div>
                    {release.body.trim() && (
                        <>
                            <Prose className={opened.has(release.id) ? "prose" : "prose gha-clamp"}>{release.body}</Prose>
                            {release.body.length > LONG_NOTES && (
                                <button type="button" className="gha-link" onClick={() => toggle(release.id)}>
                                    {opened.has(release.id) ? "Show less" : "Show more"}
                                </button>
                            )}
                        </>
                    )}
                    <Assets release={release} saving={saving} onSave={save} />
                </div>
            ))}
            {rows.length >= RELEASES_READ && (
                <div className="gha-pager">
                    <span className="gha-dim">These are the newest {RELEASES_READ}.</span>
                    <button
                        type="button"
                        className="gha-link"
                        onClick={() => void openUrl(rows[0].url.replace(/\/tag\/.*$/u, "")).catch(swallow("open GitHub"))}>
                        Older releases on GitHub
                    </button>
                </div>
            )}
        </div>
    );
}
