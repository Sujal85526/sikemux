import { useEffect, useState } from "react";
import { git } from "../api/git";
import { DiffEditor } from "./DiffEditor";
import { IconChevron } from "./Icons";
import { FileIcon } from "./FileIcon";
import { Tooltip } from "./Tooltip";
import { basename, joinPath } from "../lib/paths";

export function CommitReview({
    repo,
    rev,
    title,
    subtitle,
    onOpenFile,
}: {
    repo: string;
    rev: string;
    title: string;
    subtitle: string;
    onOpenFile: (abs: string) => void;
}) {
    const [files, setFiles] = useState<string[]>([]);
    const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

    useEffect(() => {
        let cancelled = false;
        setFiles([]);
        setCollapsed(new Set());
        git.commitFiles(repo, rev)
            .then((fs) => {
                if (cancelled) return;
                setFiles(fs);
                setCollapsed(new Set(fs));
            })
            .catch(() => {
                if (cancelled) return;
                setFiles([]);
                setCollapsed(new Set());
            });
        return () => {
            cancelled = true;
        };
    }, [repo, rev]);

    const toggle = (f: string) =>
        setCollapsed((s) => {
            const n = new Set(s);
            n.has(f) ? n.delete(f) : n.add(f);
            return n;
        });

    return (
        <div className="commit-review">
            <div className="commit-head">
                <span className="commit-hash">{title}</span>
                <span className="commit-subject">{subtitle}</span>
            </div>
            <div className="commit-stack">
                {files.length === 0 && <div className="commit-empty">no files</div>}
                {files.map((f) => {
                    const open = !collapsed.has(f);
                    return (
                        <div className="acc-item" key={f}>
                            <div className="acc-header">
                                <Tooltip label={open ? "Collapse" : "Expand"}>
                                    <button className="acc-toggle" onClick={() => toggle(f)} aria-label={open ? "Collapse" : "Expand"}>
                                        <span className={`acc-chev${open ? " open" : ""}`}>
                                            <IconChevron size={11} />
                                        </span>
                                    </button>
                                </Tooltip>
                                <Tooltip label="Open in editor">
                                    <button className="acc-name" onClick={() => onOpenFile(joinPath(repo, f))}>
                                        <FileIcon name={basename(f)} size={15} />
                                        <span>{f}</span>
                                    </button>
                                </Tooltip>
                            </div>
                            {open && <DiffEditor repo={repo} path={f} baseRev={`${rev}~1`} headRev={rev} editable={false} autoHeight />}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
