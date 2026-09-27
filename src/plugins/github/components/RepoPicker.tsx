import { useMemo, useState } from "react";
import { usePluginOverlay } from "../../../plugin-api/host";
import { useResource } from "../../../plugin-api/resources";
import { IconClose, rankBy, SkeletonRows } from "../../../plugin-api/ui";
import type { RepoRef } from "../api";
import { actionsMyReposR } from "../resources";
import { actionsSettings, refOf, slugOf } from "../state";
import { GithubMark } from "./ActionsIcon";

interface Props {
    current: RepoRef | null;
    onPick: (repo: RepoRef) => void;
    onClose: () => void;
}

export function RepoPicker({ current, onPick, onClose }: Props) {
    const [typed, setTyped] = useState("");
    const mine = useResource(actionsMyReposR);
    const pinned = actionsSettings.useSelect((settings) => settings.pinned);
    usePluginOverlay(true);

    const slugs = useMemo(() => {
        const seen = new Set<string>();
        const all: { slug: string; pinned: boolean }[] = [];
        for (const slug of pinned) {
            seen.add(slug);
            all.push({ slug, pinned: true });
        }
        for (const repo of mine.data ?? []) {
            if (seen.has(repo.slug)) continue;
            seen.add(repo.slug);
            all.push({ slug: repo.slug, pinned: false });
        }
        return all;
    }, [pinned, mine.data]);

    const shown = useMemo(() => rankBy(typed.trim(), slugs, (entry) => entry.slug, 60), [slugs, typed]);

    const typedRef = refOf(typed.trim());
    const pick = (repo: RepoRef) => {
        onPick(repo);
        onClose();
    };

    return (
        <div className="gha-modal-scrim" role="presentation" onClick={onClose}>
            <div className="gha-modal picker" role="dialog" aria-label="Choose a repository" onClick={(event) => event.stopPropagation()}>
                <div className="gha-modal-head">
                    <h2>Repository</h2>
                    <button type="button" className="gha-icon-btn" onClick={onClose} aria-label="Close">
                        <IconClose size={13} />
                    </button>
                </div>
                <input
                    className="gha-input gha-mono"
                    value={typed}
                    onChange={(event) => setTyped(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key !== "Enter") return;
                        const first = shown[0];
                        if (typedRef) pick(typedRef);
                        else if (first) {
                            const ref = refOf(first.slug);
                            if (ref) pick(ref);
                        }
                    }}
                    placeholder="owner/repo"
                    autoFocus
                    spellCheck={false}
                />
                {typedRef && (
                    <button type="button" className="gha-pick-row" onClick={() => pick(typedRef)}>
                        <GithubMark size={12} />
                        <span className="gha-pick-name">Open {slugOf(typedRef)}</span>
                    </button>
                )}
                <div className="gha-pick-list">
                    {mine.status === "loading" && !mine.data && <SkeletonRows rows={6} label="Loading repositories" />}
                    {shown.map((entry) => {
                        const ref = refOf(entry.slug);
                        if (!ref) return null;
                        return (
                            <button
                                key={entry.slug}
                                type="button"
                                className="gha-pick-row"
                                data-on={current && slugOf(current) === entry.slug ? "1" : "0"}
                                onClick={() => pick(ref)}>
                                <GithubMark size={12} />
                                <span className="gha-pick-name">{entry.slug}</span>
                                {entry.pinned && <span className="gha-dim">pinned</span>}
                            </button>
                        );
                    })}
                    {shown.length === 0 && mine.status !== "loading" && <div className="gha-side-empty">Type owner/repo to open one.</div>}
                </div>
            </div>
        </div>
    );
}
