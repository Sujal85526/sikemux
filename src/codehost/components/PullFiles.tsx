import { memo, useEffect, useMemo, useState } from "react";
import { DiffView } from "../../components/DiffView";
import { requestOpenFile } from "../../state/commands";
import { currentTheme, subscribeTheme } from "../../themes/bus";
import { joinPath } from "../../lib/paths";
import { useResourceEnabled } from "../../plugin-api/resources";
import { EmptyState, SkeletonRows } from "../../plugin-api/ui";
import { FileReviewList } from "../../components/FileReviewList";
import { failureMessage, type ChangedFile, type RepoRef } from "../api";
import { patchToRows } from "../patchRows";
import { pullFilesR } from "../resources";

const LINE_HEIGHT = 19;
const DIFF_PADDING = 16;

const STATUS: Record<string, { letter: string; cls: string; label: string }> = {
    added: { letter: "A", cls: "a", label: "added" },
    removed: { letter: "D", cls: "d", label: "deleted" },
    renamed: { letter: "R", cls: "r", label: "renamed" },
    copied: { letter: "C", cls: "r", label: "copied" },
};

function useDarkTheme(): boolean {
    const [dark, setDark] = useState(() => currentTheme().dark);
    useEffect(() => subscribeTheme((theme) => setDark(theme.dark)), []);
    return dark;
}

const FileDiff = memo(function FileDiff({ file, dark }: { file: ChangedFile; dark: boolean }) {
    const rows = useMemo(() => (file.patch ? patchToRows(file.patch) : []), [file.patch]);
    if (!file.patch)
        return (
            <div className="merge-review-content gha-side-empty">
                The host did not send a diff for this file, which it does for very large or binary ones.
            </div>
        );
    return (
        <div className="merge-review-content">
            <DiffView rows={rows} path={file.path} tinted={dark} />
        </div>
    );
});

interface Props {
    repo: RepoRef;
    number: number;
    /** The project folder, when the pull request is on its own repository, so a file can open in the editor. */
    cwd: string | null;
    active: boolean;
    /** The file picked in the list beside it, which the review scrolls to. */
    focusPath?: string;
}

/** A pull request's changed files, reviewed the way the git pane reviews local changes. */
export function PullFiles({ repo, number, cwd, active, focusPath }: Props) {
    const files = useResourceEnabled(active, pullFilesR, repo, number);
    const dark = useDarkTheme();
    const byPath = useMemo(() => new Map((files.data ?? []).map((file) => [file.path, file])), [files.data]);
    const paths = useMemo(() => (files.data ?? []).map((file) => file.path), [files.data]);

    if (files.status === "loading" && !files.data) return <SkeletonRows rows={6} label="Loading files" />;
    if (files.error && !files.data) return <EmptyState title="Could not read the files" message={failureMessage(files.error)} tone="error" />;

    return (
        <section className="gha-pull-files">
            <FileReviewList
                paths={paths}
                focusPath={focusPath}
                estimate={(path) => {
                    const file = byPath.get(path);
                    return file?.patch ? Math.min(600, file.patch.split("\n").length * LINE_HEIGHT + DIFF_PADDING) : 60;
                }}
                onOpenFile={cwd ? (path) => requestOpenFile(joinPath(cwd, path)) : undefined}
                status={(path) => {
                    const file = byPath.get(path);
                    if (!file) return null;
                    const badge = STATUS[file.status] ?? { letter: "M", cls: "m", label: "modified" };
                    return (
                        <>
                            <span className="gha-diffstat">
                                <span className="gha-add">+{file.additions}</span>
                                <span className="gha-del">−{file.deletions}</span>
                            </span>
                            <span
                                className={`git-status-symbol git-${badge.cls}`}
                                title={file.previousPath ? `${badge.label} from ${file.previousPath}` : badge.label}
                                aria-label={badge.label}>
                                {badge.letter}
                            </span>
                        </>
                    );
                }}
                body={(path) => {
                    const file = byPath.get(path);
                    return file ? <FileDiff file={file} dark={dark} /> : null;
                }}
            />
        </section>
    );
}
